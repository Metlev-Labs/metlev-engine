use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SystemTransfer};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
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

    /// The collateral token mint (supports both SPL Token and Token-2022)
    #[account(
        mint::token_program = token_program
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [CollateralConfig::SEED_PREFIX, mint.key().as_ref()],
        bump = collateral_config.bump,
        constraint = collateral_config.mint == mint.key() @ ProtocolError::InvalidCollateralType,
        constraint = collateral_config.enabled @ ProtocolError::InvalidCollateralType,
    )]
    pub collateral_config: Account<'info, CollateralConfig>,

    /// Per-user vault PDA
    /// For SOL: SystemAccount that holds lamports directly
    /// For SPL: TokenAccount that holds tokens
    /// CHECK: Validated based on mint type in deposit logic
    #[account(
        mut,
        seeds = [b"vault", user.key().as_ref(), mint.key().as_ref()],
        bump,
    )]
    pub vault: UncheckedAccount<'info>,

    /// User's token account (only validated for SPL tokens, ignored for SOL)
    /// CHECK: Validated when processing SPL token transfers
    #[account(mut)]
    pub user_token_account: UncheckedAccount<'info>,

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
    fn is_native_sol(&self) -> bool {
        self.mint.key() == anchor_spl::token::spl_token::native_mint::id()
    }

    fn transfer_sol(&mut self, amount: u64) -> Result<()> {
        require!(
            self.vault.owner == &system_program::ID,
            ProtocolError::InvalidCollateralType
        );

        let cpi_program = self.system_program.to_account_info();
        let cpi_accounts = SystemTransfer {
            from: self.user.to_account_info(),
            to: self.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        system_program::transfer(cpi_ctx, amount)
    }

    fn transfer_token(&self, amount: u64) -> Result<()> {
        require!(
            self.vault.owner == self.token_program.key,
            ProtocolError::InvalidCollateralType
        );

        require!(
            self.user_token_account.owner == self.token_program.key,
            ProtocolError::InvalidCollateralType
        );

        let transfer_accounts = TransferChecked {
            from: self.user_token_account.to_account_info(),
            mint: self.mint.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.user.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(
            self.token_program.to_account_info(),
            transfer_accounts,
        );

        token_interface::transfer_checked(cpi_ctx, amount, self.mint.decimals)
    }

    pub fn deposit(
        &mut self,
        bumps: &DepositCollateralBumps,
        amount: u64,
    ) -> Result<()> {
        require!(!self.config.paused, ProtocolError::ProtocolPaused);

        require!(
            amount >= self.collateral_config.min_deposit,
            ProtocolError::InsufficientCollateral
        );

        self.position.set_inner(Position {
            owner: self.user.key(),
            collateral_mint: self.collateral_config.mint,
            collateral_amount: amount,
            debt_amount: 0,
            meteora_position: Pubkey::default(),
            created_at: Clock::get()?.unix_timestamp,
            status: PositionStatus::Active,
            bump: bumps.position,
        });

        if self.is_native_sol() {
            self.transfer_sol(amount)?;
        } else {
            self.transfer_token(amount)?;
        }

        Ok(())
    }
}
