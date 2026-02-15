use anchor_lang::prelude::*;

mod state;
mod instructions;
mod errors;
mod utils;

use instructions::*;

declare_id!("9viJvWnSPMgBibr2edQM6nHwZTmUHy8JC8AKAbEcko8w");

#[program]
pub mod metlev_engine {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.initialize(&ctx.bumps)
    }

    pub fn register_collateral(
        ctx: Context<RegisterCollateral>,
        oracle: Pubkey,
        max_ltv: u16,
        liquidation_threshold: u16,
        liquidation_penalty: u16,
        min_deposit: u64,
        interest_rate_bps: u16,
        oracle_max_age: u64,
    ) -> Result<()> {
        ctx.accounts.register(
            &ctx.bumps,
            oracle,
            max_ltv,
            liquidation_threshold,
            liquidation_penalty,
            min_deposit,
            interest_rate_bps,
            oracle_max_age,
        )
    }


}
