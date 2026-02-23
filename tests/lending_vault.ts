import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MetlevEngine } from "../target/types/metlev_engine";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";

describe("Lending Vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.metlevEngine as Program<MetlevEngine>;
  const authority = provider.wallet.publicKey;

  const lp = Keypair.generate();
  const lp2 = Keypair.generate();

  let configPda: PublicKey;
  let lendingVaultPda: PublicKey;
  let solVaultPda: PublicKey;

  before(async () => {
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    [lendingVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lending_vault")],
      program.programId
    );

    [solVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sol_vault"), lendingVaultPda.toBuffer()],
      program.programId
    );

    // Airdrop to LP users
    for (const user of [lp, lp2]) {
      const sig = await provider.connection.requestAirdrop(
        user.publicKey,
        10 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Initialize protocol if needed
    try {
      await program.account.config.fetch(configPda);
      console.log("Protocol already initialized, skipping...");
    } catch {
      await program.methods
        .initialize()
        .accountsStrict({
          authority,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    // Initialize lending vault if needed
    try {
      await program.account.lendingVault.fetch(lendingVaultPda);
      console.log("Lending vault already initialized, skipping...");
    } catch {
      await program.methods
        .initializeLendingVault()
        .accountsStrict({
          authority,
          config: configPda,
          lendingVault: lendingVaultPda,
          solVault: solVaultPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("Lending vault initialized");
    }

    console.log("\n=== Setup Complete ===");
    console.log("Lending Vault PDA:", lendingVaultPda.toBase58());
    console.log("SOL Vault PDA:", solVaultPda.toBase58());
  });

  describe("Initialize Lending Vault", () => {
    it("Lending vault is initialized correctly", async () => {
      const vault = await program.account.lendingVault.fetch(lendingVaultPda);

      expect(vault.authority.toBase58()).to.equal(authority.toBase58());
      expect(vault.totalSupplied.toNumber()).to.equal(0);
      expect(vault.totalBorrowed.toNumber()).to.equal(0);

      const solVaultBalance = await provider.connection.getBalance(solVaultPda);
      expect(solVaultBalance).to.be.greaterThan(0);

      console.log("Vault authority:", vault.authority.toBase58());
      console.log("SOL vault balance (rent):", solVaultBalance, "lamports");
    });
  });

  describe("Supply", () => {
    it("LP supplies SOL and LP position is created", async () => {
      const supplyAmount = new anchor.BN(2 * LAMPORTS_PER_SOL);

      const [lpPositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_position"), lp.publicKey.toBuffer()],
        program.programId
      );

      const solVaultBefore = await provider.connection.getBalance(solVaultPda);
      const vaultStateBefore = await program.account.lendingVault.fetch(lendingVaultPda);

      await program.methods
        .supply(supplyAmount)
        .accountsStrict({
          signer: lp.publicKey,
          lendingVault: lendingVaultPda,
          solVault: solVaultPda,
          lpPosition: lpPositionPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([lp])
        .rpc();

      const lpPosition = await program.account.lpPosition.fetch(lpPositionPda);
      expect(lpPosition.lp.toBase58()).to.equal(lp.publicKey.toBase58());
      expect(lpPosition.suppliedAmount.toNumber()).to.equal(supplyAmount.toNumber());
      expect(lpPosition.interestEarned.toNumber()).to.equal(0);

      const vaultStateAfter = await program.account.lendingVault.fetch(lendingVaultPda);
      expect(vaultStateAfter.totalSupplied.toNumber()).to.equal(
        vaultStateBefore.totalSupplied.toNumber() + supplyAmount.toNumber()
      );

      const solVaultAfter = await provider.connection.getBalance(solVaultPda);
      expect(solVaultAfter - solVaultBefore).to.equal(supplyAmount.toNumber());

      console.log("LP supplied:", supplyAmount.toNumber() / LAMPORTS_PER_SOL, "SOL");
      console.log("SOL vault balance:", solVaultAfter / LAMPORTS_PER_SOL, "SOL");
      console.log("Total supplied:", vaultStateAfter.totalSupplied.toNumber() / LAMPORTS_PER_SOL, "SOL");
    });

    it("LP can top-up supply (second deposit)", async () => {
      const topUpAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);

      const [lpPositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_position"), lp.publicKey.toBuffer()],
        program.programId
      );

      const positionBefore = await program.account.lpPosition.fetch(lpPositionPda);

      await program.methods
        .supply(topUpAmount)
        .accountsStrict({
          signer: lp.publicKey,
          lendingVault: lendingVaultPda,
          solVault: solVaultPda,
          lpPosition: lpPositionPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([lp])
        .rpc();

      const positionAfter = await program.account.lpPosition.fetch(lpPositionPda);
      expect(positionAfter.suppliedAmount.toNumber()).to.equal(
        positionBefore.suppliedAmount.toNumber() + topUpAmount.toNumber()
      );

      console.log("LP top-up successful");
      console.log("Total supplied by LP:", positionAfter.suppliedAmount.toNumber() / LAMPORTS_PER_SOL, "SOL");
    });

    it("Multiple LPs can supply independently", async () => {
      const supplyAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);

      const [lp2PositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_position"), lp2.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .supply(supplyAmount)
        .accountsStrict({
          signer: lp2.publicKey,
          lendingVault: lendingVaultPda,
          solVault: solVaultPda,
          lpPosition: lp2PositionPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([lp2])
        .rpc();

      const lp2Position = await program.account.lpPosition.fetch(lp2PositionPda);
      expect(lp2Position.lp.toBase58()).to.equal(lp2.publicKey.toBase58());
      expect(lp2Position.suppliedAmount.toNumber()).to.equal(supplyAmount.toNumber());

      const vaultState = await program.account.lendingVault.fetch(lendingVaultPda);
      console.log("Total vault supplied:", vaultState.totalSupplied.toNumber() / LAMPORTS_PER_SOL, "SOL");
    });
  });
});
