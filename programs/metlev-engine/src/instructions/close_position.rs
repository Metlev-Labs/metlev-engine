use anchor_lang::prelude::*;
use crate::state::{Config, Position, LendingVault};
use crate::errors::ProtocolError;

#[derive(Accounts)]
pub struct ClosePosition<'info> {
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

    /// TODO: Add Meteora DLMM program and accounts
    /// CHECK: Meteora program
    pub meteora_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

impl<'info> ClosePosition<'info> {
    pub fn close(&mut self) -> Result<()> {
        // TODO: CPI to Meteora to remove liquidity
        // This will:
        // 1. Call Meteora remove_liquidity instruction
        // 2. Receive tokens back to program vaults
        // 3. Collect any accumulated fees

        // TODO: Calculate total proceeds from position
        // let total_proceeds = collateral_returned + fees_collected;

        // Repay debt to lending vault
        let debt = self.position.debt_amount;
        self.lending_vault.repay(debt)?;

        // TODO: Transfer remaining collateral back to user
        // let remaining = total_proceeds.saturating_sub(debt);
        // transfer(remaining, user);

        // Mark position as closed
        self.position.mark_closed();

        Ok(())
    }
}
