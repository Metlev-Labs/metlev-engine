use anchor_lang::prelude::*;
use crate::state::LendingVault;

#[derive(Accounts)]
pub struct InitializeLendingVault<'info>{
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = LendingVault::DISCRIMINATOR.len() + LendingVault::INIT_SPACE,
        seeds = [LendingVault::SEED_PREFIX],
        bump,
    )]
    pub lending_vault: Account<'info, LendingVault>,

    pub system_program: Program<'info, System>,
}

impl<'info> InitializeLendingVault<'info> {
    pub fn initialize_lending_vault(&mut self, bumps: &InitializeLendingVaultBumps) -> Result<()> {
        self.lending_vault.set_inner(LendingVault {
            authority: self.authority.key(),
            total_supplied: 0,
            total_borrowed: 0,
            interest_rate_bps: 30, // Let's update that later to be dynamic
            last_update: Clock::get()?.unix_timestamp,
            bump: bumps.lending_vault
        });
        Ok(())
    }
}