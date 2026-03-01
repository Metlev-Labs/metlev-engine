use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum PositionStatus {
    Active,
    Closed,
    Liquidated,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    /// Position owner
    pub owner: Pubkey,

    /// Collateral token mint
    pub collateral_mint: Pubkey,

    /// Amount of collateral deposited (in native token units)
    pub collateral_amount: u64,

    /// Amount of debt borrowed (in USDC, 6 decimals)
    pub debt_amount: u64,

    /// Meteora DLMM position reference (position pubkey or ID)
    pub meteora_position: Pubkey,

    /// Timestamp when position was created
    pub created_at: i64,

    /// Position status
    pub status: PositionStatus,

    /// Bump seed for PDA
    pub bump: u8,
}

impl Position {
    pub const SEED_PREFIX: &'static [u8] = b"position";

    pub fn is_active(&self) -> bool {
        matches!(self.status, PositionStatus::Active)
    }

    pub fn is_closed(&self) -> bool {
        matches!(self.status, PositionStatus::Closed | PositionStatus::Liquidated)
    }

    pub fn mark_closed(&mut self) {
        self.status = PositionStatus::Closed;
    }

    pub fn mark_liquidated(&mut self) {
        self.status = PositionStatus::Liquidated;
    }
}
