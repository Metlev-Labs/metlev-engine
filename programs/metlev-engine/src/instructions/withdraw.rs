use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};
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

    #[account(address = anchor_spl::token::spl_token::native_mint::id())]
    pub wsol_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"wsol_vault", lending_vault.key().as_ref()],
        bump = lending_vault.vault_bump,
        token::mint = wsol_mint,
        token::authority = lending_vault,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = wsol_mint,
        token::authority = signer,
    )]
    pub signer_wsol_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> Withdraw<'info> {
    pub fn withdraw(&mut self) -> Result<()> {
        // TODO: update later for algo-based dynamic APY
        self.lp_position.accrue_interest(
            self.lending_vault.interest_rate_bps,
            Clock::get()?.unix_timestamp,
        );
        let amount = self.lp_position.claimable();

        require!(
            self.wsol_vault.amount >= amount,
            ProtocolError::InsufficientLiquidity
        );

        self.lending_vault.total_supplied = self.lending_vault.total_supplied
            .checked_sub(self.lp_position.supplied_amount)
            .ok_or(ProtocolError::MathUnderflow)?;

        // lending_vault PDA is the authority of wsol_vault
        let lending_vault_bump = self.lending_vault.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            LendingVault::SEED_PREFIX,
            &[lending_vault_bump],
        ]];

        let accounts = TransferChecked {
            from: self.wsol_vault.to_account_info(),
            mint: self.wsol_mint.to_account_info(),
            to: self.signer_wsol_ata.to_account_info(),
            authority: self.lending_vault.to_account_info(),
        };
        let ctx = CpiContext::new_with_signer(
            self.token_program.to_account_info(),
            accounts,
            signer_seeds,
        );
        transfer_checked(ctx, amount, self.wsol_mint.decimals)
    }
}
