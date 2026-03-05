/**
 * drain-pool.ts
 *
 * Removes all liquidity from the current DLMM pool.
 * Run this before setup-pool to start fresh with balanced liquidity.
 *
 * Usage:
 *   anchor run drain-pool
 */

import * as anchor from "@coral-xyz/anchor";
import DLMM from "@meteora-ag/dlmm";
import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

// Current pool — update this to match your LB_PAIR
const LB_PAIR = new PublicKey("9E3m4i6pfnYho5jpHVXgupz6dwX1osAbg918CjHrM674");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const authority = provider.wallet.publicKey;
  const connection = provider.connection;

  console.log("=== Drain DLMM Pool ===");
  console.log("Authority:", authority.toBase58());
  console.log("Pool     :", LB_PAIR.toBase58());

  const dlmmPool = await DLMM.create(connection, LB_PAIR, { cluster: "devnet" });
  await dlmmPool.refetchStates();

  // Find all positions owned by authority
  const positions = await dlmmPool.getPositionsByUserAndLbPair(authority);

  if (!positions.userPositions || positions.userPositions.length === 0) {
    console.log("No positions found for authority. Nothing to drain.");
    return;
  }

  console.log(`Found ${positions.userPositions.length} position(s)`);

  for (const pos of positions.userPositions) {
    const positionPubkey = pos.publicKey;
    const bins = pos.positionData.positionBinData;

    if (!bins || bins.length === 0) {
      console.log(`  Position ${positionPubkey.toBase58()} has no bins, skipping.`);
      continue;
    }

    console.log(`  Removing liquidity from position ${positionPubkey.toBase58()}`);
    console.log(`    Bins: ${bins[0].binId} to ${bins[bins.length - 1].binId} (${bins.length} bins)`);

    const fromBinId = bins[0].binId;
    const toBinId = bins[bins.length - 1].binId;

    // Remove all liquidity
    const removeLiqTxs = await dlmmPool.removeLiquidity({
      position: positionPubkey,
      user: authority,
      fromBinId,
      toBinId,
      bps: new anchor.BN(10000), // 100%
      shouldClaimAndClose: true,
    });

    const txList = Array.isArray(removeLiqTxs) ? removeLiqTxs : [removeLiqTxs];
    for (const tx of txList) {
      (tx as Transaction).feePayer = authority;
      (tx as Transaction).recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(connection, tx as Transaction, [provider.wallet.payer]);
    }

    console.log(`    Done.`);
  }

  console.log("\nPool drained successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
