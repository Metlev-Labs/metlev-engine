use anchor_lang::prelude::*;
use crate::state::{Config, Position, LendingVault, CollateralConfig};
use crate::errors::ProtocolError;
use crate::utils::{read_oracle_price, calculate_collateral_value, calculate_ltv};

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(mut)]
    pub liquidator: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [Position::SEED_PREFIX, position.owner.key().as_ref(), position.collateral_mint.as_ref()],
        bump = position.bump,
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
    )]
    pub collateral_config: Account<'info, CollateralConfig>,

    /// CHECK: verified via collateral_config.oracle constraint
    #[account(
        constraint = price_oracle.key() == collateral_config.oracle @ ProtocolError::OraclePriceUnavailable,
    )]
    pub price_oracle: UncheckedAccount<'info>,

    /// CHECK: Position owner to receive remaining collateral (if any)
    #[account(mut)]
    pub position_owner: UncheckedAccount<'info>,

    /// TODO: Add Meteora DLMM program and accounts
    /// CHECK: Meteora program
    pub meteora_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

impl<'info> Liquidate<'info> {
    pub fn liquidate(&mut self) -> Result<()> {
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
            self.position.debt_amount,
            price,
            self.collateral_config.decimals,
        )?;
        let ltv = calculate_ltv(collateral_value, debt_value)?;
        require!(
            self.collateral_config.is_liquidatable(ltv),
            ProtocolError::PositionHealthy
        );

        // TODO: CPI to Meteora to remove liquidity
        // let total_proceeds = remove_liquidity_from_meteora();

        // Repay debt
        let debt = self.position.debt_amount;
        self.lending_vault.repay(debt)?;

        // TODO: Calculate liquidation penalty
        // let penalty = calculate_penalty(total_proceeds, self.config.liquidation_penalty);
        // transfer(penalty, liquidator);

        // TODO: Return remaining to position owner (if any)
        // let remaining = total_proceeds.saturating_sub(debt + penalty);
        // if remaining > 0 {
        //     transfer(remaining, position_owner);
        // }

        // Mark position as liquidated
        self.position.mark_liquidated();

        Ok(())
    }
}
