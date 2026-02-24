import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MetlevEngine } from "../target/types/metlev_engine";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect, assert } from "chai";

describe("Mock Oracle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.metlevEngine as Program<MetlevEngine>;

  const authority = provider.wallet.publicKey;
  const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

  let configPda: PublicKey;
  let solOraclePda: PublicKey;

  const SOL_PRICE_USD = new anchor.BN(150_000_000); // $150.00 with 6 decimals

  before(async () => {
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    [solOraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle"), SOL_MINT.toBuffer()],
      program.programId
    );

    try {
      await program.account.config.fetch(configPda);
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
  });

  describe("Initialize Mock Oracle", () => {
    it("Authority can initialize a mock oracle", async () => {
      try {
        await program.account.mockOracle.fetch(solOraclePda);
        console.log("✓ SOL mock oracle already initialized, skipping...");
        return;
      } catch {}

      await program.methods
        .initializeMockOracle(SOL_PRICE_USD)
        .accountsStrict({
          authority,
          config: configPda,
          mint: SOL_MINT,
          mockOracle: solOraclePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const oracle = await program.account.mockOracle.fetch(solOraclePda);

      expect(oracle.price.toNumber()).to.equal(SOL_PRICE_USD.toNumber());
      expect(oracle.decimals).to.equal(6);
      expect(oracle.authority.toBase58()).to.equal(authority.toBase58());
      expect(oracle.timestamp.toNumber()).to.be.greaterThan(0);

      console.log("SOL mock oracle initialized:");
      console.log("  Price: $", oracle.price.toNumber() / 1_000_000);
      console.log("  Decimals:", oracle.decimals);
    });

    it("Non-authority cannot initialize a mock oracle", async () => {
      const attacker = anchor.web3.Keypair.generate();
      const airdropSig = await provider.connection.requestAirdrop(
        attacker.publicKey,
        LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      const fakeMint = anchor.web3.Keypair.generate().publicKey;
      const [fakeOraclePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("mock_oracle"), fakeMint.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .initializeMockOracle(SOL_PRICE_USD)
          .accountsStrict({
            authority: attacker.publicKey,
            config: configPda,
            mint: fakeMint,
            mockOracle: fakeOraclePda,
            systemProgram: SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();

        assert.fail("Should have failed with Unauthorized");
      } catch (error) {
        expect(error.message).to.include("Unauthorized");
      }
    });
  });

  describe("Update Mock Oracle", () => {
    it("Authority can update the price", async () => {
      const newPrice = new anchor.BN(200_000_000); // $200.00

      await program.methods
        .updateMockOracle(newPrice)
        .accountsStrict({
          authority,
          config: configPda,
          mint: SOL_MINT,
          mockOracle: solOraclePda,
        })
        .rpc();

      const oracle = await program.account.mockOracle.fetch(solOraclePda);
      expect(oracle.price.toNumber()).to.equal(newPrice.toNumber());

      console.log("Oracle price updated to: $", oracle.price.toNumber() / 1_000_000);
    });

    it("Timestamp is refreshed on update", async () => {
      const oracleBefore = await program.account.mockOracle.fetch(solOraclePda);

      await new Promise(resolve => setTimeout(resolve, 1000));

      await program.methods
        .updateMockOracle(new anchor.BN(180_000_000))
        .accountsStrict({
          authority,
          config: configPda,
          mint: SOL_MINT,
          mockOracle: solOraclePda,
        })
        .rpc();

      const oracleAfter = await program.account.mockOracle.fetch(solOraclePda);
      expect(oracleAfter.timestamp.toNumber()).to.be.greaterThanOrEqual(
        oracleBefore.timestamp.toNumber()
      );
    });

    it("Non-authority cannot update the price", async () => {
      const attacker = anchor.web3.Keypair.generate();
      const airdropSig = await provider.connection.requestAirdrop(
        attacker.publicKey,
        LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      try {
        await program.methods
          .updateMockOracle(new anchor.BN(1_000_000)) // $1.00 — crash the price
          .accountsStrict({
            authority: attacker.publicKey,
            config: configPda,
            mint: SOL_MINT,
            mockOracle: solOraclePda,
          })
          .signers([attacker])
          .rpc();

        assert.fail("Should have failed with Unauthorized");
      } catch (error) {
        expect(error.message).to.include("Unauthorized");
      }
    });

    it("Restores SOL price to $150 for subsequent tests", async () => {
      await program.methods
        .updateMockOracle(SOL_PRICE_USD)
        .accountsStrict({
          authority,
          config: configPda,
          mint: SOL_MINT,
          mockOracle: solOraclePda,
        })
        .rpc();

      const oracle = await program.account.mockOracle.fetch(solOraclePda);
      expect(oracle.price.toNumber()).to.equal(SOL_PRICE_USD.toNumber());
      console.log("SOL price restored to: $", oracle.price.toNumber() / 1_000_000);
    });
  });
});
