import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { MetlevEngine } from "../target/types/metlev_engine";
import DLMM from "@meteora-ag/dlmm";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  createSyncNativeInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";
import { expect } from "chai";

const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
);
const LB_PAIR = new PublicKey("9zUvxwFTcuumU6Dkq68wWEAiLEmA4sp1amdG96aY7Tmq");

const POSITION_WIDTH = 5;
const BIN_ARRAY_SIZE = 70;

// Returns which bin array a bin belongs to, floor division for negatives.
function binArrayIndex(binId: number): BN {
  const quotient = Math.trunc(binId / BIN_ARRAY_SIZE);
  const remainder = binId % BIN_ARRAY_SIZE;
  const index = remainder < 0 ? quotient - 1 : quotient;
  return new BN(index);
}

function deriveBinArrayPda(lbPair: PublicKey, index: BN): PublicKey {
  const indexBuf = Buffer.alloc(8);
  indexBuf.writeBigInt64LE(BigInt(index.toString()));
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

describe("Close Position", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.metlevEngine as Program<MetlevEngine>;
  const authority = provider.wallet.publicKey;

  let configPda: PublicKey;
  let lendingVaultPda: PublicKey;
  let wsolVaultPda: PublicKey;
  let collateralConfigPda: PublicKey;
  let dlmmPool: DLMM;

  // ─── Helpers ────────────────────────────────────────────────────────────────

  async function wrapSol(payer: Keypair, recipient: PublicKey, lamports: number): Promise<PublicKey> {
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      NATIVE_MINT,
      recipient
    );
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ata.address, lamports }),
      createSyncNativeInstruction(ata.address)
    );
    await provider.sendAndConfirm(tx, [payer]);
    return ata.address;
  }

  async function ensureBinArrayExists(index: BN): Promise<void> {
    const pda = deriveBinArrayPda(LB_PAIR, index);
    if (await provider.connection.getAccountInfo(pda)) return;
    const ixs = await dlmmPool.initializeBinArrays([index], authority);
    if (ixs.length > 0) await provider.sendAndConfirm(new Transaction().add(...ixs));
  }

  // Opens a fresh leveraged DLMM position for `user` and returns all state needed to close it.
  async function openPosition(
    user: Keypair,
    positionPda: PublicKey,
    wsolVault: PublicKey,
  ): Promise<{ metPositionKp: Keypair; minBinId: number; maxBinId: number }> {
    await dlmmPool.refetchStates();
    const activeBin = await dlmmPool.getActiveBin();
    const activeBinId = activeBin.binId;
    const isWsolX = dlmmPool.lbPair.tokenXMint.equals(NATIVE_MINT);

    const activeArrayIdx = binArrayIndex(activeBinId).toNumber();
    const half = Math.floor(POSITION_WIDTH / 2);

    let minBinId: number, maxBinId: number;

    if (isWsolX) {
      minBinId = activeBinId + 1;
      maxBinId = activeBinId + POSITION_WIDTH;
    } else {
      minBinId = activeBinId - POSITION_WIDTH + 1;
      maxBinId = activeBinId;
    }

    let lowerIdx = binArrayIndex(minBinId);
    let upperIdx = binArrayIndex(maxBinId);

    if (lowerIdx.eq(upperIdx)) {
      if (isWsolX) {
        let boundary = (activeArrayIdx + 1) * BIN_ARRAY_SIZE;
        if (boundary - half <= activeBinId) boundary += BIN_ARRAY_SIZE;
        minBinId = boundary - half;
        maxBinId = minBinId + POSITION_WIDTH - 1;
      } else {
        let boundary = activeArrayIdx * BIN_ARRAY_SIZE;
        if (boundary + (POSITION_WIDTH - 1 - half) > activeBinId) boundary -= BIN_ARRAY_SIZE;
        minBinId = boundary - half;
        maxBinId = minBinId + POSITION_WIDTH - 1;
      }
      lowerIdx = binArrayIndex(minBinId);
      upperIdx = binArrayIndex(maxBinId);
    }

    await ensureBinArrayExists(lowerIdx);
    await ensureBinArrayExists(upperIdx);

    const binArrayLower = deriveBinArrayPda(LB_PAIR, lowerIdx);
    const binArrayUpper = deriveBinArrayPda(LB_PAIR, upperIdx);

    const reserve  = isWsolX ? dlmmPool.lbPair.reserveX : dlmmPool.lbPair.reserveY;
    const tokenMint = isWsolX ? dlmmPool.lbPair.tokenXMint : dlmmPool.lbPair.tokenYMint;

    const binLiquidityDist = [];
    for (let i = minBinId; i <= maxBinId; i++) {
      binLiquidityDist.push({ binId: i, weight: 1000 });
    }

    const [priceOracle] = PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle"), NATIVE_MINT.toBuffer()],
      program.programId
    );

    // Refresh oracle timestamp before opening
    await program.methods
      .updateMockOracle(new BN(150_000_000))
      .accountsStrict({ authority, config: configPda, mint: NATIVE_MINT, mockOracle: priceOracle })
      .rpc();

    const metPositionKp = Keypair.generate();

    await program.methods
      .openPosition(
        new BN(20_000), // 2× leverage
        minBinId,
        maxBinId - minBinId + 1,
        activeBinId,
        10, // maxActiveBinSlippage
        binLiquidityDist
      )
      .accountsStrict({
        user: user.publicKey,
        config: configPda,
        wsolMint: NATIVE_MINT,
        position: positionPda,
        lendingVault: lendingVaultPda,
        wsolVault: wsolVault,
        collateralConfig: collateralConfigPda,
        priceOracle,
        metPosition: metPositionKp.publicKey,
        lbPair: LB_PAIR,
        binArrayBitmapExtension: null,
        reserve,
        tokenMint,
        binArrayLower,
        binArrayUpper,
        eventAuthority: deriveEventAuthority(),
        tokenProgram: TOKEN_PROGRAM_ID,
        dlmmProgram: DLMM_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user, metPositionKp])
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc({ commitment: "confirmed" });

    console.log("    Opened DLMM position:", metPositionKp.publicKey.toBase58());
    return { metPositionKp, minBinId, maxBinId };
  }

  // Builds the accounts object for closePosition given a DLMM position.
  async function buildCloseAccounts(
    user: PublicKey,
    positionPda: PublicKey,
    metPositionPubkey: PublicKey,
    fromBinId: number,
    toBinId: number
  ) {
    await dlmmPool.refetchStates();

    const lowerIdx = binArrayIndex(fromBinId);
    const upperIdx = binArrayIndex(toBinId);

    const binArrayLower = deriveBinArrayPda(LB_PAIR, lowerIdx);
    const binArrayUpper = deriveBinArrayPda(LB_PAIR, upperIdx);

    // Lending vault's token X ATA — init_if_needed handles creation on-chain,
    // but we still need to derive/create the account client-side to pass its address.
    const userTokenXAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      dlmmPool.lbPair.tokenXMint,
      lendingVaultPda,
      true // allowOwnerOffCurve — lending_vault is a PDA
    );

    return {
      accounts: {
        user,
        config: configPda,
        wsolMint: NATIVE_MINT,
        position: positionPda,
        lendingVault: lendingVaultPda,
        wsolVault: wsolVaultPda,
        metPosition: metPositionPubkey,
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
      },
    };
  }

  // ─── Shared protocol setup ─────────────────────────────────────────────────

  before("Init protocol and DLMM SDK", async function () {
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    [lendingVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lending_vault")],
      program.programId
    );
    [wsolVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("wsol_vault"), lendingVaultPda.toBuffer()],
      program.programId
    );
    [collateralConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("collateral_config"), NATIVE_MINT.toBuffer()],
      program.programId
    );

    // Idempotent: config
    try {
      await program.account.config.fetch(configPda);
    } catch {
      await program.methods.initialize()
        .accountsStrict({ authority, config: configPda, systemProgram: SystemProgram.programId })
        .rpc();
    }

    // Idempotent: lending vault
    try {
      await program.account.lendingVault.fetch(lendingVaultPda);
    } catch {
      await program.methods.initializeLendingVault()
        .accountsStrict({
          authority, config: configPda, lendingVault: lendingVaultPda,
          wsolMint: NATIVE_MINT, wsolVault: wsolVaultPda,
          tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    // Idempotent: mock oracle for wSOL
    const [priceOracle] = PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle"), NATIVE_MINT.toBuffer()],
      program.programId
    );
    try {
      await program.account.mockOracle.fetch(priceOracle);
    } catch {
      await program.methods.initializeMockOracle(new BN(150_000_000))
        .accountsStrict({
          authority, config: configPda, mint: NATIVE_MINT, mockOracle: priceOracle,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("  Mock oracle initialized.");
    }

    // Idempotent: collateral config for wSOL
    try {
      const existing = await program.account.collateralConfig.fetch(collateralConfigPda);
      if (existing.oracle.toBase58() !== priceOracle.toBase58()) {
        await program.methods.updateCollateralOracle(NATIVE_MINT, priceOracle)
          .accountsStrict({ authority, config: configPda, collateralConfig: collateralConfigPda })
          .rpc();
        console.log("  CollateralConfig oracle updated.");
      }
    } catch {
      await program.methods.registerCollateral(
        priceOracle,
        7500,         // max_ltv (75%)
        8000,         // liquidation_threshold (80%)
        500,          // liquidation_penalty (5%)
        new BN(Math.floor(0.1 * LAMPORTS_PER_SOL)), // min_deposit
        500,          // interest_rate_bps (5%)
        new BN(3600), // oracle_max_age (1 hour)
      )
        .accountsStrict({
          authority, config: configPda, mint: NATIVE_MINT,
          collateralConfig: collateralConfigPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("  CollateralConfig registered.");
    }

    // Ensure vault has enough liquidity for tests (idempotent via try/catch on lpPosition)
    const lp = Keypair.generate();
    const lpSig = await provider.connection.requestAirdrop(lp.publicKey, 15 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(lpSig);
    const lpWsolAta = await wrapSol(lp, lp.publicKey, 10 * LAMPORTS_PER_SOL);
    const [lpPositionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_position"), lp.publicKey.toBuffer()],
      program.programId
    );
    try {
      await program.account.lpPosition.fetch(lpPositionPda);
    } catch {
      await program.methods.supply(new BN(8 * LAMPORTS_PER_SOL))
        .accountsStrict({
          signer: lp.publicKey, lendingVault: lendingVaultPda,
          wsolMint: NATIVE_MINT, wsolVault: wsolVaultPda, signerWsolAta: lpWsolAta,
          lpPosition: lpPositionPda, tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([lp])
        .rpc();
      console.log("  LP supplied 8 wSOL to vault.");
    }

    // Init DLMM SDK
    try {
      dlmmPool = await DLMM.create(provider.connection, LB_PAIR, { cluster: "devnet" });
      await dlmmPool.refetchStates();
    } catch {
      console.log("  ⚠ LB pair not found — skipping close position tests (requires devnet)");
      this.skip();
    }

    console.log("\n=== Close Position Setup ===");
    console.log("  configPda        :", configPda.toBase58());
    console.log("  lendingVaultPda  :", lendingVaultPda.toBase58());
    console.log("  wsolVaultPda     :", wsolVaultPda.toBase58());
  });

  // ─── Happy path ─────────────────────────────────────────────────────────────

  describe("closePosition — happy path", () => {
    const user = Keypair.generate();
    let positionPda: PublicKey;
    let collateralVaultPda: PublicKey;
    let metPositionKp: Keypair;
    let openedMinBinId: number;
    let openedMaxBinId: number;
    const depositAmount = new BN(2 * LAMPORTS_PER_SOL);

    before("Fund, deposit collateral, open leveraged position", async function () {
      [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), user.publicKey.toBuffer(), NATIVE_MINT.toBuffer()],
        program.programId
      );
      [collateralVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), user.publicKey.toBuffer(), NATIVE_MINT.toBuffer()],
        program.programId
      );

      const sig = await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);

      await program.methods.depositSolCollateral(depositAmount)
        .accountsStrict({
          user: user.publicKey, config: configPda, mint: NATIVE_MINT,
          collateralConfig: collateralConfigPda, vault: collateralVaultPda,
          position: positionPda, systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      console.log("  Deposited", depositAmount.toNumber() / LAMPORTS_PER_SOL, "SOL as collateral");

      const result = await openPosition(user, positionPda, wsolVaultPda);
      metPositionKp = result.metPositionKp;
      openedMinBinId = result.minBinId;
      openedMaxBinId = result.maxBinId;

      // Verify the position was opened correctly
      const pos = await program.account.position.fetch(positionPda);
      expect(pos.status).to.deep.equal({ active: {} }, "Position must be Active after open");
      expect(pos.debtAmount.toNumber()).to.be.greaterThan(0, "Position must have debt after open");
      expect(pos.collateralAmount.toNumber()).to.equal(
        depositAmount.toNumber(),
        "Collateral must match deposit"
      );

      const metPositionInfo = await provider.connection.getAccountInfo(metPositionKp.publicKey);
      expect(metPositionInfo).to.not.be.null;

      const vault = await program.account.lendingVault.fetch(lendingVaultPda);
      expect(vault.totalBorrowed.toNumber()).to.be.greaterThan(0, "Vault must have outstanding borrows");

      console.log("  Position state verified — active, debt:", pos.debtAmount.toString());
    });

    it("Closes DLMM position, repays debt, and marks position Closed", async () => {
      const vaultBefore = await program.account.lendingVault.fetch(lendingVaultPda);
      const positionBefore = await program.account.position.fetch(positionPda);
      const debtBefore = positionBefore.debtAmount;

      expect(positionBefore.status).to.deep.equal({ active: {} });
      expect(debtBefore.toNumber()).to.be.greaterThan(0, "Position must have debt before close");

      const { accounts } = await buildCloseAccounts(
        user.publicKey,
        positionPda,
        metPositionKp.publicKey,
        openedMinBinId,
        openedMaxBinId
      );

      const tx = await program.methods
        .closePosition(openedMinBinId, openedMaxBinId)
        .accountsStrict(accounts)
        .signers([user])
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc({ commitment: "confirmed" })
        .catch((e) => {
          console.log("\n  closePosition error:", e.message);
          if (e.logs) console.log("  logs:\n   ", e.logs.join("\n    "));
          throw e;
        });

      console.log("\n  closePosition tx:", tx);

      // Verify position state
      const positionAfter = await program.account.position.fetch(positionPda);
      expect(positionAfter.status).to.deep.equal(
        { closed: {} },
        "Position status must be Closed"
      );
      expect(positionAfter.debtAmount.toNumber()).to.equal(
        0,
        "debt_amount must be zeroed after close"
      );

      // Verify lending vault accounting
      const vaultAfter = await program.account.lendingVault.fetch(lendingVaultPda);
      expect(vaultAfter.totalBorrowed.toString()).to.equal(
        vaultBefore.totalBorrowed.sub(debtBefore).toString(),
        "totalBorrowed must decrease by exactly the debt amount"
      );

      // Verify DLMM position account is gone
      const metPositionInfo = await provider.connection.getAccountInfo(metPositionKp.publicKey);
      expect(metPositionInfo).to.be.null;

      console.log("  Position status   : closed");
      console.log("  Debt zeroed       :", positionAfter.debtAmount.toString());
      console.log("  totalBorrowed Δ   :", debtBefore.toString(), "→", vaultAfter.totalBorrowed.toString());
      console.log("  DLMM position     : closed on-chain");
    });

    it("Withdraws SOL collateral and closes the position account", async () => {
      const userBalanceBefore = await provider.connection.getBalance(user.publicKey);
      const vaultBalanceBefore = await provider.connection.getBalance(collateralVaultPda);

      expect(vaultBalanceBefore).to.equal(
        depositAmount.toNumber(),
        "Collateral vault should still hold the original deposit"
      );

      await program.methods
        .withdrawCollateral()
        .accountsStrict({
          user: user.publicKey,
          wsolMint: NATIVE_MINT,
          position: positionPda,
          collateralVault: collateralVaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc({ commitment: "confirmed" });

      // Collateral vault should be empty (or have 0 lamports)
      const vaultBalanceAfter = await provider.connection.getBalance(collateralVaultPda);
      expect(vaultBalanceAfter).to.equal(0, "Collateral vault must be empty after withdrawal");

      // User received the collateral back (minus tx fees)
      const userBalanceAfter = await provider.connection.getBalance(user.publicKey);
      expect(userBalanceAfter).to.be.greaterThan(
        userBalanceBefore,
        "User balance must increase after collateral withdrawal"
      );

      // Position account should be closed (rent returned, discriminator zeroed)
      const positionInfo = await provider.connection.getAccountInfo(positionPda);
      expect(positionInfo).to.be.null;

      console.log("\n  Collateral returned :", depositAmount.toNumber() / LAMPORTS_PER_SOL, "SOL");
      console.log("  Position account    : closed on-chain");
      console.log("  User balance delta  :", (userBalanceAfter - userBalanceBefore) / LAMPORTS_PER_SOL, "SOL (net of fees)");
    });
  });

  // ─── Constraints ────────────────────────────────────────────────────────────

  describe("closePosition — constraints", () => {
    // A second user+position used for constraint tests — opened once, reused across tests.
    const constraintUser = Keypair.generate();
    let constraintPositionPda: PublicKey;
    let constraintMetPositionKp: Keypair;
    let constraintMinBinId: number;
    let constraintMaxBinId: number;

    before("Open a second position for constraint tests", async function () {
      [constraintPositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), constraintUser.publicKey.toBuffer(), NATIVE_MINT.toBuffer()],
        program.programId
      );
      const [constraintVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), constraintUser.publicKey.toBuffer(), NATIVE_MINT.toBuffer()],
        program.programId
      );

      const sig = await provider.connection.requestAirdrop(
        constraintUser.publicKey,
        10 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      await program.methods.depositSolCollateral(new BN(2 * LAMPORTS_PER_SOL))
        .accountsStrict({
          user: constraintUser.publicKey, config: configPda, mint: NATIVE_MINT,
          collateralConfig: collateralConfigPda, vault: constraintVaultPda,
          position: constraintPositionPda, systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([constraintUser])
        .rpc();

      const result = await openPosition(constraintUser, constraintPositionPda, wsolVaultPda);
      constraintMetPositionKp = result.metPositionKp;
      constraintMinBinId = result.minBinId;
      constraintMaxBinId = result.maxBinId;
    });

    it("Rejects close when position is not active (already closed)", async () => {
      // Close the constraint position once first
      const { accounts } = await buildCloseAccounts(
        constraintUser.publicKey,
        constraintPositionPda,
        constraintMetPositionKp.publicKey,
        constraintMinBinId,
        constraintMaxBinId
      );

      await program.methods
        .closePosition(constraintMinBinId, constraintMaxBinId)
        .accountsStrict(accounts)
        .signers([constraintUser])
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc({ commitment: "confirmed" });

      // Now try to close it again — must fail with PositionNotActive
      try {
        await program.methods
          .closePosition(constraintMinBinId, constraintMaxBinId)
          .accountsStrict(accounts)
          .signers([constraintUser])
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
          .rpc();
        throw new Error("Should have failed");
      } catch (e) {
        expect((e as Error).message).to.match(/PositionNotActive|closed|3010/i);
        console.log("  Correctly rejected close on already-closed position");
      }
    });

    it("Rejects close by a different user", async () => {
      // rogue tries to pass constraintUser's position PDA but signs with their own key.
      // The seeds constraint derives position from user.key(), so mismatched signer
      // produces a PDA that doesn't match the on-chain account.
      const rogue = Keypair.generate();
      const rogSig = await provider.connection.requestAirdrop(rogue.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(rogSig);

      // Derive what rogue thinks the accounts should be (their own position + vault)
      const [rogueFakePosition] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), rogue.publicKey.toBuffer(), NATIVE_MINT.toBuffer()],
        program.programId
      );

      // Build close accounts as if rogue is the user — position PDA won't exist
      const { accounts: constraintAccounts } = await buildCloseAccounts(
        constraintUser.publicKey,
        constraintPositionPda,
        constraintMetPositionKp.publicKey,
        constraintMinBinId,
        constraintMaxBinId
      );

      try {
        await program.methods
          .closePosition(constraintMinBinId, constraintMaxBinId)
          .accountsStrict({ ...constraintAccounts, user: rogue.publicKey })
          .signers([rogue])
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
          .rpc();
        throw new Error("Should have failed");
      } catch (e) {
        // seeds constraint: position PDA derived from rogue.key() ≠ constraintPositionPda
        expect((e as Error).message).to.match(/seeds|constraint|InvalidOwner|2006/i);
        console.log("  Correctly rejected close by wrong user");
      }
    });
  });
});
