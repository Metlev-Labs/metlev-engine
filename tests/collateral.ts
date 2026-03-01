import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MetlevEngine } from "../target/types/metlev_engine";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert, expect } from "chai";

describe("Collateral", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.metlevEngine as Program<MetlevEngine>;
  const authority = provider.wallet.publicKey;

  const solUser = Keypair.generate();
  const usdcUser = Keypair.generate();

  let configPda: PublicKey;
  let solCollateralConfigPda: PublicKey;
  let usdcCollateralConfigPda: PublicKey;

  const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
  let USDC_MINT: PublicKey;

  const SOL_ORACLE = Keypair.generate().publicKey;
  const USDC_ORACLE = Keypair.generate().publicKey;

  const SOL_CONFIG = {
    maxLtv: 7500,              // 75%
    liquidationThreshold: 8000, // 80%
    liquidationPenalty: 500,    // 5%
    minDeposit: new anchor.BN(0.1 * LAMPORTS_PER_SOL), // 0.1 SOL
    interestRateBps: 500,       // 5% APR
    oracleMaxAge: new anchor.BN(60),
  };

  const USDC_CONFIG = {
    maxLtv: 9000,              // 90% (stablecoin)
    liquidationThreshold: 9500, // 95%
    liquidationPenalty: 300,    // 3%
    minDeposit: new anchor.BN(10_000_000), // 10 USDC (6 decimals)
    interestRateBps: 300,       // 3% APR
    oracleMaxAge: new anchor.BN(60),
  };

  before(async () => {
    const airdropSol = await provider.connection.requestAirdrop(
      solUser.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSol);

    const airdropUsdc = await provider.connection.requestAirdrop(
      usdcUser.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropUsdc);

    USDC_MINT = await createMint(
      provider.connection,
      provider.wallet.payer,
      authority,
      null,
      6
    );

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    [solCollateralConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("collateral_config"), SOL_MINT.toBuffer()],
      program.programId
    );

    [usdcCollateralConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("collateral_config"), USDC_MINT.toBuffer()],
      program.programId
    );

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
      await program.account.collateralConfig.fetch(solCollateralConfigPda);
      console.log("SOL collateral already registered, skipping...");
    } catch {
      await program.methods
        .registerCollateral(
          SOL_ORACLE,
          SOL_CONFIG.maxLtv,
          SOL_CONFIG.liquidationThreshold,
          SOL_CONFIG.liquidationPenalty,
          SOL_CONFIG.minDeposit,
          SOL_CONFIG.interestRateBps,
          SOL_CONFIG.oracleMaxAge
        )
        .accountsStrict({
          authority,
          config: configPda,
          mint: SOL_MINT,
          collateralConfig: solCollateralConfigPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    try {
      await program.account.collateralConfig.fetch(usdcCollateralConfigPda);
      console.log("USDC collateral already registered, skipping...");
    } catch {
      await program.methods
        .registerCollateral(
          USDC_ORACLE,
          USDC_CONFIG.maxLtv,
          USDC_CONFIG.liquidationThreshold,
          USDC_CONFIG.liquidationPenalty,
          USDC_CONFIG.minDeposit,
          USDC_CONFIG.interestRateBps,
          USDC_CONFIG.oracleMaxAge
        )
        .accountsStrict({
          authority,
          config: configPda,
          mint: USDC_MINT,
          collateralConfig: usdcCollateralConfigPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    console.log("\n=== Setup Complete ===");
    console.log("SOL Mint:", SOL_MINT.toBase58());
    console.log("USDC Mint:", USDC_MINT.toBase58());
  });

  // ─── Deposit ──────────────────────────────────────────────────────────────

  describe("SOL Deposits", () => {
    it("Deposits SOL successfully", async () => {
      const depositAmount = new anchor.BN(0.5 * LAMPORTS_PER_SOL);

      const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), solUser.publicKey.toBuffer(), SOL_MINT.toBuffer()],
        program.programId
      );

      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), solUser.publicKey.toBuffer(), SOL_MINT.toBuffer()],
        program.programId
      );

      const userBalanceBefore = await provider.connection.getBalance(solUser.publicKey);

      await program.methods
        .depositSolCollateral(depositAmount)
        .accountsStrict({
          user: solUser.publicKey,
          config: configPda,
          mint: SOL_MINT,
          collateralConfig: solCollateralConfigPda,
          vault: vaultPda,
          position: positionPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([solUser])
        .rpc();

      const position = await program.account.position.fetch(positionPda);
      expect(position.owner.toBase58()).to.equal(solUser.publicKey.toBase58());
      expect(position.collateralMint.toBase58()).to.equal(SOL_MINT.toBase58());
      expect(position.collateralAmount.toNumber()).to.equal(depositAmount.toNumber());
      expect(position.debtAmount.toNumber()).to.equal(0);

      const vaultBalance = await provider.connection.getBalance(vaultPda);
      expect(vaultBalance).to.equal(depositAmount.toNumber());

      const userBalanceAfter = await provider.connection.getBalance(solUser.publicKey);
      expect(userBalanceBefore - userBalanceAfter).to.be.greaterThan(depositAmount.toNumber());

      console.log("SOL deposit successful:");
      console.log("  Amount:", depositAmount.toNumber() / LAMPORTS_PER_SOL, "SOL");
      console.log("  Vault balance:", vaultBalance / LAMPORTS_PER_SOL, "SOL");
    });

    it("Fails to use depositSolCollateral with non-SOL mint", async () => {
      const depositAmount = new anchor.BN(LAMPORTS_PER_SOL);
      const testUser = Keypair.generate();

      await provider.connection.requestAirdrop(
        testUser.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await new Promise(resolve => setTimeout(resolve, 1000));

      const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), testUser.publicKey.toBuffer(), USDC_MINT.toBuffer()],
        program.programId
      );

      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), testUser.publicKey.toBuffer(), USDC_MINT.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .depositSolCollateral(depositAmount)
          .accountsStrict({
            user: testUser.publicKey,
            config: configPda,
            mint: USDC_MINT,
            collateralConfig: usdcCollateralConfigPda,
            vault: vaultPda,
            position: positionPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([testUser])
          .rpc();

        assert.fail("Should have failed with constraint error");
      } catch (error) {
        expect(error.message).to.match(/InvalidCollateralType|constraint/i);
        console.log("Correctly rejected non-SOL mint for depositSolCollateral");
      }
    });

    it("Fails to deposit SOL below minimum", async () => {
      const tooSmall = new anchor.BN(0.01 * LAMPORTS_PER_SOL);
      const anotherUser = Keypair.generate();

      await provider.connection.requestAirdrop(
        anotherUser.publicKey,
        LAMPORTS_PER_SOL
      );
      await new Promise(resolve => setTimeout(resolve, 1000));

      const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), anotherUser.publicKey.toBuffer(), SOL_MINT.toBuffer()],
        program.programId
      );

      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), anotherUser.publicKey.toBuffer(), SOL_MINT.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .depositSolCollateral(tooSmall)
          .accountsStrict({
            user: anotherUser.publicKey,
            config: configPda,
            mint: SOL_MINT,
            collateralConfig: solCollateralConfigPda,
            vault: vaultPda,
            position: positionPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([anotherUser])
          .rpc();

        assert.fail("Should have failed with InsufficientCollateral");
      } catch (error) {
        expect(error.message).to.include("InsufficientCollateral");
        console.log("Correctly rejected SOL deposit below minimum");
      }
    });
  });

  describe("SPL Token Deposits", () => {
    let userUsdcAccount: PublicKey;
    let vaultPda: PublicKey;

    before(async () => {
      userUsdcAccount = await createAccount(
        provider.connection,
        provider.wallet.payer,
        USDC_MINT,
        usdcUser.publicKey
      );

      await mintTo(
        provider.connection,
        provider.wallet.payer,
        USDC_MINT,
        userUsdcAccount,
        authority,
        100_000_000
      );

      [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), usdcUser.publicKey.toBuffer(), USDC_MINT.toBuffer()],
        program.programId
      );

      console.log("\n=== USDC Accounts Created ===");
      console.log("User USDC account:", userUsdcAccount.toBase58());
      console.log("Vault PDA:", vaultPda.toBase58());
    });

    it("Deposits USDC successfully", async () => {
      const depositAmount = new anchor.BN(50_000_000);

      const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), usdcUser.publicKey.toBuffer(), USDC_MINT.toBuffer()],
        program.programId
      );

      const userBalanceBefore = await getAccount(provider.connection, userUsdcAccount);

      await program.methods
        .depositTokenCollateral(depositAmount)
        .accountsStrict({
          user: usdcUser.publicKey,
          config: configPda,
          mint: USDC_MINT,
          collateralConfig: usdcCollateralConfigPda,
          vault: vaultPda,
          userTokenAccount: userUsdcAccount,
          position: positionPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([usdcUser])
        .rpc();

      const position = await program.account.position.fetch(positionPda);
      expect(position.owner.toBase58()).to.equal(usdcUser.publicKey.toBase58());
      expect(position.collateralMint.toBase58()).to.equal(USDC_MINT.toBase58());
      expect(position.collateralAmount.toNumber()).to.equal(depositAmount.toNumber());

      const vaultAccount = await getAccount(provider.connection, vaultPda);
      expect(Number(vaultAccount.amount)).to.equal(depositAmount.toNumber());

      const userBalanceAfter = await getAccount(provider.connection, userUsdcAccount);
      expect(Number(userBalanceBefore.amount) - Number(userBalanceAfter.amount))
        .to.equal(depositAmount.toNumber());

      console.log("USDC deposit successful:");
      console.log("  Amount:", depositAmount.toNumber() / 1_000_000, "USDC");
      console.log("  Vault balance:", Number(vaultAccount.amount) / 1_000_000, "USDC");
    });

    it("Fails to use depositTokenCollateral with SOL mint", async () => {
      const depositAmount = new anchor.BN(50_000_000);
      const testUser = Keypair.generate();

      await provider.connection.requestAirdrop(
        testUser.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await new Promise(resolve => setTimeout(resolve, 1000));

      const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), testUser.publicKey.toBuffer(), SOL_MINT.toBuffer()],
        program.programId
      );

      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), testUser.publicKey.toBuffer(), SOL_MINT.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .depositTokenCollateral(depositAmount)
          .accountsStrict({
            user: testUser.publicKey,
            config: configPda,
            mint: SOL_MINT,
            collateralConfig: solCollateralConfigPda,
            vault: vaultPda,
            userTokenAccount: testUser.publicKey,
            position: positionPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([testUser])
          .rpc();

        assert.fail("Should have failed with constraint error");
      } catch (error) {
        expect(error.message).to.match(/InvalidCollateralType|constraint|account/i);
        console.log("Correctly rejected SOL mint for depositTokenCollateral");
      }
    });

    it("Fails to deposit USDC below minimum", async () => {
      const tooSmall = new anchor.BN(5_000_000);
      const anotherUser = Keypair.generate();

      await provider.connection.requestAirdrop(
        anotherUser.publicKey,
        LAMPORTS_PER_SOL
      );
      await new Promise(resolve => setTimeout(resolve, 1000));

      const anotherUserUsdcAccount = await createAccount(
        provider.connection,
        provider.wallet.payer,
        USDC_MINT,
        anotherUser.publicKey
      );

      await mintTo(
        provider.connection,
        provider.wallet.payer,
        USDC_MINT,
        anotherUserUsdcAccount,
        authority,
        10_000_000
      );

      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), anotherUser.publicKey.toBuffer(), USDC_MINT.toBuffer()],
        program.programId
      );

      const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), anotherUser.publicKey.toBuffer(), USDC_MINT.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .depositTokenCollateral(tooSmall)
          .accountsStrict({
            user: anotherUser.publicKey,
            config: configPda,
            mint: USDC_MINT,
            collateralConfig: usdcCollateralConfigPda,
            vault: vaultPda,
            userTokenAccount: anotherUserUsdcAccount,
            position: positionPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([anotherUser])
          .rpc();

        assert.fail("Should have failed with InsufficientCollateral");
      } catch (error) {
        expect(error.message).to.include("InsufficientCollateral");
        console.log("Correctly rejected USDC deposit below minimum");
      }
    });
  });

  describe("Protocol Pause", () => {
    it("Prevents deposits when paused", async () => {
      await program.methods
        .updatePauseState(true)
        .accountsStrict({
          authority,
          config: configPda,
        })
        .rpc();

      const depositAmount = new anchor.BN(LAMPORTS_PER_SOL);
      const pausedUser = Keypair.generate();

      await provider.connection.requestAirdrop(
        pausedUser.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await new Promise(resolve => setTimeout(resolve, 1000));

      const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), pausedUser.publicKey.toBuffer(), SOL_MINT.toBuffer()],
        program.programId
      );

      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), pausedUser.publicKey.toBuffer(), SOL_MINT.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .depositSolCollateral(depositAmount)
          .accountsStrict({
            user: pausedUser.publicKey,
            config: configPda,
            mint: SOL_MINT,
            collateralConfig: solCollateralConfigPda,
            vault: vaultPda,
            position: positionPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([pausedUser])
          .rpc();

        assert.fail("Should have failed with ProtocolPaused");
      } catch (error) {
        expect(error.message).to.include("ProtocolPaused");
        console.log("Correctly prevented deposit when paused");
      }

      await program.methods
        .updatePauseState(false)
        .accountsStrict({
          authority,
          config: configPda,
        })
        .rpc();
    });
  });

  // ─── Withdraw Collateral ───────────────────────────────────────────────────

  describe("Withdraw Collateral", () => {
    const withdrawUser = Keypair.generate();
    let positionPda: PublicKey;
    let collateralVaultPda: PublicKey;

    before(async () => {
      const airdrop = await provider.connection.requestAirdrop(
        withdrawUser.publicKey,
        3 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdrop);

      [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), withdrawUser.publicKey.toBuffer(), SOL_MINT.toBuffer()],
        program.programId
      );

      [collateralVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), withdrawUser.publicKey.toBuffer(), SOL_MINT.toBuffer()],
        program.programId
      );

      await program.methods
        .depositSolCollateral(new anchor.BN(0.5 * LAMPORTS_PER_SOL))
        .accountsStrict({
          user: withdrawUser.publicKey,
          config: configPda,
          mint: SOL_MINT,
          collateralConfig: solCollateralConfigPda,
          vault: collateralVaultPda,
          position: positionPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([withdrawUser])
        .rpc();

      console.log("\n=== Withdraw Collateral Setup ===");
      console.log("withdrawUser:", withdrawUser.publicKey.toBase58());
      console.log("position:", positionPda.toBase58());
      console.log("collateralVault:", collateralVaultPda.toBase58());
    });

    it("Fails to withdraw collateral while position is still active", async () => {
      const position = await program.account.position.fetch(positionPda);
      expect(position.status).to.deep.equal({ active: {} });

      try {
        await program.methods
          .withdrawCollateral()
          .accountsStrict({
            user: withdrawUser.publicKey,
            wsolMint: SOL_MINT,
            position: positionPda,
            collateralVault: collateralVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([withdrawUser])
          .rpc();

        assert.fail("Should have failed with PositionStillActive");
      } catch (error) {
        expect(error.message).to.include("PositionStillActive");
        console.log("Correctly blocked withdrawal from an active position");
      }
    });

    it("Fails when a different user tries to withdraw someone else's collateral", async () => {
      const attacker = Keypair.generate();
      const airdrop = await provider.connection.requestAirdrop(
        attacker.publicKey,
        LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdrop);

      try {
        await program.methods
          .withdrawCollateral()
          .accountsStrict({
            user: attacker.publicKey,         // attacker signs
            wsolMint: SOL_MINT,
            position: positionPda,            // victim's position
            collateralVault: collateralVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();

        assert.fail("Should have failed with a seeds / owner constraint error");
      } catch (error) {
        expect(error.message).to.match(/seeds|constraint|InvalidOwner/i);
        console.log("Correctly rejected withdrawal by wrong signer");
      }
    });

  });
});
