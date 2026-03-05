/**
 * force-liquidate.ts
 *
 * Emergency script to liquidate a stuck position by:
 * 1. Dropping the oracle price to make the position unhealthy
 * 2. Calling liquidate with the known DLMM position address
 * 3. Restoring the oracle price
 *
 * Usage:
 *   anchor run force-liquidate
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { MetlevEngine } from "../target/types/metlev_engine";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import DLMM from "@meteora-ag/dlmm";

// ── Known addresses from the stuck transaction ──
const DLMM_POSITION = new PublicKey(
  "Eh4MVpB9Ykvwpa7dhZrQzJoHdGUwWbYFbDEniTFRinFi"
);
const LB_PAIR = new PublicKey(
  "49SMeRravr4WEfbJQY9d38PAoA3E5pxKxtvKoYN8wp3a"
);
const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
);

// The wallet that opened the position (Phantom browser wallet)
const POSITION_OWNER = new PublicKey(
  "hry6ZGfH4mMmF4LBDFiWjV23bScUQ3NjVrWb9esFS5S"
);

// Position was opened with lower_bin_id = -4, width = 5 → bins -4 to 0
const FROM_BIN_ID = -4;
const TO_BIN_ID = 0;

function binArrayIndex(binId: number): BN {
  const BIN_ARRAY_SIZE = 70;
  const quotient = Math.trunc(binId / BIN_ARRAY_SIZE);
  const remainder = binId % BIN_ARRAY_SIZE;
  const index = remainder < 0 ? quotient - 1 : quotient;
  return new BN(index);
}

function deriveBinArrayPda(lbPair: PublicKey, index: BN): PublicKey {
  const indexBuf = Buffer.alloc(8);
  const val = index.toNumber();
  const lo = val & 0xffffffff;
  const hi = val < 0 ? -1 : 0;
  indexBuf.writeInt32LE(lo, 0);
  indexBuf.writeInt32LE(hi, 4);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bin_array"), lbPair.toBuffer(), indexBuf],
    DLMM_PROGRAM_ID
  );
  return pda;
}

function deriveEventAuthority(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DLMM_PROGRAM_ID
  );
  return pda;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.metlevEngine as Program<MetlevEngine>;
  const authority = provider.wallet.publicKey;
  const connection = provider.connection;

  console.log("=== Force Liquidate Stuck Position ===");
  console.log("Authority:", authority.toBase58());

  // Derive PDAs
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
  const [priceOraclePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mock_oracle"), NATIVE_MINT.toBuffer()],
    program.programId
  );
  const [positionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), POSITION_OWNER.toBuffer(), NATIVE_MINT.toBuffer()],
    program.programId
  );
  const [collateralVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), POSITION_OWNER.toBuffer(), NATIVE_MINT.toBuffer()],
    program.programId
  );

  // Fetch current state
  const position = await program.account.position.fetch(positionPda);
  const oracleBefore = await program.account.mockOracle.fetch(priceOraclePda);
  const priceBefore = oracleBefore.price.toNumber() / 1_000_000;

  console.log("\nPosition state:");
  console.log("  Debt:", position.debtAmount.toNumber() / 1e9, "SOL");
  console.log("  Collateral:", position.collateralAmount.toNumber() / 1e9, "SOL");
  console.log("  Status:", Object.keys(position.status)[0]);
  console.log("  Meteora position:", position.meteoraPosition.toBase58());
  console.log("  Oracle price: $" + priceBefore);

  if (position.debtAmount.isZero()) {
    console.log("\nPosition has no debt, nothing to liquidate.");
    return;
  }

  // Step 1: Drop oracle price to make position unhealthy
  // LTV = debt / (collateral + debt). With 1 SOL collateral and 2 SOL debt,
  // LTV = 2/3 = 66.7%. Liq threshold is typically 80%.
  // We need LTV > threshold. Setting price very low doesn't change LTV since
  // both collateral and debt are in SOL.
  // But the LTV formula uses collateral_value and debt_value independently.
  // Actually since both are SOL-denominated, the price cancels out.
  // Let me check the collateral config threshold.
  const collateralConfig = await program.account.collateralConfig.fetch(collateralConfigPda);
  const liqThreshold = collateralConfig.liquidationThreshold / 100;
  const currentLtv = position.debtAmount.toNumber() /
    (position.collateralAmount.toNumber() + position.debtAmount.toNumber()) * 100;

  console.log("\n  Current LTV:", currentLtv.toFixed(1) + "%");
  console.log("  Liq threshold:", liqThreshold + "%");

  if (currentLtv < liqThreshold) {
    // Need to lower the threshold temporarily or raise LTV.
    // Since both sides are SOL, price changes don't help.
    // We need to lower the liquidation threshold below current LTV.
    console.log("\n  Position is healthy at current LTV. Lowering liquidation threshold...");

    // Must satisfy: liquidation_threshold > max_ltv, and threshold < currentLtv
    // So set both below currentLtv with threshold slightly above maxLtv.
    const newMaxLtv = Math.floor(currentLtv * 100) - 200;       // e.g., 6470
    const newThreshold = Math.floor(currentLtv * 100) - 100;    // e.g., 6570
    await program.methods
      .updateCollateralLtvParams(
        NATIVE_MINT,
        newMaxLtv,
        newThreshold,
      )
      .accountsStrict({
        authority,
        config: configPda,
        collateralConfig: collateralConfigPda,
      })
      .rpc();
    console.log("  Max LTV lowered to " + (newMaxLtv / 100) + "%, threshold to " + (newThreshold / 100) + "%");
  }

  // Step 2: Load DLMM pool for reserve/mint info
  console.log("\n[2] Loading DLMM pool...");
  const dlmmPool = await DLMM.create(connection, LB_PAIR, { cluster: "devnet" });

  const lowerIdx = binArrayIndex(FROM_BIN_ID);
  const upperIdx = binArrayIndex(TO_BIN_ID);
  const binArrayLower = deriveBinArrayPda(LB_PAIR, lowerIdx);
  const binArrayUpper = deriveBinArrayPda(LB_PAIR, upperIdx);

  // Get or create the lending vault's token X ATA
  const userTokenXAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    provider.wallet.payer,
    dlmmPool.lbPair.tokenXMint,
    lendingVaultPda,
    true // allowOwnerOffCurve
  );

  console.log("  Bin arrays:", lowerIdx.toString(), "to", upperIdx.toString());
  console.log("  Token X mint:", dlmmPool.lbPair.tokenXMint.toBase58());

  // Step 3: Update oracle (refresh timestamp so it's not stale)
  console.log("\n[3] Refreshing oracle timestamp...");
  await program.methods
    .updateMockOracle(oracleBefore.price)
    .accountsStrict({
      authority,
      config: configPda,
      mint: NATIVE_MINT,
      mockOracle: priceOraclePda,
    })
    .rpc();

  // Step 4: Call liquidate
  console.log("\n[4] Calling liquidate...");
  const tx = await program.methods
    .liquidate(FROM_BIN_ID, TO_BIN_ID)
    .accountsStrict({
      liquidator: authority,
      config: configPda,
      wsolMint: NATIVE_MINT,
      position: positionPda,
      lendingVault: lendingVaultPda,
      collateralConfig: collateralConfigPda,
      priceOracle: priceOraclePda,
      wsolVault: wsolVaultPda,
      positionOwner: POSITION_OWNER,
      collateralVault,
      metPosition: DLMM_POSITION,
      lbPair: LB_PAIR,
      binArrayBitmapExtension: null,
      userTokenX: userTokenXAccount.address,
      reserveX: dlmmPool.lbPair.reserveX,
      reserveY: dlmmPool.lbPair.reserveY,
      tokenXMint: dlmmPool.lbPair.tokenXMint,
      tokenYMint: dlmmPool.lbPair.tokenYMint,
      binArrayLower,
      binArrayUpper,
      oracle: dlmmPool.lbPair.oracle,
      eventAuthority: deriveEventAuthority(),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      dlmmProgram: DLMM_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([
      anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ])
    .rpc();

  console.log("  Liquidation tx:", tx);

  // Step 5: Restore liquidation threshold
  console.log("\n[5] Restoring liquidation threshold...");
  await program.methods
    .updateCollateralLtvParams(
      NATIVE_MINT,
      collateralConfig.maxLtv,                   // restore original maxLtv
      collateralConfig.liquidationThreshold,     // restore original threshold
    )
    .accountsStrict({
      authority,
      config: configPda,
      collateralConfig: collateralConfigPda,
    })
    .rpc();

  // Verify
  const positionAfter = await program.account.position.fetch(positionPda);
  console.log("\nPosition after liquidation:");
  console.log("  Debt:", positionAfter.debtAmount.toNumber() / 1e9, "SOL");
  console.log("  Collateral:", positionAfter.collateralAmount.toNumber() / 1e9, "SOL");
  console.log("  Status:", Object.keys(positionAfter.status)[0]);
  console.log("\nDone! Position cleared.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
