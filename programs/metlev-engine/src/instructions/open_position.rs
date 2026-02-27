use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::state::{Config, Position, LendingVault, CollateralConfig};
use crate::errors::ProtocolError;
use crate::utils::{read_oracle_price, calculate_collateral_value, calculate_ltv};
use crate::dlmm;

/// Opens a leveraged DLMM position by:
///   1. Borrowing wSOL from the lending vault proportional to `leverage`.
///   2. Validating the resulting LTV against the collateral config.
///   3. CPI → Meteora `initialize_position`  (creates the DLMM position account).
///   4. CPI → Meteora `add_liquidity_one_side` (deposits borrowed wSOL into the pool,
///      signing as the lending_vault PDA – the authority of wsol_vault).
///
/// # Single-sided deposit bin rules (caller must respect these):
///   - Depositing token X (WSOL is X): all bin_ids in `bin_liquidity_dist`
///     must be **strictly > active_id**.
///   - Depositing token Y (WSOL is Y): all bin_ids must be **<= active_id**.
///   - All bin_ids must fall within [lower_bin_id, lower_bin_id + width - 1].
///
/// # Leverage encoding
///   `leverage` is in basis points: 10_000 = 1×, 20_000 = 2×, 30_000 = 3×, etc.
///   The borrow amount equals `collateral_amount * leverage / 10_000`.

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    // ── Protocol actor ────────────────────────────────────────────────────────
    /// Pays rent for the new DLMM position account and signs as the position owner.
    #[account(mut)]
    pub user: Signer<'info>,

    // ── Protocol state ────────────────────────────────────────────────────────
    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [Position::SEED_PREFIX, user.key().as_ref(), wsol_mint.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ ProtocolError::InvalidOwner,
        constraint = position.is_active() @ ProtocolError::PositionNotActive,
    )]
    pub position: Account<'info, Position>,

    /// The protocol lending vault. Signs the add_liquidity CPI as the authority
    /// of `wsol_vault` using PDA signer seeds.
    #[account(
        mut,
        seeds = [LendingVault::SEED_PREFIX],
        bump = lending_vault.bump,
    )]
    pub lending_vault: Account<'info, LendingVault>,

    /// The vault's wSOL token account. This is the **source** of the borrowed
    /// funds that flow into the Meteora pool.
    ///
    /// Seeds: ["wsol_vault", lending_vault]
    /// Authority: lending_vault PDA
    #[account(
        mut,
        seeds = [b"wsol_vault", lending_vault.key().as_ref()],
        bump = lending_vault.vault_bump,
        token::mint = wsol_mint,
        token::authority = lending_vault,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    /// wSOL mint — needed for the wsol_vault token constraint.
    #[account(address = anchor_spl::token::spl_token::native_mint::id())]
    pub wsol_mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [CollateralConfig::SEED_PREFIX, position.collateral_mint.as_ref()],
        bump = collateral_config.bump,
        constraint = collateral_config.is_enabled() @ ProtocolError::InvalidCollateralType,
    )]
    pub collateral_config: Account<'info, CollateralConfig>,

    /// CHECK: Validated against collateral_config.oracle
    #[account(
        constraint = price_oracle.key() == collateral_config.oracle @ ProtocolError::OraclePriceUnavailable,
    )]
    pub price_oracle: UncheckedAccount<'info>,

    // ── Meteora DLMM accounts ─────────────────────────────────────────────────

    /// Freshly generated Keypair for the new DLMM position.
    /// Must sign this transaction so the DLMM program can verify it is not
    /// already claimed (replay protection).
    #[account(mut)]
    pub met_position: Signer<'info>,

    /// The Meteora DLMM lb_pair (pool) account.
    /// CHECK: Verified by the DLMM program during CPI.
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,

    /// Bin array bitmap extension. Only required when the active bin falls
    /// outside the main bitmap range (|bin_id| > 512). Pass `None` otherwise.
    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub bin_array_bitmap_extension: Option<UncheckedAccount<'info>>,

    /// The pool's token reserve for the deposited asset (wSOL reserve).
    /// Use lb_pair.reserve_x if WSOL is token X, lb_pair.reserve_y if token Y.
    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    /// Mint of the token being deposited (wSOL = So1111...1112).
    /// CHECK: Verified by the DLMM program.
    pub token_mint: UncheckedAccount<'info>,

    /// Bin array covering the lower end of the position's bin range.
    /// PDA: ["bin_array", lb_pair, floor(lower_bin_id / 70)] under DLMM program.
    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub bin_array_lower: UncheckedAccount<'info>,

    /// Bin array covering the upper end of the position's bin range.
    /// PDA: ["bin_array", lb_pair, floor(upper_bin_id / 70)] under DLMM program.
    /// May be the same account as bin_array_lower if the range fits in one array.
    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub bin_array_upper: UncheckedAccount<'info>,

    /// DLMM event authority PDA.
    /// Derived as: find_program_address(&[b"__event_authority"], &dlmm::ID)
    /// CHECK: Verified by the DLMM program.
    pub event_authority: UncheckedAccount<'info>,

    /// SPL Token program (use Token or Token-2022 depending on the pool).
    pub token_program: Interface<'info, TokenInterface>,

    /// The DLMM program itself.
    /// CHECK: Address constrained to dlmm::ID.
    #[account(address = dlmm::ID)]
    pub dlmm_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

