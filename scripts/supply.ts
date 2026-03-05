/**
 * supply.ts
 *
 * Supply wSOL to the lending vault as an LP.
 *
 * Usage:
 *   npx ts-node scripts/supply.ts <amount_sol>
 *
 * Examples:
 *   npx ts-node scripts/supply.ts 5     # Supply 5 SOL
 *   npx ts-node scripts/supply.ts 0.5   # Supply 0.5 SOL
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { MetlevEngine } from "../target/types/metlev_engine";
import {
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  createSyncNativeInstruction,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";

async function main() {
  const amountArg = process.argv[2];
  if (!amountArg) {
    console.log("Usage: npx ts-node scripts/supply.ts <amount_sol>");
    process.exit(1);
  }

  const amountSol = parseFloat(amountArg);
  if (isNaN(amountSol) || amountSol <= 0) {
    console.error("Invalid amount:", amountArg);
    process.exit(1);
  }

  const amountLamports = new BN(Math.round(amountSol * LAMPORTS_PER_SOL));

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.metlevEngine as Program<MetlevEngine>;
  const signer = provider.wallet.publicKey;

  const [lendingVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lending_vault")],
    program.programId
  );
  const [wsolVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("wsol_vault"), lendingVaultPda.toBuffer()],
    program.programId
  );
  const [lpPositionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_position"), signer.toBuffer()],
    program.programId
  );

  // Wrap SOL
  const signerWsolAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    provider.wallet.payer,
    NATIVE_MINT,
    signer
  );

  const wrapTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: signer,
      toPubkey: signerWsolAta.address,
      lamports: amountLamports.toNumber(),
    }),
    createSyncNativeInstruction(signerWsolAta.address)
  );
  await provider.sendAndConfirm(wrapTx);

  // Supply
  await program.methods
    .supply(amountLamports)
    .accountsStrict({
      signer,
      lendingVault: lendingVaultPda,
      wsolMint: NATIVE_MINT,
      wsolVault: wsolVaultPda,
      signerWsolAta: signerWsolAta.address,
      lpPosition: lpPositionPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const lpPosition = await program.account.lpPosition.fetch(lpPositionPda);
  const vault = await program.account.lendingVault.fetch(lendingVaultPda);

  console.log("Supplied", amountSol, "wSOL to lending vault.");
  console.log("LP total supplied:", lpPosition.suppliedAmount.toNumber() / LAMPORTS_PER_SOL, "wSOL");
  console.log("Vault total supplied:", vault.totalSupplied.toNumber() / LAMPORTS_PER_SOL, "wSOL");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
