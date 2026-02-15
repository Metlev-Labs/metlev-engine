use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

impl Config {
    pub const SEED_PREFIX: &'static [u8] = b"config";

    pub fn is_paused(&self) -> bool {
        self.paused
    }
}

#[account]
#[derive(InitSpace)]
pub struct CollateralConfig {
    /// Collateral token mint (e.g., SOL mint, USDC mint)
    pub mint: Pubkey,

    /// Price oracle account (Pyth/Switchboard)
    pub oracle: Pubkey,

    /// Maximum loan-to-value ratio (basis points, 7500 = 75%)
    pub max_ltv: u16,

    /// Liquidation threshold (basis points, 8000 = 80%)
    pub liquidation_threshold: u16,

    /// Liquidation penalty paid to liquidator (basis points, 500 = 5%)
    pub liquidation_penalty: u16,

    /// Minimum deposit amount (in native token units)
    pub min_deposit: u64,

    /// Interest rate for borrowing (basis points per year, 500 = 5%)
    pub interest_rate_bps: u16,

    /// Maximum oracle staleness in seconds
    pub oracle_max_age: u64,

    /// Whether this collateral is enabled
    pub enabled: bool,

    /// Bump seed for PDA
    pub bump: u8,
}

impl CollateralConfig {
    pub const SEED_PREFIX: &'static [u8] = b"collateral_config";

    pub fn validate_ltv(&self, ltv: u64) -> bool {
        ltv <= self.max_ltv as u64
    }

    pub fn is_liquidatable(&self, ltv: u64) -> bool {
        ltv >= self.liquidation_threshold as u64
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn validate_thresholds(&self) -> bool {
        self.liquidation_threshold > self.max_ltv
    }
}
