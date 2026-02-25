use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct LpPosition {
    /// LP provider wallet
    pub lp: Pubkey,

    /// Total SOL/TOKEN_X supplied (in lamports)
    pub supplied_amount_x: u64,

    // TOTAL TOKEN_Y
    pub supplied_amount_y: u64,

    /// Accumulated interest earned so far (in lamports)
    pub interest_earned_x: u64,

     /// Accumulated interest earned so far (in lamports)
    pub interest_earned_y: u64,

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
        let interest_x = (self.supplied_amount_x as u128)
            .saturating_mul(interest_rate_bps as u128)
            .saturating_mul(elapsed)
            / (365u128 * 24 * 3600 * 10000);

        let interest_y = (self.supplied_amount_y as u128)
            .saturating_mul(interest_rate_bps as u128)
            .saturating_mul(elapsed)
            / (365u128 * 24 * 3600 * 10000);

        self.interest_earned_x = self.interest_earned_x.saturating_add(interest_x as u64);
        self.interest_earned_y = self.interest_earned_y.saturating_add(interest_y as u64);
        self.last_update = current_time;
    }

    /// Total claimable amount (principal + accrued interest)
    pub fn claimable(&self) -> (u64,u64) {
        (self.supplied_amount_x.saturating_add(self.interest_earned_x),self.supplied_amount_y.saturating_add(self.interest_earned_y))
    }
}
