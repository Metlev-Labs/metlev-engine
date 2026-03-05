use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SystemTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::state::{Config, Position, LendingVault, CollateralConfig};
use crate::errors::ProtocolError;
use crate::utils::{read_oracle_price, calculate_collateral_value, calculate_ltv, calculate_liquidation_penalty};
use crate::dlmm;

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(mut)]
    pub liquidator: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(address = anchor_spl::token::spl_token::native_mint::id())]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [Position::SEED_PREFIX, position.owner.key().as_ref(), wsol_mint.key().as_ref()],
        bump = position.bump,
        constraint = position.is_active() @ ProtocolError::PositionNotActive,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        mut,
        seeds = [LendingVault::SEED_PREFIX],
        bump = lending_vault.bump,
    )]
    pub lending_vault: Box<Account<'info, LendingVault>>,

    #[account(
        seeds = [CollateralConfig::SEED_PREFIX, wsol_mint.key().as_ref()],
        bump = collateral_config.bump,
    )]
    pub collateral_config: Box<Account<'info, CollateralConfig>>,

    /// CHECK: verified via collateral_config.oracle constraint
    #[account(
        constraint = price_oracle.key() == collateral_config.oracle @ ProtocolError::OraclePriceUnavailable,
    )]
    pub price_oracle: UncheckedAccount<'info>,

    /// Receives the wSOL proceeds (token Y) from DLMM remove_liquidity / swap.
    #[account(
        mut,
        seeds = [b"wsol_vault", lending_vault.key().as_ref()],
        bump = lending_vault.vault_bump,
        token::mint = wsol_mint,
        token::authority = lending_vault,
    )]
    pub wsol_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Position owner to receive remaining collateral.
    #[account(
        mut,
        constraint = position_owner.key() == position.owner @ ProtocolError::InvalidOwner,
    )]
    pub position_owner: UncheckedAccount<'info>,

    /// User's collateral vault — holds native SOL.
    /// CHECK: PDA validated by seeds.
    #[account(
        mut,
        seeds = [b"vault", position.owner.key().as_ref(), wsol_mint.key().as_ref()],
        bump,
    )]
    pub collateral_vault: UncheckedAccount<'info>,

    // ── DLMM accounts ──
    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub met_position: UncheckedAccount<'info>,

    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,

    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub bin_array_bitmap_extension: Option<UncheckedAccount<'info>>,

    /// Lending vault's token X ATA — created if it doesn't exist yet.
    #[account(
        init_if_needed,
        payer = liquidator,
        associated_token::mint = token_x_mint,
        associated_token::authority = lending_vault,
        associated_token::token_program = token_program,
    )]
    pub user_token_x: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,

    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,

    pub token_x_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Verified by the DLMM program.
    pub token_y_mint: UncheckedAccount<'info>,

    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub bin_array_lower: UncheckedAccount<'info>,

    /// CHECK: Verified by the DLMM program.
    #[account(mut)]
    pub bin_array_upper: UncheckedAccount<'info>,

    /// CHECK: Pool TWAP oracle — required by DLMM swap.
    #[account(mut)]
    pub oracle: UncheckedAccount<'info>,

    /// CHECK: Verified by the DLMM program.
    pub event_authority: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    pub associated_token_program: Program<'info, AssociatedToken>,

    /// CHECK: Address constrained to dlmm::ID.
    #[account(address = dlmm::ID)]
    pub dlmm_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

impl<'info> Liquidate<'info> {
    pub fn liquidate(
        &mut self,
        bumps: &LiquidateBumps,
        from_bin_id: i32,
        to_bin_id: i32,
    ) -> Result<()> {
        let oracle_info = self.price_oracle.to_account_info();
        let (price, _) = read_oracle_price(&oracle_info, self.collateral_config.oracle_max_age)?;

        let collateral_value = calculate_collateral_value(
            self.position.collateral_amount,
            price,
            self.collateral_config.decimals,
        )?;
        let debt_value = calculate_collateral_value(
            self.position.debt_amount,
            price,
            self.collateral_config.decimals,
        )?;
        // LTV = debt / (collateral + debt) — same formula as open_position
        let total_value = collateral_value
            .checked_add(debt_value)
            .ok_or(ProtocolError::MathOverflow)?;
        let ltv = calculate_ltv(total_value, debt_value)?;
        require!(
            self.collateral_config.is_liquidatable(ltv),
            ProtocolError::PositionHealthy
        );

        // Remove DLMM liquidity
        let vault_bump = self.lending_vault.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[LendingVault::SEED_PREFIX, &[vault_bump]]];
        let debt = self.position.debt_amount;

