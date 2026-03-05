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
- Risk-appropriate parameters - Volatile assets (SOL) have lower LTV than stablecoins (USDC)
- Scalability - Add new collaterals without code changes
- Flexibility - Adjust parameters per asset based on market conditions
- Capital efficiency - Users can optimize based on their preferred collateral

### Program Structure
```
programs/
└── metlev-engine/
    └── src/
        ├── lib.rs                           # Program entry point
        ├── state/
        │   ├── mod.rs                       # State module exports
        │   ├── config.rs                    # Global protocol configuration
        │   ├── position.rs                  # User leveraged position state
        │   ├── lending_vault.rs             # Lending vault state and accounting
        │   └── lp_position.rs               # LP supplier position and interest
        ├── instructions/
        │   ├── mod.rs                       # Instruction exports
        │   ├── initialize.rs                # Initialize protocol config
        │   ├── register_collateral.rs       # Register new collateral type
        │   ├── deposit_sol_collateral.rs    # Deposit SOL as collateral
        │   ├── deposit_token_collateral.rs  # Deposit SPL tokens as collateral
        │   ├── initialize_lending_vault.rs  # Create and seed the lending vault
        │   ├── supply.rs                    # LP supplies wSOL to the vault
        │   ├── withdraw.rs                  # LP withdraws wSOL + interest
        │   ├── open_position.rs             # Create leveraged DLMM position
        │   ├── close_position.rs            # Close position, repay debt, handle shortfall
        │   ├── withdraw_collateral.rs       # Withdraw collateral after position closed
        │   ├── liquidate.rs                 # Force-close unhealthy positions
        │   ├── mock_oracle.rs               # Mock oracle for testing/demo
        │   └── update_config.rs             # Update protocol/collateral parameters
        ├── utils/
        │   ├── mod.rs                       # Utility exports
        │   ├── health.rs                    # Health factor / LTV calculations
        │   └── oracle.rs                    # Price oracle helpers
        └── errors.rs                        # Custom error definitions

scripts/
├── init-protocol.ts                         # Bootstrap protocol on devnet
├── update-oracle.ts                         # Update mock oracle price
├── supply.ts                                # Supply wSOL to lending vault
├── withdraw-lp.ts                           # Withdraw wSOL + interest from vault
├── setup-pool.ts                            # Create DLMM pool on devnet
└── force-liquidate.ts                       # Force-liquidate a stuck position
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

**LendingVault (On-Chain wSOL Vault)**
```rust
pub struct LendingVault {
    pub total_supplied: u64,    // Total wSOL supplied by LPs
    pub total_borrowed: u64,    // Total wSOL currently borrowed
    pub interest_rate_bps: u16, // Annual interest rate in basis points
    pub bump: u8,               // LendingVault PDA bump
    pub vault_bump: u8,         // wsol_vault PDA bump (for CPI signing)
}
```
- PDA: `["lending_vault"]`
- Paired with a `wsol_vault` token account PDA that holds wSOL
- `wsol_vault` PDA: `["wsol_vault", lending_vault]`
- Tracks total supplied and borrowed for utilization calculations

**LpPosition (Per-LP Supplier State)**
```rust
pub struct LpPosition {
    pub lp: Pubkey,             // Supplier wallet
    pub supplied_amount: u64,   // Principal supplied
    pub interest_earned: u64,   // Accrued interest
    pub last_update: i64,       // Unix timestamp of last interest accrual
    pub bump: u8,
}
```
- PDA: `["lp_position", lp]`
- Created via `init_if_needed` to support top-up deposits
- Interest accrues using simple interest: `principal * rate_bps * elapsed / (365 * 24 * 3600 * 10000)`
- Closed (rent returned) on full withdrawal

### Instruction Flow

**Open Position**
1. User deposits SOL collateral into PDA vault (`["vault", owner, mint]`)
2. Protocol checks LTV against oracle price
3. Borrows wSOL from lending vault (updates `total_borrowed`)
4. CPI to Meteora DLMM: creates position and adds one-sided wSOL liquidity
5. Records debt and DLMM position reference on `Position` account

**Close Position**
1. CPI to Meteora DLMM: removes all liquidity and closes position
2. If LP received non-wSOL token (token X), swaps it back to wSOL via DLMM
3. If proceeds >= debt: repay debt, send surplus to user's wSOL ATA
4. If proceeds < debt: cover shortfall from user's collateral vault (native SOL -> wSOL via `sync_native`)
5. Marks position as `Closed`

**Liquidation**
1. Anyone can call `liquidate` on a position where LTV > `liquidation_threshold`
2. CPI to Meteora DLMM: removes all liquidity and closes position
3. LP proceeds repay debt to lending vault
4. Liquidation penalty (% of collateral) sent to liquidator as native SOL
5. Remaining collateral returned to position owner
6. Marks position as `Liquidated`

## Risk Parameters (POC)

Risk parameters are **per-collateral**, allowing different configurations for volatile vs stable assets.

### SOL Collateral (Volatile Asset)
| Parameter | Value | Description |
|-----------|-------|-------------|
| Max LTV | 75% | Maximum loan-to-value ratio |
| Liquidation Threshold | 80% | Health factor triggers liquidation |
| Liquidation Penalty | 5% | Penalty paid to liquidator from collateral |
| Min Deposit | 0.1 SOL | Minimum deposit amount |
| Interest Rate | 5% APR | Borrow rate for SOL positions |
| Oracle Max Age | 1 hour | Max staleness for price feeds |

### USDC Collateral (Stablecoin)
| Parameter | Value | Description |
|-----------|-------|-------------|
| Max LTV | 90% | Higher LTV due to stability |
| Liquidation Threshold | 95% | Closer threshold (less volatility) |
| Liquidation Penalty | 3% | Lower penalty (less risk) |
| Min Deposit | 10 USDC | Minimum deposit amount |
| Interest Rate | 3% APR | Lower rate for stable collateral |
| Oracle Max Age | 1 hour | Max staleness for price feeds |

> **Note**: Each collateral type can be added via `register_collateral` instruction with custom parameters.

## Dependencies

```toml
[dependencies]
anchor-lang = "0.32.1"
anchor-spl = { version = "0.32.1", features = ["token"] }
```

## Getting Started

### Prerequisites
- Rust 1.89.0
- Solana CLI 3.1.6
- Anchor 0.32.1
- Node.js 20+
- Yarn

### Installation

```bash
# Install dependencies (also sets up git hooks)
yarn install

