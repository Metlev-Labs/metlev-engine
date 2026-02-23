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

    pub fn initialize_lending_vault(ctx: Context<InitializeLendingVault>) -> Result<()> {
        ctx.accounts.initialize_lending_vault(&ctx.bumps)
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

    pub fn deposit_sol_collateral(
        ctx: Context<DepositSolCollateral>,
        amount: u64,
    ) -> Result<()> {
        ctx.accounts.deposit(&ctx.bumps, amount)
    }

    pub fn deposit_token_collateral(
        ctx: Context<DepositTokenCollateral>,
        amount: u64,
    ) -> Result<()> {
        ctx.accounts.deposit(&ctx.bumps, amount)
    }
    pub fn supply(
        ctx: Context<Supply>,
        amount: u64,
    ) -> Result<()> {
        ctx.accounts.supply(&ctx.bumps, amount)
    }

    pub fn withdraw(
        ctx: Context<Withdraw>,
    ) -> Result<()> {
        ctx.accounts.withdraw()
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

    pub fn update_collateral_enabled(
        ctx: Context<UpdateCollateralConfig>,
        _mint: Pubkey,
        enabled: bool,
    ) -> Result<()> {
        ctx.accounts.update_enabled(enabled)
    }

    pub fn update_collateral_ltv_params(
        ctx: Context<UpdateCollateralConfig>,
        _mint: Pubkey,
        max_ltv: Option<u16>,
        liquidation_threshold: Option<u16>,
    ) -> Result<()> {
        ctx.accounts.update_ltv_params(max_ltv, liquidation_threshold)
    }

    pub fn update_collateral_liquidation_penalty(
        ctx: Context<UpdateCollateralConfig>,
        _mint: Pubkey,
        penalty: u16,
    ) -> Result<()> {
        ctx.accounts.update_liquidation_penalty(penalty)
    }

    pub fn update_collateral_min_deposit(
        ctx: Context<UpdateCollateralConfig>,
        _mint: Pubkey,
        min_deposit: u64,
    ) -> Result<()> {
        ctx.accounts.update_min_deposit(min_deposit)
    }
}
