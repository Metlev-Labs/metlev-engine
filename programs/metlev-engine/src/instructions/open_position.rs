use anchor_lang::prelude::*;
use crate::state::{Config, Position, LendingVault, CollateralConfig};
use crate::errors::ProtocolError;
use crate::utils::{read_oracle_price, calculate_collateral_value, calculate_ltv};

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [Position::SEED_PREFIX, user.key().as_ref()],
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
        seeds = [CollateralConfig::SEED_PREFIX, position.collateral_mint.as_ref()],
        bump = collateral_config.bump,
        constraint = collateral_config.is_enabled() @ ProtocolError::InvalidCollateralType,
    )]
    pub collateral_config: Account<'info, CollateralConfig>,

    /// CHECK: verified via collateral_config.oracle constraint
    #[account(
        constraint = price_oracle.key() == collateral_config.oracle @ ProtocolError::OraclePriceUnavailable,
    )]
    pub price_oracle: UncheckedAccount<'info>,

    /// TODO: Add Meteora DLMM program and accounts here
    /// CHECK: Meteora program
    pub meteora_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

impl<'info> OpenPosition<'info> {
    pub fn open(
        &mut self,
        leverage: u64, // Leverage multiplier (basis points, 20000 = 2x)
    ) -> Result<()> {
        require!(!self.config.paused, ProtocolError::ProtocolPaused);

        // Calculate borrow amount based on leverage
        let borrow_amount = self.position.collateral_amount
            .checked_mul(leverage)
            .and_then(|v| v.checked_div(10000))
            .ok_or(ProtocolError::MathOverflow)?;

        // Check if lending vault has enough liquidity
        self.lending_vault.borrow(borrow_amount)?;

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

        // Update position debt
        self.position.debt_amount = borrow_amount;

        // TODO: CPI to Meteora to create DLMM position
        // This will involve:
        // 1. Prepare token accounts (collateral + borrowed funds)
        // 2. Call Meteora add_liquidity instruction
        // 3. Store Meteora position reference in self.position.meteora_position

        Ok(())
    }
}
