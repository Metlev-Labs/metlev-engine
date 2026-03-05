/**
 * withdraw-lp.ts
 *
 * Withdraw all supplied wSOL from the lending vault (closes LP position).
 * Returns supplied amount + accrued interest.
 *
 * Usage:
 *   npx ts-node scripts/withdraw-lp.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MetlevEngine } from "../target/types/metlev_engine";
import {
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";

async function main() {
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

  // Check LP position exists
  let lpPosition;
  try {
    lpPosition = await program.account.lpPosition.fetch(lpPositionPda);
  } catch {
    console.log("No LP position found for", signer.toBase58());
    process.exit(1);
  }

  console.log("LP position found:");
  console.log("  Supplied:", lpPosition.suppliedAmount.toNumber() / LAMPORTS_PER_SOL, "wSOL");
  console.log("  Interest earned:", lpPosition.interestEarned.toNumber() / LAMPORTS_PER_SOL, "wSOL");

  const signerWsolAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    provider.wallet.payer,
    NATIVE_MINT,
    signer
  );

  const balanceBefore = await provider.connection.getTokenAccountBalance(signerWsolAta.address);

  await program.methods
    .withdraw()
    .accountsStrict({
      signer,
      lpPosition: lpPositionPda,
      lendingVault: lendingVaultPda,
      wsolMint: NATIVE_MINT,
      wsolVault: wsolVaultPda,
      signerWsolAta: signerWsolAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const balanceAfter = await provider.connection.getTokenAccountBalance(signerWsolAta.address);
  const received = (parseInt(balanceAfter.value.amount) - parseInt(balanceBefore.value.amount)) / LAMPORTS_PER_SOL;

  console.log("Withdrawn successfully. Received:", received, "wSOL");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
