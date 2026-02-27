/**
 * open_position.ts
 */

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
  NATIVE_MINT,
} from "@solana/spl-token";
import { expect } from "chai";

// ─── Constants ────────────────────────────────────────────────────────────────

const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
);
const LB_PAIR = new PublicKey("9zUvxwFTcuumU6Dkq68wWEAiLEmA4sp1amdG96aY7Tmq");
const BIN_RANGE = 5;
const BIN_ARRAY_SIZE = 70;

// ─── PDA helpers ─────────────────────────────────────────────────────────────

function binArrayIndex(binId: number): BN {
  return new BN(Math.floor(binId / BIN_ARRAY_SIZE));
}

function deriveBinArrayPda(lbPair: PublicKey, index: BN): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("bin_array"),
      lbPair.toBuffer(),
      index.toArrayLike(Buffer, "le", 8),
    ],
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

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Open Position", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.metlevEngine as Program<MetlevEngine>;
  const authority = provider.wallet.publicKey;

  const user = Keypair.generate();
  const lp = Keypair.generate();

  let configPda: PublicKey;
  let lendingVaultPda: PublicKey;
  let wsolVaultPda: PublicKey;
  let positionPda: PublicKey;
  let collateralConfigPda: PublicKey;
  let lpPositionPda: PublicKey;

  let userWsolAta: PublicKey;
  let lpWsolAta: PublicKey;

  let dlmmPool: DLMM;

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async function wrapSol(
    payer: Keypair,
    recipient: PublicKey,
    lamports: number
  ): Promise<PublicKey> {
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer,
      NATIVE_MINT,
      recipient
    );

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: ata.address,
        lamports,
      }),
      createSyncNativeInstruction(ata.address)
    );

    await provider.sendAndConfirm(tx, [payer]);
    return ata.address;
  }

  async function ensureBinArrayExists(index: BN): Promise<void> {
    const binArrayPda = deriveBinArrayPda(LB_PAIR, index);
    const info = await provider.connection.getAccountInfo(binArrayPda);
    if (info) return;

    console.log(`  Initialising bin array at index ${index.toString()} …`);
    const initTxs = await dlmmPool.initializeBinArrays([index], authority);
    for (const tx of initTxs) {
      await provider.sendAndConfirm(tx);
    }
  }

  // ─── before() ─────────────────────────────────────────────────────────────

  before("Fund wallets, derive PDAs, seed vault", async () => {
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
    [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), user.publicKey.toBuffer(), NATIVE_MINT.toBuffer()], 
      program.programId
    );
    [lpPositionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_position"), lp.publicKey.toBuffer()],
      program.programId
    );

    for (const kp of [user, lp]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        15 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    userWsolAta = await wrapSol(user, user.publicKey, 5 * LAMPORTS_PER_SOL);
    lpWsolAta = await wrapSol(lp, lp.publicKey, 10 * LAMPORTS_PER_SOL);

    try {
      await program.account.config.fetch(configPda);
      console.log("  Config already initialised, skipping.");
    } catch {
      await program.methods
        .initialize()
        .accountsStrict({
          authority,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("  Protocol config initialised.");
    }

    try {
      await program.account.lendingVault.fetch(lendingVaultPda);
      console.log("  Lending vault already initialised, skipping.");
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
      console.log("  Lending vault initialised.");
    }

    const supplyAmount = new BN(8 * LAMPORTS_PER_SOL);
    try {
      await program.account.lpPosition.fetch(lpPositionPda);
      console.log("  LP position already exists, skipping supply.");
    } catch {
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
      console.log("  LP supplied 8 wSOL to vault.");
    }

    try {
      await program.account.position.fetch(positionPda);
      console.log("  ✓ User position already exists, skipping deposit.");
    } catch {
      console.log("  Depositing 2 SOL to open a new position...");
      [collateralConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("collateral_config"), NATIVE_MINT.toBuffer()],
        program.programId
      );

      const [collateralVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), user.publicKey.toBuffer(), NATIVE_MINT.toBuffer()],
        program.programId
      );

      await program.methods
        .depositSolCollateral(new BN(2 * LAMPORTS_PER_SOL))
        .accountsStrict({
          user: user.publicKey,
          config: configPda,
          mint: NATIVE_MINT,
          collateralConfig: collateralConfigPda,
          vault: collateralVaultPda,
          position: positionPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      console.log("  ✓ User deposited 2 SOL as collateral.");
    }

    if (!collateralConfigPda) {
      [collateralConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("collateral_config"), NATIVE_MINT.toBuffer()],
        program.programId
      );
    }

    dlmmPool = await DLMM.create(provider.connection, LB_PAIR, {
      cluster: "devnet",
    });
    await dlmmPool.refetchStates();

    console.log("\n=== Setup Complete ===");
    console.log("  Lending Vault PDA : ", lendingVaultPda.toBase58());
    console.log("  wSOL Vault PDA    : ", wsolVaultPda.toBase58());
    console.log("  User Position PDA : ", positionPda.toBase58());
    console.log("  Pool (lb_pair)    : ", LB_PAIR.toBase58());
  });

  // ─── Helper: build all accounts for openPosition ──────────────────────────

  async function buildOpenPositionAccounts(positionKeypair: Keypair) {
    await dlmmPool.refetchStates();
    const activeBin = await dlmmPool.getActiveBin();
    const activeBinId = activeBin.binId;

    const isWsolX = dlmmPool.lbPair.tokenXMint.equals(NATIVE_MINT);

    let minBinId: number;
    let maxBinId: number;

    if (isWsolX) {
      minBinId = activeBinId + 1;
      maxBinId = activeBinId + BIN_RANGE;
    } else {
      minBinId = activeBinId - BIN_RANGE + 1;
      maxBinId = activeBinId;
    }

    const lowerBinId = minBinId;
    const width = maxBinId - minBinId + 1;

    const binLiquidityDist = [];
    for (let i = minBinId; i <= maxBinId; i++) {
      binLiquidityDist.push({
        binId: i,
        weight: 1000, 
      });
    }

    const lowerIdx = binArrayIndex(minBinId);
    const upperIdx = binArrayIndex(maxBinId);

    await ensureBinArrayExists(lowerIdx);
    if (!lowerIdx.eq(upperIdx)) {
      await ensureBinArrayExists(upperIdx);
    }

    const binArrayLower = deriveBinArrayPda(LB_PAIR, lowerIdx);
    const binArrayUpper = deriveBinArrayPda(LB_PAIR, upperIdx);

    const reserve = isWsolX
      ? dlmmPool.lbPair.reserveX
      : dlmmPool.lbPair.reserveY;
    const tokenMint = isWsolX
      ? dlmmPool.lbPair.tokenXMint
      : dlmmPool.lbPair.tokenYMint;

    const eventAuthority = deriveEventAuthority();

    const collateralCfgState = await program.account.collateralConfig.fetch(
      collateralConfigPda
    );
    const priceOracle: PublicKey = collateralCfgState.oracle;

    // --- FIX: Pre-allocate Meteora PositionV2 Account ---
    // Safely retrieve the exact size needed by the active DLMM program version
    const positionSize = dlmmPool.program.account.positionV2?.size || 376;
    const rent = await provider.connection.getMinimumBalanceForRentExemption(positionSize);

    const createPositionIx = SystemProgram.createAccount({
      fromPubkey: user.publicKey,
      newAccountPubkey: positionKeypair.publicKey,
      space: positionSize,
      lamports: rent,
      programId: DLMM_PROGRAM_ID,
    });

    return {
      params: {
        leverage: new BN(20_000),
        lowerBinId,
        width,
        activeId: activeBinId,
        maxActiveBinSlippage: 10,
        binLiquidityDist,
      },
      accounts: {
        user: user.publicKey,
        config: configPda,
        position: positionPda,
        lendingVault: lendingVaultPda,
        wsolVault: wsolVaultPda,
        wsolMint: NATIVE_MINT,
        collateralConfig: collateralConfigPda,
        priceOracle,
        metPosition: positionKeypair.publicKey,
        lbPair: LB_PAIR,
        binArrayBitmapExtension: null,
        reserve,
        tokenMint,
        binArrayLower,
        binArrayUpper,
        eventAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
        dlmmProgram: DLMM_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      },
      meta: {
        activeBinId,
        isWsolX,
        minBinId,
        maxBinId,
        binArrayLower,
        binArrayUpper,
        positionPubkey: positionKeypair.publicKey,
      },
      // Export the preInstruction
      createPositionIx,
    };
  }

  // ─── Tests ────────────────────────────────────────────────────────────────

  describe("openPosition — happy path", () => {
    it("Opens a 2× leveraged DLMM position and deposits wSOL", async () => {
      const metPositionKp = Keypair.generate();
      const { params, accounts, meta, createPositionIx } = await buildOpenPositionAccounts(
        metPositionKp
      );

      console.log("\n  Pool details:");
      console.log("    Active bin     :", meta.activeBinId);
      console.log("    wSOL is token  :", meta.isWsolX ? "X" : "Y");
      console.log(`    Bin range      : [${meta.minBinId}, ${meta.maxBinId}]`);
      console.log("    Bin array lower:", meta.binArrayLower.toBase58());
      console.log("    Bin array upper:", meta.binArrayUpper.toBase58());

      const vaultBefore = await program.account.lendingVault.fetch(lendingVaultPda);
      const wsolVaultBefore = await provider.connection.getTokenAccountBalance(wsolVaultPda);

      const tx = await program.methods
        .openPosition(
          params.leverage,
          params.lowerBinId,
          params.width,
          params.activeId,
          params.maxActiveBinSlippage,
          params.binLiquidityDist
        )
        .accountsStrict(accounts)
        .signers([user, metPositionKp])
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          createPositionIx, // Inject the manual account allocation here!
        ])
        .rpc({ commitment: "confirmed" });

      console.log("\n  openPosition tx:", tx);

      const positionState = await program.account.position.fetch(positionPda);
      const expectedBorrow = positionState.collateralAmount.mul(params.leverage).divn(10_000);
      
      expect(positionState.debtAmount.toString()).to.equal(expectedBorrow.toString());

      const vaultAfter = await program.account.lendingVault.fetch(lendingVaultPda);
      expect(vaultAfter.totalBorrowed.toString()).to.equal(
        vaultBefore.totalBorrowed.add(expectedBorrow).toString()
      );

      const wsolVaultAfter = await provider.connection.getTokenAccountBalance(wsolVaultPda);
      const delta = Number(wsolVaultBefore.value.amount) - Number(wsolVaultAfter.value.amount);
      
      expect(delta).to.equal(expectedBorrow.toNumber());

      const metPositionInfo = await provider.connection.getAccountInfo(metPositionKp.publicKey);
      expect(metPositionInfo).to.not.be.null;
      expect(metPositionInfo!.owner.toBase58()).to.equal(DLMM_PROGRAM_ID.toBase58());

      console.log("\n  ✓ Debt recorded   :", positionState.debtAmount.toString(), "lamports");
      console.log("  ✓ Vault decrease  :", delta / LAMPORTS_PER_SOL, "wSOL removed from vault");
      console.log("  ✓ DLMM position   :", metPositionKp.publicKey.toBase58());
    });

    it("Can verify DLMM position has liquidity via the SDK", async () => {
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(user.publicKey);

      expect(userPositions.length).to.be.greaterThan(0);

      const pos = userPositions[0];
      const totalLiquidity = pos.positionData.positionBinData.reduce(
        (sum, bin) => sum + Number(bin.positionLiquidity),
        0
      );

      expect(totalLiquidity).to.be.greaterThan(0);
      console.log("\n  ✓ Total position liquidity:", totalLiquidity);
    });
  });

  // ─── Constraint tests ─────────────────────────────────────────────────────

  describe("openPosition — constraints", () => {
    it("Rejects when protocol is paused", async () => {
      await program.methods
        .updatePauseState(true)
        .accountsStrict({ authority, config: configPda })
        .rpc();

      const metPositionKp = Keypair.generate();
      const { params, accounts, createPositionIx } = await buildOpenPositionAccounts(metPositionKp);

      try {
        await program.methods
          .openPosition(
            params.leverage,
            params.lowerBinId,
            params.width,
            params.activeId,
            params.maxActiveBinSlippage,
            params.binLiquidityDist
          )
          .accountsStrict(accounts)
          .signers([user, metPositionKp])
          .preInstructions([createPositionIx]) // Must allocate even to test failures
          .rpc();
        throw new Error("Should have failed");
      } catch (e) {
        expect((e as Error).message).to.match(/ProtocolPaused|paused/i);
        console.log("  ✓ Correctly rejected when protocol is paused");
      } finally {
        await program.methods
          .updatePauseState(false)
          .accountsStrict({ authority, config: configPda })
          .rpc();
      }
    });

    it("Rejects when LTV exceeds maximum", async () => {
      const metPositionKp = Keypair.generate();
      const { params, accounts, createPositionIx } = await buildOpenPositionAccounts(metPositionKp);

      try {
        await program.methods
          .openPosition(
            new BN(500_000), 
            params.lowerBinId,
            params.width,
            params.activeId,
            params.maxActiveBinSlippage,
            params.binLiquidityDist
          )
          .accountsStrict(accounts)
          .signers([user, metPositionKp])
          .preInstructions([createPositionIx])
          .rpc();
        throw new Error("Should have failed");
      } catch (e) {
        expect((e as Error).message).to.match(/ExceedsMaxLTV|ltv|LTV/i);
        console.log("  ✓ Correctly rejected when LTV is exceeded");
      }
    });

    it("Rejects when vault has insufficient liquidity", async () => {
      const metPositionKp = Keypair.generate();
      const { params, accounts, createPositionIx } = await buildOpenPositionAccounts(metPositionKp);

      try {
        await program.methods
          .openPosition(
            new BN(10_000_000), 
            params.lowerBinId,
            params.width,
            params.activeId,
            params.maxActiveBinSlippage,
            params.binLiquidityDist
          )
          .accountsStrict(accounts)
          .signers([user, metPositionKp])
          .preInstructions([createPositionIx])
          .rpc();
        throw new Error("Should have failed");
      } catch (e) {
        expect((e as Error).message).to.match(/InsufficientLiquidity|insufficient|ExceedsMaxLTV/i);
        console.log("  ✓ Correctly rejected due to insufficient vault liquidity");
      }
    });

    it("Rejects when the wrong user tries to open against someone else's position", async () => {
      const rogue = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        rogue.publicKey,
        3 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      const metPositionKp = Keypair.generate();
      const { params, accounts, createPositionIx } = await buildOpenPositionAccounts(metPositionKp);

      try {
        await program.methods
          .openPosition(
            params.leverage,
            params.lowerBinId,
            params.width,
            params.activeId,
            params.maxActiveBinSlippage,
            params.binLiquidityDist
          )
          .accountsStrict({ ...accounts, user: rogue.publicKey })
          .signers([rogue, metPositionKp])
          .preInstructions([createPositionIx]) 
          .rpc();
        throw new Error("Should have failed");
      } catch (e) {
        expect((e as Error).message).to.match(/InvalidOwner|seeds|constraint/i);
        console.log("  ✓ Correctly rejected unauthorized access to position");
      }
    });
  });
});