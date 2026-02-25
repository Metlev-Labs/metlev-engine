use anchor_lang::{
    prelude::*,
    system_program::{
        transfer,
        Transfer
    }
};
use crate::state::{LendingVault};
use crate::state::LpPosition;
use crate::errors::ProtocolError;

#[derive(Accounts)]
pub struct Supply<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [LendingVault::SEED_PREFIX],
        bump = lending_vault.vault_bump
    )]
    pub lending_vault: Account<'info, LendingVault>,

    #[account(
        mut,
        seeds = [b"sol_vault", lending_vault.key().as_ref()],
        bump = lending_vault.vault_bump
    )]
    pub sol_vault: SystemAccount<'info>,

    #[account(
        init_if_needed,
        payer = signer,
        space = LpPosition::DISCRIMINATOR.len() + LpPosition::INIT_SPACE,
        seeds = [b"lp_position", signer.key().as_ref()],
        bump,
    )]
    pub lp_position: Account<'info, LpPosition>,

    pub system_program: Program<'info, System>,
}

impl<'info> Supply<'info> {
    pub fn supply(&mut self, bumps: &SupplyBumps, amount: u64) -> Result<()> {
        let current_time = Clock::get()?.unix_timestamp;

        if self.lp_position.lp == Pubkey::default() {
            self.lp_position.lp = self.signer.key();
            self.lp_position.last_update = current_time;
            self.lp_position.bump = bumps.lp_position;
        } else {
            self.lp_position.accrue_interest(
                self.lending_vault.interest_rate_bps,
                current_time,
            );
        }

        self.lp_position.supplied_amount = self.lp_position.supplied_amount
            .checked_add(amount)
            .ok_or(ProtocolError::MathOverflow)?;

        self.lending_vault.total_supplied = self.lending_vault.total_supplied
            .checked_add(amount)
            .ok_or(ProtocolError::MathOverflow)?;

        let accounts = Transfer {
            from: self.signer.to_account_info(),
            to: self.sol_vault.to_account_info()
        };

        let ctx = CpiContext::new(
            self.system_program.to_account_info(),
            accounts,
        );

        transfer(ctx, amount)
    }
}