impl<'info> OpenPosition<'info> {
    pub fn open(
        &mut self,
        // Leverage in basis points. 10_000 = 1×, 20_000 = 2×.
        leverage: u64,
        // Lower bin ID for the new DLMM position (inclusive).
        lower_bin_id: i32,
        // Number of bins in the position (width).
        // upper_bin_id = lower_bin_id + width - 1
        width: i32,
        // Active bin ID observed off-chain before building the transaction.
        // Used for on-chain slippage protection.
        active_id: i32,
        // Maximum deviation (in bins) between `active_id` and the actual
        // on-chain active bin. Recommended: 3–10.
        max_active_bin_slippage: i32,
        // Per-bin weight distribution for the single-sided deposit.
        // Each entry: { bin_id: i32, weight: u16 }
        // Only ratios matter — the DLMM program normalises internally.
        bin_liquidity_dist: Vec<dlmm::types::BinLiquidityDistributionByWeight>,
    ) -> Result<()> {
        require!(!self.config.paused, ProtocolError::ProtocolPaused);

        // ─── 1. Compute borrow amount from leverage ────────────────────────────
        // borrow_amount = collateral_amount × leverage / 10_000
        // e.g. 1 SOL collateral × 20_000 leverage / 10_000 = 2 SOL borrowed
        let borrow_amount = self
            .position
            .collateral_amount
            .checked_mul(leverage)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(ProtocolError::MathOverflow)?;

        require!(borrow_amount > 0, ProtocolError::InvalidAmount);

        // ─── 2. Attempt to borrow from the lending vault ──────────────────────
        // This checks available liquidity and updates total_borrowed.
        self.lending_vault.borrow(borrow_amount)?;

        // ─── 3. Oracle + LTV validation ───────────────────────────────────────
        let oracle_info = self.price_oracle.to_account_info();
        let (price, _) = read_oracle_price(
            &oracle_info,
            self.collateral_config.oracle_max_age,
        )?;

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

        // ─── 4. Persist debt + DLMM position key in our protocol state ────────
        self.position.debt_amount = borrow_amount;
        // TODO: store met_position.key() in Position state if you add that field
        // self.position.dlmm_position = self.met_position.key();

        // ─── 5. CPI → Meteora: initialize_position ────────────────────────────
        // Creates the on-chain DLMM Position account.
        //   payer = user  (pays account rent)
        //   owner = user  (receives trading fees from this position)
        //
        // NOTE: If you want the protocol to own the position fees, set owner
        // to lending_vault.key() and sign via signer_seeds in this CPI too.
        let init_pos_ctx = CpiContext::new(
            self.dlmm_program.to_account_info(),
            dlmm::cpi::accounts::InitializePosition {
                position: self.met_position.to_account_info(),
                lb_pair: self.lb_pair.to_account_info(),
                payer: self.user.to_account_info(),
                owner: self.user.to_account_info(),
                system_program: self.system_program.to_account_info(),
                rent: self.rent.to_account_info(),
                event_authority: self.event_authority.to_account_info(),
                program: self.dlmm_program.to_account_info(),
            },
        );

        dlmm::cpi::initialize_position(init_pos_ctx, lower_bin_id, width)?;

        // ─── 6. CPI → Meteora: add_liquidity_one_side ─────────────────────────
        // Deposits `borrow_amount` wSOL from wsol_vault into the pool.
        //
        // The lending_vault PDA is the authority (sender) for the wsol_vault
        // token account. We sign the CPI using the vault's PDA seeds.
        let vault_bump = self.lending_vault.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[LendingVault::SEED_PREFIX, &[vault_bump]]];

        let add_liq_ctx = CpiContext::new_with_signer(
            self.dlmm_program.to_account_info(),
            dlmm::cpi::accounts::AddLiquidityOneSide {
                position: self.met_position.to_account_info(),
                lb_pair: self.lb_pair.to_account_info(),
                bin_array_bitmap_extension: self
                    .bin_array_bitmap_extension
                    .as_ref()
                    .map(|a| a.to_account_info()),
                // wsol_vault IS the user_token: tokens flow from here → pool reserve
                user_token: self.wsol_vault.to_account_info(),
                reserve: self.reserve.to_account_info(),
                token_mint: self.token_mint.to_account_info(),
                bin_array_lower: self.bin_array_lower.to_account_info(),
                bin_array_upper: self.bin_array_upper.to_account_info(),
                // lending_vault PDA signs as the authority of wsol_vault
                sender: self.lending_vault.to_account_info(),
                token_program: self.token_program.to_account_info(),
                event_authority: self.event_authority.to_account_info(),
                program: self.dlmm_program.to_account_info(),
            },
            signer_seeds,
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