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
    pub position: Account<'info, Position>,

    #[account(
        mut,
        seeds = [LendingVault::SEED_PREFIX],
        bump = lending_vault.bump,
    )]
    pub lending_vault: Account<'info, LendingVault>,

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

        //    wSOL (token Y) goes to wsol_vault; any X-side tokens go to user_token_x.
        let remove_ctx = CpiContext::new_with_signer(
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
        dlmm::cpi::remove_liquidity_by_range(remove_ctx, from_bin_id, to_bin_id, 10_000)?;

        // Re-read user_token_x balance from the account data updated by the CPI above.
        self.user_token_x.reload()?;
        //If any X tokens landed in user_token_x (price moved in-range), swap them back to
        //    wSOL so the full debt can be repaid from wsol_vault.
        let x_balance = self.user_token_x.amount;
        if x_balance > 0 {
            let swap_ctx = CpiContext::new_with_signer(
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
            );
            // min_amount_out = 0 for POC
            // for a production caller supplied min derived from the oracle price.
            dlmm::cpi::swap(swap_ctx, x_balance, 0)?;
        }

        // Close the DLMM position account rent lamports go back to user.
        let close_ctx = CpiContext::new_with_signer(
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
        dlmm::cpi::close_position(close_ctx)?;

        self.position.debt_amount = 0;
        self.lending_vault.repay(debt)?;
        self.position.mark_closed();
        Ok(())
    }
}
