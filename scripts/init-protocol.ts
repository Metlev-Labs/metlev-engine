/**
 * init-protocol.ts
 *
 * One-shot script to bootstrap the protocol on devnet after deployment.
 * Idempotent: safe to re-run — skips anything already initialised.
 *
 * Usage:
 *   npx ts-node scripts/init-protocol.ts
 *
 * Requires ANCHOR_PROVIDER_URL and ANCHOR_WALLET env vars
 * (or run via: anchor run init-protocol)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { MetlevEngine } from "../target/types/metlev_engine";
import {
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";

// ── Config ──────────────────────────────────────────────────────────────────
const SOL_ORACLE_PRICE = new BN(150_000_000); // $150 (6 decimals)
const SOL_COLLATERAL = {
  maxLtv: 7500,                // 75%
  liquidationThreshold: 8000,  // 80%
  liquidationPenalty: 500,     // 5%
  minDeposit: new BN(Math.floor(0.1 * LAMPORTS_PER_SOL)),
  interestRateBps: 500,        // 5%
  oracleMaxAge: new BN(3600),  // 1 hour
};

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.metlevEngine as Program<MetlevEngine>;
  const authority = provider.wallet.publicKey;

  console.log("=== Metlev Engine — Init Protocol ===");
  console.log("Program ID :", program.programId.toBase58());
  console.log("Authority  :", authority.toBase58());
  console.log("Cluster    :", provider.connection.rpcEndpoint);
  console.log("");

  // ── Derive PDAs ─────────────────────────────────────────────────────────
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const [lendingVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lending_vault")],
    program.programId
  );
  const [wsolVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("wsol_vault"), lendingVaultPda.toBuffer()],
    program.programId
  );
  const [collateralConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("collateral_config"), NATIVE_MINT.toBuffer()],
    program.programId
  );
  const [mockOraclePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mock_oracle"), NATIVE_MINT.toBuffer()],
    program.programId
  );

  // ── 1. Initialize protocol config ──────────────────────────────────────
  try {
    await program.account.config.fetch(configPda);
    console.log("[1/4] Config already initialized, skipping.");
  } catch {
    await program.methods
      .initialize()
      .accountsStrict({
        authority,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("[1/4] Protocol config initialized.");
  }

  // ── 2. Initialize mock oracle ──────────────────────────────────────────
  try {
    await program.account.mockOracle.fetch(mockOraclePda);
    console.log("[2/4] Mock oracle already initialized, skipping.");
    // Refresh the timestamp
    await program.methods
      .updateMockOracle(SOL_ORACLE_PRICE)
      .accountsStrict({
        authority,
        config: configPda,
        mint: NATIVE_MINT,
        mockOracle: mockOraclePda,
      })
      .rpc();
    console.log("       Oracle price refreshed to $" + SOL_ORACLE_PRICE.toNumber() / 1_000_000);
  } catch {
    await program.methods
      .initializeMockOracle(SOL_ORACLE_PRICE)
      .accountsStrict({
        authority,
        config: configPda,
        mint: NATIVE_MINT,
        mockOracle: mockOraclePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("[2/4] Mock oracle initialized at $" + SOL_ORACLE_PRICE.toNumber() / 1_000_000);
  }

  // ── 3. Register SOL collateral config ──────────────────────────────────
  try {
    await program.account.collateralConfig.fetch(collateralConfigPda);
    console.log("[3/4] SOL collateral config already registered, skipping.");
  } catch {
    await program.methods
      .registerCollateral(
        mockOraclePda,
        SOL_COLLATERAL.maxLtv,
        SOL_COLLATERAL.liquidationThreshold,
        SOL_COLLATERAL.liquidationPenalty,
        SOL_COLLATERAL.minDeposit,
        SOL_COLLATERAL.interestRateBps,
        SOL_COLLATERAL.oracleMaxAge,
      )
      .accountsStrict({
        authority,
        config: configPda,
        mint: NATIVE_MINT,
        collateralConfig: collateralConfigPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("[3/4] SOL collateral registered.");
    console.log("       Max LTV:", SOL_COLLATERAL.maxLtv / 100, "%");
    console.log("       Liquidation threshold:", SOL_COLLATERAL.liquidationThreshold / 100, "%");
    console.log("       Liquidation penalty:", SOL_COLLATERAL.liquidationPenalty / 100, "%");
  }

  // ── 4. Initialize lending vault ────────────────────────────────────────
  try {
    await program.account.lendingVault.fetch(lendingVaultPda);
    console.log("[4/4] Lending vault already initialized, skipping.");
  } catch {
    await program.methods
      .initializeLendingVault()
      .accountsStrict({
        authority,
        config: configPda,
        lendingVault: lendingVaultPda,
        wsolMint: NATIVE_MINT,
        wsolVault: wsolVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("[4/4] Lending vault initialized.");
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log("\n=== PDAs ===");
  console.log("Config            :", configPda.toBase58());
  console.log("Lending Vault     :", lendingVaultPda.toBase58());
  console.log("wSOL Vault        :", wsolVaultPda.toBase58());
  console.log("SOL Collateral Cfg:", collateralConfigPda.toBase58());
  console.log("Mock Oracle (SOL) :", mockOraclePda.toBase58());
  console.log("\nProtocol ready. Next step: anchor run supply -- <amount>");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
