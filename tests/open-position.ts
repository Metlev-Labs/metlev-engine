/**
 * open_position.ts
 *
 * Integration tests for the `open_position` instruction.
 *
 * Flow tested:
 * 1. Protocol init  (config + lending vault)
 * 2. LP supplies wSOL liquidity to lending vault
 * 3. User deposits collateral to create a protocol Position
 * 4. User calls `openPosition` which:
 * a. Borrows wSOL from the vault (leverage × collateral)
 * b. CPI → Meteora initialize_position
 * c. CPI → Meteora add_liquidity_one_side  (signed by lending_vault PDA)
 *
 * Prerequisites:
 * - Devnet pool `9zUvxwFTcuumU6Dkq68wWEAiLEmA4sp1amdG96aY7Tmq` must be live.
 * - The bin arrays covering your chosen bin range must already be initialised.
 * Call `dlmmPool.initializeBinArrays(...)` once per range if they are not.
 *
 * Install dependencies:
 * yarn add @meteora-ag/dlmm @coral-xyz/anchor @solana/web3.js @solana/spl-token bn.js
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

/** Meteora DLMM program (same on mainnet and devnet) */
const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
);

/** The devnet pool we are targeting */
const LB_PAIR = new PublicKey("9zUvxwFTcuumU6Dkq68wWEAiLEmA4sp1amdG96aY7Tmq");

/** How many bins on each side of the active bin to cover */
const BIN_RANGE = 5;

/** 70 bins packed into one BinArray account */
const BIN_ARRAY_SIZE = 70;

// ─── PDA helpers ─────────────────────────────────────────────────────────────

/**
 * Returns the BinArray index for a given bin ID.
 * JavaScript's `Math.floor` handles negative bin IDs correctly.
 */
function binArrayIndex(binId: number): BN {
  return new BN(Math.floor(binId / BIN_ARRAY_SIZE));
}

/**
 * Derives the on-chain BinArray PDA for the given lb_pair and array index.
 * PDA seeds: ["bin_array", lb_pair_pubkey, index_as_i64_le]
 */
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

