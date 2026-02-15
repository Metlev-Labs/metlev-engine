use anchor_lang::prelude::*;
use crate::state::{Config, CollateralConfig};
use crate::errors::ProtocolError;

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
        constraint = config.authority == authority.key() @ ProtocolError::Unauthorized,
    )]
    pub config: Account<'info, Config>,
}

impl<'info> UpdateConfig<'info> {
    pub fn update_pause_state(&mut self, paused: bool) -> Result<()> {
        self.config.paused = paused;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(mint: Pubkey)]
pub struct UpdateCollateralConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
        constraint = config.authority == authority.key() @ ProtocolError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [CollateralConfig::SEED_PREFIX, mint.as_ref()],
        bump = collateral_config.bump,
    )]
    pub collateral_config: Account<'info, CollateralConfig>,
}

impl<'info> UpdateCollateralConfig<'info> {
    pub fn update_enabled(&mut self, enabled: bool) -> Result<()> {
        self.collateral_config.enabled = enabled;
        Ok(())
    }

    pub fn update_ltv_params(
        &mut self,
        max_ltv: Option<u16>,
        liquidation_threshold: Option<u16>,
    ) -> Result<()> {
        if let Some(ltv) = max_ltv {
            self.collateral_config.max_ltv = ltv;
        }

        if let Some(threshold) = liquidation_threshold {
            self.collateral_config.liquidation_threshold = threshold;
        }

        // Validate thresholds
        require!(
            self.collateral_config.validate_thresholds(),
            ProtocolError::InvalidLiquidationThreshold
        );

        Ok(())
    }

    pub fn update_liquidation_penalty(&mut self, penalty: u16) -> Result<()> {
        require!(penalty <= 2000, ProtocolError::InvalidAmount); // Max 20%
        self.collateral_config.liquidation_penalty = penalty;
        Ok(())
    }

    pub fn update_min_deposit(&mut self, min_deposit: u64) -> Result<()> {
        self.collateral_config.min_deposit = min_deposit;
        Ok(())
    }
}
