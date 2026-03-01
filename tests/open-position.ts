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

  let lpWsolAta: PublicKey;

  let dlmmPool: DLMM;

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
    const ixs = await dlmmPool.initializeBinArrays([index], authority);
    if (ixs.length > 0) {
      const tx = new Transaction().add(...ixs);
      await provider.sendAndConfirm(tx);
    }
  }

  before("Fund wallets, derive PDAs, seed vault", async function() {
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

    try {
      dlmmPool = await DLMM.create(provider.connection, LB_PAIR, {
        cluster: "devnet",
      });
      await dlmmPool.refetchStates();
    } catch {
      console.log("  ⚠ LB pair not found — skipping open position tests (requires devnet)");
      this.skip();
    }

    console.log("\n=== Setup Complete ===");
    console.log("  Program ID        : ", program.programId.toBase58());
    console.log("  collateralConfigPda:", collateralConfigPda.toBase58());
    console.log("  Lending Vault PDA : ", lendingVaultPda.toBase58());
    console.log("  wSOL Vault PDA    : ", wsolVaultPda.toBase58());
    console.log("  User Position PDA : ", positionPda.toBase58());
    console.log("  Pool (lb_pair)    : ", LB_PAIR.toBase58());
  });

  async function buildOpenPositionAccounts(positionKeypair: Keypair) {
    await dlmmPool.refetchStates();
    const activeBin = await dlmmPool.getActiveBin();
    const activeBinId = activeBin.binId;

    const isWsolX = dlmmPool.lbPair.tokenXMint.equals(NATIVE_MINT);

    const activeArrayIdx = binArrayIndex(activeBinId).toNumber();
    const half = Math.floor(POSITION_WIDTH / 2);

    let minBinId: number;
    let maxBinId: number;

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

    const lowerBinId = minBinId;
    const width = maxBinId - minBinId + 1;

    // Uniform weight distribution across all bins in range
    const binLiquidityDist: Array<{ binId: number; weight: number }> = [];
    for (let i = minBinId; i <= maxBinId; i++) {
      binLiquidityDist.push({ binId: i, weight: 1000 });
    }

    await ensureBinArrayExists(lowerIdx);
    await ensureBinArrayExists(upperIdx);

    const binArrayLower = deriveBinArrayPda(LB_PAIR, lowerIdx);
    const binArrayUpper = deriveBinArrayPda(LB_PAIR, upperIdx);

    const reserve  = isWsolX ? dlmmPool.lbPair.reserveX  : dlmmPool.lbPair.reserveY;
    const tokenMint = isWsolX ? dlmmPool.lbPair.tokenXMint : dlmmPool.lbPair.tokenYMint;
    const eventAuthority = deriveEventAuthority();

    const [priceOracle] = PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle"), NATIVE_MINT.toBuffer()],
      program.programId
    );

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

  describe("openPosition — happy path", () => {
    it("Opens a 2× leveraged DLMM position and deposits wSOL", async () => {
      // This account MUST NOT exist on-chain DLMM creates it in the CPI.
      const metPositionKp = Keypair.generate();

      const { params, accounts, meta } = await buildOpenPositionAccounts(metPositionKp);

      console.log("\n  Pool details:");
      console.log("    Active bin     :", meta.activeBinId);
      console.log("    wSOL is token  :", meta.isWsolX ? "X" : "Y");
      console.log(`    Bin range      : [${meta.minBinId}, ${meta.maxBinId}]`);
      console.log("    Bin array lower:", meta.binArrayLower.toBase58());
      console.log("    Bin array upper:", meta.binArrayUpper.toBase58());

      const vaultBefore    = await program.account.lendingVault.fetch(lendingVaultPda);
      const wsolBefore     = await provider.connection.getTokenAccountBalance(wsolVaultPda);

      const mockOraclePda = accounts.priceOracle;
      console.log("\n  priceOracle (mockOraclePda):", mockOraclePda.toBase58());

      // Refresh oracle timestamp so the staleness check passes
      await program.methods
        .updateMockOracle(new BN(150_000_000))
        .accountsStrict({
          authority,
          config: configPda,
          mint: NATIVE_MINT,
          mockOracle: mockOraclePda,
        })
        .rpc();

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
        .rpc({ commitment: "confirmed" })
        .catch((e) => {
          console.log("\n  openPosition error:", e.message);
          if (e.logs) console.log("  logs:\n   ", e.logs.join("\n    "));
          throw e;
        });

      console.log("\n  openPosition tx:", tx);

      const positionState  = await program.account.position.fetch(positionPda);
      const expectedBorrow = positionState.collateralAmount
        .mul(params.leverage)
        .divn(10_000);

      expect(positionState.debtAmount.toString()).to.equal(
        expectedBorrow.toString(),
        "debtAmount mismatch"
      );

      const vaultAfter = await program.account.lendingVault.fetch(lendingVaultPda);
      expect(vaultAfter.totalBorrowed.toString()).to.equal(
        vaultBefore.totalBorrowed.add(expectedBorrow).toString(),
        "totalBorrowed mismatch"
      );

      const wsolAfter = await provider.connection.getTokenAccountBalance(wsolVaultPda);
      const delta = Number(wsolBefore.value.amount) - Number(wsolAfter.value.amount);
      expect(delta).to.equal(
        expectedBorrow.toNumber(),
        "wSOL vault delta mismatch"
      );

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
      const rogue = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        rogue.publicKey,
        3 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

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
          .accountsStrict({ ...accounts, user: rogue.publicKey })
          .signers([rogue, metPositionKp])
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ])
          .rpc();
        throw new Error("Should have failed");
      } catch (e) {
        expect((e as Error).message).to.match(
          /InvalidOwner|seeds|constraint|AccountNotFound|2006/i
        );
        console.log("  ✓ Correctly rejected unauthorized access to position");
      }
    });
  });
});