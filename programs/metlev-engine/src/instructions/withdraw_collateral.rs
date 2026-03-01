use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SystemTransfer};
use anchor_spl::token_interface::Mint;
use crate::state::Position;
use crate::errors::ProtocolError;

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(address = anchor_spl::token::spl_token::native_mint::id())]
    pub wsol_mint: InterfaceAccount<'info, Mint>,

    /// Position must be Closed or Liquidated before collateral can be reclaimed.
    #[account(
        mut,
        close = user,
        seeds = [Position::SEED_PREFIX, user.key().as_ref(), wsol_mint.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ ProtocolError::InvalidOwner,
        constraint = position.is_closed() @ ProtocolError::PositionStillActive,
    )]
    pub position: Account<'info, Position>,

    /// CHECK: seeds validated below.
    #[account(
        mut,
        seeds = [b"vault", user.key().as_ref(), wsol_mint.key().as_ref()],
        bump,
    )]
    pub collateral_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

impl<'info> WithdrawCollateral<'info> {
    pub fn withdraw(&mut self, bumps: &WithdrawCollateralBumps) -> Result<()> {
        let collateral = self.position.collateral_amount;

        if collateral > 0 {
            require!(
                self.collateral_vault.lamports() >= collateral,
                ProtocolError::WithdrawalFailed
            );

            self.position.collateral_amount = 0;

            let user_key       = self.user.key();
            let wsol_key       = self.wsol_mint.key();
            let vault_bump_arr = [bumps.collateral_vault];
            let vault_seeds: &[&[&[u8]]] = &[&[
                b"vault",
                user_key.as_ref(),
                wsol_key.as_ref(),
                &vault_bump_arr,
            ]];
            system_program::transfer(
                CpiContext::new_with_signer(
                    self.system_program.to_account_info(),
                    SystemTransfer {
                        from: self.collateral_vault.to_account_info(),
                        to:   self.user.to_account_info(),
                    },
                    vault_seeds,
                ),
                collateral,
            )?;
        }

        Ok(())
    }
}
