use anchor_lang::prelude::*;
use crate::state::{Config, Position, LendingVault, CollateralConfig};
use crate::errors::ProtocolError;
use crate::dlmm;  

/// Adds single-sided liquidity to a Meteora DLMM position.
/// Single-sided means only one token (X or Y) is deposited, distributing
/// liquidity exclusively to bins above the active price (for token X) or
/// below (for token Y).
///
/// # Arguments
///
/// * `ctx` - The context containing all required accounts.
/// * `amount` - Total amount of the single token to deposit, in base units.
/// * `active_id` - The active bin ID observed off-chain prior to building
///   the transaction. Used to validate slippage on-chain.
/// * `max_active_bin_slippage` - Maximum allowed bin ID deviation from
///   `active_id` at execution time. Protects against price movement between
///   observation and execution. Recommended: 3–10.
/// * `bin_liquidity_dist` - Per-bin weight distribution. Each entry specifies
///   a bin_id and a relative weight (u16). The program normalises these
///   weights internally so only the ratios matter.
///
///   Rules for bin_id selection:
///   - Token X deposits: all bin_ids must be strictly > active_id
///   - Token Y deposits: all bin_ids must be <= active_id
///   - All bin_ids must fall within [position.lower_bin_id, position.upper_bin_id]
///
use crate::utils::{read_oracle_price, calculate_collateral_value, calculate_ltv};

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [Config::SEED_PREFIX],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [Position::SEED_PREFIX, user.key().as_ref()],
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

    #[account(
        seeds = [CollateralConfig::SEED_PREFIX, position.collateral_mint.as_ref()],
        bump = collateral_config.bump,
        constraint = collateral_config.is_enabled() @ ProtocolError::InvalidCollateralType,
    )]
    pub collateral_config: Account<'info, CollateralConfig>,

    /// CHECK: verified via collateral_config.oracle constraint
    #[account(
        constraint = price_oracle.key() == collateral_config.oracle @ ProtocolError::OraclePriceUnavailable,
    )]
    pub price_oracle: UncheckedAccount<'info>,
    //Meteora CPI Accounts

     #[account(mut)]
    /// CHECK: The user's position account
    pub met_position: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: The pool account. Must match the lb_pair stored inside position,
    /// bin_array_bitmap_extension, bin_array_lower, and bin_array_upper.
    pub lb_pair: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Bin array bitmap extension account of the pool. Only required
    /// when the active bin falls outside the main bitmap range (|bin_id| > 512).
    /// Pass None if not needed.
    pub bin_array_bitmap_extension: Option<UncheckedAccount<'info>>,

    #[account(mut)]
    /// CHECK: User token account for the token being deposited (either token X or Y).
    /// Tokens are transferred FROM this account into the pool reserve.
    pub user_token: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: The pool's reserve vault for the token being deposited.
    /// Use lb_pair.reserve_x for token X deposits, lb_pair.reserve_y for token Y.
    pub reserve: UncheckedAccount<'info>,

    /// CHECK: Mint of the token being deposited.
    /// Must match lb_pair.token_x_mint or lb_pair.token_y_mint.
    pub token_mint: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: The lower bin array account covering the position's bin range.
    /// PDA: ["bin_array", lb_pair, floor(lower_bin_id / 70)]
    pub bin_array_lower: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: The upper bin array account covering the position's bin range.
    /// PDA: ["bin_array", lb_pair, floor(upper_bin_id / 70)]
    /// May be the same account as bin_array_lower if the position fits in one array.
    pub bin_array_upper: UncheckedAccount<'info>,

    /// CHECK: The authority that owns user_token. Must sign the transaction.
    pub sender: Signer<'info>,

    /// CHECK: DLMM program event authority for event CPI.
    /// PDA derived as: find_program_address(&[b"__event_authority"], &dlmm::ID)
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: Token program of the mint being deposited.
    /// Use Token (spl-token) or Token-2022 depending on the pool's token program.
    pub token_program: UncheckedAccount<'info>,

    #[account(address = dlmm::ID)]
    /// CHECK: DLMM program
    pub dlmm_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

impl<'info> OpenPosition<'info> {
    pub fn open(
        &mut self,
        leverage: u64, // Leverage multiplier (basis points, 20000 = 2x)
        amount: u64,
    active_id: i32,
    max_active_bin_slippage: i32,
    bin_liquidity_dist: Vec<dlmm::types::BinLiquidityDistributionByWeight>,
    ) -> Result<()> {
        require!(!self.config.paused, ProtocolError::ProtocolPaused);

        // Calculate borrow amount based on leverage
        let borrow_amount = self.position.collateral_amount
            .checked_mul(leverage)
            .and_then(|v| v.checked_div(10000))
            .ok_or(ProtocolError::MathOverflow)?;

        // Check if lending vault has enough liquidity
        // check happens in the borrow fn
        self.lending_vault.borrow(borrow_amount)?;

        let oracle_info = self.price_oracle.to_account_info();
        let (price, _) = read_oracle_price(
            &oracle_info,
            self.collateral_config.oracle_max_age,
        )?;

        let collateral_value = calculate_collateral_value(
            self.position.collateral_amount,
            price,
            self.collateral_config.decimals,
        )?;
        let debt_value = calculate_collateral_value(
            borrow_amount,
            price,
            self.collateral_config.decimals,
        )?;
        let ltv = calculate_ltv(collateral_value, debt_value)?;
        require!(
            self.collateral_config.validate_ltv(ltv),
            ProtocolError::ExceedsMaxLTV
        );
    
        //TODO:
        //implement native transfer to WSOL token account
        //token::native_sync

        // Update position debt
        self.position.debt_amount = borrow_amount;

        // TODO: CPI to Meteora to create DLMM position
        // This will involve:
        // 1. Prepare token accounts (collateral + borrowed funds)
        // 2. Call Meteora add_liquidity instruction
        let accounts = dlmm::cpi::accounts::AddLiquidityOneSide {
        position: self.met_position.to_account_info(),
        lb_pair: self.lb_pair.to_account_info(),
        bin_array_bitmap_extension: 
            self
            .bin_array_bitmap_extension
            .as_ref()
            .map(|account| account.to_account_info()),
        user_token: self.user_token.to_account_info(),
        reserve: self.reserve.to_account_info(),
        token_mint: self.token_mint.to_account_info(),
        bin_array_lower: self.bin_array_lower.to_account_info(),
        bin_array_upper: self.bin_array_upper.to_account_info(),
        sender: self.sender.to_account_info(),
        token_program: self.token_program.to_account_info(),
        event_authority: self.event_authority.to_account_info(),
        program: self.dlmm_program.to_account_info(),
    };

    let liquidity_parameter = dlmm::types::LiquidityOneSideParameter {
        amount,
        active_id,
        max_active_bin_slippage,
        bin_liquidity_dist,
    };

    let cpi_context =
        CpiContext::new(self.dlmm_program.to_account_info(), accounts);

    dlmm::cpi::add_liquidity_one_side(cpi_context, liquidity_parameter)
}
}



