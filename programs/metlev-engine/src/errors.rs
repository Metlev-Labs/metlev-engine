use anchor_lang::prelude::*;

#[error_code]
pub enum ProtocolError {
    #[msg("Protocol is currently paused")]
    ProtocolPaused,

    #[msg("Unauthorized: only protocol authority can perform this action")]
    Unauthorized,

    #[msg("Invalid collateral type")]
    InvalidCollateralType,

    #[msg("Collateral amount below minimum required")]
    InsufficientCollateral,

    #[msg("Position exceeds maximum LTV ratio")]
    ExceedsMaxLTV,

    #[msg("Position is not in liquidatable state")]
    NotLiquidatable,

    #[msg("Position is already closed or liquidated")]
    PositionNotActive,

    #[msg("Position is still healthy and cannot be liquidated")]
    PositionHealthy,

    #[msg("Lending vault has insufficient liquidity")]
    InsufficientLiquidity,

    #[msg("Oracle price is stale or invalid")]
    OracleStale,

    #[msg("Oracle price is not available")]
    OraclePriceUnavailable,

    #[msg("Math overflow occurred")]
    MathOverflow,

    #[msg("Math underflow occurred")]
    MathUnderflow,

    #[msg("Invalid amount provided")]
    InvalidAmount,

    #[msg("Invalid liquidation threshold configuration")]
    InvalidLiquidationThreshold,

    #[msg("Position owner mismatch")]
    InvalidOwner,

    #[msg("Meteora position reference is invalid")]
    InvalidMeteoraPosition,

    #[msg("Debt repayment failed")]
    RepaymentFailed,

    #[msg("Collateral withdrawal failed")]
    WithdrawalFailed,

    #[msg("Bad debt detected - insufficient collateral to cover debt")]
    BadDebt,
}
