use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::state::{Config, Position, LendingVault};
use crate::errors::ProtocolError;
use crate::dlmm;

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(address = anchor_spl::token::spl_token::native_mint::id())]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [Position::SEED_PREFIX, user.key().as_ref(), wsol_mint.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ ProtocolError::InvalidOwner,
        constraint = position.is_active() @ ProtocolError::PositionNotActive,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        mut,
        seeds = [LendingVault::SEED_PREFIX],
        bump = lending_vault.bump,
    )]
    pub lending_vault: Box<Account<'info, LendingVault>>,

    /// Receives the wSOL proceeds (token Y) from DLMM remove_liquidity / swap.
    #[account(
        mut,
        seeds = [b"wsol_vault", lending_vault.key().as_ref()],
        bump = lending_vault.vault_bump,
        token::mint = wsol_mint,
        token::authority = lending_vault,
    )]
    pub wsol_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// DLMM position — owned by lending_vault, not a signer on close.
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
    /// Any X-side tokens returned by remove_liquidity land here, then get swapped to wSOL.
    #[account(
        init_if_needed,
        payer = user,
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

    /// CHECK: Pool TWAP oracle — required by DLMM swap to update price tracking.
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

impl<'info> ClosePosition<'info> {
    pub fn close(
        &mut self,
        from_bin_id: i32,
        to_bin_id: i32,
    ) -> Result<()> {
        let vault_bump = self.lending_vault.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[LendingVault::SEED_PREFIX, &[vault_bump]]];
        let debt = self.position.debt_amount;

        self.cpi_remove_liquidity(signer_seeds, from_bin_id, to_bin_id)?;
        self.cpi_claim_fee(signer_seeds)?;

        self.user_token_x.reload()?;
        let x_balance = self.user_token_x.amount;
        if x_balance > 0 {
            self.cpi_swap(signer_seeds, x_balance)?;
        }

        self.cpi_close_position(signer_seeds)?;

        self.position.debt_amount = 0;
        self.lending_vault.repay(debt)?;
        self.position.mark_closed();
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
                rent_receiver:   self.user.to_account_info(),
                event_authority: self.event_authority.to_account_info(),
                program:         self.dlmm_program.to_account_info(),
            },
            signer_seeds,
        );
        dlmm::cpi::close_position(ctx)
    }
}
