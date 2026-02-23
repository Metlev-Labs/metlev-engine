use anchor_lang::{
    prelude::*,
    system_program::{
        transfer,
        Transfer
    }
};
use crate::state::{LendingVault, lending_vault};
use crate::state::LpPosition;

#[derive(Accounts)]
pub struct Supply<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [LendingVault::SEED_PREFIX],
        bump = lending_vault.bump
    )]
    pub lending_vault: Account<'info, LendingVault>,

    pub system_program: Program<'info, System>,
}

impl<'info> Supply<'info> {
    pub fn supply(&mut self, amount: u64) -> Result<()> {

        // Transfer SOL to vault
        let accounts = Transfer {
            from: self.signer.to_account_info(),
            to: self.lending_vault.to_account_info()
        };

        let ctx = CpiContext::new(
            self.system_program.to_account_info(),
            accounts,
        );

        transfer(ctx, amount)?;
        // track LP position of the user who supply
        Ok(())
    }
}