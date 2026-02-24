use anchor_lang::prelude::*;
use crate::state::{MockOracle, Config};
use crate::errors::ProtocolError;

#[derive(Accounts)]
pub struct UpdateMockOracle<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
        constraint = config.authority == authority.key() @ ProtocolError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    /// CHECK: used only as PDA seed
    pub mint: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [MockOracle::SEED_PREFIX, mint.key().as_ref()],
        bump = mock_oracle.bump
    )]
    pub mock_oracle: Account<'info, MockOracle>,
}

impl<'info> UpdateMockOracle<'info> {
    pub fn update_mock_oracle(&mut self, price: u64) -> Result<()> {
        self.mock_oracle.price = price;
        self.mock_oracle.timestamp = Clock::get()?.unix_timestamp;
        Ok(())
    }
}
