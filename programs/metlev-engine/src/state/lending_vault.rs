use anchor_lang::prelude::*;

/// Mock lending vault for POC
#[account]
#[derive(InitSpace)]
pub struct LendingVault {
    /// Vault authority (program PDA)
    pub authority: Pubkey,
    pub total_supplied_x: u64,
    pub total_supplied_y:u64,
    pub total_borrowed_x: u64,
    pub total_borrowed_y: u64,
    /// Simple interest rate (basis points per year, 500 = 5%)
    /// MVP:: interest rate same for both X & Y
    pub interest_rate_bps: u16,
    /// Last time interest was accrued
    pub last_update: i64,
    pub vault_bump: u8,
    pub x_vault_bump: u8,
    pub y_vault_bump: u8,
}

impl LendingVault {
    pub const SEED_PREFIX: &'static [u8] = b"lending_vault";

    /// Get available liquidity to borrow
    pub fn available_liquidity(&self) -> u64 {
        self.total_supplied.saturating_sub(self.total_borrowed)
    }

    /// Check if vault has enough liquidity for borrow amount
    pub fn can_borrow(&self, amount: u64) -> bool {
        self.available_liquidity() >= amount
    }

    pub fn borrow(&mut self, amount: u64) -> Result<()> {
        require!(self.can_borrow(amount), crate::errors::ProtocolError::InsufficientLiquidity);
        self.total_borrowed = self.total_borrowed.checked_add(amount)
            .ok_or(crate::errors::ProtocolError::MathOverflow)?;
        Ok(())
    }

    /// Record debt repayment
    pub fn repay(&mut self, amount: u64) -> Result<()> {
        self.total_borrowed = self.total_borrowed.checked_sub(amount)
            .ok_or(crate::errors::ProtocolError::MathOverflow)?;
        Ok(())
    }
}
