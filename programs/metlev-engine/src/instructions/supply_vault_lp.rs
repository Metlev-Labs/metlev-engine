use anchor_lang::prelude::*;
use anchor_lang::system_program::{Transfer, transfer};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface, TransferChecked, transfer_checked, sync_native, SyncNative};
use crate::state::{LendingVault};
use crate::state::LpPosition;
use crate::errors::ProtocolError;
use crate::utils::constants::*;

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
        token::mint = mint_x,
        token::authority = lending_vault,
        token::token_program = token_program,
        seeds = [b"token_x_vault"],
        bump
    )]
    pub token_x_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        token::mint = mint_y,
        token::authority = lending_vault,
        token::token_program = token_program,
        seeds = [b"token_y_vault"],
        bump
    )]
    pub token_y_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = signer,
        space = LpPosition::DISCRIMINATOR.len() + LpPosition::INIT_SPACE,
        seeds = [b"lp_position", signer.key().as_ref()],
        bump,
    )]
    pub lp_position: Account<'info, LpPosition>,
    // mint_x = NATIVE_MINT for WSOL
    pub mint_x: InterfaceAccount<'info, Mint>,
    pub mint_y: InterfaceAccount<'info, Mint>,
    ///Check: SPL token interface will check this
    pub user_x_ata: UncheckedAccount<'info>,
    ///Check: SPL token interface will check this
    pub user_y_ata: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> Supply<'info> {
    pub fn supply(&mut self, bumps: &SupplyBumps, amount_x: u64, amount_y:u64) -> Result<()> {
        let current_time = Clock::get()?.unix_timestamp;

        require_neq!(self.mint_x.key(), self.mint_y.key(), ProtocolError::PubkeyMismatch);
        require!(!(self.mint_x.key()==Pubkey::default() && self.mint_x.key()==Pubkey::default()), ProtocolError::PubkeyMismatch);

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

        self.lp_position.supplied_amount_x = self.lp_position.supplied_amount_x
            .checked_add(amount_x)
            .ok_or(ProtocolError::MathOverflow)?;

        self.lp_position.supplied_amount_y = self.lp_position.supplied_amount_y
            .checked_add(amount_y)
            .ok_or(ProtocolError::MathOverflow)?;

        self.lending_vault.total_supplied_x = self.lending_vault.total_supplied_x
            .checked_add(amount_x)
            .ok_or(ProtocolError::MathOverflow)?;
        self.lending_vault.total_supplied_y = self.lending_vault.total_supplied_y
            .checked_add(amount_y)
            .ok_or(ProtocolError::MathOverflow)?;

        let is_native_x =  self.mint_x.key() == NATIVE_MINT_ID;
        let is_native_y = self.mint_y.key() == NATIVE_MINT_ID;

        // Transfer Logic for X
        self.handle_transfer(
            is_native_x, 
            amount_x, 
            &self.user_x_ata.to_account_info(), 
            &self.token_x_vault.to_account_info(), 
            &self.mint_x
        )?;

        // Transfer Logic for Y
        self.handle_transfer(
            is_native_y, 
            amount_y, 
            &self.user_y_ata.to_account_info(), 
            &self.token_y_vault.to_account_info(), 
            &self.mint_y
        )?;

        Ok(())
        }

        //Helper Function For Handling Native & SPL transfers
        fn handle_transfer(
            &self,
            is_native:bool,
            amount: u64,
            user_token_info: &AccountInfo<'info>,
            vault_info: &AccountInfo<'info>,
            mint: &InterfaceAccount<'info, Mint>
        ) -> Result<()> {
            if amount == 0 {
                return Ok(())
            };
            if is_native {
                //Transfer Raw SOL to Vault token account
                let native_transfer_accounts = Transfer {
                    from: self.signer.to_account_info(),
                    to: vault_info.clone()
                };
                let native_transfer_ctx = CpiContext::new(self.system_program.to_account_info(), native_transfer_accounts);
                transfer(native_transfer_ctx, amount)?;
                // 2. Sync Native to wrap it instantly inside the Vault
                let sync_native_ctx = CpiContext::new(self.token_program.to_account_info(), SyncNative {
                    account: vault_info.clone()
                });
                sync_native(sync_native_ctx)?;
            
            } else {
                let spl_transfer_accounts = TransferChecked {
                    from: user_token_info.clone(),
                    to: vault_info.clone(),
                    mint: mint.to_account_info(),
                    authority: self.signer.to_account_info()
                };
                let spl_transfer_ctx = CpiContext::new(self.token_program.to_account_info(), spl_transfer_accounts);
                transfer_checked(spl_transfer_ctx, amount, mint.decimals)?;
            }
            Ok(())
        }

}
