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
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  createSyncNativeInstruction,
  createMint,
  mintTo,
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

  // Send SDK-generated transactions (fee payer = first signer, NOT provider wallet)
  async function sendSdkTx(tx: Transaction, signers: Keypair[]): Promise<string> {
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
    return sendAndConfirmTransaction(provider.connection, tx, signers);
  }

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

  // ─── In-range / losing position ─────────────────────────────────────────────

  describe("closePosition — in-range position (losing position with internal swap)", () => {
    const mmUser = Keypair.generate();   // market maker — seeds fresh pool
    const posUser = Keypair.generate();  // position owner
    const swapUser = Keypair.generate(); // external trader moves price

    let freshPool: DLMM;
    let freshLbPair: PublicKey;
    let customMint: PublicKey;
    let positionPda: PublicKey;
    let collateralVaultPda: PublicKey;
    let metPositionKp: Keypair;
    let openedMinBinId: number;
    let openedMaxBinId: number;
    let debtBefore: BN;
    const depositAmount = new BN(2 * LAMPORTS_PER_SOL);

    // Scoped helpers — use freshLbPair instead of module-level LB_PAIR
    function deriveFreshBinArrayPda(index: BN): PublicKey {
      const indexBuf = Buffer.alloc(8);
      indexBuf.writeBigInt64LE(BigInt(index.toString()));
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bin_array"), freshLbPair.toBuffer(), indexBuf],
        DLMM_PROGRAM_ID
      );
      return pda;
    }

    async function ensureFreshBinArrayExists(index: BN): Promise<void> {
      const pda = deriveFreshBinArrayPda(index);
      if (await provider.connection.getAccountInfo(pda)) return;
      const ixs = await freshPool.initializeBinArrays([index], authority);
      if (ixs.length > 0) await provider.sendAndConfirm(new Transaction().add(...ixs));
    }

    before("Create fresh pool, seed liquidity, open position, push price", async function () {
      this.timeout(120_000);

      const sigs = await Promise.all([
        provider.connection.requestAirdrop(mmUser.publicKey, 20 * LAMPORTS_PER_SOL),
        provider.connection.requestAirdrop(posUser.publicKey, 10 * LAMPORTS_PER_SOL),
        provider.connection.requestAirdrop(swapUser.publicKey, 15 * LAMPORTS_PER_SOL),
      ]);
      await Promise.all(sigs.map(s => provider.connection.confirmTransaction(s)));

      customMint = await createMint(
        provider.connection,
        mmUser,            // payer
        mmUser.publicKey,  // mint authority
        null,              // freeze authority
        9
      );

      // Mint to market maker
      const mmTokenAta = await getOrCreateAssociatedTokenAccount(
        provider.connection, mmUser, customMint, mmUser.publicKey
      );
      await mintTo(
        provider.connection, mmUser, customMint,
        mmTokenAta.address, mmUser,
        BigInt(1_000_000) * BigInt(10 ** 9)
      );

      // Mint to swapUser (they sell customMint to push price through position)
      const swapTokenAta = await getOrCreateAssociatedTokenAccount(
        provider.connection, mmUser, customMint, swapUser.publicKey
      );
      await mintTo(
        provider.connection, mmUser, customMint,
        swapTokenAta.address, mmUser,
        BigInt(500_000) * BigInt(10 ** 9)
      );

      await wrapSol(mmUser, mmUser.publicKey, 10 * LAMPORTS_PER_SOL);

      // new DLMM pool
      const createPoolTx = await (DLMM as any).createCustomizablePermissionlessLbPair(
        provider.connection,
        new BN(10),          // binStep (10 bps = 0.1%)
        customMint,          // token X
        NATIVE_MINT,         // token Y (wSOL)
        new BN(0),           // activeId
        new BN(50),          // feeBps (0.5%)
        0,                   // activationType = Slot
        false,               // hasAlphaVault
        mmUser.publicKey,    // creator
        null,                // activationPoint (immediate)
        false,               // creatorPoolOnOffControl
        { cluster: "devnet" }
      );
      await sendSdkTx(createPoolTx, [mmUser]);

      // Derive pool address and create SDK instance
      const [derivedPair] = (DLMM as any).deriveCustomizablePermissionlessLbPair(
        customMint, NATIVE_MINT, DLMM_PROGRAM_ID
      );
      freshLbPair = derivedPair;
      freshPool = await DLMM.create(provider.connection, freshLbPair, { cluster: "devnet" });
      await freshPool.refetchStates();

      const isWsolX = freshPool.lbPair.tokenXMint.equals(NATIVE_MINT);
      console.log("  Fresh pool:", freshLbPair.toBase58());
      console.log("  Token X:", freshPool.lbPair.tokenXMint.toBase58(), isWsolX ? "(wSOL)" : "(custom)");
      console.log("  Token Y:", freshPool.lbPair.tokenYMint.toBase58(), !isWsolX ? "(wSOL)" : "(custom)");

      // ── Seed two-sided liquidity ──
      const activeBin = await freshPool.getActiveBin();
      const SEED_RANGE = 30;
      const seedMinBin = activeBin.binId - SEED_RANGE;
      const seedMaxBin = activeBin.binId + SEED_RANGE;

      const mmPositionKp = Keypair.generate();
      const addLiqTx = await freshPool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: mmPositionKp.publicKey,
        user: mmUser.publicKey,
        totalXAmount: new BN(100_000).mul(new BN(10 ** 9)),  // 100K tokens
        totalYAmount: new BN(5 * LAMPORTS_PER_SOL),          // 5 SOL
        strategy: {
          maxBinId: seedMaxBin,
          minBinId: seedMinBin,
          strategyType: 0, // Spot
        },
      });

      if (Array.isArray(addLiqTx)) {
        for (const tx of addLiqTx) {
          await sendSdkTx(tx, [mmUser, mmPositionKp]);
        }
      } else {
        await sendSdkTx(addLiqTx, [mmUser, mmPositionKp]);
      }
      console.log("  Two-sided liquidity seeded: bins", seedMinBin, "to", seedMaxBin);

      // ── posUser: deposit SOL collateral ──
      [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), posUser.publicKey.toBuffer(), NATIVE_MINT.toBuffer()],
        program.programId
      );
      [collateralVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), posUser.publicKey.toBuffer(), NATIVE_MINT.toBuffer()],
        program.programId
      );

      await program.methods.depositSolCollateral(depositAmount)
        .accountsStrict({
          user: posUser.publicKey, config: configPda, mint: NATIVE_MINT,
          collateralConfig: collateralConfigPda, vault: collateralVaultPda,
          position: positionPda, systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([posUser])
        .rpc();

      // ── posUser: open leveraged position on the fresh pool ──
      await freshPool.refetchStates();
      const currentActiveBin = await freshPool.getActiveBin();
      const activeBinId = currentActiveBin.binId;

      // Place bins on the wSOL side (one-sided wSOL deposit)
      let minBinId: number, maxBinId: number;
      if (isWsolX) {
        minBinId = activeBinId + 1;
        maxBinId = activeBinId + POSITION_WIDTH;
      } else {
        minBinId = activeBinId - POSITION_WIDTH + 1;
        maxBinId = activeBinId;
      }

      // Ensure bins span two bin arrays (same logic as openPosition helper)
      let lowerIdx = binArrayIndex(minBinId);
      let upperIdx = binArrayIndex(maxBinId);
      if (lowerIdx.eq(upperIdx)) {
        const activeArrayIdx = binArrayIndex(activeBinId).toNumber();
        const half = Math.floor(POSITION_WIDTH / 2);
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

      await ensureFreshBinArrayExists(lowerIdx);
      await ensureFreshBinArrayExists(upperIdx);

      const fBinArrayLower = deriveFreshBinArrayPda(lowerIdx);
      const fBinArrayUpper = deriveFreshBinArrayPda(upperIdx);

      // wSOL reserve in the fresh pool
      const reserve = isWsolX ? freshPool.lbPair.reserveX : freshPool.lbPair.reserveY;
      const tokenMint = isWsolX ? freshPool.lbPair.tokenXMint : freshPool.lbPair.tokenYMint;

      const binLiquidityDist = [];
      for (let i = minBinId; i <= maxBinId; i++) {
        binLiquidityDist.push({ binId: i, weight: 1000 });
      }

      // Refresh oracle timestamp
      const [priceOracle] = PublicKey.findProgramAddressSync(
        [Buffer.from("mock_oracle"), NATIVE_MINT.toBuffer()],
        program.programId
      );
      await program.methods
        .updateMockOracle(new BN(150_000_000))
        .accountsStrict({ authority, config: configPda, mint: NATIVE_MINT, mockOracle: priceOracle })
        .rpc();

      metPositionKp = Keypair.generate();
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
          user: posUser.publicKey,
          config: configPda,
          wsolMint: NATIVE_MINT,
          position: positionPda,
          lendingVault: lendingVaultPda,
          wsolVault: wsolVaultPda,
          collateralConfig: collateralConfigPda,
          priceOracle,
          metPosition: metPositionKp.publicKey,
          lbPair: freshLbPair,
          binArrayBitmapExtension: null,
          reserve,
          tokenMint,
          binArrayLower: fBinArrayLower,
          binArrayUpper: fBinArrayUpper,
          eventAuthority: deriveEventAuthority(),
          tokenProgram: TOKEN_PROGRAM_ID,
          dlmmProgram: DLMM_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([posUser, metPositionKp])
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc({ commitment: "confirmed" });

      openedMinBinId = minBinId;
      openedMaxBinId = maxBinId;

      const pos = await program.account.position.fetch(positionPda);
      debtBefore = pos.debtAmount;
      console.log("  Position opened: bins", openedMinBinId, "to", openedMaxBinId,
                  " debt:", debtBefore.toString());

      // ── swapUser: sell customMint to push active bin THROUGH position's bins ──
      // isWsolX=false: customMint is X, sell X get Y (wSOL), swapForY=true, bin moves DOWN
      // isWsolX=true:  customMint is Y, sell Y get X (wSOL), swapForY=false, bin moves UP
      const sellCustomForWsol = !isWsolX;

      // Ensure swapUser has a wSOL ATA (receives swap proceeds)
      await wrapSol(swapUser, swapUser.publicKey, 0.01 * LAMPORTS_PER_SOL);

      await freshPool.refetchStates();
      const swapAmount = new BN(5 * LAMPORTS_PER_SOL);
      const binArraysForSwap = await freshPool.getBinArrayForSwap(sellCustomForWsol);
      const swapQuote = freshPool.swapQuote(swapAmount, sellCustomForWsol, new BN(500), binArraysForSwap);

      const inToken = sellCustomForWsol ? freshPool.tokenX.publicKey : freshPool.tokenY.publicKey;
      const outToken = sellCustomForWsol ? freshPool.tokenY.publicKey : freshPool.tokenX.publicKey;

      const swapTx = await freshPool.swap({
        inToken,
        outToken,
        inAmount: swapAmount,
        minOutAmount: swapQuote.minOutAmount,
        lbPair: freshPool.pubkey,
        user: swapUser.publicKey,
        binArraysPubkey: swapQuote.binArraysPubkey,
      });
      await sendSdkTx(swapTx, [swapUser]);

      await freshPool.refetchStates();
      const newActiveBin = await freshPool.getActiveBin();
      console.log("  Active bin after swap:", newActiveBin.binId,
                  "(position range:", openedMinBinId, "to", openedMaxBinId, ")");
    });

    it("Closes in-range position with internal X to wSOL swap", async () => {
      const vaultBefore = await program.account.lendingVault.fetch(lendingVaultPda);
      const wsolVaultBalanceBefore = await provider.connection.getTokenAccountBalance(wsolVaultPda);

      // Build close accounts for the fresh pool
      await freshPool.refetchStates();
      const lowerIdx = binArrayIndex(openedMinBinId);
      const upperIdx = binArrayIndex(openedMaxBinId);
      const fBinArrayLower = deriveFreshBinArrayPda(lowerIdx);
      const fBinArrayUpper = deriveFreshBinArrayPda(upperIdx);

      // Lending vault's ATA for the non-wSOL token (token X in the fresh pool)
      const userTokenXAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        freshPool.lbPair.tokenXMint,
        lendingVaultPda,
        true
      );

      const accounts = {
        user: posUser.publicKey,
        config: configPda,
        wsolMint: NATIVE_MINT,
        position: positionPda,
        lendingVault: lendingVaultPda,
        wsolVault: wsolVaultPda,
        metPosition: metPositionKp.publicKey,
        lbPair: freshLbPair,
        binArrayBitmapExtension: null,
        userTokenX: userTokenXAccount.address,
        reserveX: freshPool.lbPair.reserveX,
        reserveY: freshPool.lbPair.reserveY,
        tokenXMint: freshPool.lbPair.tokenXMint,
        tokenYMint: freshPool.lbPair.tokenYMint,
        binArrayLower: fBinArrayLower,
        binArrayUpper: fBinArrayUpper,
        oracle: freshPool.lbPair.oracle,
        eventAuthority: deriveEventAuthority(),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        dlmmProgram: DLMM_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      };

      await program.methods
        .closePosition(openedMinBinId, openedMaxBinId)
        .accountsStrict(accounts)
        .signers([posUser])
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc({ commitment: "confirmed" })
        .catch((e) => {
          console.log("\n  closePosition error:", e.message);
          if (e.logs) console.log("  logs:\n   ", e.logs.join("\n    "));
          throw e;
        });

      const positionAfter = await program.account.position.fetch(positionPda);
      expect(positionAfter.status).to.deep.equal(
        { closed: {} },
        "Position status must be Closed"
      );
      expect(positionAfter.debtAmount.toNumber()).to.equal(
        0,
        "debt_amount must be zeroed after close"
      );

      const vaultAfter = await program.account.lendingVault.fetch(lendingVaultPda);
      expect(vaultAfter.totalBorrowed.toString()).to.equal(
        vaultBefore.totalBorrowed.sub(debtBefore).toString(),
        "totalBorrowed must decrease by the debt amount"
      );

      // Verify DLMM position account is gone
      const metPositionInfo = await provider.connection.getAccountInfo(metPositionKp.publicKey);
      expect(metPositionInfo).to.be.null;

      // Verify token X ATA is empty (all swapped to wSOL)
      const tokenXBalance = await provider.connection.getTokenAccountBalance(userTokenXAccount.address);
      expect(tokenXBalance.value.amount).to.equal(
        "0",
        "All token X must be swapped to wSOL"
      );

      // Log the vault wSOL delta (shows the "loss" from price movement)
      const wsolVaultBalanceAfter = await provider.connection.getTokenAccountBalance(wsolVaultPda);
      const before = parseInt(wsolVaultBalanceBefore.value.amount);
      const after = parseInt(wsolVaultBalanceAfter.value.amount);
      const delta = after - before;
      const borrowed = debtBefore.toNumber();

      console.log("\n  Position status      : closed");
      console.log("  Debt repaid          :", borrowed / LAMPORTS_PER_SOL, "SOL");
      console.log("  wSOL vault before    :", before / LAMPORTS_PER_SOL, "SOL");
      console.log("  wSOL vault after     :", after / LAMPORTS_PER_SOL, "SOL");
      console.log("  Vault delta          :", delta / LAMPORTS_PER_SOL, "SOL");
      console.log("  Token X ATA balance  : 0 (all swapped)");
      console.log("  DLMM position        : closed on-chain");
    });
  });


  describe("closePosition — constraints", () => {
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
      const rogue = Keypair.generate();
      const rogSig = await provider.connection.requestAirdrop(rogue.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(rogSig);

      const [rogueFakePosition] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), rogue.publicKey.toBuffer(), NATIVE_MINT.toBuffer()],
        program.programId
      );

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
        expect((e as Error).message).to.match(/seeds|constraint|InvalidOwner|2006/i);
        console.log("  Correctly rejected close by wrong user");
      }
    });
  });
});
