use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct MockOracle {
    pub authority: Pubkey,
    pub price: u64,
    pub decimals: u8,
    pub timestamp: i64,
    pub bump: u8,
}

impl MockOracle {
    pub const SEED_PREFIX: &'static [u8] = b"mock_oracle";
}