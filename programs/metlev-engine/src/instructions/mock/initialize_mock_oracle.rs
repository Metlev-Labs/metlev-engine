use anchor_lang::prelude::*;
use crate::state::{MockOracle, Config};
use crate::errors::ProtocolError;

#[derive(Accounts)]
pub struct InitializeMockOracle<'info> {
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
        init,
        payer = authority,
        space = MockOracle::DISCRIMINATOR.len() + MockOracle::INIT_SPACE,
        seeds = [MockOracle::SEED_PREFIX, mint.key().as_ref()],
        bump
    )]
    pub mock_oracle: Account<'info, MockOracle>,

    pub system_program: Program<'info, System>,
}

impl<'info> InitializeMockOracle<'info> {
    pub fn initialize_mock_oracle(&mut self, bumps: &InitializeMockOracleBumps, price: u64) -> Result<()> {
        self.mock_oracle.set_inner(
            MockOracle {
                authority: self.authority.key(),
                price: price,
                decimals: 6,
                timestamp: Clock::get()?.unix_timestamp,
                bump: bumps.mock_oracle
            }
        );
        Ok(())
    }
}