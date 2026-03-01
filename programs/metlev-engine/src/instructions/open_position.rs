use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::state::{Config, Position, LendingVault, CollateralConfig};
use crate::errors::ProtocolError;
use crate::utils::{read_oracle_price, calculate_collateral_value, calculate_ltv};
use crate::dlmm;

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(address = anchor_spl::token::spl_token::native_mint::id())]
    pub wsol_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [Position::SEED_PREFIX, user.key().as_ref(), wsol_mint.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ ProtocolError::InvalidOwner,
        constraint = position.is_active() @ ProtocolError::PositionNotActive,
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        seeds = [LendingVault::SEED_PREFIX],
        bump = lending_vault.bump,
    )]
    pub lending_vault: Account<'info, LendingVault>,

    #[account(
        mut,
        seeds = [b"wsol_vault", lending_vault.key().as_ref()],
        bump = lending_vault.vault_bump,
        token::mint = wsol_mint,
        token::authority = lending_vault,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        seeds = [CollateralConfig::SEED_PREFIX, wsol_mint.key().as_ref()],
        bump = collateral_config.bump,
        constraint = collateral_config.is_enabled() @ ProtocolError::InvalidCollateralType,
    )]
    pub collateral_config: Account<'info, CollateralConfig>,

    /// CHECK: key validated against collateral_config.oracle
    #[account(
        constraint = price_oracle.key() == collateral_config.oracle @ ProtocolError::OraclePriceUnavailable,
    )]
    pub price_oracle: UncheckedAccount<'info>,

    #[account(mut)]
    pub met_position: Signer<'info>,

    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,

    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub bin_array_bitmap_extension: Option<UncheckedAccount<'info>>,

    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    /// CHECK: Verified by the DLMM program.
    pub token_mint: UncheckedAccount<'info>,

    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub bin_array_lower: UncheckedAccount<'info>,

    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub bin_array_upper: UncheckedAccount<'info>,

    /// CHECK: Verified by the DLMM program.
    pub event_authority: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    /// CHECK: Address constrained to dlmm::ID.
    #[account(address = dlmm::ID)]
    pub dlmm_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    pub rent: Sysvar<'info, Rent>,
}

impl<'info> OpenPosition<'info> {
    pub fn open(
        &mut self,
        leverage: u64,
        lower_bin_id: i32,
        width: i32,
        active_id: i32,
        max_active_bin_slippage: i32,
        bin_liquidity_dist: Vec<dlmm::types::BinLiquidityDistributionByWeight>,
    ) -> Result<()> {
        require!(!self.config.paused, ProtocolError::ProtocolPaused);

        // borrow = collateral * leverage / 10_000
        // leverage 10_000 = 1x (borrow == collateral), 20_000 = 2x, etc.
        let borrow_amount = self
            .position
            .collateral_amount
            .checked_mul(leverage)
            .and_then(|v| v.checked_div(10_000))
            .ok_or(ProtocolError::MathOverflow)?;

        require!(borrow_amount > 0, ProtocolError::InvalidAmount);

        self.lending_vault.borrow(borrow_amount)?;

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

        // LTV = debt / (collateral + debt)
        // For 2x leverage: debt = 2 * collateral → LTV = 2/3 = 66.7%
        // For 3x leverage: debt = 3 * collateral → LTV = 3/4 = 75%
        let total_value = collateral_value
            .checked_add(debt_value)
            .ok_or(ProtocolError::MathOverflow)?;
        let ltv = calculate_ltv(total_value, debt_value)?;
        require!(
            self.collateral_config.validate_ltv(ltv),
            ProtocolError::ExceedsMaxLTV
        );

        self.position.debt_amount = borrow_amount;

        let vault_bump = self.lending_vault.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[LendingVault::SEED_PREFIX, &[vault_bump]]];

        let init_pos_ctx = CpiContext::new_with_signer(
            self.dlmm_program.to_account_info(),
            dlmm::cpi::accounts::InitializePosition {
                position:        self.met_position.to_account_info(),
                lb_pair:         self.lb_pair.to_account_info(),
                payer:           self.user.to_account_info(),
                owner:           self.lending_vault.to_account_info(),
                system_program:  self.system_program.to_account_info(),
                rent:            self.rent.to_account_info(),
                event_authority: self.event_authority.to_account_info(),
                program:         self.dlmm_program.to_account_info(),
            },
            signer_seeds,
        );
        dlmm::cpi::initialize_position(init_pos_ctx, lower_bin_id, width)?;

        let add_liq_ctx = CpiContext::new_with_signer(
            self.dlmm_program.to_account_info(),
            dlmm::cpi::accounts::AddLiquidityOneSide {
                position:                   self.met_position.to_account_info(),
                lb_pair:                    self.lb_pair.to_account_info(),
                bin_array_bitmap_extension: self
                    .bin_array_bitmap_extension
                    .as_ref()
                    .map(|a| a.to_account_info()),
                user_token:      self.wsol_vault.to_account_info(),
                reserve:         self.reserve.to_account_info(),
                token_mint:      self.token_mint.to_account_info(),
                bin_array_lower: self.bin_array_lower.to_account_info(),
                bin_array_upper: self.bin_array_upper.to_account_info(),
                sender:          self.lending_vault.to_account_info(),
                token_program:   self.token_program.to_account_info(),
                event_authority: self.event_authority.to_account_info(),
                program:         self.dlmm_program.to_account_info(),
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
