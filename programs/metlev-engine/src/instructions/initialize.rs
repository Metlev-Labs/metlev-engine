use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = Config::DISCRIMINATOR.len() + Config::INIT_SPACE,
        seeds = [Config::SEED_PREFIX],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = authority,
        space = LendingVault::DISCRIMINATOR.len()+LendingVault::INIT_SPACE,
        seeds = [b"collateral_vault", mint.key().as_ref()],
        bump
    )]
    pub lending_vault: Account<'info, LendingVault>,

    

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> Initialize<'info> {
    pub fn initialize(&mut self, bumps: &InitializeBumps) -> Result<()> {

        // Setting protocol Config
        self.config.set_inner(Config {
            authority: self.authority.key(),
            paused: false,
            bump: bumps.config,
        });

        // Setting Lending Vault parameters
        self.lending_vault.set_inner(LendingVault {
            authority: self.authority.key(),
            total_supplied: 0,
            total_borrowed: 0,
            interest_rate_bps:350, // 3.5% in basis points
            last_update:Clock::get()?.unix_timestamp,
            bump:bumps.lending_vault,
        });

        Ok(())
    }
}
