# Leveraged Meteora DLMM Protocol

> **Turbin3 Q1 2026 - Capstone Project** - A protocol for opening leveraged liquidity provider positions on Meteora DLMM pools with automated risk management.

## Overview

This protocol enables experienced Solana LPs to open **leveraged DLMM liquidity positions** on Meteora where trading fees are the primary source of return. Users deposit SOL or USDC as collateral, and the protocol borrows additional capital to create larger liquidity positions, amplifying fee generation while managing liquidation risk.

### Core Value Proposition

- **Fee-First Leverage** - Amplify DLMM trading fee yield through conservative leverage
- **Automated Position Management** - Protocol handles bin setup, position creation, and risk monitoring
- **Explicit Risk Controls** - Clear LTV thresholds, oracle-based health checks, and automated liquidations
- **Capital Efficiency** - Earn more fees with the same collateral through leverage

### How It Works

1. **Deposit Collateral** - User deposits SOL or USDC into protocol vaults
2. **Open Leveraged Position** - Protocol borrows additional funds and creates DLMM LP position on Meteora
3. **Earn Fees** - Position generates trading fees from Meteora pool activity
4. **Monitor Health** - Oracle-based health checks ensure position stays solvent
5. **Close or Liquidate** - User can voluntarily close, or liquidators force-close if unhealthy

### Target Users

- **Experienced Meteora LPs** - Already familiar with DLMM mechanics and bin strategies
- **Leverage-Comfortable DeFi Users** - Understand leverage protocols (Kamino, Loopscale)
- **Risk-Aware Yield Optimizers** - Comfortable with liquidation risk for higher fee APR

## Architecture

### Design Pattern: Per-Collateral Configuration

This protocol uses a **per-collateral configuration pattern** (similar to Aave, Kamino, Solend) where:

- Each collateral type (SOL, USDC, etc.) has its own `CollateralConfig` account
- Risk parameters (LTV, liquidation thresholds, interest rates) are tailored per asset
- New collateral types can be added dynamically without program upgrades
- Users can hold multiple positions with different collateral types simultaneously

**Benefits:**
- ✅ **Risk-appropriate parameters** - Volatile assets (SOL) have lower LTV than stablecoins (USDC)
- ✅ **Scalability** - Add new collaterals without code changes
- ✅ **Flexibility** - Adjust parameters per asset based on market conditions
- ✅ **Capital efficiency** - Users can optimize based on their preferred collateral

### Program Structure
```
programs/
└── metlev-engine/
    └── src/
        ├── lib.rs                      # Program entry point
        ├── state/
        │   ├── mod.rs                  # State module exports
        │   ├── config.rs               # Global protocol configuration
        │   ├── position.rs             # User position state
        │   └── lending_vault.rs        # Mock lending vault (POC)
        ├── instructions/
        │   ├── mod.rs                  # Instruction exports
        │   ├── initialize.rs           # Initialize protocol config
        │   ├── add_collateral.rs       # Register new collateral type
        │   ├── deposit_collateral.rs   # Deposit SOL/USDC/other tokens
        │   ├── open_position.rs        # Create leveraged DLMM position
        │   ├── close_position.rs       # Close position and repay debt
        │   ├── liquidate.rs            # Force-close unhealthy positions
        │   └── update_config.rs        # Update protocol/collateral parameters
        ├── utils/
        │   ├── mod.rs                  # Utility exports
        │   ├── health.rs               # Health factor calculations
        │   └── oracle.rs               # Price oracle helpers
        └── errors.rs                   # Custom error definitions
```

### State Accounts

**Config (Global Protocol Settings)**
```rust
pub struct Config {
    pub authority: Pubkey,   // Protocol admin
    pub paused: bool,        // Emergency pause state
    pub bump: u8,
}
```
- PDA: `["config"]`
- Manages protocol-level settings and pause state
- Does NOT store collateral-specific parameters

