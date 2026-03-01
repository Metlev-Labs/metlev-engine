#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;

mod state;
mod instructions;
mod errors;
mod utils;

use instructions::*;

declare_id!("6ySvjJb41GBCBbtVvmaCd7cQUuzWFtqZ1SA931rEuSSx");
declare_program!(dlmm);

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

    /// Modified to include all DLMM and leverage parameters
    pub fn open_position(
        ctx: Context<OpenPosition>,
        leverage: u64,
        lower_bin_id: i32,
        width: i32,
        active_id: i32,
        max_active_bin_slippage: i32,
        bin_liquidity_dist: Vec<dlmm::types::BinLiquidityDistributionByWeight>,
    ) -> Result<()> {
        ctx.accounts.open(
            leverage,
            lower_bin_id,
            width,
            active_id,
            max_active_bin_slippage,
            bin_liquidity_dist,
        )
    }

    pub fn close_position(
        ctx: Context<ClosePosition>,
        from_bin_id: i32,
        to_bin_id: i32,
    ) -> Result<()> {
        // ctx.accounts.close(from_bin_id, to_bin_id)
        Ok(())
    }

    pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>) -> Result<()> {
        ctx.accounts.withdraw(&ctx.bumps)
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

    pub fn update_collateral_oracle(
        ctx: Context<UpdateCollateralConfig>,
        _mint: Pubkey,
        oracle: Pubkey,
    ) -> Result<()> {
        ctx.accounts.update_oracle(oracle)
    }

    pub fn initialize_mock_oracle(
        ctx: Context<InitializeMockOracle>,
        price: u64,
    ) -> Result<()> {
        ctx.accounts.initialize_mock_oracle(&ctx.bumps, price)
    }

    pub fn update_mock_oracle(
        ctx: Context<UpdateMockOracle>,
        price: u64,
    ) -> Result<()> {
        ctx.accounts.update_mock_oracle(price)
    }
}