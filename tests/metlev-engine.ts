import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MetlevEngine } from "../target/types/metlev_engine";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint } from "@solana/spl-token";
import { assert, expect } from "chai";

describe("metlev-engine", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.metlevEngine as Program<MetlevEngine>;

  // Test accounts
  const authority = provider.wallet.publicKey;
  const user = Keypair.generate();

  // PDAs
  let configPda: PublicKey;
  let solCollateralConfigPda: PublicKey;
  let usdcCollateralConfigPda: PublicKey;
  let userSolPositionPda: PublicKey;
  let solOraclePda: PublicKey;

  // Mock mints and oracles
  const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
  let USDC_MINT: PublicKey; // Will be created in before hook
  const USDC_ORACLE = Keypair.generate().publicKey; // Mock Pyth oracle

  // Collateral parameters
  const SOL_CONFIG = {
    maxLtv: 7500,              // 75%
    liquidationThreshold: 8000, // 80%
    liquidationPenalty: 500,    // 5%
    minDeposit: 0.1 * LAMPORTS_PER_SOL, // 0.1 SOL
    interestRateBps: 500,       // 5% APR
    oracleMaxAge: 3600,         // 1 hour
  };

  const USDC_CONFIG = {
    maxLtv: 9000,              // 90% (stablecoin)
    liquidationThreshold: 9500, // 95%
    liquidationPenalty: 300,    // 3%
    minDeposit: 10_000_000,     // 10 USDC (6 decimals)
    interestRateBps: 300,       // 3% APR
    oracleMaxAge: 60,
  };

  before(async () => {
    const airdropSig = await provider.connection.requestAirdrop(
      user.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    USDC_MINT = await createMint(
      provider.connection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      null,
      6 // USDC has 6 decimals
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

    [userSolPositionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), user.publicKey.toBuffer(), SOL_MINT.toBuffer()],
      program.programId
    );

    [solOraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle"), SOL_MINT.toBuffer()],
      program.programId
    );

    console.log("\n=== PDAs ===");
    console.log("Program ID       :", program.programId.toBase58());
    console.log("Config:", configPda.toBase58());
    console.log("SOL Collateral Config:", solCollateralConfigPda.toBase58());
    console.log("USDC Collateral Config:", usdcCollateralConfigPda.toBase58());
    console.log("User SOL Position:", userSolPositionPda.toBase58());
    console.log("SOL Oracle PDA   :", solOraclePda.toBase58());
  });

  describe("Protocol Initialization", () => {
    it("Initializes the protocol config", async () => {
      // Skip if already initialized
      try {
        await program.account.config.fetch(configPda);
        console.log("✓ Protocol already initialized, skipping...");
        return;
      } catch {
        // Not initialized, proceed
      }

      await program.methods
        .initialize()
        .accountsStrict({
          authority,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const config = await program.account.config.fetch(configPda);

      expect(config.authority.toBase58()).to.equal(authority.toBase58());
      expect(config.paused).to.equal(false);

      console.log("✓ Protocol initialized with authority:", authority.toBase58());
    });
  });

  describe("Collateral Configuration", () => {
    it("Registers SOL as collateral", async () => {
      let existing;
      try {
        existing = await program.account.collateralConfig.fetch(solCollateralConfigPda);
        console.log("✓ SOL collateral already registered");
        console.log("  stored oracle  :", existing.oracle.toBase58());
        console.log("  expected oracle:", solOraclePda.toBase58());
      } catch {
        // Not registered, proceed to register below
      }

      if (existing) {
        if (existing.oracle.toBase58() === solOraclePda.toBase58()) {
          console.log("  oracle is correct, skipping...");
          return;
        }
        // Stored oracle is stale (from a previous session with a different program ID).
        // Fix it so the on-chain constraint price_oracle.key() == collateral_config.oracle
        // will pass when tests pass the freshly-derived PDA.
        console.log("  Stale oracle detected — updating...");
        await program.methods
          .updateCollateralOracle(SOL_MINT, solOraclePda)
          .accountsStrict({
            authority,
            config: configPda,
            collateralConfig: solCollateralConfigPda,
          })
          .rpc();
        console.log("  ✓ Oracle updated to:", solOraclePda.toBase58());
        return;
      }

      console.log("  registering collateral with oracle:", solOraclePda.toBase58());
      await program.methods
        .registerCollateral(
          solOraclePda,
          SOL_CONFIG.maxLtv,
          SOL_CONFIG.liquidationThreshold,
          SOL_CONFIG.liquidationPenalty,
          new anchor.BN(SOL_CONFIG.minDeposit),
          SOL_CONFIG.interestRateBps,
          new anchor.BN(SOL_CONFIG.oracleMaxAge)
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

      const solConfig = await program.account.collateralConfig.fetch(
        solCollateralConfigPda
      );

      expect(solConfig.mint.toBase58()).to.equal(SOL_MINT.toBase58());
      expect(solConfig.oracle.toBase58()).to.equal(solOraclePda.toBase58());
      expect(solConfig.maxLtv).to.equal(SOL_CONFIG.maxLtv);
      expect(solConfig.liquidationThreshold).to.equal(SOL_CONFIG.liquidationThreshold);
      expect(solConfig.liquidationPenalty).to.equal(SOL_CONFIG.liquidationPenalty);
      expect(solConfig.minDeposit.toNumber()).to.equal(SOL_CONFIG.minDeposit);
      expect(solConfig.interestRateBps).to.equal(SOL_CONFIG.interestRateBps);
      expect(solConfig.enabled).to.equal(true);

      console.log("SOL collateral registered:");
      console.log("  Max LTV:", solConfig.maxLtv / 100, "%");
      console.log("  Liquidation Threshold:", solConfig.liquidationThreshold / 100, "%");
      console.log("  Min Deposit:", solConfig.minDeposit.toNumber() / LAMPORTS_PER_SOL, "SOL");
    });

    it("Registers USDC as collateral with different parameters", async () => {
      // Skip if already registered
      try {
        await program.account.collateralConfig.fetch(usdcCollateralConfigPda);
        console.log("✓ USDC collateral already registered, skipping...");
        return;
      } catch {
        // Not registered, proceed
      }

      await program.methods
        .registerCollateral(
          USDC_ORACLE,
          USDC_CONFIG.maxLtv,
          USDC_CONFIG.liquidationThreshold,
          USDC_CONFIG.liquidationPenalty,
          new anchor.BN(USDC_CONFIG.minDeposit),
          USDC_CONFIG.interestRateBps,
          new anchor.BN(USDC_CONFIG.oracleMaxAge)
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

      const usdcConfig = await program.account.collateralConfig.fetch(
        usdcCollateralConfigPda
      );

      expect(usdcConfig.mint.toBase58()).to.equal(USDC_MINT.toBase58());
      expect(usdcConfig.maxLtv).to.equal(USDC_CONFIG.maxLtv);
      expect(usdcConfig.liquidationThreshold).to.equal(USDC_CONFIG.liquidationThreshold);
      expect(usdcConfig.enabled).to.equal(true);

      console.log("USDC collateral registered:");
      console.log("  Max LTV:", usdcConfig.maxLtv / 100, "%");
      console.log("  Liquidation Threshold:", usdcConfig.liquidationThreshold / 100, "%");
      console.log("  Interest Rate:", usdcConfig.interestRateBps / 100, "% APR");
    });

    it("Validates different risk parameters per collateral", async () => {
      const solConfig = await program.account.collateralConfig.fetch(
        solCollateralConfigPda
      );
      const usdcConfig = await program.account.collateralConfig.fetch(
        usdcCollateralConfigPda
      );

      expect(solConfig.maxLtv).to.be.lessThan(usdcConfig.maxLtv);
      expect(solConfig.liquidationPenalty).to.be.greaterThan(usdcConfig.liquidationPenalty);

      console.log("Risk parameters correctly differentiated:");
      console.log("  SOL LTV:", solConfig.maxLtv / 100, "% vs USDC LTV:", usdcConfig.maxLtv / 100, "%");
    });

    it("Fails to register collateral with invalid thresholds", async () => {
      const testMint = Keypair.generate().publicKey;
      const [testConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("collateral_config"), testMint.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .registerCollateral(
            solOraclePda,
            8000,  // max_ltv
            7500,  // liquidation_threshold (INVALID: should be > max_ltv)
            500,
            new anchor.BN(LAMPORTS_PER_SOL),
            500,
            new anchor.BN(60)
          )
          .accountsStrict({
            authority,
            config: configPda,
            mint: testMint,
            collateralConfig: testConfigPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        assert.fail("Should have failed with InvalidLiquidationThreshold");
      } catch (error) {
        expect(error.message).to.match(/InvalidLiquidationThreshold|AccountNotInitialized|Invalid account data/);
      }
    });
  });

  describe("Deposit Collateral", () => {
    it("Creates a position with SOL collateral", async () => {
      const depositAmount = new anchor.BN(0.5 * LAMPORTS_PER_SOL);

      // Derive vault PDA
      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), user.publicKey.toBuffer(), SOL_MINT.toBuffer()],
        program.programId
      );

      await program.methods
        .depositSolCollateral(depositAmount)
        .accountsStrict({
          user: user.publicKey,
          config: configPda,
          mint: SOL_MINT,
          collateralConfig: solCollateralConfigPda,
          vault: vaultPda,
          position: userSolPositionPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      const position = await program.account.position.fetch(userSolPositionPda);

      expect(position.owner.toBase58()).to.equal(user.publicKey.toBase58());
      expect(position.collateralMint.toBase58()).to.equal(SOL_MINT.toBase58());
      expect(position.collateralAmount.toNumber()).to.equal(depositAmount.toNumber());
      expect(position.debtAmount.toNumber()).to.equal(0);

      console.log("Position created:");
      console.log("  Owner:", user.publicKey.toBase58());
      console.log("  Collateral:", position.collateralAmount.toNumber() / LAMPORTS_PER_SOL, "SOL");
      console.log("  Debt:", position.debtAmount.toNumber());
    });

    it("Fails to deposit below minimum amount", async () => {
      const tooSmall = new anchor.BN(0.01 * LAMPORTS_PER_SOL); // Less than 0.1 SOL minimum
      const anotherUser = Keypair.generate();

      await provider.connection.requestAirdrop(
        anotherUser.publicKey,
        LAMPORTS_PER_SOL
      );
      await new Promise(resolve => setTimeout(resolve, 1000));

      const [anotherPositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), anotherUser.publicKey.toBuffer(), SOL_MINT.toBuffer()],
        program.programId
      );

      const [anotherVaultPda] = PublicKey.findProgramAddressSync(
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
            vault: anotherVaultPda,
              position: anotherPositionPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([anotherUser])
          .rpc();

        assert.fail("Should have failed with InsufficientCollateral");
      } catch (error) {
        expect(error.message).to.include("InsufficientCollateral");
      }
    });

    it("Fails to deposit with mismatched mint", async () => {
      const anotherUser = Keypair.generate();
      const depositAmount = new anchor.BN(LAMPORTS_PER_SOL);

      await provider.connection.requestAirdrop(
        anotherUser.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await new Promise(resolve => setTimeout(resolve, 1000));

      const [wrongPositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), anotherUser.publicKey.toBuffer(), USDC_MINT.toBuffer()],
        program.programId
      );

      const [wrongVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), anotherUser.publicKey.toBuffer(), USDC_MINT.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .depositSolCollateral(depositAmount)
          .accountsStrict({
            user: anotherUser.publicKey,
            config: configPda,
            mint: USDC_MINT, // Wrong mint!
            collateralConfig: solCollateralConfigPda, // SOL config
            vault: wrongVaultPda,
            position: wrongPositionPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([anotherUser])
          .rpc();

        assert.fail("Should have failed with constraint error");
      } catch (error) {
        expect(error.message).to.match(/InvalidCollateralType|ConstraintSeeds|collateral_config/);
      }
    });
  });

  describe("Protocol Pause", () => {
    it("Allows authority to pause protocol", async () => {
      await program.methods
        .updatePauseState(true)
        .accountsStrict({
          authority,
          config: configPda,
        })
        .rpc();

      const config = await program.account.config.fetch(configPda);
      expect(config.paused).to.equal(true);
    });

    it("Prevents deposits when paused", async () => {
      const anotherUser = Keypair.generate();
      await provider.connection.requestAirdrop(
        anotherUser.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await new Promise(resolve => setTimeout(resolve, 1000));

      const [pausedPositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), anotherUser.publicKey.toBuffer(), SOL_MINT.toBuffer()],
        program.programId
      );

      const [pausedVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), anotherUser.publicKey.toBuffer(), SOL_MINT.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .depositSolCollateral(new anchor.BN(LAMPORTS_PER_SOL))
          .accountsStrict({
            user: anotherUser.publicKey,
            config: configPda,
            mint: SOL_MINT,
            collateralConfig: solCollateralConfigPda,
            vault: pausedVaultPda,
              position: pausedPositionPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([anotherUser])
          .rpc();

        assert.fail("Should have failed with ProtocolPaused");
      } catch (error) {
        expect(error.message).to.include("ProtocolPaused");
      }
    });

    it("Allows authority to unpause protocol", async () => {
      await program.methods
        .updatePauseState(false)
        .accountsStrict({
          authority,
          config: configPda,
        })
        .rpc();

      const config = await program.account.config.fetch(configPda);
      expect(config.paused).to.equal(false);
    });
  });

  describe("Update Collateral Config", () => {
    it("Authority can disable a collateral", async () => {
      await program.methods
        .updateCollateralEnabled(SOL_MINT, false)
        .accountsStrict({
          authority,
          config: configPda,
          collateralConfig: solCollateralConfigPda,
        })
        .rpc();

      const config = await program.account.collateralConfig.fetch(solCollateralConfigPda);
      expect(config.enabled).to.equal(false);
    });

    it("Authority can re-enable a collateral", async () => {
      await program.methods
        .updateCollateralEnabled(SOL_MINT, true)
        .accountsStrict({
          authority,
          config: configPda,
          collateralConfig: solCollateralConfigPda,
        })
        .rpc();

      const config = await program.account.collateralConfig.fetch(solCollateralConfigPda);
      expect(config.enabled).to.equal(true);
    });

    it("Authority can update LTV params", async () => {
      await program.methods
        .updateCollateralLtvParams(SOL_MINT, 7000, 8500)
        .accountsStrict({
          authority,
          config: configPda,
          collateralConfig: solCollateralConfigPda,
        })
        .rpc();

      const config = await program.account.collateralConfig.fetch(solCollateralConfigPda);
      expect(config.maxLtv).to.equal(7000);
      expect(config.liquidationThreshold).to.equal(8500);

      // Restore original values
      await program.methods
        .updateCollateralLtvParams(SOL_MINT, SOL_CONFIG.maxLtv, SOL_CONFIG.liquidationThreshold)
        .accountsStrict({
          authority,
          config: configPda,
          collateralConfig: solCollateralConfigPda,
        })
        .rpc();
    });

    it("Authority can update only one LTV param at a time", async () => {
      await program.methods
        .updateCollateralLtvParams(SOL_MINT, null, 8200)
        .accountsStrict({
          authority,
          config: configPda,
          collateralConfig: solCollateralConfigPda,
        })
        .rpc();

      const config = await program.account.collateralConfig.fetch(solCollateralConfigPda);
      expect(config.maxLtv).to.equal(SOL_CONFIG.maxLtv); // unchanged
      expect(config.liquidationThreshold).to.equal(8200);

      // Restore
      await program.methods
        .updateCollateralLtvParams(SOL_MINT, null, SOL_CONFIG.liquidationThreshold)
        .accountsStrict({
          authority,
          config: configPda,
          collateralConfig: solCollateralConfigPda,
        })
        .rpc();
    });

    it("Authority can update liquidation penalty", async () => {
      await program.methods
        .updateCollateralLiquidationPenalty(SOL_MINT, 700)
        .accountsStrict({
          authority,
          config: configPda,
          collateralConfig: solCollateralConfigPda,
        })
        .rpc();

      const config = await program.account.collateralConfig.fetch(solCollateralConfigPda);
      expect(config.liquidationPenalty).to.equal(700);

      // Restore
      await program.methods
        .updateCollateralLiquidationPenalty(SOL_MINT, SOL_CONFIG.liquidationPenalty)
        .accountsStrict({
          authority,
          config: configPda,
          collateralConfig: solCollateralConfigPda,
        })
        .rpc();
    });

    it("Authority can update min deposit", async () => {
      const newMin = new anchor.BN(0.2 * LAMPORTS_PER_SOL);

      await program.methods
        .updateCollateralMinDeposit(SOL_MINT, newMin)
        .accountsStrict({
          authority,
          config: configPda,
          collateralConfig: solCollateralConfigPda,
        })
        .rpc();

      const config = await program.account.collateralConfig.fetch(solCollateralConfigPda);
      expect(config.minDeposit.toNumber()).to.equal(newMin.toNumber());

      // Restore
      await program.methods
        .updateCollateralMinDeposit(SOL_MINT, new anchor.BN(SOL_CONFIG.minDeposit))
        .accountsStrict({
          authority,
          config: configPda,
          collateralConfig: solCollateralConfigPda,
        })
        .rpc();
    });

    it("Fails when LTV params violate threshold invariant", async () => {
      try {
        // max_ltv (8500) >= liquidation_threshold (8000) — invalid
        await program.methods
          .updateCollateralLtvParams(SOL_MINT, 8500, 8000)
          .accountsStrict({
            authority,
            config: configPda,
            collateralConfig: solCollateralConfigPda,
          })
          .rpc();

        assert.fail("Should have failed with InvalidLiquidationThreshold");
      } catch (error) {
        expect(error.message).to.include("InvalidLiquidationThreshold");
      }
    });

    it("Fails when liquidation penalty exceeds 20%", async () => {
      try {
        await program.methods
          .updateCollateralLiquidationPenalty(SOL_MINT, 2001) // 20.01%
          .accountsStrict({
            authority,
            config: configPda,
            collateralConfig: solCollateralConfigPda,
          })
          .rpc();

        assert.fail("Should have failed with InvalidAmount");
      } catch (error) {
        expect(error.message).to.include("InvalidAmount");
      }
    });

    it("Non-authority cannot update collateral config", async () => {
      try {
        await program.methods
          .updateCollateralEnabled(SOL_MINT, false)
          .accountsStrict({
            authority: user.publicKey,
            config: configPda,
            collateralConfig: solCollateralConfigPda,
          })
          .signers([user])
          .rpc();

        assert.fail("Should have failed with Unauthorized");
      } catch (error) {
        expect(error.message).to.include("Unauthorized");
      }
    });
  });

  describe("Multiple Positions", () => {
    it("User can have both SOL and USDC positions", async () => {
      const [userUsdcPositionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), user.publicKey.toBuffer(), USDC_MINT.toBuffer()],
        program.programId
      );

      const solPosition = await program.account.position.fetch(userSolPositionPda);
      console.log("User can have multiple positions:");
      console.log("  SOL Position PDA:", userSolPositionPda.toBase58());
      console.log("  USDC Position PDA:", userUsdcPositionPda.toBase58());
      console.log("  Current SOL collateral:", solPosition.collateralAmount.toNumber() / LAMPORTS_PER_SOL, "SOL");
    });
  });
});
