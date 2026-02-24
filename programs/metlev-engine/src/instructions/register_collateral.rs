use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};
use crate::state::{Config, CollateralConfig};
use crate::errors::ProtocolError;

#[derive(Accounts)]
pub struct RegisterCollateral<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
        constraint = config.authority == authority.key() @ ProtocolError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mint::token_program = token_program
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = CollateralConfig::DISCRIMINATOR.len() + CollateralConfig::INIT_SPACE,
        seeds = [CollateralConfig::SEED_PREFIX, mint.key().as_ref()],
        bump
    )]
    pub collateral_config: Account<'info, CollateralConfig>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> RegisterCollateral<'info> {
    pub fn register(
        &mut self,
        bumps: &RegisterCollateralBumps,
        oracle: Pubkey,
        max_ltv: u16,
        liquidation_threshold: u16,
        liquidation_penalty: u16,
        min_deposit: u64,
        interest_rate_bps: u16,
        oracle_max_age: u64,
    ) -> Result<()> {
        require!(
            liquidation_threshold > max_ltv,
            ProtocolError::InvalidLiquidationThreshold
        );
        require!(
            liquidation_penalty <= 2000, // Max 20%
            ProtocolError::InvalidAmount
        );

        self.collateral_config.set_inner(CollateralConfig {
            mint: self.mint.key(),
            oracle,
            max_ltv,
            liquidation_threshold,
            liquidation_penalty,
            min_deposit,
            interest_rate_bps,
            oracle_max_age,
            decimals: self.mint.decimals,
            enabled: true,
            bump: bumps.collateral_config,
        });

        Ok(())
    }
}
