use anchor_lang::prelude::*;
use crate::errors::ProtocolError;
use crate::state::{MockOracle};

/// Check if oracle price data is stale
pub fn is_oracle_stale(
    oracle_timestamp: i64,
    max_age_seconds: u64,
) -> bool {
    let current_timestamp = Clock::get().unwrap().unix_timestamp;
    let age = current_timestamp.saturating_sub(oracle_timestamp);
    age > max_age_seconds as i64
}

/// Validate oracle price feed
pub fn validate_oracle_price(
    price: u64,
    timestamp: i64,
    max_age: u64,
) -> Result<()> {
    // Check price is not zero
    require!(price > 0, ProtocolError::OraclePriceUnavailable);

    // Check timestamp is not stale
    require!(
        !is_oracle_stale(timestamp, max_age),
        ProtocolError::OracleStale
    );

    Ok(())
}

/// Mock oracle price reader (for POC testing)
/// In production, this would integrate with Pyth, Switchboard, etc.
pub fn read_oracle_price(
    oracle_account: &AccountInfo,
    max_age: u64,
) -> Result<(u64, i64)> {
    let data = oracle_account.try_borrow_data()?;
    let mock = MockOracle::try_deserialize(&mut data.as_ref())?;
    require!(
        !is_oracle_stale(mock.timestamp, max_age),
        ProtocolError::OracleStale
    );
    Ok((mock.price, mock.timestamp))
}

/// Price feed result
#[derive(Debug, Clone, Copy)]
pub struct PriceData {
    pub price: u64,        // Price with 6 decimals
    pub confidence: u64,   // Confidence interval
    pub timestamp: i64,    // Unix timestamp
    pub is_valid: bool,    // Validity flag
}

impl PriceData {
    pub fn new(price: u64, confidence: u64, timestamp: i64) -> Self {
        Self {
            price,
            confidence,
            timestamp,
            is_valid: true,
        }
    }

    pub fn is_stale(&self, max_age: u64) -> bool {
        is_oracle_stale(self.timestamp, max_age)
    }

    pub fn validate(&self, max_age: u64) -> Result<()> {
        require!(self.is_valid, ProtocolError::OraclePriceUnavailable);
        require!(!self.is_stale(max_age), ProtocolError::OracleStale);
        require!(self.price > 0, ProtocolError::OraclePriceUnavailable);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_oracle_stale() {
        let current = Clock::get().unwrap().unix_timestamp;

        // Not stale (10 seconds old, max 60)
        assert!(!is_oracle_stale(current - 10, 60));

        // Stale (70 seconds old, max 60)
        assert!(is_oracle_stale(current - 70, 60));
    }

    #[test]
    fn test_price_data_validation() {
        let current = Clock::get().unwrap().unix_timestamp;
        let price_data = PriceData::new(100_000_000, 10_000, current);

        // Should be valid (fresh)
        assert!(price_data.validate(60).is_ok());

        // Should be stale
        let old_price = PriceData::new(100_000_000, 10_000, current - 120);
        assert!(old_price.validate(60).is_err());
    }
}
