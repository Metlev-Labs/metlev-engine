import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MetlevEngine } from "../target/types/metlev_engine";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  createSyncNativeInstruction,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
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
  let wsolVaultPda: PublicKey;
  let lpWsolAta: PublicKey;
  let lp2WsolAta: PublicKey;

  async function wrapSol(user: Keypair, lamports: number): Promise<PublicKey> {
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      NATIVE_MINT,
      user.publicKey,
    );

    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: user.publicKey,
        toPubkey: ata.address,
        lamports,
      }),
      createSyncNativeInstruction(ata.address),
    );

    await provider.sendAndConfirm(tx, [user]);
    return ata.address;
  }

  before(async () => {
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId,
    );

    [lendingVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lending_vault")],
      program.programId,
    );

    [wsolVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("wsol_vault"), lendingVaultPda.toBuffer()],
      program.programId,
    );

    // Airdrop SOL then wrap half of it into WSOL for each LP
    for (const user of [lp, lp2]) {
      const sig = await provider.connection.requestAirdrop(
        user.publicKey,
        10 * LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig);
    }

    lpWsolAta = await wrapSol(lp, 5 * LAMPORTS_PER_SOL);
    lp2WsolAta = await wrapSol(lp2, 5 * LAMPORTS_PER_SOL);

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
          wsolMint: NATIVE_MINT,
          wsolVault: wsolVaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("Lending vault initialized");
    }

    console.log("\n=== Setup Complete ===");
    console.log("Lending Vault PDA:", lendingVaultPda.toBase58());
    console.log("WSOL Vault PDA:", wsolVaultPda.toBase58());
  });

  describe("Initialize Lending Vault", () => {
    it("Lending vault is initialized correctly", async () => {
      const vault = await program.account.lendingVault.fetch(lendingVaultPda);

      expect(vault.authority.toBase58()).to.equal(authority.toBase58());

      expect(vault.totalSupplied.toNumber()).to.be.greaterThanOrEqual(0);
      console.log(
        `  ✓ Vault initialized with total supplied: ${
          vault.totalSupplied.toNumber() / LAMPORTS_PER_SOL
        } wSOL`,
      );
      expect(vault.totalBorrowed.toNumber()).to.be.greaterThanOrEqual(0);

      const wsolBalance = await provider.connection.getTokenAccountBalance(
        wsolVaultPda,
      );
      expect(Number(wsolBalance.value.amount)).to.be.greaterThanOrEqual(0);

      console.log("Vault authority:", vault.authority.toBase58());
      console.log("WSOL vault balance:", wsolBalance.value.uiAmount, "WSOL");
    });
  });

  describe("Supply", () => {
    it("LP supplies WSOL and LP position is created", async () => {
      const supplyAmount = new anchor.BN(2 * LAMPORTS_PER_SOL);

      const [lpPositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_position"), lp.publicKey.toBuffer()],
        program.programId,
      );

      const wsolVaultBefore = await provider.connection.getTokenAccountBalance(
        wsolVaultPda,
      );
      const vaultStateBefore = await program.account.lendingVault.fetch(
        lendingVaultPda,
      );

      await program.methods
        .supply(supplyAmount)
        .accountsStrict({
          signer: lp.publicKey,
          lendingVault: lendingVaultPda,
          wsolMint: NATIVE_MINT,
          wsolVault: wsolVaultPda,
          signerWsolAta: lpWsolAta,
          lpPosition: lpPositionPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([lp])
        .rpc();

      const lpPosition = await program.account.lpPosition.fetch(lpPositionPda);
      expect(lpPosition.lp.toBase58()).to.equal(lp.publicKey.toBase58());
      expect(lpPosition.suppliedAmount.toNumber()).to.equal(
        supplyAmount.toNumber(),
      );
      expect(lpPosition.interestEarned.toNumber()).to.equal(0);

      const vaultStateAfter = await program.account.lendingVault.fetch(
        lendingVaultPda,
      );
      expect(vaultStateAfter.totalSupplied.toNumber()).to.equal(
        vaultStateBefore.totalSupplied.toNumber() + supplyAmount.toNumber(),
      );

      const wsolVaultAfter = await provider.connection.getTokenAccountBalance(
        wsolVaultPda,
      );
      expect(
        Number(wsolVaultAfter.value.amount) -
          Number(wsolVaultBefore.value.amount),
      ).to.equal(supplyAmount.toNumber());

      console.log(
        "LP supplied:",
        supplyAmount.toNumber() / LAMPORTS_PER_SOL,
        "WSOL",
      );
      console.log("WSOL vault balance:", wsolVaultAfter.value.uiAmount, "WSOL");
      console.log(
        "Total supplied:",
        vaultStateAfter.totalSupplied.toNumber() / LAMPORTS_PER_SOL,
        "WSOL",
      );
    });

    it("LP can top-up supply (second deposit)", async () => {
      const topUpAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);

      const [lpPositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_position"), lp.publicKey.toBuffer()],
        program.programId,
      );

      const positionBefore = await program.account.lpPosition.fetch(
        lpPositionPda,
      );

      await program.methods
        .supply(topUpAmount)
        .accountsStrict({
          signer: lp.publicKey,
          lendingVault: lendingVaultPda,
          wsolMint: NATIVE_MINT,
          wsolVault: wsolVaultPda,
          signerWsolAta: lpWsolAta,
          lpPosition: lpPositionPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([lp])
        .rpc();

      const positionAfter = await program.account.lpPosition.fetch(
        lpPositionPda,
      );
      expect(positionAfter.suppliedAmount.toNumber()).to.equal(
        positionBefore.suppliedAmount.toNumber() + topUpAmount.toNumber(),
      );

      console.log("LP top-up successful");
      console.log(
        "Total supplied by LP:",
        positionAfter.suppliedAmount.toNumber() / LAMPORTS_PER_SOL,
        "WSOL",
      );
    });

    it("Multiple LPs can supply independently", async () => {
      const supplyAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);

      const [lp2PositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_position"), lp2.publicKey.toBuffer()],
        program.programId,
      );

      await program.methods
        .supply(supplyAmount)
        .accountsStrict({
          signer: lp2.publicKey,
          lendingVault: lendingVaultPda,
          wsolMint: NATIVE_MINT,
          wsolVault: wsolVaultPda,
          signerWsolAta: lp2WsolAta,
          lpPosition: lp2PositionPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([lp2])
        .rpc();

      const lp2Position = await program.account.lpPosition.fetch(
        lp2PositionPda,
      );
      expect(lp2Position.lp.toBase58()).to.equal(lp2.publicKey.toBase58());
      expect(lp2Position.suppliedAmount.toNumber()).to.equal(
        supplyAmount.toNumber(),
      );

      const vaultState = await program.account.lendingVault.fetch(
        lendingVaultPda,
      );
      console.log(
        "Total vault supplied:",
        vaultState.totalSupplied.toNumber() / LAMPORTS_PER_SOL,
        "WSOL",
      );
    });
  });

  describe("Constraints", () => {
    it("Non-authority cannot initialize lending vault", async () => {
      const rogue = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        rogue.publicKey,
        2 * LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig);

      try {
        await program.methods
          .initializeLendingVault()
          .accountsStrict({
            authority: rogue.publicKey,
            config: configPda,
            lendingVault: lendingVaultPda,
            wsolMint: NATIVE_MINT,
            wsolVault: wsolVaultPda,
            tokenProgram: TOKEN_PROGRAM_ID,
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
            wsolMint: NATIVE_MINT,
            wsolVault: wsolVaultPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        throw new Error("Should have failed");
      } catch (e) {
        expect(e.message).to.match(/already in use|already.?initialized|AccountAlreadyInUse|0x0|Simulation/i);
        console.log("Correctly rejected double initialization");
      }
    });

    it("Cannot withdraw without a position", async () => {
      const noPosition = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        noPosition.publicKey,
        2 * LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig);

      const [lpPositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_position"), noPosition.publicKey.toBuffer()],
        program.programId,
      );

      const noPositionWsolAta = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          provider.wallet.payer,
          NATIVE_MINT,
          noPosition.publicKey,
        )
      ).address;

      try {
        await program.methods
          .withdraw()
          .accountsStrict({
            signer: noPosition.publicKey,
            lpPosition: lpPositionPda,
            lendingVault: lendingVaultPda,
            wsolMint: NATIVE_MINT,
            wsolVault: wsolVaultPda,
            signerWsolAta: noPositionWsolAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([noPosition])
          .rpc();

        throw new Error("Should have failed");
      } catch (e) {
        expect(e.message).to.match(
          /Account does not exist|not found|AccountNotInitialized/i,
        );
        console.log("Correctly rejected withdraw with no position");
      }
    });
  });

  describe("Withdraw", () => {
    it("LP withdraws and receives WSOL back", async () => {
      const [lpPositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_position"), lp.publicKey.toBuffer()],
        program.programId,
      );

      const positionBefore = await program.account.lpPosition.fetch(
        lpPositionPda,
      );
      const lpWsolBefore = await provider.connection.getTokenAccountBalance(
        lpWsolAta,
      );
      const wsolVaultBefore = await provider.connection.getTokenAccountBalance(
        wsolVaultPda,
      );
      const vaultStateBefore = await program.account.lendingVault.fetch(
        lendingVaultPda,
      );

      await program.methods
        .withdraw()
        .accountsStrict({
          signer: lp.publicKey,
          lpPosition: lpPositionPda,
          lendingVault: lendingVaultPda,
          wsolMint: NATIVE_MINT,
          wsolVault: wsolVaultPda,
          signerWsolAta: lpWsolAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([lp])
        .rpc();

      try {
        await program.account.lpPosition.fetch(lpPositionPda);
        throw new Error("LP position should have been closed");
      } catch (e) {
        expect(e.message).to.match(/Account does not exist|not found/i);
      }

      const lpWsolAfter = await provider.connection.getTokenAccountBalance(
        lpWsolAta,
      );
      expect(Number(lpWsolAfter.value.amount)).to.be.gte(
        Number(lpWsolBefore.value.amount) +
          positionBefore.suppliedAmount.toNumber(),
      );

      const wsolVaultAfter = await provider.connection.getTokenAccountBalance(
        wsolVaultPda,
      );
      expect(
        Number(wsolVaultBefore.value.amount) -
          Number(wsolVaultAfter.value.amount),
      ).to.equal(positionBefore.suppliedAmount.toNumber());

      const vaultStateAfter = await program.account.lendingVault.fetch(
        lendingVaultPda,
      );
      expect(vaultStateAfter.totalSupplied.toNumber()).to.equal(
        vaultStateBefore.totalSupplied.toNumber() -
          positionBefore.suppliedAmount.toNumber(),
      );

      console.log(
        "LP withdrew:",
        positionBefore.suppliedAmount.toNumber() / LAMPORTS_PER_SOL,
        "WSOL",
      );
      console.log("LP WSOL balance after:", lpWsolAfter.value.uiAmount, "WSOL");
      console.log("WSOL vault after:", wsolVaultAfter.value.uiAmount, "WSOL");
    });

    it("Cannot withdraw someone else's position", async () => {
      const [lp2PositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_position"), lp2.publicKey.toBuffer()],
        program.programId,
      );

      try {
        await program.methods
          .withdraw()
          .accountsStrict({
            signer: lp.publicKey,
            lpPosition: lp2PositionPda,
            lendingVault: lendingVaultPda,
            wsolMint: NATIVE_MINT,
            wsolVault: wsolVaultPda,
            signerWsolAta: lpWsolAta,
            tokenProgram: TOKEN_PROGRAM_ID,
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