**CollateralConfig (Per-Collateral Risk Parameters)**
```rust
pub struct CollateralConfig {
    pub mint: Pubkey,                    // Collateral token mint
    pub oracle: Pubkey,                  // Price oracle (Pyth/Switchboard)
    pub max_ltv: u16,                    // Max loan-to-value (basis points)
    pub liquidation_threshold: u16,      // Liquidation trigger (basis points)
    pub liquidation_penalty: u16,        // Penalty for liquidation (basis points)
    pub min_deposit: u64,                // Minimum deposit amount
    pub interest_rate_bps: u16,          // Interest rate (basis points)
    pub oracle_max_age: u64,             // Max oracle staleness (seconds)
    pub enabled: bool,                   // Whether collateral is active
    pub bump: u8,
}
```
- PDA: `["collateral_config", mint]`
- Each collateral (SOL, USDC, etc.) has independent risk parameters
- Allows different LTV ratios for volatile vs stable assets
- Example: SOL at 75% LTV, USDC at 90% LTV

**Position (Per-User Leveraged Position)**
```rust
pub struct Position {
    pub owner: Pubkey,              // User wallet
    pub collateral_mint: Pubkey,    // Which token is used as collateral
    pub collateral_amount: u64,     // Amount deposited
    pub debt_amount: u64,           // Amount borrowed
    pub meteora_position: Pubkey,   // Reference to DLMM position
    pub created_at: i64,            // Unix timestamp
    pub status: PositionStatus,     // Active/Closed/Liquidated
    pub bump: u8,
}
```
- PDA: `["position", owner, collateral_mint]`
- Users can have multiple positions with different collateral types
- Each position is isolated per collateral mint

**Lending Vault (Mock Lender - POC)**
```rust
pub struct LendingVault {
    pub total_supplied: u64,
    pub total_borrowed: u64,
    pub interest_rate_bps: u16,
    pub bump: u8,
}
```
- Simple mock vault for POC
- Tracks available liquidity for borrowing
- Will integrate with real lenders post-POC

## Implementation Steps

### Phase 1: Core Infrastructure 
1. **Project Setup**
   - Initialize Anchor project structure
   - Define state accounts (Config, CollateralConfig, Position, LendingVault)
   - Create custom error types
   - Set up test environment

2. **Basic Instructions**
   - `initialize` - Set up global protocol config (authority, pause state)
   - `add_collateral` - Register new collateral types with risk parameters
   - `deposit_collateral` - Accept deposits for any enabled collateral
   - Base account validation and PDA derivation

### Phase 2: Position Management
3. **Open Position Logic**
   - `open_position` - Create leveraged DLMM position
   - Integrate mock lending vault for borrowing
   - CPI to Meteora DLMM to create LP position
   - Store position reference and debt tracking

4. **Close Position Logic**
   - `close_position` - Unwind position voluntarily
   - CPI to Meteora to remove liquidity
   - Repay debt to lending vault
   - Return remaining collateral to user

### Phase 3: Risk Management
5. **Health Monitoring**
   - Integrate price oracle (Pyth/Switchboard/magicblock)
   - Implement health factor calculation
   - LTV calculation based on collateral value vs debt

6. **Liquidation System**
   - `liquidate` - Force-close unhealthy positions
   - Health check validation
   - Liquidator incentive distribution
   - Bad debt handling

### Phase 4: Testing & Refinement
7. **Comprehensive Testing**
   - Unit tests for all instructions
   - Integration tests with Meteora devnet
   - Liquidation scenario testing
   - Oracle edge case handling

8. **Security Hardening**
   - Reentrancy protection
   - Oracle staleness checks
   - Overflow/underflow validation
   - Access control verification

## Key Technical Challenges

### 1. **Meteora DLMM Integration**
- **Challenge**: CPI to Meteora to create/close DLMM positions
- **Solution**: Study Meteora SDK and program interface, implement proper account passing

### 2. **Health Factor Calculation**
- **Challenge**: Accurately value DLMM position + account for impermanent loss
- **Solution**: Oracle-based collateral pricing, conservative LTV ratios

### 3. **Debt Accounting**
- **Challenge**: Track borrowed amounts and interest accrual
- **Solution**: Simple interest model in POC, store principal + timestamp

### 4. **Liquidation Mechanics**
- **Challenge**: Ensure liquidations are profitable and timely
- **Solution**: Clear threshold + liquidator incentives, anyone can liquidate

### 5. **Oracle Integration**
- **Challenge**: Reliable price feeds for SOL/USDC
- **Solution**: Pyth oracle integration with staleness checks

