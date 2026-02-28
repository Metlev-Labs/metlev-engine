use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::state::{Config, Position, LendingVault, CollateralConfig};
use crate::errors::ProtocolError;
use crate::utils::{read_oracle_price, calculate_collateral_value, calculate_ltv};
use crate::dlmm;

/// Opens a leveraged DLMM position by:
///
///   1. Computing the borrow amount from leverage (`collateral × leverage / 10_000`).
///   2. Checking vault liquidity and recording the debt via `LendingVault::borrow()`.
///   3. Reading the oracle price and validating the resulting LTV.
///   4. CPI → Meteora `initialize_position`:
///        - `payer = user`          → user pays the position rent (lamports from their SOL).
///        - `owner = lending_vault` → protocol PDA owns the position so it can be the
///                                    `sender` in step 5 (DLMM requires sender == owner).
///        - Signed with `lending_vault` PDA seeds (owner must sign the CPI).
///   5. CPI → Meteora `add_liquidity_one_side`:
///        - `user_token = wsol_vault` → borrowed wSOL flows from the vault into the pool.
///        - `sender     = lending_vault` → PDA authority of `wsol_vault`, also position owner.
///
/// # Why lending_vault must be both owner and sender
///   DLMM's `add_liquidity_one_side` validates `sender.key() == position.owner`.
///   Because the protocol (not the user) supplies the deposited tokens from `wsol_vault`,
///   the protocol PDA must be both the position owner and the SPL token authority.
///   Setting `owner = lending_vault` satisfies this constraint and keeps the position
///   under protocol control for future rebalancing and fee collection.
///
/// # met_position account requirements
///   `met_position` must be a freshly generated Keypair with NO on-chain state —
///   i.e. owned by SystemProgram with 0 lamports.
///   DO NOT pre-allocate this account with `SystemProgram.createAccount` before calling
///   this instruction. DLMM's `initialize_position` uses `#[account(init, ...)]` which:
///     - Requires the account to be owned by SystemProgram (uninitialized).
///     - Creates and initialises the account (writes discriminator) via an inner CPI.
///   Pre-allocating the account will cause `AccountDiscriminatorNotFound` (Error 3001).
///
/// # Single-sided deposit bin rules (caller must enforce these off-chain):
///   - wSOL is token X → all `bin_ids` in `bin_liquidity_dist` must be > `active_id`.
///   - wSOL is token Y → all `bin_ids` must be ≤ `active_id`.
///   - All `bin_ids` must fall within `[lower_bin_id, lower_bin_id + width − 1]`.
///
/// # Leverage encoding
///   `leverage` is in basis points: 10_000 = 1×, 20_000 = 2×, 50_000 = 5×, etc.
///   Borrow amount = `collateral_amount * leverage / 10_000`.

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    // ── User ──────────────────────────────────────────────────────────────────

    /// The user opening the leveraged position.
    ///   - Must have an active protocol Position with collateral already deposited.
    ///   - Pays rent for the newly created DLMM position account.
    ///   - Must be a Signer so the nested `system_program::create_account` CPI
    ///     (inside DLMM's initialize_position) can debit the rent from their account.
    #[account(mut)]
    pub user: Signer<'info>,

    // ── Protocol state ────────────────────────────────────────────────────────

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    /// wSOL mint — serves as both a seed component for `position` and as the
    /// `token::mint` constraint on `wsol_vault`.
    #[account(address = anchor_spl::token::spl_token::native_mint::id())]
    pub wsol_mint: InterfaceAccount<'info, Mint>,

    /// The user's protocol-level Position (tracks collateral and debt).
    #[account(
        mut,
        seeds = [Position::SEED_PREFIX, user.key().as_ref(), wsol_mint.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ ProtocolError::InvalidOwner,
        constraint = position.is_active()          @ ProtocolError::PositionNotActive,
    )]
    pub position: Account<'info, Position>,

    /// The protocol lending vault.
    /// Signs BOTH CPIs with its PDA seeds:
    ///   1. As `owner` in `initialize_position` (creates position under protocol control).
    ///   2. As `sender` in `add_liquidity_one_side` (authorises token transfer from wsol_vault).
    #[account(
        mut,
        seeds = [LendingVault::SEED_PREFIX],
        bump = lending_vault.bump,
    )]
    pub lending_vault: Account<'info, LendingVault>,

    /// The vault's wSOL token account — the source of borrowed funds.
    ///
    /// Seeds  : ["wsol_vault", lending_vault.key()]
    /// Authority: lending_vault PDA
    #[account(
        mut,
        seeds = [b"wsol_vault", lending_vault.key().as_ref()],
        bump = lending_vault.vault_bump,
        token::mint      = wsol_mint,
        token::authority = lending_vault,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        seeds = [CollateralConfig::SEED_PREFIX, wsol_mint.key().as_ref()],
        bump = collateral_config.bump,
        constraint = collateral_config.is_enabled() @ ProtocolError::InvalidCollateralType,
    )]
    pub collateral_config: Account<'info, CollateralConfig>,

    /// CHECK: key validated against `collateral_config.oracle`.
    #[account(
        constraint = price_oracle.key() == collateral_config.oracle
            @ ProtocolError::OraclePriceUnavailable,
    )]
    pub price_oracle: UncheckedAccount<'info>,

    // ── Meteora DLMM accounts ─────────────────────────────────────────────────

    /// A freshly generated Keypair for the new DLMM position.
    ///
    /// Must be a `Signer` so the inner `system_program::create_account` CPI
    /// (executed inside DLMM's `initialize_position`) can assign this pubkey.
    ///
    /// ⚠️  IMPORTANT: This account MUST NOT exist on-chain before this transaction.
    ///     Do NOT call `SystemProgram.createAccount` for this keypair as a
    ///     pre-instruction. DLMM uses `#[account(init)]` which requires the account
    ///     to be uninitialized (owned by SystemProgram, 0 lamports).
    #[account(mut)]
    pub met_position: Signer<'info>,

    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,

    /// Bin array bitmap extension — only required when |bin_id| > 512.
    /// Pass `None` (TypeScript: `null`) when not needed.
    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub bin_array_bitmap_extension: Option<UncheckedAccount<'info>>,

    /// Pool reserve for the deposited token (wSOL reserve).
    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    /// Mint of the deposited token (wSOL = `So1111…1112`).
    /// CHECK: Verified by the DLMM program.
    pub token_mint: UncheckedAccount<'info>,

    /// Bin array covering the lower end of the position's bin range.
    /// PDA (DLMM): `["bin_array", lb_pair, bin_id_to_bin_array_index(lower_bin_id)]`
    /// Index formula (matches DLMM on-chain logic):
    ///   index = (bin_id / 70) - (1 if bin_id % 70 < 0 else 0)
    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub bin_array_lower: UncheckedAccount<'info>,

    /// Bin array covering the upper end of the position's bin range.
    /// May be the same account as `bin_array_lower` when the entire range fits
    /// within a single bin array (common for small ranges or negative bin IDs).
    /// When lower == upper, pass the same pubkey for both — DLMM handles it.
    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub bin_array_upper: UncheckedAccount<'info>,

    /// DLMM event authority PDA.
    /// Seeds (under DLMM program): `["__event_authority"]`
    /// CHECK: Verified by the DLMM program.
    pub event_authority: UncheckedAccount<'info>,

    /// SPL Token (or Token-2022) program matching the pool's token standard.
    pub token_program: Interface<'info, TokenInterface>,

    /// CHECK: Address constrained to `dlmm::ID`.
    #[account(address = dlmm::ID)]
    pub dlmm_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// Required by DLMM's `initialize_position` instruction.
    pub rent: Sysvar<'info, Rent>,
}