# Build the program
anchor build

# Run tests (requires local validator with Meteora DLMM)
anchor test
```

### Branch Naming Convention

This repo enforces branch naming via a git pre-push hook and CI check. Branches must follow:

```
feat/<name>      # New feature
fix/<name>       # Bug fix
chore/<name>     # Maintenance
docs/<name>      # Documentation
refactor/<name>  # Code refactoring
```

The hook is automatically configured when you run `yarn install`.

## Devnet Deployment

### 1. Build and Deploy

```bash
# Build the program
anchor build

# Deploy to devnet (IDL is uploaded automatically by Anchor 0.32+)
anchor deploy --provider.cluster devnet
```

### 2. Initialize Protocol

All scripts require `ANCHOR_PROVIDER_URL` and `ANCHOR_WALLET` env vars, or use `anchor run` which reads from `Anchor.toml`.

```bash
# Set env for devnet
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET=~/.config/solana/id.json

# Initialize protocol (config, oracle, collateral config, lending vault)
anchor run init-protocol

# Supply wSOL to the lending vault as LP
anchor run supply -- 8
```

### 3. Demo Scripts

```bash
# Update oracle price (for demoing LTV changes and liquidations)
anchor run update-oracle -- 150    # Set SOL = $150
anchor run update-oracle -- 80     # Drop to $80 (triggers liquidation)
anchor run update-oracle -- 200    # Pump to $200

# Supply / withdraw from lending vault
anchor run supply -- 5             # Supply 5 wSOL as LP
anchor run withdraw-lp             # Withdraw all supplied wSOL + interest
```

### Devnet Addresses

| Account | PDA Seeds | Description |
|---------|-----------|-------------|
| Program | `6ySvjJb41GBCBbtVvmaCd7cQUuzWFtqZ1SA931rEuSSx` | Program ID |
| Config | `["config"]` | Protocol config |
| Lending Vault | `["lending_vault"]` | Vault accounting |
| wSOL Vault | `["wsol_vault", lending_vault]` | wSOL token account |
| SOL Collateral Config | `["collateral_config", NATIVE_MINT]` | SOL risk params |
| Mock Oracle (SOL) | `["mock_oracle", NATIVE_MINT]` | Mock price oracle |
| User Position | `["position", owner, mint]` | Per-user position |
| Collateral Vault | `["vault", owner, mint]` | Per-user collateral (native SOL) |

## Testing

### Test Suite (58 tests)

```
Close Position (5 tests)
  - Closes DLMM position, repays debt, marks position Closed
  - Withdraws SOL collateral and closes position account
  - Closes in-range (losing) position with shortfall covered from collateral
  - Rejects close when position is not active
  - Rejects close by a different user

Collateral (8 tests)
  - SOL deposits (success, wrong mint, below minimum)
  - SPL token deposits (USDC success, wrong mint, below minimum)
  - Protocol pause prevents deposits
  - Withdraw collateral (blocked while active, wrong signer rejected)

Lending Vault (10 tests)
  - Vault initialization and state verification
  - LP supply, top-up, multiple LPs
  - Constraints (unauthorized init, double init, no position withdraw)
  - LP withdrawal with wSOL return

Liquidation (2 tests)
  - Liquidates unhealthy position, penalty from collateral to liquidator
  - Rejects liquidation of healthy position

Protocol Config (20 tests)
  - Initialization, collateral registration, risk param validation
  - Deposit collateral, pause/unpause, config updates
  - Multiple positions per user

