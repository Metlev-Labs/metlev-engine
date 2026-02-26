use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct LpPosition {
    /// LP provider wallet
    pub lp: Pubkey,

    /// Total SOL/TOKEN supplied (in lamports)
    pub supplied_amount: u64,

    /// Accumulated interest earned so far (in lamports)
    pub interest_earned: u64,

    /// Last time interest was accrued (unix timestamp)
    pub last_update: i64,

    /// Bump seed for PDA
    pub bump: u8,
}

impl LpPosition {
    pub const SEED_PREFIX: &'static [u8] = b"lp_position";

    /// Accrue simple annual interest based on elapsed time and update state.
    /// interest = principal * rate_bps * elapsed_seconds / (365 * 24 * 3600 * 10000)
    /// Interest Rate Same for Token_x and Token_Y
    pub fn accrue_interest(&mut self, interest_rate_bps: u16, current_time: i64) {
        let elapsed = (current_time - self.last_update).max(0) as u128;
        let interest = (self.supplied_amount as u128)
            .saturating_mul(interest_rate_bps as u128)
            .saturating_mul(elapsed)
            / (365u128 * 24 * 3600 * 10000);

        self.interest_earned = self.interest_earned.saturating_add(interest as u64);
        self.last_update = current_time;
    }

    /// Total claimable amount (principal + accrued interest)
    pub fn claimable(&self) -> u64 {
        self.supplied_amount.saturating_add(self.interest_earned)
    }
}
