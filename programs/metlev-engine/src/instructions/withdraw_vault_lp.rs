use anchor_lang::{prelude::*, system_program::{Transfer, transfer}};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
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
        bump = lending_vault.vault_bump,
    )]
    pub lending_vault: Account<'info, LendingVault>,

    #[account(
        mut,
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

impl<'info> Withdraw<'info> {
    pub fn withdraw(&mut self) -> Result<()> {

        // TODO update this later for an algo based on the supply and demande dynamic APY
         self.lp_position.accrue_interest(
            self.lending_vault.interest_rate_bps,

            Clock::get()?.unix_timestamp
        );
        let amount = self.lp_position.claimable();


        // let rent_exempt = Rent::get()?.minimum_balance(0);
        //not sure whether it is safer to treat the WSOL as a token account and use token_vault.amount here
        // as we have used the sync_native to sync the balances
        require!(
            // self.sol_vault.get_lamports() >= amount + rent_exempt,  
            self.token_vault.amount >= amount,
            ProtocolError::InsufficientLiquidity
        );      

        self.lending_vault.total_supplied =  self.lending_vault.total_supplied
            .checked_sub(self.lp_position.supplied_amount)
            .ok_or(ProtocolError::MathUnderflow)?;

        let accounts = Transfer{
            from: self.token_vault.to_account_info(),
            to: self.signer.to_account_info()
        };

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"token_vault",
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