/**
 * Derives the DLMM program's event authority PDA.
 * Seeds: ["__event_authority"]
 */
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

  /** The leveraged user */
  const user = Keypair.generate();
  /** An LP who pre-funds the lending vault */
  const lp = Keypair.generate();

  // ── PDAs ──────────────────────────────────────────────────────────────────
  let configPda: PublicKey;
  let lendingVaultPda: PublicKey;
  let wsolVaultPda: PublicKey;
  let positionPda: PublicKey;
  let collateralConfigPda: PublicKey;
  let lpPositionPda: PublicKey;

  // ── Token accounts ────────────────────────────────────────────────────────
  let userWsolAta: PublicKey;
  let lpWsolAta: PublicKey;

  // ── DLMM pool state (fetched via SDK) ────────────────────────────────────
  let dlmmPool: DLMM;

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Wraps native SOL into wSOL for the given keypair. */
  async function wrapSol(
    payer: Keypair,
    recipient: PublicKey,
    lamports: number
  ): Promise<PublicKey> {
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer, // fee payer
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

  /** Ensures a bin array exists on-chain; initialises it if not. */
  async function ensureBinArrayExists(index: BN): Promise<void> {
    const binArrayPda = deriveBinArrayPda(LB_PAIR, index);
    const info = await provider.connection.getAccountInfo(binArrayPda);
    if (info) return; // already initialised

    console.log(`  Initialising bin array at index ${index.toString()} …`);
    const initTxs = await dlmmPool.initializeBinArrays([index], authority);
    for (const tx of initTxs) {
      await provider.sendAndConfirm(tx);
    }
  }

  // ─── before() ─────────────────────────────────────────────────────────────

  before("Fund wallets, derive PDAs, seed vault", async () => {
    // ── Derive PDAs ─────────────────────────────────────────────────────────
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
    
    // Updated to match 3 seeds from deposit_sol_collateral
    [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), user.publicKey.toBuffer(), NATIVE_MINT.toBuffer()], 
      program.programId
    );
    [lpPositionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_position"), lp.publicKey.toBuffer()],
      program.programId
    );

    // ── Airdrop SOL to actors ────────────────────────────────────────────────
    for (const kp of [user, lp]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        15 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // ── Wrap SOL for user (will be used as collateral) ───────────────────────
    userWsolAta = await wrapSol(user, user.publicKey, 5 * LAMPORTS_PER_SOL);

    // ── Wrap SOL for LP (will supply to lending vault) ───────────────────────
    lpWsolAta = await wrapSol(lp, lp.publicKey, 10 * LAMPORTS_PER_SOL);

    // ── Initialise protocol config (idempotent) ──────────────────────────────
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

    // ── Initialise lending vault (idempotent) ────────────────────────────────
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

    // ── LP supplies 8 SOL worth of wSOL ─────────────────────────────────────
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

    // ── User deposits 2 SOL collateral to create protocol Position ───────────
    try {
      await program.account.position.fetch(positionPda);
      console.log("  ✓ User position already exists, skipping deposit.");
    } catch {
      console.log("  Depositing 2 SOL to open a new position...");
      [collateralConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("collateral_config"), NATIVE_MINT.toBuffer()],
        program.programId
      );

      // Derive the collateral vault PDA required by deposit_sol_collateral.rs
      const [collateralVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), user.publicKey.toBuffer(), NATIVE_MINT.toBuffer()],
        program.programId
      );

      await program.methods
        .depositSolCollateral(new BN(2 * LAMPORTS_PER_SOL)) // Correct method name
        .accountsStrict({
          user: user.publicKey,
          config: configPda,
          mint: NATIVE_MINT, // Correct account name expected by Rust
          collateralConfig: collateralConfigPda,
          vault: collateralVaultPda, // Add missing vault PDA
          position: positionPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      console.log("  ✓ User deposited 2 SOL as collateral.");
    }

    // ── Fetch existing collateralConfig PDA (may have been set above) ─────────
    if (!collateralConfigPda) {
      [collateralConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("collateral_config"), NATIVE_MINT.toBuffer()],
        program.programId
      );
    }

    // ── Initialise DLMM SDK against the devnet pool ──────────────────────────
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
    // Refresh on-chain state so we have current active bin
    await dlmmPool.refetchStates();
    const activeBin = await dlmmPool.getActiveBin();
    const activeBinId = activeBin.binId;

    // Decide which side WSOL occupies in this pool
    const isWsolX = dlmmPool.lbPair.tokenXMint.equals(NATIVE_MINT);

    // Bin range for single-sided deposit:
    //   token X → bins strictly ABOVE active bin
    //   token Y → bins at or BELOW active bin
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
    const width = maxBinId - minBinId + 1; // = BIN_RANGE

    // Build uniform per-bin weight distribution
    const binLiquidityDist = [];
    for (let i = minBinId; i <= maxBinId; i++) {
      binLiquidityDist.push({
        binId: i,
        weight: 1000, // equal weight; DLMM normalises internally
      });
    }

    // Derive bin array PDAs (covers lower and upper edges of the range)
    const lowerIdx = binArrayIndex(minBinId);
    const upperIdx = binArrayIndex(maxBinId);

    // Ensure the bin arrays are initialised on-chain
    await ensureBinArrayExists(lowerIdx);
    if (!lowerIdx.eq(upperIdx)) {
      await ensureBinArrayExists(upperIdx);
    }

    const binArrayLower = deriveBinArrayPda(LB_PAIR, lowerIdx);
    const binArrayUpper = deriveBinArrayPda(LB_PAIR, upperIdx);

    // Pool reserve and mint for the deposited token
    const reserve = isWsolX
      ? dlmmPool.lbPair.reserveX
      : dlmmPool.lbPair.reserveY;
    const tokenMint = isWsolX
      ? dlmmPool.lbPair.tokenXMint
      : dlmmPool.lbPair.tokenYMint;

    // Event authority PDA of the DLMM program
    const eventAuthority = deriveEventAuthority();

    // Fetch the oracle address from the on-chain collateral config
    const collateralCfgState = await program.account.collateralConfig.fetch(
      collateralConfigPda
    );
    const priceOracle: PublicKey = collateralCfgState.oracle;

    return {
      // openPosition instruction parameters
      params: {
        leverage: new BN(20_000), // 2× — borrow = collateral × 2
        lowerBinId,
        width,
        activeId: activeBinId,
        maxActiveBinSlippage: 10,
        binLiquidityDist,
      },
      // Accounts
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
        binArrayBitmapExtension: null, // Only needed for |binId| > 512
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
      // Extra info for assertions
      meta: {
        activeBinId,
        isWsolX,
        minBinId,
        maxBinId,
        binArrayLower,
        binArrayUpper,
        positionPubkey: positionKeypair.publicKey,
      },
    };
  }

  // ─── Tests ────────────────────────────────────────────────────────────────

  describe("openPosition — happy path", () => {
    it("Opens a 2× leveraged DLMM position and deposits wSOL", async () => {
      // Generate a fresh DLMM position keypair for this test
      const metPositionKp = Keypair.generate();

      const { params, accounts, meta } = await buildOpenPositionAccounts(
        metPositionKp
      );

      console.log("\n  Pool details:");
      console.log("    Active bin     :", meta.activeBinId);
      console.log("    wSOL is token  :", meta.isWsolX ? "X" : "Y");
      console.log(
        `    Bin range      : [${meta.minBinId}, ${meta.maxBinId}]`
      );
      console.log("    Bin array lower:", meta.binArrayLower.toBase58());
      console.log("    Bin array upper:", meta.binArrayUpper.toBase58());

      // Snapshot state before
      const vaultBefore = await program.account.lendingVault.fetch(
        lendingVaultPda
      );
      const wsolVaultBefore =
        await provider.connection.getTokenAccountBalance(wsolVaultPda);

      // ── Execute the instruction ────────────────────────────────────────────
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
        // Both user AND the freshly generated met_position Keypair must sign.
        //   user         → pays rent, collateral, satisfies Signer constraints
        //   metPositionKp → authorises creation of the DLMM position account
        .signers([user, metPositionKp])
        .preInstructions([
          // DLMM add_liquidity is compute-heavy; request extra units.
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ])
        .rpc({ commitment: "confirmed" });

      console.log("\n  openPosition tx:", tx);

      // ── Assertions ────────────────────────────────────────────────────────

      // 1. Our protocol Position now has a non-zero debt
      const positionState = await program.account.position.fetch(positionPda);
      const expectedBorrow = positionState.collateralAmount
        .mul(params.leverage)
        .divn(10_000);
      expect(positionState.debtAmount.toString()).to.equal(
        expectedBorrow.toString(),
        "Position debt should equal collateral × leverage / 10_000"
      );

      // 2. Lending vault total_borrowed increased by the same amount
      const vaultAfter = await program.account.lendingVault.fetch(
        lendingVaultPda
      );
      expect(vaultAfter.totalBorrowed.toString()).to.equal(
        vaultBefore.totalBorrowed.add(expectedBorrow).toString(),
        "totalBorrowed should have increased"
      );

      // 3. wSOL was pulled from the vault (balance decreased)
      const wsolVaultAfter =
        await provider.connection.getTokenAccountBalance(wsolVaultPda);
      const delta =
        Number(wsolVaultBefore.value.amount) -
        Number(wsolVaultAfter.value.amount);
      expect(delta).to.equal(
        expectedBorrow.toNumber(),
        "wSOL vault should have decreased by the borrowed amount"
      );

      // 4. The DLMM position account was created on-chain
      const metPositionInfo = await provider.connection.getAccountInfo(
        metPositionKp.publicKey
      );
      expect(metPositionInfo).to.not.be.null;
      expect(metPositionInfo!.owner.toBase58()).to.equal(
        DLMM_PROGRAM_ID.toBase58(),
        "DLMM position account should be owned by the DLMM program"
      );

      console.log("\n  ✓ Debt recorded   :", positionState.debtAmount.toString(), "lamports");
      console.log(
        "  ✓ Vault decrease  :",
        delta / LAMPORTS_PER_SOL,
        "wSOL removed from vault"
      );
      console.log(
        "  ✓ DLMM position   :",
        metPositionKp.publicKey.toBase58()
      );
    });

    it("Can verify DLMM position has liquidity via the SDK", async () => {
      // Re-query positions owned by user through the SDK
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(
        user.publicKey
      );

      expect(userPositions.length).to.be.greaterThan(
        0,
        "User should have at least one DLMM position"
      );

      const pos = userPositions[0];
      const totalLiquidity = pos.positionData.positionBinData.reduce(
        (sum, bin) => sum + Number(bin.positionLiquidity),
        0
      );

      expect(totalLiquidity).to.be.greaterThan(
        0,
        "DLMM position should contain non-zero liquidity"
      );

      console.log(
        "\n  ✓ Total position liquidity:",
        totalLiquidity
      );
    });
  });

  // ─── Constraint tests ─────────────────────────────────────────────────────

  describe("openPosition — constraints", () => {
    it("Rejects when protocol is paused", async () => {
      // Pause the protocol first - UPDATED METHOD NAME
      await program.methods
        .updatePauseState(true)
        .accountsStrict({
          authority,
          config: configPda,
        })
        .rpc();

      const metPositionKp = Keypair.generate();
      const { params, accounts } = await buildOpenPositionAccounts(
        metPositionKp
      );

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
          .rpc();
        throw new Error("Should have failed");
      } catch (e) {
        expect((e as Error).message).to.match(
          /ProtocolPaused|paused/i,
          "Expected ProtocolPaused error"
        );
        console.log("  ✓ Correctly rejected when protocol is paused");
      } finally {
        // Un-pause for subsequent tests - UPDATED METHOD NAME
        await program.methods
          .updatePauseState(false)
          .accountsStrict({ authority, config: configPda })
          .rpc();
      }
    });

    it("Rejects when LTV exceeds maximum", async () => {
      // Use an absurdly high leverage that pushes LTV above the allowed cap
      const metPositionKp = Keypair.generate();
      const { params, accounts } = await buildOpenPositionAccounts(
        metPositionKp
      );

      try {
        await program.methods
          .openPosition(
            new BN(500_000), // 50× leverage — should breach max LTV
            params.lowerBinId,
            params.width,
            params.activeId,
            params.maxActiveBinSlippage,
            params.binLiquidityDist
          )
          .accountsStrict(accounts)
          .signers([user, metPositionKp])
          .rpc();
        throw new Error("Should have failed");
      } catch (e) {
        expect((e as Error).message).to.match(
          /ExceedsMaxLTV|ltv|LTV/i,
          "Expected ExceedsMaxLTV error"
        );
        console.log("  ✓ Correctly rejected when LTV is exceeded");
      }
    });

    it("Rejects when vault has insufficient liquidity", async () => {
      // Request more wSOL than the vault holds
      const metPositionKp = Keypair.generate();
      const { params, accounts } = await buildOpenPositionAccounts(
        metPositionKp
      );

      try {
        await program.methods
          .openPosition(
            new BN(10_000_000), // huge leverage to exhaust vault
            params.lowerBinId,
            params.width,
            params.activeId,
            params.maxActiveBinSlippage,
            params.binLiquidityDist
          )
          .accountsStrict(accounts)
          .signers([user, metPositionKp])
          .rpc();
        throw new Error("Should have failed");
      } catch (e) {
        expect((e as Error).message).to.match(
          /InsufficientLiquidity|insufficient|ExceedsMaxLTV/i,
          "Expected an error when vault has insufficient liquidity"
        );
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
      const { params, accounts } = await buildOpenPositionAccounts(
        metPositionKp
      );

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
          // Rogue signer but accounts still point to `user`'s position
          .accountsStrict({ ...accounts, user: rogue.publicKey })
          .signers([rogue, metPositionKp])
          .rpc();
        throw new Error("Should have failed");
      } catch (e) {
        expect((e as Error).message).to.match(
          /InvalidOwner|seeds|constraint/i,
          "Expected an ownership error"
        );
        console.log("  ✓ Correctly rejected unauthorized access to position");
      }
    });
  });
});