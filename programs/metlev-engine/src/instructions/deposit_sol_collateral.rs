use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SystemTransfer};
use anchor_spl::token_interface::{Mint, TokenInterface};
use crate::state::{Config, CollateralConfig, Position, PositionStatus};
use crate::errors::ProtocolError;

#[derive(Accounts)]
pub struct DepositSolCollateral<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mint::token_program = token_program,
        constraint = mint.key() == anchor_spl::token::spl_token::native_mint::id() @ ProtocolError::InvalidCollateralType,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [CollateralConfig::SEED_PREFIX, mint.key().as_ref()],
        bump = collateral_config.bump,
        constraint = collateral_config.mint == mint.key() @ ProtocolError::InvalidCollateralType,
        constraint = collateral_config.enabled @ ProtocolError::InvalidCollateralType,
    )]
    pub collateral_config: Account<'info, CollateralConfig>,

    /// CHECK: PDA validated by seeds
    #[account(
        mut,
        seeds = [b"vault", user.key().as_ref(), mint.key().as_ref()],
        bump,
    )]
    pub vault: UncheckedAccount<'info>,

    #[account(
        init,
        payer = user,
        space = Position::DISCRIMINATOR.len() + Position::INIT_SPACE,
        seeds = [Position::SEED_PREFIX, user.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

impl<'info> DepositSolCollateral<'info> {
    pub fn deposit(
        &mut self,
        bumps: &DepositSolCollateralBumps,
        amount: u64,
    ) -> Result<()> {
        require!(!self.config.paused, ProtocolError::ProtocolPaused);

        require!(
            amount >= self.collateral_config.min_deposit,
            ProtocolError::InsufficientCollateral
        );

        self.position.set_inner(Position {
            owner: self.user.key(),
            collateral_mint: self.collateral_config.mint,
            collateral_amount: amount,
            debt_amount: 0,
            meteora_position: Pubkey::default(),
            created_at: Clock::get()?.unix_timestamp,
            status: PositionStatus::Active,
            bump: bumps.position,
        });

        let cpi_program = self.system_program.to_account_info();
        let cpi_accounts = SystemTransfer {
            from: self.user.to_account_info(),
            to: self.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        system_program::transfer(cpi_ctx, amount)?;

        Ok(())
    }
}