Mock Oracle (6 tests)
  - Initialize, update price, timestamp refresh, auth checks

Open Position (5 tests)
  - Opens 2x leveraged DLMM position with wSOL
  - Verifies DLMM position has liquidity via SDK
  - Rejects when paused, LTV exceeded, insufficient liquidity, wrong user
```

Run tests:
```bash
anchor test
```

## Security Considerations

1. **Oracle Manipulation** - Staleness checks on mock oracle, per-collateral `oracle_max_age`
2. **Collateral Isolation** - Each user's collateral held in separate PDA vault
3. **Shortfall Coverage** - LP losses covered from user collateral via `sync_native` pattern
4. **Liquidation Incentives** - Penalty taken from collateral (not LP proceeds) ensures liquidator profit
5. **Access Control** - Position operations require owner signature, admin ops require authority
6. **Protocol Pause** - Emergency pause halts deposits and position opening

## CI/CD

Tests run automatically via GitHub Actions on push to `main`, `feat/**`, `fix/**` and on pull requests to `main`.

The pipeline:
1. Validates branch naming convention
2. Builds with Rust 1.89.0 (Rust deps cached)
3. Installs Solana CLI 3.1.6 (cached after first run)
4. Installs Anchor CLI 0.32.1 (cached after first run)
5. Installs Node dependencies (yarn cache)
6. Runs `anchor build` + `anchor test`

## Known Limitations (V1)

### Static LTV / Health Check

The current health check uses the **static collateral and debt amounts** recorded at position open time. Since both collateral and debt are denominated in SOL, oracle price changes cancel out and do not affect the LTV ratio.

In reality, the DLMM position value can diverge from the original debt:
- **Price moves through the position's bins** → SOL gets swapped to the paired token (impermanent loss)
- **On close/liquidation**, the LP proceeds may be less than the original borrowed amount
- The protocol handles this correctly at settlement (bad debt absorption, shortfall from collateral), but the **health check cannot detect it in advance**

**V2 fix**: Compute dynamic health by reading the DLMM position's bin shares on-chain and calculating their current SOL-equivalent value against the outstanding debt. This requires cross-program reads of Meteora's position and bin array accounts.

### Same-Asset Collateral and Debt

V1 uses SOL as both collateral and borrowed asset. This means:
- LTV is fixed at open time and never changes from market movements
- Liquidation can only be triggered by admin threshold changes or DLMM position value loss (which isn't tracked)

**V2 fix**: Support cross-asset collateral (e.g., deposit USDC, borrow SOL). When SOL price rises, debt value increases relative to collateral, naturally pushing LTV up and enabling market-driven liquidations.

## Future Enhancements (V2+)

### Health & Risk
- Dynamic health factor based on live DLMM position value
- Cross-asset collateral (USDC, mSOL, jitoSOL)
- Real oracle integration (Pyth, Switchboard)
- Partial liquidations

### Yield & Capital Efficiency
- Dynamic APY based on vault utilization (kink rate model)
- Fee compounding / auto-reinvestment
- Auto-rebalancing based on volatility
- Partial position closes

### Infrastructure
- Multiple leverage presets (2x, 3x, 5x)
- Integration with real lending protocols (Kamino, Solend)
- Support for additional DLMM pairs
- Frontend dashboard

## Resources

- [Meteora DLMM Docs](https://docs.meteora.ag/dlmm-documentation)
- [Anchor Framework](https://www.anchor-lang.com/)
- [Turbin3 Program](https://www.turbin3.org/)

## Project Status

**Feature Complete** - All core protocol functionality implemented and tested (58 tests passing).

- [x] Project planning and requirements
- [x] Project skeleton and base structure
- [x] Core state accounts (Config, Position, LendingVault, LpPosition, CollateralConfig)
- [x] Base instructions (initialize, register_collateral, deposit_collateral)
- [x] Lending vault (initialize_lending_vault, supply, withdraw with interest accrual)
- [x] Lending vault test suite with constraint validation
- [x] CI/CD pipeline (GitHub Actions) with Solana/Anchor/Rust caching
- [x] Branch naming enforcement (git hook + CI check)
- [x] Open position with Meteora DLMM CPI (one-sided wSOL liquidity)
- [x] Close position with debt repayment, surplus return, and shortfall coverage from collateral
- [x] Mock oracle for price feeds (initialize, update)
- [x] Health monitoring with oracle-based LTV calculation
- [x] Liquidation system with collateral-based penalty distribution
- [x] Collateral withdrawal after position closed
- [x] Admin config updates (pause, LTV params, penalty, oracle, min deposit, enable/disable)
- [x] Deployment scripts (init-protocol, update-oracle, supply, withdraw-lp, setup-pool, force-liquidate)
- [x] Frontend dashboard (Next.js + wallet adapter)
- [x] DLMM pool setup script for devnet
- [ ] Dynamic health factor based on live DLMM position value
- [ ] Cross-asset collateral support
- [ ] Dynamic APY based on vault utilization (kink rate model)
