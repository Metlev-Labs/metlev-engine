use anchor_lang::{prelude::*, system_program::{Transfer, transfer}};

use crate::state::{LpPosition, LendingVault};
use crate::errors::ProtocolError;

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        close = signer,
        seeds = [LpPosition::SEED_PREFIX, signer.key().as_ref()],
        bump = lp_position.bump,
        constraint = lp_position.lp == signer.key() @ ProtocolError::InvalidOwner,
    )]
    pub lp_position: Account<'info, LpPosition>,

    #[account(
        mut,
        seeds = [LendingVault::SEED_PREFIX],
        bump = lending_vault.bump,
    )]
    pub lending_vault: Account<'info, LendingVault>,

    #[account(
        mut,
        seeds = [b"sol_vault", lending_vault.key().as_ref()],
        bump = lending_vault.vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,

}

impl<'info> Withdraw<'info> {
    pub fn withdraw(&mut self) -> Result<()> {

        // TODO update this later for an algo based on the supply and demande dynamic APY
         self.lp_position.accrue_interest(
            self.lending_vault.interest_rate_bps,

            Clock::get()?.unix_timestamp
        );
        let amount = self.lp_position.claimable();


        let rent_exempt = Rent::get()?.minimum_balance(0);
        require!(
            self.sol_vault.get_lamports() >= amount + rent_exempt,
            ProtocolError::InsufficientLiquidity
        );

        self.lending_vault.total_supplied =  self.lending_vault.total_supplied
            .checked_sub(self.lp_position.supplied_amount)
            .ok_or(ProtocolError::MathUnderflow)?;

        let accounts = Transfer{
            from: self.sol_vault.to_account_info(),
            to: self.signer.to_account_info()
        };
        let lending_vault_key = self.lending_vault.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"sol_vault",
            lending_vault_key.as_ref(),
            &[self.lending_vault.vault_bump],
            ]
        ];
        let ctx = CpiContext::new_with_signer(
            self.system_program.to_account_info(),
            accounts,
            signer_seeds
        );

        transfer(ctx, amount)
    }
}