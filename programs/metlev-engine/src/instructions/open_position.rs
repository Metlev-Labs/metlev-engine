use anchor_lang::prelude::*;
use crate::state::{Config, Position, LendingVault};
use crate::errors::ProtocolError;

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
        bump = lending_vault.vault_bump,
    )]
    pub lending_vault: Account<'info, LendingVault>,

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

        // TODO: Implement position health check
        // let ltv = calculate_ltv(collateral_value, debt_value);
        // require!(self.config.validate_ltv(ltv), ProtocolError::ExceedsMaxLTV);

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
