import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MetlevEngine } from "../target/types/metlev_engine";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
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
  let tokenXVaultPda: PublicKey;
  let tokenYVaultPda: PublicKey;

  const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
  let USDC_MINT: PublicKey;


  before(async () => {
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    [lendingVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lending_vault")],
      program.programId
    );

    [tokenXVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_x_vault")],
      program.programId
    );
    [tokenYVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_y_vault")],
      program.programId
    );

    USDC_MINT = await createMint(
          provider.connection,
          provider.wallet.payer,
          authority,
          null,
          6
        );

    for (const user of [lp, lp2]) {
      const sig = await provider.connection.requestAirdrop(
        user.publicKey,
        10 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

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
          tokenXVault: tokenXVaultPda,
          tokenYVault: tokenYVaultPda,
          mintX: SOL_MINT,
          mintY: USDC_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("Lending vault initialized");
    }

    console.log("\n=== Setup Complete ===");
    console.log("Lending Vault PDA:", lendingVaultPda.toBase58());
    console.log("WSOL Vault PDA:", tokenXVaultPda.toBase58());
    console.log("USDC Vault PDA:", tokenYVaultPda.toBase58());
  });

  describe("Initialize Lending Vault", () => {
    it("Lending vault is initialized correctly", async () => {
      const vault = await program.account.lendingVault.fetch(lendingVaultPda);

      expect(vault.authority.toBase58()).to.equal(authority.toBase58());
      expect(vault.totalSupplied.toNumber()).to.equal(0);
      expect(vault.totalBorrowed.toNumber()).to.equal(0);

      console.log("Vault authority:", vault.authority.toBase58());
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

  describe("Constraints", () => {
    it("Non-authority cannot initialize lending vault", async () => {
      const rogue = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(rogue.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);

      try {
        await program.methods
          .initializeLendingVault()
          .accountsStrict({
            authority: rogue.publicKey,
            config: configPda,
            lendingVault: lendingVaultPda,
            solVault: solVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([rogue])
          .rpc();

        throw new Error("Should have failed");
      } catch (e) {
        expect(e.message).to.match(/Unauthorized|constraint|already in use/i);
        console.log("Correctly rejected unauthorized vault init");
      }
    });

    it("Cannot initialize lending vault twice", async () => {
      try {
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

        throw new Error("Should have failed");
      } catch (e) {
        expect(e.message).to.match(/already in use|already initialized/i);
        console.log("Correctly rejected double initialization");
      }
    });

    it("Cannot withdraw without a position", async () => {
      const noPosition = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(noPosition.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);

      const [lpPositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_position"), noPosition.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .withdraw()
          .accountsStrict({
            signer: noPosition.publicKey,
            lpPosition: lpPositionPda,
            lendingVault: lendingVaultPda,
            solVault: solVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([noPosition])
          .rpc();

        throw new Error("Should have failed");
      } catch (e) {
        expect(e.message).to.match(/Account does not exist|not found|AccountNotInitialized/i);
        console.log("Correctly rejected withdraw with no position");
      }
    });
  });

  describe("Withdraw", () => {
    it("LP withdraws and receives SOL back", async () => {
      const [lpPositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_position"), lp.publicKey.toBuffer()],
        program.programId
      );

      const positionBefore = await program.account.lpPosition.fetch(lpPositionPda);
      const lpBalanceBefore = await provider.connection.getBalance(lp.publicKey);
      const solVaultBefore = await provider.connection.getBalance(solVaultPda);
      const vaultStateBefore = await program.account.lendingVault.fetch(lendingVaultPda);

      await program.methods
        .withdraw()
        .accountsStrict({
          signer: lp.publicKey,
          lpPosition: lpPositionPda,
          lendingVault: lendingVaultPda,
          solVault: solVaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([lp])
        .rpc();

      // LP position should be closed
      try {
        await program.account.lpPosition.fetch(lpPositionPda);
        throw new Error("LP position should have been closed");
      } catch (e) {
        expect(e.message).to.match(/Account does not exist|not found/i);
      }

      // LP balance should have increased by supplied amount (+ rent from closed account)
      const lpBalanceAfter = await provider.connection.getBalance(lp.publicKey);
      expect(lpBalanceAfter).to.be.greaterThan(lpBalanceBefore);

      // Sol vault balance should have decreased
      const solVaultAfter = await provider.connection.getBalance(solVaultPda);
      expect(solVaultBefore - solVaultAfter).to.equal(positionBefore.suppliedAmount.toNumber());

      // total_supplied should have decreased by principal
      const vaultStateAfter = await program.account.lendingVault.fetch(lendingVaultPda);
      expect(vaultStateAfter.totalSupplied.toNumber()).to.equal(
        vaultStateBefore.totalSupplied.toNumber() - positionBefore.suppliedAmount.toNumber()
      );

      console.log("LP withdrew:", positionBefore.suppliedAmount.toNumber() / LAMPORTS_PER_SOL, "SOL");
      console.log("LP balance after:", lpBalanceAfter / LAMPORTS_PER_SOL, "SOL");
      console.log("SOL vault after:", solVaultAfter / LAMPORTS_PER_SOL, "SOL");
    });

    it("Cannot withdraw someone else's position", async () => {
      const [lp2PositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_position"), lp2.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .withdraw()
          .accountsStrict({
            signer: lp.publicKey,
            lpPosition: lp2PositionPda,
            lendingVault: lendingVaultPda,
            solVault: solVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([lp])
          .rpc();

        throw new Error("Should have failed");
      } catch (e) {
        expect(e.message).to.match(/InvalidOwner|constraint|seeds/i);
        console.log("Correctly rejected unauthorized withdrawal");
      }
    });
  });
});