        let vault_before = self.wsol_vault.amount;

        self.cpi_remove_liquidity(signer_seeds, from_bin_id, to_bin_id)?;
        self.cpi_claim_fee(signer_seeds)?;

        self.user_token_x.reload()?;
        let x_balance = self.user_token_x.amount;
        if x_balance > 0 {
            self.cpi_swap(signer_seeds, x_balance)?;
        }

        self.cpi_close_position(signer_seeds)?;

        // Repay debt from LP proceeds
        self.wsol_vault.reload()?;
        let vault_after = self.wsol_vault.amount;
        let proceeds = vault_after.saturating_sub(vault_before);

        if proceeds >= debt {
            self.lending_vault.repay(debt)?;
        } else if proceeds > 0 {
            // Bad debt: repay whatever we can, vault absorbs the loss.
            self.lending_vault.repay(proceeds)?;
        }

        // Distribute collateral: penalty to liquidator, remainder to owner
        let collateral = self.position.collateral_amount;
        if collateral > 0 {
            let penalty = calculate_liquidation_penalty(
                collateral,
                self.collateral_config.liquidation_penalty,
            )?;
            let remainder = collateral
                .checked_sub(penalty)
                .ok_or(ProtocolError::MathOverflow)?;

            let owner_key = self.position.owner;
            let mint_key = self.wsol_mint.key();
            let vault_bump_arr = [bumps.collateral_vault];
            let collateral_seeds: &[&[&[u8]]] = &[&[
                b"vault",
                owner_key.as_ref(),
                mint_key.as_ref(),
                &vault_bump_arr,
            ]];

            if penalty > 0 {
                self.transfer_collateral(collateral_seeds, self.liquidator.to_account_info(), penalty)?;
            }
            if remainder > 0 {
                self.transfer_collateral(collateral_seeds, self.position_owner.to_account_info(), remainder)?;
            }
        }