impl<'info> OpenPosition<'info> {
    pub fn open(
        &mut self,
        // Leverage in basis points.  10_000 = 1×, 20_000 = 2×, etc.
        leverage: u64,
        // Lower bin ID for the new DLMM position (inclusive).
        lower_bin_id: i32,
        // Number of bins in the position (width).
        // `upper_bin_id = lower_bin_id + width − 1`
        width: i32,
        // Active bin ID observed off-chain — used for on-chain slippage protection.
        active_id: i32,
        // Maximum deviation (in bins) between the observed `active_id` and the
        // actual on-chain active bin when the transaction executes. Recommended: 3–10.
        max_active_bin_slippage: i32,
        // Per-bin weight distribution for the single-sided deposit.
        // Each entry: `{ bin_id: i32, weight: u16 }`.
        // Only relative ratios matter — DLMM normalises the weights internally.
        bin_liquidity_dist: Vec<dlmm::types::BinLiquidityDistributionByWeight>,
    ) -> Result<()> {
        require!(!self.config.paused, ProtocolError::ProtocolPaused);

        // ── 1. Compute borrow amount ──────────────────────────────────────────
        // borrow = collateral × leverage / 10_000
        // Example: 2 SOL collateral, 20_000 leverage → 4 SOL borrowed.
        let borrow_amount = self
            .position
            .collateral_amount
            .checked_mul(leverage)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(ProtocolError::MathOverflow)?;

        require!(borrow_amount > 0, ProtocolError::InvalidAmount);

        // ── 2. Borrow from lending vault ──────────────────────────────────────
        // Validates available liquidity and increments `total_borrowed`.
        self.lending_vault.borrow(borrow_amount)?;

        // ── 3. Oracle + LTV validation ────────────────────────────────────────
        let oracle_info = self.price_oracle.to_account_info();
        let (price, _) = read_oracle_price(&oracle_info, self.collateral_config.oracle_max_age)?;

        let collateral_value = calculate_collateral_value(
            self.position.collateral_amount,
            price,
            self.collateral_config.decimals,
        )?;
        let debt_value = calculate_collateral_value(
            borrow_amount,
            price,
            self.collateral_config.decimals,
        )?;
        let ltv = calculate_ltv(collateral_value, debt_value)?;
        require!(
            self.collateral_config.validate_ltv(ltv),
            ProtocolError::ExceedsMaxLTV
        );

        // ── 4. Persist debt in protocol state ─────────────────────────────────
        self.position.debt_amount = borrow_amount;
        // Optional: store the DLMM position key for future reference.
        // self.position.dlmm_position = self.met_position.key();

        // ── Shared PDA signer seeds ───────────────────────────────────────────
        // lending_vault PDA signs BOTH CPIs:
        //   (a) as `owner`  in initialize_position → DLMM records vault as position owner
        //   (b) as `sender` in add_liquidity_one_side → must match position.owner
        let vault_bump = self.lending_vault.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[LendingVault::SEED_PREFIX, &[vault_bump]]];

