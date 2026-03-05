/**
 * setup-pool.ts
 *
 * Creates a DLMM pool on devnet with wSOL as one side and seeds it with
 * two-sided liquidity so leveraged positions can be opened.
 *
 * Uses wSOL/wSOL pool (both sides are wSOL) for simplicity —
 * the protocol only deposits wSOL-side liquidity anyway.
 *
 * Usage:
 *   anchor run setup-pool
 *
 * Outputs the LB_PAIR address to use in the frontend constants.
 */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import DLMM from "@meteora-ag/dlmm";
import {
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";

const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
);

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const authority = provider.wallet.publicKey;
  const connection = provider.connection;

  console.log("=== Metlev Engine — Setup DLMM Pool ===");
  console.log("Authority:", authority.toBase58());
  console.log("Cluster  :", connection.rpcEndpoint);
  console.log("");

  // Step 1: Create a custom SPL token (the "other side" of the pool)
  console.log("[1/4] Creating custom token mint...");
  const customMint = await createMint(
    connection,
    provider.wallet.payer,
    authority,
    null,
    9 // 9 decimals like SOL
  );
  console.log("  Custom mint:", customMint.toBase58());

  // Step 2: Mint tokens and wrap SOL for seeding liquidity
  console.log("[2/4] Minting tokens and wrapping SOL...");

  const customAta = await getOrCreateAssociatedTokenAccount(
    connection,
    provider.wallet.payer,
    customMint,
    authority
  );
  await mintTo(
    connection,
    provider.wallet.payer,
    customMint,
    customAta.address,
    authority,
    BigInt(100_000) * BigInt(10 ** 9) // 100K tokens
  );
  console.log("  Minted 100K custom tokens");

  // Wrap SOL for liquidity seeding
  const wsolAta = await getOrCreateAssociatedTokenAccount(
    connection,
    provider.wallet.payer,
    NATIVE_MINT,
    authority
  );
  const wrapAmount = 2 * LAMPORTS_PER_SOL;
  const wrapTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: authority,
      toPubkey: wsolAta.address,
      lamports: wrapAmount,
    }),
    createSyncNativeInstruction(wsolAta.address)
  );
  await provider.sendAndConfirm(wrapTx);
  console.log("  Wrapped 2 SOL");

  // Step 3: Create the DLMM pool
  console.log("[3/4] Creating DLMM pool...");
  const createPoolTx = await (DLMM as any).createCustomizablePermissionlessLbPair(
    connection,
    new BN(10),           // binStep (10 bps = 0.1%)
    customMint,           // token X
    NATIVE_MINT,          // token Y (wSOL)
    new BN(0),            // activeId
    new BN(50),           // feeBps (0.5%)
    0,                    // activationType = Slot
    false,                // hasAlphaVault
    authority,            // creator
    null,                 // activationPoint (immediate)
    false,                // creatorPoolOnOffControl
    { cluster: "devnet" }
  );

  // Send with explicit fee payer
  createPoolTx.feePayer = authority;
  createPoolTx.recentBlockhash = (
    await connection.getLatestBlockhash()
  ).blockhash;
  await sendAndConfirmTransaction(connection, createPoolTx, [
    provider.wallet.payer,
  ]);

  // Derive the pool address
  const [lbPair] = (DLMM as any).deriveCustomizablePermissionlessLbPair(
    customMint,
    NATIVE_MINT,
    DLMM_PROGRAM_ID
  );
  console.log("  Pool created:", lbPair.toBase58());

  // Step 4: Seed two-sided liquidity
  console.log("[4/4] Seeding two-sided liquidity...");
  const dlmmPool = await DLMM.create(connection, lbPair, {
    cluster: "devnet",
  });
  await dlmmPool.refetchStates();

  const activeBin = await dlmmPool.getActiveBin();
  const SEED_RANGE = 30;
  const seedMinBin = activeBin.binId - SEED_RANGE;
  const seedMaxBin = activeBin.binId + SEED_RANGE;

  const mmPositionKp = Keypair.generate();
  const addLiqTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: mmPositionKp.publicKey,
    user: authority,
    totalXAmount: new BN(50_000).mul(new BN(10 ** 9)), // 50K custom tokens
    totalYAmount: new BN(1 * LAMPORTS_PER_SOL),         // 1 SOL
    strategy: {
      maxBinId: seedMaxBin,
      minBinId: seedMinBin,
      strategyType: 0, // Spot
    },
  });

  if (Array.isArray(addLiqTx)) {
    for (const tx of addLiqTx) {
      tx.feePayer = authority;
      tx.recentBlockhash = (
        await connection.getLatestBlockhash()
      ).blockhash;
      await sendAndConfirmTransaction(connection, tx, [
        provider.wallet.payer,
        mmPositionKp,
      ]);
    }
  } else {
    addLiqTx.feePayer = authority;
    addLiqTx.recentBlockhash = (
      await connection.getLatestBlockhash()
    ).blockhash;
    await sendAndConfirmTransaction(connection, addLiqTx, [
      provider.wallet.payer,
      mmPositionKp,
    ]);
  }

  const isWsolX = dlmmPool.lbPair.tokenXMint.equals(NATIVE_MINT);
  console.log("  Liquidity seeded: bins", seedMinBin, "to", seedMaxBin);

  // Summary
  console.log("\n=== Pool Ready ===");
  console.log("LB_PAIR       :", lbPair.toBase58());
  console.log("Custom Mint   :", customMint.toBase58());
  console.log("Token X       :", dlmmPool.lbPair.tokenXMint.toBase58(), isWsolX ? "(wSOL)" : "(custom)");
  console.log("Token Y       :", dlmmPool.lbPair.tokenYMint.toBase58(), !isWsolX ? "(wSOL)" : "(custom)");
  console.log("Active Bin    :", activeBin.binId);
  console.log("Bin Step      : 10 bps (0.1%)");
  console.log("Reserve X     :", dlmmPool.lbPair.reserveX.toBase58());
  console.log("Reserve Y     :", dlmmPool.lbPair.reserveY.toBase58());
  console.log("");
  console.log("Update LB_PAIR in metlev-frontend/src/lib/dlmm.ts with:");
  console.log(`  export const LB_PAIR = new PublicKey("${lbPair.toBase58()}");`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
