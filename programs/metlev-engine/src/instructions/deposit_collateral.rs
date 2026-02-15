use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};
use crate::state::{Config, CollateralConfig, Position, PositionStatus};
use crate::errors::ProtocolError;

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mint::token_program = token_program
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [CollateralConfig::SEED_PREFIX, mint.key().as_ref()],
        bump = collateral_config.bump,
        constraint = collateral_config.mint == mint.key() @ ProtocolError::InvalidCollateralType,
    )]
    pub collateral_config: Account<'info, CollateralConfig>,

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

impl<'info> DepositCollateral<'info> {
    pub fn deposit(
        &mut self,
        bumps: &DepositCollateralBumps,
        amount: u64,
    ) -> Result<()> {
        require!(!self.config.paused, ProtocolError::ProtocolPaused);
        require!(
            self.collateral_config.is_enabled(),
            ProtocolError::InvalidCollateralType
        );

        require!(
            amount >= self.collateral_config.min_deposit,
            ProtocolError::InsufficientCollateral
        );

        self.position.set_inner(Position {
            owner: self.user.key(),
            collateral_mint: self.collateral_config.mint,
            collateral_amount: amount,
            debt_amount: 0,
            meteora_position: Pubkey::default(), // Will be set when opening position
            created_at: Clock::get()?.unix_timestamp,
            status: PositionStatus::Active,
            bump: bumps.position,
        });

        // TODO: Transfer collateral to vault
        // For SOL: system_program transfer
        // For tokens: token_program transfer

        Ok(())
    }
}