        // ── 5. CPI → Meteora: initialize_position ─────────────────────────────
        //
        // Creates and initialises a brand-new DLMM Position account.
        //
        //   payer = user          → deducted from user's SOL for rent
        //   owner = lending_vault → protocol PDA is the position owner;
        //                           this is REQUIRED so that sender == owner
        //                           in the add_liquidity CPI below.
        //
        // lending_vault must sign this CPI (it is listed as `owner`).
        // user also signs implicitly via the transaction, enabling the nested
        // system_program::create_account CPI to debit rent from user's account.
        //
        // ⚠️  met_position must be a fresh, uninitialized account (owned by
        //     SystemProgram) — DLMM's #[account(init)] handles the creation.
        let init_pos_ctx = CpiContext::new_with_signer(
            self.dlmm_program.to_account_info(),
            dlmm::cpi::accounts::InitializePosition {
                position:        self.met_position.to_account_info(),
                lb_pair:         self.lb_pair.to_account_info(),
                payer:           self.user.to_account_info(),
                owner:           self.lending_vault.to_account_info(), // ← vault, not user
                system_program:  self.system_program.to_account_info(),
                rent:            self.rent.to_account_info(),
                event_authority: self.event_authority.to_account_info(),
                program:         self.dlmm_program.to_account_info(),
            },
            signer_seeds, // lending_vault signs as owner
        );
        dlmm::cpi::initialize_position(init_pos_ctx, lower_bin_id, width)?;

        // ── 6. CPI → Meteora: add_liquidity_one_side ──────────────────────────
        //
        // Deposits `borrow_amount` wSOL from `wsol_vault` into the pool.
        //
        //   user_token = wsol_vault   → source of the borrowed wSOL
        //   sender     = lending_vault → PDA authority of wsol_vault AND position owner
        //
        // DLMM validates: sender.key() == position.owner
        // Since initialize_position set owner = lending_vault, this constraint is met.
        let add_liq_ctx = CpiContext::new_with_signer(
            self.dlmm_program.to_account_info(),
            dlmm::cpi::accounts::AddLiquidityOneSide {
                position:    self.met_position.to_account_info(),
                lb_pair:     self.lb_pair.to_account_info(),
                bin_array_bitmap_extension: self
                    .bin_array_bitmap_extension
                    .as_ref()
                    .map(|a| a.to_account_info()),
                user_token:     self.wsol_vault.to_account_info(),
                reserve:        self.reserve.to_account_info(),
                token_mint:     self.token_mint.to_account_info(),
                bin_array_lower: self.bin_array_lower.to_account_info(),
                bin_array_upper: self.bin_array_upper.to_account_info(),
                sender:         self.lending_vault.to_account_info(), // ← must equal owner
                token_program:  self.token_program.to_account_info(),
                event_authority: self.event_authority.to_account_info(),
                program:        self.dlmm_program.to_account_info(),
            },
            signer_seeds, // lending_vault signs as sender
        );
        dlmm::cpi::add_liquidity_one_side(
            add_liq_ctx,
            dlmm::types::LiquidityOneSideParameter {
                amount: borrow_amount,
                active_id,
                max_active_bin_slippage,
                bin_liquidity_dist,
            },
        )?;

        Ok(())
    }
}