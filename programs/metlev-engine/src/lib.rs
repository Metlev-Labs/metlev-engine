use anchor_lang::prelude::*;

mod state;
mod instructions;
mod errors;
mod utils;

use instructions::*;

declare_id!("3hiGnNihh2eACtAU3d45cT6unWgwtPLsqKUmZE5kYma3");

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

    pub fn deposit_collateral(
        ctx: Context<DepositCollateral>,
        amount: u64,
    ) -> Result<()> {
        ctx.accounts.deposit(&ctx.bumps, amount)
    }

    pub fn open_position(
        ctx: Context<OpenPosition>,
        leverage: u64,
    ) -> Result<()> {
        ctx.accounts.open(leverage)
    }

    pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
        ctx.accounts.close()
    }

    pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
        ctx.accounts.liquidate()
    }

    pub fn update_pause_state(
        ctx: Context<UpdateConfig>,
        paused: bool,
    ) -> Result<()> {
        ctx.accounts.update_pause_state(paused)
    }
}