## User Stories (POC Scope)

### Experienced Solana LP
- **Deposit collateral** - Deposit SOL or USDC to open positions
- **Open leveraged position** - Create DLMM LP with borrowed funds
- **View position status** - Check health factor and liquidation risk
- **Close position** - Exit position, repay debt, withdraw collateral

### Liquidator / Keeper
- **Check position health** - Monitor positions for liquidation
- **Force-close unsafe positions** - Liquidate unhealthy positions for reward

## Risk Parameters (POC)

Risk parameters are **per-collateral**, allowing different configurations for volatile vs stable assets.

### SOL Collateral (Volatile Asset)
| Parameter | Value | Description |
|-----------|-------|-------------|
| Max LTV | 75% | Maximum loan-to-value ratio |
| Liquidation Threshold | 80% | Health factor triggers liquidation |
| Liquidation Penalty | 5% | Penalty paid to liquidator |
| Min Deposit | 0.1 SOL | Minimum deposit amount |
| Interest Rate | 5% APR | Borrow rate for SOL positions |
| Oracle Max Age | 60 seconds | Max staleness for price feeds |

### USDC Collateral (Stablecoin)
| Parameter | Value | Description |
|-----------|-------|-------------|
| Max LTV | 90% | Higher LTV due to stability |
| Liquidation Threshold | 95% | Closer threshold (less volatility) |
| Liquidation Penalty | 3% | Lower penalty (less risk) |
| Min Deposit | 10 USDC | Minimum deposit amount |
| Interest Rate | 3% APR | Lower rate for stable collateral |
| Oracle Max Age | 60 seconds | Max staleness for price feeds |

> **Note**: Each collateral type can be added via `add_collateral` instruction with custom parameters.

## Dependencies

```toml
[dependencies]
anchor-lang = "0.32.1"
anchor-spl = { version = "0.32.1", features = ["token"] }
pyth-solana-receiver-sdk = "0.2.0"  # Oracle integration
```

## Getting Started

### Prerequisites
- Rust 1.75+
- Solana CLI 1.18+
- Anchor 0.32.1
- Node.js 18+
- Yarn

### Installation

```bash
# Install dependencies
yarn install

# Build the program
anchor build

# Run tests
anchor test
```

## Testing Strategy

### Unit Tests
- Config initialization
- Collateral deposit/withdrawal
- Debt accounting
- Health factor calculation
- Liquidation threshold logic

### Integration Tests
- Full position lifecycle (deposit → open → close)
- Liquidation scenarios (healthy → unhealthy → liquidated)
- Oracle price updates
- Multi-user interactions

### Devnet Testing
- Deploy to Solana devnet
- Test with real Meteora DLMM pools
- Monitor liquidation bot behavior
- Validate oracle integration

## Security Considerations

1. **Oracle Manipulation** - Use staleness checks, multiple oracle sources
2. **Flash Loan Attacks** - Position changes require minimum time delays
3. **Bad Debt Accumulation** - Conservative LTV ratios, liquidation buffers
4. **CPI Reentrancy** - Proper account validation and state checks

## Future Enhancements (Post-POC)

- Multiple leverage presets (2x, 3x, 5x)
- Auto-rebalancing based on volatility
- Fee compounding / auto-reinvestment
- Partial position closes
- Integration with real lending protocols (Kamino, Solana)
- Support for additional DLMM pairs

## Resources

- [Meteora DLMM Docs](https://docs.meteora.ag/dlmm-documentation)
- [Pyth Oracle Docs](https://docs.pyth.network/price-feeds/solana-price-feeds)
- [Anchor Framework](https://www.anchor-lang.com/)
- [Turbin3 Program](https://www.turbin3.org/)

## Project Status

🚧 **In Development** - POC Phase

- [x] Project planning and requirements
- [] Project skeleton and base structure
- [] Core state accounts (Config, CollateralConfig, Position, LendingVault)
- [] Base instruction implementations (initialize, add_collateral, deposit, etc.)
- [] Comprehensive test suite
- [ ] Token transfers and vault management
- [ ] Position opening (Meteora DLMM integration via CPI)
- [ ] Health monitoring (oracle integration)
- [ ] Liquidation system
- [ ] Full integration testing and deployment
