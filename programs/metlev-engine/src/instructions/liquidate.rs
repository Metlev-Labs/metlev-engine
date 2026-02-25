use anchor_lang::prelude::*;
use crate::state::{Config, Position, LendingVault};
use crate::errors::ProtocolError;

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
        seeds = [Position::SEED_PREFIX, position.owner.key().as_ref()],
        bump = position.bump,
        constraint = position.is_active() @ ProtocolError::PositionNotActive,
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        seeds = [LendingVault::SEED_PREFIX],
        bump = lending_vault.vault_bump,
    )]
    pub lending_vault: Account<'info, LendingVault>,

    /// CHECK: Position owner to receive remaining collateral (if any)
    #[account(mut)]
    pub position_owner: UncheckedAccount<'info>,

    /// TODO: Add Meteora DLMM program and accounts
    /// CHECK: Meteora program
    pub meteora_program: UncheckedAccount<'info>,

    /// TODO: Add oracle accounts for price feeds
    /// CHECK: Price oracle
    pub price_oracle: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

impl<'info> Liquidate<'info> {
    pub fn liquidate(&mut self) -> Result<()> {
        // TODO: Read oracle prices
        // let sol_price = read_oracle_price(&self.price_oracle)?;
        // require!(!is_oracle_stale(oracle_timestamp), ProtocolError::OracleStale);

        // TODO: Calculate position health
        // let collateral_value = calculate_collateral_value(position, oracle);
        // let debt_value = position.debt_amount;
        // let ltv = calculate_ltv(collateral_value, debt_value);

        // Check if position is liquidatable
        // require!(
        //     self.config.is_liquidatable(ltv),
        //     ProtocolError::PositionHealthy
        // );

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
