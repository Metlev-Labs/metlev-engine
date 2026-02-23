use anchor_lang::{prelude::*, system_program::{Transfer, transfer}};
use crate::state::LendingVault;
use crate::state::Config;
use crate::errors::ProtocolError;

#[derive(Accounts)]
pub struct InitializeLendingVault<'info>{
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
        constraint = config.authority == authority.key() @ ProtocolError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = authority,
        space = LendingVault::DISCRIMINATOR.len() + LendingVault::INIT_SPACE,
        seeds = [LendingVault::SEED_PREFIX],
        bump,
    )]
    pub lending_vault: Account<'info, LendingVault>,

    #[account(
        mut,
        seeds = [b"sol_vault", lending_vault.key().as_ref()],
        bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

impl<'info> InitializeLendingVault<'info> {
    pub fn initialize_lending_vault(&mut self, bumps: &InitializeLendingVaultBumps) -> Result<()> {
        let rent_exempt = Rent::get()?.minimum_balance(
            self.sol_vault.to_account_info().data_len()
        );
        let accounts = Transfer {
            from: self.authority.to_account_info(),
            to: self.sol_vault.to_account_info(),
        };

        let ctx = CpiContext::new(
            self.system_program.to_account_info(),
            accounts,
        );
        transfer(ctx, rent_exempt)?;

        self.lending_vault.set_inner(LendingVault {
            authority: self.authority.key(),
            total_supplied: 0,
            total_borrowed: 0,
            interest_rate_bps: 30, // Let's update that later to be dynamic
            last_update: Clock::get()?.unix_timestamp,
            bump: bumps.lending_vault,
            vault_bump: bumps.sol_vault,
        });
        Ok(())
    }
}