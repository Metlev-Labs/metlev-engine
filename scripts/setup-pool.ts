/**
 * setup-pool.ts
 *
 * Creates a DLMM pool on devnet with wSOL (Y) and a custom token (X),
 * seeds it with thin two-sided liquidity for demo purposes.
 *
 * Pool is designed so small swaps (~0.5 SOL) visibly move the active bin.
 * The CLI wallet keeps ~498 tokens for "whale" sell/buy demo swaps.
 *
 * Demo flow:
 *   1. User supplies SOL to lending vault
 *   2. User deposits collateral + opens 2x leveraged position (5 bins)
 *   3. Whale sells tokens → active bin sweeps through user's position → fees!
 *   4. Whale buys back → position refunded
 *   5. User closes → profit visible
 *
 * Usage:
 *   anchor run setup-pool
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

  // Step 2: Mint tokens and wrap SOL
  // Mint 500 tokens — 2 go to pool seed, ~498 stay in wallet for whale swaps
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
    BigInt(500) * BigInt(10 ** 9) // 500 tokens
  );
  console.log("  Minted 500 custom tokens (2 for pool, ~498 for whale swaps)");

  // Wrap SOL for liquidity seeding + whale buy-back swaps
  const wsolAta = await getOrCreateAssociatedTokenAccount(
    connection,
    provider.wallet.payer,
    NATIVE_MINT,
    authority
  );
  const wrapAmount = 5 * LAMPORTS_PER_SOL;
  const wrapTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: authority,
      toPubkey: wsolAta.address,
      lamports: wrapAmount,
    }),
    createSyncNativeInstruction(wsolAta.address)
  );
  await provider.sendAndConfirm(wrapTx);
  console.log("  Wrapped 5 SOL (2 for pool, ~3 reserve)");

  // Step 3: Create the DLMM pool
  console.log("[3/4] Creating DLMM pool...");
  const createPoolTx = await (DLMM as any).createCustomizablePermissionlessLbPair(
    connection,
    new BN(200),          // binStep (200 bps = 2% per bin)
    customMint,           // token X
    NATIVE_MINT,          // token Y (wSOL)
    new BN(0),            // activeId
    new BN(1000),          // feeBps (10%)
    0,                    // activationType = Slot
    false,                // hasAlphaVault
    authority,            // creator
    null,                 // activationPoint (immediate)
    false,                // creatorPoolOnOffControl
    { cluster: "devnet" }
  );

  createPoolTx.feePayer = authority;
  createPoolTx.recentBlockhash = (
    await connection.getLatestBlockhash()
  ).blockhash;
  await sendAndConfirmTransaction(connection, createPoolTx, [
    provider.wallet.payer,
  ]);

  const [lbPair] = (DLMM as any).deriveCustomizablePermissionlessLbPair(
    customMint,
    NATIVE_MINT,
    DLMM_PROGRAM_ID
  );
  console.log("  Pool created:", lbPair.toBase58());

  // Step 4: Seed thin two-sided liquidity
  // 2 tokens + 2 SOL across ±20 bins (41 bins)
  // = ~0.05 SOL/bin and ~0.05 token/bin
  // A 0.5 SOL swap moves the bin ~10 positions — very visual!
  console.log("[4/4] Seeding two-sided liquidity...");
  const dlmmPool = await DLMM.create(connection, lbPair, {
    cluster: "devnet",
  });
  await dlmmPool.refetchStates();

  const activeBin = await dlmmPool.getActiveBin();
  const SEED_RANGE = 20;
  const seedMinBin = activeBin.binId - SEED_RANGE;
  const seedMaxBin = activeBin.binId + SEED_RANGE;

  const mmPositionKp = Keypair.generate();
  const addLiqTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: mmPositionKp.publicKey,
    user: authority,
    totalXAmount: new BN(2).mul(new BN(10 ** 9)),       // 2 tokens
    totalYAmount: new BN(2 * LAMPORTS_PER_SOL),          // 2 SOL
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
  console.log("  Liquidity seeded: bins", seedMinBin, "to", seedMaxBin, "(41 bins)");
  console.log("  Per bin: ~0.05 SOL + ~0.05 token");

  // Summary
  console.log("\n=== Pool Ready ===");
  console.log("LB_PAIR       :", lbPair.toBase58());
  console.log("Custom Mint   :", customMint.toBase58());
  console.log("Token X       :", dlmmPool.lbPair.tokenXMint.toBase58(), isWsolX ? "(wSOL)" : "(custom)");
  console.log("Token Y       :", dlmmPool.lbPair.tokenYMint.toBase58(), !isWsolX ? "(wSOL)" : "(custom)");
  console.log("Active Bin    :", activeBin.binId);
  console.log("Bin Step      : 200 bps (2% per bin)");
  console.log("Fee           : 1000 bps (10%)");

  console.log("\n=== Demo Plan ===");
  console.log("1. Supply 5 SOL to lending vault (LP)");
  console.log("2. Deposit 1 SOL collateral + open 2x leveraged position");
  console.log("3. Whale: sell ~1.5 SOL worth of tokens to sweep through position bins");
  console.log("4. Whale: buy ~1.5 SOL of tokens to restore position");
  console.log("5. Close position — show fees earned!");

  console.log("\nCLI wallet has ~498 tokens for whale swaps.");
  console.log("Send tokens to Phantom via: spl-token transfer", customMint.toBase58(), "<amount> <phantom-address> --fund-recipient");
  console.log("");
  console.log("Update LB_PAIR in metlev-frontend/src/lib/dlmm.ts with:");
  console.log(`  export const LB_PAIR = new PublicKey("${lbPair.toBase58()}");`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