        self.position.debt_amount = 0;
        self.position.collateral_amount = 0;
        self.position.mark_liquidated();
        Ok(())
    }

    #[inline(never)]
    fn cpi_remove_liquidity(
        &self,
        signer_seeds: &[&[&[u8]]],
        from_bin_id: i32,
        to_bin_id: i32,
    ) -> Result<()> {
        let ctx = CpiContext::new_with_signer(
            self.dlmm_program.to_account_info(),
            dlmm::cpi::accounts::RemoveLiquidityByRange {
                position:                   self.met_position.to_account_info(),
                lb_pair:                    self.lb_pair.to_account_info(),
                bin_array_bitmap_extension: self
                    .bin_array_bitmap_extension
                    .as_ref()
                    .map(|a| a.to_account_info()),
                user_token_x:    self.user_token_x.to_account_info(),
                user_token_y:    self.wsol_vault.to_account_info(),
                reserve_x:       self.reserve_x.to_account_info(),
                reserve_y:       self.reserve_y.to_account_info(),
                token_x_mint:    self.token_x_mint.to_account_info(),
                token_y_mint:    self.token_y_mint.to_account_info(),
                bin_array_lower: self.bin_array_lower.to_account_info(),
                bin_array_upper: self.bin_array_upper.to_account_info(),
                sender:          self.lending_vault.to_account_info(),
                token_x_program: self.token_program.to_account_info(),
                token_y_program: self.token_program.to_account_info(),
                event_authority: self.event_authority.to_account_info(),
                program:         self.dlmm_program.to_account_info(),
            },
            signer_seeds,
        );
        dlmm::cpi::remove_liquidity_by_range(ctx, from_bin_id, to_bin_id, 10_000)
    }

    #[inline(never)]
    fn cpi_claim_fee(&self, signer_seeds: &[&[&[u8]]]) -> Result<()> {
        let ctx = CpiContext::new_with_signer(
            self.dlmm_program.to_account_info(),
            dlmm::cpi::accounts::ClaimFee {
                lb_pair:         self.lb_pair.to_account_info(),
                position:        self.met_position.to_account_info(),
                bin_array_lower: self.bin_array_lower.to_account_info(),
                bin_array_upper: self.bin_array_upper.to_account_info(),
                sender:          self.lending_vault.to_account_info(),
                reserve_x:       self.reserve_x.to_account_info(),
                reserve_y:       self.reserve_y.to_account_info(),
                user_token_x:    self.user_token_x.to_account_info(),
                user_token_y:    self.wsol_vault.to_account_info(),
                token_x_mint:    self.token_x_mint.to_account_info(),
                token_y_mint:    self.token_y_mint.to_account_info(),
                token_program:   self.token_program.to_account_info(),
                event_authority: self.event_authority.to_account_info(),
                program:         self.dlmm_program.to_account_info(),
            },
            signer_seeds,
        );
        dlmm::cpi::claim_fee(ctx)
    }

    #[inline(never)]
    fn cpi_swap(&self, signer_seeds: &[&[&[u8]]], amount: u64) -> Result<()> {
        let ctx = CpiContext::new_with_signer(
            self.dlmm_program.to_account_info(),
            dlmm::cpi::accounts::Swap {
                lb_pair:                    self.lb_pair.to_account_info(),
                bin_array_bitmap_extension: self
                    .bin_array_bitmap_extension
                    .as_ref()
                    .map(|a| a.to_account_info()),
                reserve_x:       self.reserve_x.to_account_info(),
                reserve_y:       self.reserve_y.to_account_info(),
                user_token_in:   self.user_token_x.to_account_info(),
                user_token_out:  self.wsol_vault.to_account_info(),
                token_x_mint:    self.token_x_mint.to_account_info(),
                token_y_mint:    self.token_y_mint.to_account_info(),
                oracle:          self.oracle.to_account_info(),
                host_fee_in:     None,
                user:            self.lending_vault.to_account_info(),
                token_x_program: self.token_program.to_account_info(),
                token_y_program: self.token_program.to_account_info(),
                event_authority: self.event_authority.to_account_info(),
                program:         self.dlmm_program.to_account_info(),
            },
            signer_seeds,
        )
        .with_remaining_accounts(vec![
            self.bin_array_lower.to_account_info(),
            self.bin_array_upper.to_account_info(),
        ]);
        dlmm::cpi::swap(ctx, amount, 0)
    }

    #[inline(never)]
    fn cpi_close_position(&self, signer_seeds: &[&[&[u8]]]) -> Result<()> {
        let ctx = CpiContext::new_with_signer(
            self.dlmm_program.to_account_info(),
            dlmm::cpi::accounts::ClosePosition {
                position:        self.met_position.to_account_info(),
                lb_pair:         self.lb_pair.to_account_info(),
                bin_array_lower: self.bin_array_lower.to_account_info(),
                bin_array_upper: self.bin_array_upper.to_account_info(),
                sender:          self.lending_vault.to_account_info(),
                rent_receiver:   self.liquidator.to_account_info(),
                event_authority: self.event_authority.to_account_info(),
                program:         self.dlmm_program.to_account_info(),
            },
            signer_seeds,
        );
        dlmm::cpi::close_position(ctx)
    }

    #[inline(never)]
    fn transfer_collateral(
        &self,
        collateral_seeds: &[&[&[u8]]],
        destination: AccountInfo<'info>,
        amount: u64,
    ) -> Result<()> {
        system_program::transfer(
            CpiContext::new_with_signer(
                self.system_program.to_account_info(),
                SystemTransfer {
                    from: self.collateral_vault.to_account_info(),
                    to:   destination,
                },
                collateral_seeds,
            ),
            amount,
        )
    }
}
