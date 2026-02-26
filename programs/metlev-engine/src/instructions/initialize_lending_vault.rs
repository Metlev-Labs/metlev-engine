use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::state::{LendingVault, Config};
use crate::errors::ProtocolError;

#[derive(Accounts)]
pub struct InitializeLendingVault<'info> {
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

    #[account(address = anchor_spl::token::spl_token::native_mint::id())]
    pub wsol_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = wsol_mint,
        token::authority = lending_vault,
        seeds = [b"wsol_vault", lending_vault.key().as_ref()],
        bump,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> InitializeLendingVault<'info> {
    pub fn initialize_lending_vault(&mut self, bumps: &InitializeLendingVaultBumps) -> Result<()> {
        self.lending_vault.set_inner(LendingVault {
            authority: self.authority.key(),
            total_supplied: 0,
            total_borrowed: 0,
            interest_rate_bps: 30,
            last_update: Clock::get()?.unix_timestamp,
            bump: bumps.lending_vault,
            vault_bump: bumps.wsol_vault,
        });
        Ok(())
    }
}
