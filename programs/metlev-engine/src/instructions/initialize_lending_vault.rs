use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
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
        init,
        payer = authority,
        token::mint = mint_x,
        token::authority = lending_vault,
        token::token_program = token_program,
        seeds = [b"token_vault"],
        bump
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,

    // mint_x = NATIVE_MINT for WSOL
    pub mint_x: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
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
            vault_bump: bumps.lending_vault,
            token_vault_bump: bumps.token_vault,    
        });
        Ok(())
    }
}