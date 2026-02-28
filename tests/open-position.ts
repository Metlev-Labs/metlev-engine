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

/**
 * Computes the bin array index for a given bin ID, matching DLMM's on-chain
 * Rust logic which uses truncating integer division:
 *
 *   index = (bin_id / 70) - (1 if bin_id % 70 < 0 else 0)
 *
 * This is equivalent to Rust's `bin_id / MAX_BIN_PER_ARRAY` for all integers,
 * including negatives.  JavaScript's `Math.trunc` replicates Rust truncation.
 *
 * Examples:
 *   binArrayIndex(-16127) → Math.trunc(-230.38) = -230, remainder = -16127 - (-230*70)
 *                         = -16127 + 16100 = -27, so -27 < 0 → index = -231
 *   binArrayIndex(-16131) → Math.trunc(-230.44) = -230, remainder = -31 < 0 → index = -231
 *   binArrayIndex(100)    → Math.trunc(1.42) = 1, remainder = 30, 30 >= 0 → index = 1
 */
function binArrayIndex(binId: number): BN {
  const quotient = Math.trunc(binId / BIN_ARRAY_SIZE);
  const remainder = binId % BIN_ARRAY_SIZE;
  const index = remainder < 0 ? quotient - 1 : quotient;
  return new BN(index);
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
    lpWsolAta   = await wrapSol(lp,   lp.publicKey,  10 * LAMPORTS_PER_SOL);

    // ── Initialize protocol config ──────────────────────────────────────────
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

    // ── Initialize lending vault ────────────────────────────────────────────
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

    // ── LP supplies wSOL ────────────────────────────────────────────────────
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

    // ── User deposits collateral ────────────────────────────────────────────
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

    // Determine which token is wSOL in this pool
    const isWsolX = dlmmPool.lbPair.tokenXMint.equals(NATIVE_MINT);

    // Pick bin range based on which side wSOL occupies:
    //   wSOL is X → deposit above active bin (bins > active_id)
    //   wSOL is Y → deposit at/below active bin (bins <= active_id)
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
    const width = maxBinId - minBinId + 1; // should equal BIN_RANGE

    // Uniform weight distribution across all bins in range
    const binLiquidityDist: Array<{ binId: number; weight: number }> = [];
    for (let i = minBinId; i <= maxBinId; i++) {
      binLiquidityDist.push({ binId: i, weight: 1000 });
    }

    // Derive bin array indices using the corrected formula
    const lowerIdx = binArrayIndex(minBinId);
    const upperIdx = binArrayIndex(maxBinId);

    // Initialise bin arrays if they don't exist yet
    await ensureBinArrayExists(lowerIdx);
    if (!lowerIdx.eq(upperIdx)) {
      await ensureBinArrayExists(upperIdx);
    }

    const binArrayLower = deriveBinArrayPda(LB_PAIR, lowerIdx);
    const binArrayUpper = deriveBinArrayPda(LB_PAIR, upperIdx);

    // Note: binArrayLower === binArrayUpper is expected and valid when the
    // entire range fits within one 70-bin window (as is the case here for
    // bin range [-16131, -16127] which is fully within array index -231).
    // DLMM accepts duplicate accounts for bin_array_lower / bin_array_upper.

    const reserve  = isWsolX ? dlmmPool.lbPair.reserveX  : dlmmPool.lbPair.reserveY;
    const tokenMint = isWsolX ? dlmmPool.lbPair.tokenXMint : dlmmPool.lbPair.tokenYMint;
    const eventAuthority = deriveEventAuthority();

    const collateralCfgState = await program.account.collateralConfig.fetch(
      collateralConfigPda
    );
    const priceOracle: PublicKey = collateralCfgState.oracle;

    // ── met_position keypair: NO pre-allocation ─────────────────────────────
    //
    // Do NOT call SystemProgram.createAccount for positionKeypair.
    // DLMM's initialize_position uses #[account(init)] which:
    //   1. Verifies the account is uninitialized (owned by SystemProgram).
    //   2. Allocates space and assigns ownership to DLMM via an inner CPI.
    //   3. Writes the 8-byte discriminator.
    //
    // Pre-allocating the account causes Error 3001 AccountDiscriminatorNotFound
    // because DLMM finds an already-DLMM-owned account with zero data.

    return {
      params: {
        leverage: new BN(20_000), // 2× leverage
        lowerBinId,
        width,
        activeId: activeBinId,
        maxActiveBinSlippage: 10,
        binLiquidityDist,
      },
      accounts: {
        user: user.publicKey,
        config: configPda,
        wsolMint: NATIVE_MINT,
        position: positionPda,
        lendingVault: lendingVaultPda,
        wsolVault: wsolVaultPda,
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
    };
  }

  // ─── Tests ────────────────────────────────────────────────────────────────

  describe("openPosition — happy path", () => {
    it("Opens a 2× leveraged DLMM position and deposits wSOL", async () => {
      // Generate a fresh keypair for the DLMM position.
      // This account MUST NOT exist on-chain — DLMM creates it in the CPI.
      const metPositionKp = Keypair.generate();

      const { params, accounts, meta } = await buildOpenPositionAccounts(metPositionKp);

      console.log("\n  Pool details:");
      console.log("    Active bin     :", meta.activeBinId);
      console.log("    wSOL is token  :", meta.isWsolX ? "X" : "Y");
      console.log(`    Bin range      : [${meta.minBinId}, ${meta.maxBinId}]`);
      console.log("    Bin array lower:", meta.binArrayLower.toBase58());
      console.log("    Bin array upper:", meta.binArrayUpper.toBase58());
      if (meta.binArrayLower.equals(meta.binArrayUpper)) {
        console.log("    (lower == upper: same bin array window — valid for DLMM)");
      }

      const vaultBefore    = await program.account.lendingVault.fetch(lendingVaultPda);
      const wsolBefore     = await provider.connection.getTokenAccountBalance(wsolVaultPda);

      // ── Execute openPosition ────────────────────────────────────────────
      // Signers:
      //   - user           → pays rent for DLMM position, satisfies Signer<user>
      //   - metPositionKp  → enables inner system_program::create_account CPI
      //
      // NO preInstructions — met_position must be uninitialized.
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
        ])
        .rpc({ commitment: "confirmed" });

      console.log("\n  openPosition tx:", tx);

      // ── Assertions ─────────────────────────────────────────────────────
      const positionState  = await program.account.position.fetch(positionPda);
      const expectedBorrow = positionState.collateralAmount
        .mul(params.leverage)
        .divn(10_000);

      // 1. Protocol position records the correct debt amount
      expect(positionState.debtAmount.toString()).to.equal(
        expectedBorrow.toString(),
        "debtAmount mismatch"
      );

      // 2. Vault total_borrowed increased by borrow amount
      const vaultAfter = await program.account.lendingVault.fetch(lendingVaultPda);
      expect(vaultAfter.totalBorrowed.toString()).to.equal(
        vaultBefore.totalBorrowed.add(expectedBorrow).toString(),
        "totalBorrowed mismatch"
      );

      // 3. wSOL vault balance decreased by borrow amount
      const wsolAfter = await provider.connection.getTokenAccountBalance(wsolVaultPda);
      const delta = Number(wsolBefore.value.amount) - Number(wsolAfter.value.amount);
      expect(delta).to.equal(
        expectedBorrow.toNumber(),
        "wSOL vault delta mismatch"
      );

      // 4. DLMM position account exists and is owned by the DLMM program
      const metPositionInfo = await provider.connection.getAccountInfo(
        metPositionKp.publicKey
      );
      expect(metPositionInfo).to.not.be.null;
      expect(metPositionInfo!.owner.toBase58()).to.equal(
        DLMM_PROGRAM_ID.toBase58(),
        "DLMM position owner mismatch"
      );

      console.log("\n  ✓ Debt recorded   :", positionState.debtAmount.toString(), "lamports");
      console.log("  ✓ Vault decrease  :", delta / LAMPORTS_PER_SOL, "wSOL");
      console.log("  ✓ DLMM position   :", metPositionKp.publicKey.toBase58());
    });

    it("Can verify DLMM position has liquidity via the SDK", async () => {
      // Query all positions owned by lending_vault (the DLMM position owner)
      // The protocol's lending_vault PDA is the DLMM position owner.
      const [lendingVaultPdaAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from("lending_vault")],
        program.programId
      );

      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(
        lendingVaultPdaAddress
      );

      expect(userPositions.length).to.be.greaterThan(
        0,
        "No positions found for lending_vault owner"
      );

      const pos = userPositions[0];
      const totalLiquidity = pos.positionData.positionBinData.reduce(
        (sum, bin) => sum + Number(bin.positionLiquidity),
        0
      );

      expect(totalLiquidity).to.be.greaterThan(0, "Position has no liquidity");
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
      const { params, accounts } = await buildOpenPositionAccounts(metPositionKp);

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
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ])
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
      const { params, accounts } = await buildOpenPositionAccounts(metPositionKp);

      try {
        await program.methods
          .openPosition(
            new BN(500_000), // 50× leverage → LTV >> max
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
          ])
          .rpc();
        throw new Error("Should have failed");
      } catch (e) {
        expect((e as Error).message).to.match(
          /ExceedsMaxLTV|ltv|LTV|InsufficientLiquidity/i
        );
        console.log("  ✓ Correctly rejected when LTV is exceeded");
      }
    });

    it("Rejects when vault has insufficient liquidity", async () => {
      const metPositionKp = Keypair.generate();
      const { params, accounts } = await buildOpenPositionAccounts(metPositionKp);

      try {
        await program.methods
          .openPosition(
            new BN(10_000_000), // leverage so large borrow >> vault balance
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
          ])
          .rpc();
        throw new Error("Should have failed");
      } catch (e) {
        expect((e as Error).message).to.match(
          /InsufficientLiquidity|insufficient|ExceedsMaxLTV/i
        );
        console.log("  ✓ Correctly rejected due to insufficient vault liquidity");
      }
    });

    it("Rejects when the wrong user tries to open against someone else's position", async () => {
      // Fund a rogue actor
      const rogue = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        rogue.publicKey,
        3 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      const metPositionKp = Keypair.generate();

      // Build accounts using the legitimate user's position PDA
      const { params, accounts } = await buildOpenPositionAccounts(metPositionKp);

      // Replace user with rogue — position.owner constraint will reject this
      // because position.owner == user.publicKey != rogue.publicKey.
      // Note: no createPositionIx here, so we don't have a fromPubkey: user
      // issue causing a false "Signature verification failed" error.
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
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ])
          .rpc();
        throw new Error("Should have failed");
      } catch (e) {
        // Anchor will fail with a seeds/constraint error because position PDA
        // is derived with user.publicKey, not rogue.publicKey.
        // The error may surface as seeds/constraint violation or InvalidOwner.
        expect((e as Error).message).to.match(
          /InvalidOwner|seeds|constraint|AccountNotFound|2006/i
        );
        console.log("  ✓ Correctly rejected unauthorized access to position");
      }
    });
  });
});