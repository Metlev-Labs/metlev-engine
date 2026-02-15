use anchor_lang::prelude::*;
use crate::errors::ProtocolError;

/// Calculate loan-to-value ratio in basis points
/// LTV = (debt_value / collateral_value) * 10000
pub fn calculate_ltv(collateral_value: u64, debt_value: u64) -> Result<u64> {
    if collateral_value == 0 {
        return Err(ProtocolError::InvalidAmount.into());
    }

    let ltv = debt_value
        .checked_mul(10000)
        .and_then(|v| v.checked_div(collateral_value))
        .ok_or(ProtocolError::MathOverflow)?;

    Ok(ltv)
}

/// Calculate health factor
/// Health Factor = (collateral_value / debt_value)
/// HF > 1.0 = healthy, HF < 1.0 = liquidatable
pub fn calculate_health_factor(collateral_value: u64, debt_value: u64) -> Result<u64> {
    if debt_value == 0 {
        // No debt = infinite health
        return Ok(u64::MAX);
    }

    let health_factor = collateral_value
        .checked_mul(10000) // Scale to basis points
        .and_then(|v| v.checked_div(debt_value))
        .ok_or(ProtocolError::MathOverflow)?;

    Ok(health_factor)
}

/// Calculate collateral value based on oracle price
/// Returns value in USD terms (6 decimals for USDC)
pub fn calculate_collateral_value(
    collateral_amount: u64,
    price: u64, // Price in USD with 6 decimals
    decimals: u8,
) -> Result<u64> {
    let adjusted_amount = if decimals > 6 {
        collateral_amount
            .checked_div(10u64.pow((decimals - 6) as u32))
            .ok_or(ProtocolError::MathOverflow)?
    } else if decimals < 6 {
        collateral_amount
            .checked_mul(10u64.pow((6 - decimals) as u32))
            .ok_or(ProtocolError::MathOverflow)?
    } else {
        collateral_amount
    };

    let value = adjusted_amount
        .checked_mul(price)
        .and_then(|v| v.checked_div(1_000_000)) // Price has 6 decimals
        .ok_or(ProtocolError::MathOverflow)?;

    Ok(value)
}

/// Calculate liquidation penalty amount
pub fn calculate_liquidation_penalty(
    total_proceeds: u64,
    penalty_bps: u16,
) -> Result<u64> {
    let penalty = total_proceeds
        .checked_mul(penalty_bps as u64)
        .and_then(|v| v.checked_div(10000))
        .ok_or(ProtocolError::MathOverflow)?;

    Ok(penalty)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_ltv() {
        // 50% LTV = 5000 basis points
        let ltv = calculate_ltv(100_000, 50_000).unwrap();
        assert_eq!(ltv, 5000);

        // 75% LTV = 7500 basis points
        let ltv = calculate_ltv(100_000, 75_000).unwrap();
        assert_eq!(ltv, 7500);
    }

    #[test]
    fn test_calculate_health_factor() {
        // HF = 2.0 (200% collateralization)
        let hf = calculate_health_factor(200_000, 100_000).unwrap();
        assert_eq!(hf, 20000); // 2.0 in basis points

        // HF = 1.25 (125% collateralization)
        let hf = calculate_health_factor(125_000, 100_000).unwrap();
        assert_eq!(hf, 12500);
    }

    #[test]
    fn test_calculate_liquidation_penalty() {
        // 5% penalty on 100_000 = 5_000
        let penalty = calculate_liquidation_penalty(100_000, 500).unwrap();
        assert_eq!(penalty, 5_000);
    }
}
