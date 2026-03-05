/**
 * update-oracle.ts
 *
 * Updates the mock oracle price for SOL. Use this to demo LTV changes
 * and trigger liquidations.
 *
 * Usage:
 *   npx ts-node scripts/update-oracle.ts <price_usd>
 *
 * Examples:
 *   npx ts-node scripts/update-oracle.ts 150    # Set SOL = $150
 *   npx ts-node scripts/update-oracle.ts 80     # Drop to $80 (triggers liquidation)
 *   npx ts-node scripts/update-oracle.ts 200    # Pump to $200
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { MetlevEngine } from "../target/types/metlev_engine";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";

async function main() {
  const priceArg = process.argv[2];
  if (!priceArg) {
    console.log("Usage: npx ts-node scripts/update-oracle.ts <price_usd>");
    console.log("Example: npx ts-node scripts/update-oracle.ts 150");
    process.exit(1);
  }

  const priceUsd = parseFloat(priceArg);
  if (isNaN(priceUsd) || priceUsd <= 0) {
    console.error("Invalid price:", priceArg);
    process.exit(1);
  }

  // Oracle stores price with 6 decimals
  const priceRaw = new BN(Math.round(priceUsd * 1_000_000));

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.metlevEngine as Program<MetlevEngine>;
  const authority = provider.wallet.publicKey;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const [mockOraclePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mock_oracle"), NATIVE_MINT.toBuffer()],
    program.programId
  );

  // Fetch current price
  const oracleBefore = await program.account.mockOracle.fetch(mockOraclePda);
  const priceBefore = oracleBefore.price.toNumber() / 1_000_000;

  await program.methods
    .updateMockOracle(priceRaw)
    .accountsStrict({
      authority,
      config: configPda,
      mint: NATIVE_MINT,
      mockOracle: mockOraclePda,
    })
    .rpc();

  console.log("SOL oracle updated: $" + priceBefore + " -> $" + priceUsd);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
