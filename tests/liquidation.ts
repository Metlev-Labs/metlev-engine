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

describe("Liquidation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.metlevEngine as Program<MetlevEngine>;
  const authority = provider.wallet.publicKey;

  let configPda: PublicKey;
  let lendingVaultPda: PublicKey;
  let wsolVaultPda: PublicKey;
  let collateralConfigPda: PublicKey;
  let priceOraclePda: PublicKey;
  let dlmmPool: DLMM;

  // Original config values to restore after tests
  const ORIGINAL_MAX_LTV = 7500;
  const ORIGINAL_LIQUIDATION_THRESHOLD = 8000;

  // ─── Helpers ──────────────────────────────────────────────────────────────

  async function wrapSol(payer: Keypair, recipient: PublicKey, lamports: number): Promise<PublicKey> {
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      NATIVE_MINT,
      recipient
    );
    if (lamports > 0) {
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ata.address, lamports }),
        createSyncNativeInstruction(ata.address)
      );
      await provider.sendAndConfirm(tx, [payer]);
    }
    return ata.address;
  }

  async function ensureBinArrayExists(index: BN): Promise<void> {
    const pda = deriveBinArrayPda(LB_PAIR, index);
    if (await provider.connection.getAccountInfo(pda)) return;
    const ixs = await dlmmPool.initializeBinArrays([index], authority);
    if (ixs.length > 0) await provider.sendAndConfirm(new Transaction().add(...ixs));
  }

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

    const reserve = isWsolX ? dlmmPool.lbPair.reserveX : dlmmPool.lbPair.reserveY;
    const tokenMint = isWsolX ? dlmmPool.lbPair.tokenXMint : dlmmPool.lbPair.tokenYMint;

    const binLiquidityDist = [];
    for (let i = minBinId; i <= maxBinId; i++) {
      binLiquidityDist.push({ binId: i, weight: 1000 });
    }

    // Refresh oracle timestamp before opening
    await program.methods
      .updateMockOracle(new BN(150_000_000))
      .accountsStrict({ authority, config: configPda, mint: NATIVE_MINT, mockOracle: priceOraclePda })
      .rpc();

    const metPositionKp = Keypair.generate();

    await program.methods
      .openPosition(
        new BN(20_000), // 2x leverage
        minBinId,
        maxBinId - minBinId + 1,
        activeBinId,
        10,
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
        priceOracle: priceOraclePda,
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

  async function buildLiquidateAccounts(
    liquidator: PublicKey,
    positionOwner: PublicKey,
    positionPda: PublicKey,
    metPositionPubkey: PublicKey,
    fromBinId: number,
    toBinId: number,
  ) {
    await dlmmPool.refetchStates();

    const lowerIdx = binArrayIndex(fromBinId);
    const upperIdx = binArrayIndex(toBinId);
    const binArrayLower = deriveBinArrayPda(LB_PAIR, lowerIdx);
    const binArrayUpper = deriveBinArrayPda(LB_PAIR, upperIdx);

    const userTokenXAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      dlmmPool.lbPair.tokenXMint,
      lendingVaultPda,
      true
    );

    const [collateralVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), positionOwner.toBuffer(), NATIVE_MINT.toBuffer()],
      program.programId
    );

    return {
      accounts: {
        liquidator,
        config: configPda,
        wsolMint: NATIVE_MINT,
        position: positionPda,
        lendingVault: lendingVaultPda,
        collateralConfig: collateralConfigPda,
        priceOracle: priceOraclePda,
        wsolVault: wsolVaultPda,
        positionOwner,
        collateralVault,
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
    [priceOraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle"), NATIVE_MINT.toBuffer()],
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
    try {
      await program.account.mockOracle.fetch(priceOraclePda);
    } catch {
      await program.methods.initializeMockOracle(new BN(150_000_000))
        .accountsStrict({
          authority, config: configPda, mint: NATIVE_MINT, mockOracle: priceOraclePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("  Mock oracle initialized.");
    }

    // Idempotent: collateral config for wSOL
    try {
      const existing = await program.account.collateralConfig.fetch(collateralConfigPda);
      if (existing.oracle.toBase58() !== priceOraclePda.toBase58()) {
        await program.methods.updateCollateralOracle(NATIVE_MINT, priceOraclePda)
          .accountsStrict({ authority, config: configPda, collateralConfig: collateralConfigPda })
          .rpc();
      }
    } catch {
      await program.methods.registerCollateral(
        priceOraclePda,
        ORIGINAL_MAX_LTV,
        ORIGINAL_LIQUIDATION_THRESHOLD,
        500,          // liquidation_penalty (5%)
        new BN(Math.floor(0.1 * LAMPORTS_PER_SOL)),
        500,          // interest_rate_bps (5%)
        new BN(3600),
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

    // Ensure we start with original LTV params (may have been changed by prior test runs)
    await program.methods
      .updateCollateralLtvParams(NATIVE_MINT, ORIGINAL_MAX_LTV, ORIGINAL_LIQUIDATION_THRESHOLD)
      .accountsStrict({ authority, config: configPda, collateralConfig: collateralConfigPda })
      .rpc();

    // Supply wSOL to lending vault
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
      console.log("  LB pair not found - skipping liquidation tests (requires devnet)");
      this.skip();
    }

    console.log("\n=== Liquidation Setup ===");
    console.log("  configPda        :", configPda.toBase58());
    console.log("  lendingVaultPda  :", lendingVaultPda.toBase58());
    console.log("  wsolVaultPda     :", wsolVaultPda.toBase58());
  });

  after("Restore original LTV params", async function () {
    try {
      await program.methods
        .updateCollateralLtvParams(NATIVE_MINT, ORIGINAL_MAX_LTV, ORIGINAL_LIQUIDATION_THRESHOLD)
        .accountsStrict({ authority, config: configPda, collateralConfig: collateralConfigPda })
        .rpc();
    } catch {
      // best-effort restore
    }
  });

  // ─── Happy path ───────────────────────────────────────────────────────────

  describe("liquidate -- happy path", () => {
    const positionUser = Keypair.generate();
    const liquidator = Keypair.generate();
    let positionPda: PublicKey;
    let collateralVaultPda: PublicKey;
    let metPositionKp: Keypair;
    let openedMinBinId: number;
    let openedMaxBinId: number;
    let debtBefore: BN;
    const depositAmount = new BN(2 * LAMPORTS_PER_SOL);

    before("Fund, deposit collateral, open leveraged position, lower threshold", async function () {
      [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), positionUser.publicKey.toBuffer(), NATIVE_MINT.toBuffer()],
        program.programId
      );
      [collateralVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), positionUser.publicKey.toBuffer(), NATIVE_MINT.toBuffer()],
        program.programId
      );

      // Fund users
      const sigs = await Promise.all([
        provider.connection.requestAirdrop(positionUser.publicKey, 10 * LAMPORTS_PER_SOL),
        provider.connection.requestAirdrop(liquidator.publicKey, 5 * LAMPORTS_PER_SOL),
      ]);
      await Promise.all(sigs.map(s => provider.connection.confirmTransaction(s)));

      // Deposit collateral
      await program.methods.depositSolCollateral(depositAmount)
        .accountsStrict({
          user: positionUser.publicKey, config: configPda, mint: NATIVE_MINT,
          collateralConfig: collateralConfigPda, vault: collateralVaultPda,
          position: positionPda, systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([positionUser])
        .rpc();
      console.log("  Deposited", depositAmount.toNumber() / LAMPORTS_PER_SOL, "SOL as collateral");

      // Open position (2x leverage -> LTV ~50%)
      const result = await openPosition(positionUser, positionPda, wsolVaultPda);
      metPositionKp = result.metPositionKp;
      openedMinBinId = result.minBinId;
      openedMaxBinId = result.maxBinId;

      const pos = await program.account.position.fetch(positionPda);
      debtBefore = pos.debtAmount;
      console.log("  Position opened: debt =", debtBefore.toString(),
                  " collateral =", pos.collateralAmount.toString());

      // Compute LTV: debt / (collateral + debt)
      const collateral = pos.collateralAmount.toNumber();
      const debt = pos.debtAmount.toNumber();
      const ltv = Math.floor((debt * 10000) / (collateral + debt));
      console.log("  Current LTV:", ltv, "bps (", (ltv / 100).toFixed(1), "%)");

      // Lower liquidation threshold below current LTV to make position unhealthy
      const newThreshold = ltv - 100; // 1% below current LTV
      const newMaxLtv = newThreshold - 100; // max_ltv must be < threshold
      console.log("  Lowering threshold to", newThreshold, "bps (max_ltv:", newMaxLtv, ")");

      await program.methods
        .updateCollateralLtvParams(NATIVE_MINT, newMaxLtv, newThreshold)
        .accountsStrict({ authority, config: configPda, collateralConfig: collateralConfigPda })
        .rpc();

      // Refresh oracle timestamp
      await program.methods
        .updateMockOracle(new BN(150_000_000))
        .accountsStrict({ authority, config: configPda, mint: NATIVE_MINT, mockOracle: priceOraclePda })
        .rpc();
    });

    it("Liquidates unhealthy position, repays debt, sends penalty to liquidator", async () => {
      const vaultBefore = await program.account.lendingVault.fetch(lendingVaultPda);
      const wsolVaultBalanceBefore = await provider.connection.getTokenAccountBalance(wsolVaultPda);

      const { accounts } = await buildLiquidateAccounts(
        liquidator.publicKey,
        positionUser.publicKey,
        positionPda,
        metPositionKp.publicKey,
        openedMinBinId,
        openedMaxBinId,
      );

      // Track native SOL balances (penalty + remainder are native SOL from collateral vault)
      const liquidatorLamportsBefore = await provider.connection.getBalance(liquidator.publicKey);
      const ownerLamportsBefore = await provider.connection.getBalance(positionUser.publicKey);
      const collateralVaultBefore = await provider.connection.getBalance(accounts.collateralVault);

      const tx = await program.methods
        .liquidate(openedMinBinId, openedMaxBinId)
        .accountsStrict(accounts)
        .signers([liquidator])
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc({ commitment: "confirmed" })
        .catch((e) => {
          console.log("\n  liquidate error:", e.message);
          if (e.logs) console.log("  logs:\n   ", e.logs.join("\n    "));
          throw e;
        });

      console.log("\n  liquidate tx:", tx);

      // Verify position state
      const positionAfter = await program.account.position.fetch(positionPda);
      expect(positionAfter.status).to.deep.equal(
        { liquidated: {} },
        "Position status must be Liquidated"
      );
      expect(positionAfter.debtAmount.toNumber()).to.equal(0, "debt_amount must be zeroed");
      expect(positionAfter.collateralAmount.toNumber()).to.equal(0, "collateral_amount must be zeroed");

      // Verify lending vault accounting
      const vaultAfter = await program.account.lendingVault.fetch(lendingVaultPda);
      expect(vaultAfter.totalBorrowed.toString()).to.equal(
        vaultBefore.totalBorrowed.sub(debtBefore).toString(),
        "totalBorrowed must decrease by the debt amount"
      );

      // Verify DLMM position account is gone
      const metPositionInfo = await provider.connection.getAccountInfo(metPositionKp.publicKey);
      expect(metPositionInfo).to.be.null;

      // Verify wSOL vault balance: LP proceeds returned to vault (repays debt)
      const wsolVaultBalanceAfter = await provider.connection.getTokenAccountBalance(wsolVaultPda);
      const vaultDelta = parseInt(wsolVaultBalanceAfter.value.amount) - parseInt(wsolVaultBalanceBefore.value.amount);
      expect(vaultDelta).to.be.greaterThanOrEqual(0,
        "wSOL vault must not lose funds from liquidation"
      );

      // Collateral vault should be drained (penalty + remainder distributed)
      const collateralVaultAfter = await provider.connection.getBalance(accounts.collateralVault);
      const collateralDistributed = collateralVaultBefore - collateralVaultAfter;

      // Liquidator receives penalty from collateral (native SOL)
      // Note: liquidator also pays tx fee, so net delta may be slightly less
      const liquidatorLamportsAfter = await provider.connection.getBalance(liquidator.publicKey);
      const liquidatorDelta = liquidatorLamportsAfter - liquidatorLamportsBefore;

      // Position owner receives remainder from collateral (native SOL)
      const ownerLamportsAfter = await provider.connection.getBalance(positionUser.publicKey);
      const ownerDelta = ownerLamportsAfter - ownerLamportsBefore;

      // Collateral should be fully distributed (penalty + remainder = original collateral)
      const collateral = depositAmount.toNumber();
      const expectedPenalty = Math.floor(collateral * 500 / 10000); // 5% penalty
      const expectedRemainder = collateral - expectedPenalty;

      expect(collateralDistributed).to.equal(collateral,
        "Full collateral must be distributed from vault"
      );
      expect(ownerDelta).to.equal(expectedRemainder,
        "Owner must receive collateral minus penalty"
      );
      // Liquidator delta includes penalty minus tx fees + rent from DLMM close
      expect(liquidatorDelta).to.be.greaterThan(0,
        "Liquidator must receive penalty (net of tx fees)"
      );

      const debt = debtBefore.toNumber();
      console.log("  Position status      : liquidated");
      console.log("  Debt repaid          :", debt / LAMPORTS_PER_SOL, "SOL");
      console.log("  totalBorrowed delta  :", debtBefore.toString(), "->", vaultAfter.totalBorrowed.toString());
      console.log("  wSOL vault delta     :", vaultDelta / LAMPORTS_PER_SOL, "SOL (LP proceeds)");
      console.log("  Collateral deposited :", collateral / LAMPORTS_PER_SOL, "SOL");
      console.log("  Expected penalty (5%):", expectedPenalty / LAMPORTS_PER_SOL, "SOL");
      console.log("  Owner remainder      :", ownerDelta / LAMPORTS_PER_SOL, "SOL");
      console.log("  Liquidator net delta :", liquidatorDelta / LAMPORTS_PER_SOL, "SOL (penalty - tx fees + rent)");
      console.log("  DLMM position        : closed on-chain");
    });
  });

  // ─── Constraints ──────────────────────────────────────────────────────────

  describe("liquidate -- constraints", () => {
    it("Rejects liquidation of healthy position", async () => {
      // Restore original thresholds so position would be healthy
      await program.methods
        .updateCollateralLtvParams(NATIVE_MINT, ORIGINAL_MAX_LTV, ORIGINAL_LIQUIDATION_THRESHOLD)
        .accountsStrict({ authority, config: configPda, collateralConfig: collateralConfigPda })
        .rpc();

      // Create a fresh position
      const user = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);

      const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), user.publicKey.toBuffer(), NATIVE_MINT.toBuffer()],
        program.programId
      );
      const [collateralVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), user.publicKey.toBuffer(), NATIVE_MINT.toBuffer()],
        program.programId
      );

      await program.methods.depositSolCollateral(new BN(2 * LAMPORTS_PER_SOL))
        .accountsStrict({
          user: user.publicKey, config: configPda, mint: NATIVE_MINT,
          collateralConfig: collateralConfigPda, vault: collateralVaultPda,
          position: positionPda, systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      const result = await openPosition(user, positionPda, wsolVaultPda);

      const liquidator = Keypair.generate();
      const liqSig = await provider.connection.requestAirdrop(liquidator.publicKey, 5 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(liqSig);

      const { accounts } = await buildLiquidateAccounts(
        liquidator.publicKey,
        user.publicKey,
        positionPda,
        result.metPositionKp.publicKey,
        result.minBinId,
        result.maxBinId,
      );

      try {
        await program.methods
          .liquidate(result.minBinId, result.maxBinId)
          .accountsStrict(accounts)
          .signers([liquidator])
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
          .rpc();
        throw new Error("Should have failed");
      } catch (e) {
        expect((e as Error).message).to.match(/PositionHealthy|6007/i);
        console.log("  Correctly rejected liquidation of healthy position");
      }
    });
  });
});
