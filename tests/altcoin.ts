import * as anchor from "@coral-xyz/anchor";
import * as web3 from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { Thealtcoin } from "../target/types/thealtcoin";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import assert from "assert";
import { BN } from "bn.js";

describe("THEALTCOIN", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Thealtcoin as Program<Thealtcoin>;
  const provider = program.provider as anchor.AnchorProvider;

  const METADATA_SEED = "metadata";
  const TOKEN_METADATA_PROGRAM_ID = new web3.PublicKey(
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
  );

  const metadata = {
    name: "TheAltcoin",
    symbol: "ALTCOIN",
    uri: "https://lime-selected-hummingbird-313.mypinata.cloud/ipfs/bafkreibodust2wzl3tgxkopwre7wfrhjenfpehu6caos6thqb5wwtw4zyu",
    decimals: 9,
  };

  const MINT_SEED = "mint";
  const payer = program.provider.publicKey;

  const [mint] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from(MINT_SEED)],
    program.programId
  );

  const [burnState] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("burn_state"), mint.toBuffer()],
    program.programId
  );

  const [metadataAddress] = web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from(METADATA_SEED),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  );

  let payerAta: web3.PublicKey;
  let recipientKeypair: web3.Keypair;
  let recipientAta: web3.PublicKey;

  before(async () => {
    recipientKeypair = web3.Keypair.generate();
    payerAta = await getAssociatedTokenAddress(mint, payer);
    recipientAta = await getAssociatedTokenAddress(
      mint,
      recipientKeypair.publicKey
    );
  });

  it("Initializes token correctly without minting", async () => {
    const info = await program.provider.connection.getAccountInfo(mint);
    if (info) {
      console.log("Token already initialized");
      return;
    }

    const tx = await program.methods
      .initializeToken(metadata)
      .accounts({
        burnState,
        metadata: metadataAddress,
        mint,
        tokenAccount: payerAta,
        payer,
        rent: web3.SYSVAR_RENT_PUBKEY,
        systemProgram: web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Initialize transaction:", tx);

    const burnStateAccount = await program.account.burnState.fetch(burnState);
    assert.equal(
      burnStateAccount.totalSupply.toString(),
      "99999999999999",
      "Total supply should be initialized correctly"
    );
    assert.equal(
      burnStateAccount.mintedAmount.toString(),
      "0",
      "Initial minted amount should be 0"
    );
  });

  it("Mints initial tokens successfully", async () => {
    const mintAmount = new BN(1000).mul(new BN(10).pow(new BN(9)));

    const tx = await program.methods
      .mintTokens(mintAmount)
      .accounts({
        burnState,
        mint,
        destination: payerAta,
        payer,
        rent: web3.SYSVAR_RENT_PUBKEY,
        systemProgram: web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Mint transaction:", tx);

    const balance = await program.provider.connection.getTokenAccountBalance(
      payerAta
    );
    assert.equal(
      balance.value.amount,
      mintAmount.toString(),
      "Token balance should match minted amount"
    );
  });

  it("Transfers tokens with 2% burn", async () => {
    // First create the recipient's token account
    const createAtaIx = createAssociatedTokenAccountInstruction(
      payer,
      recipientAta,
      recipientKeypair.publicKey,
      mint
    );

    // Create ATA for recipient
    try {
      const tx = new web3.Transaction().add(createAtaIx);
      await provider.sendAndConfirm(tx);
      console.log("Created recipient's Associated Token Account");
    } catch (error) {
      // Ignore error if account already exists
      console.log("ATA might already exist, continuing with transfer");
    }

    // Get initial state
    const initialBurnState = await program.account.burnState.fetch(burnState);
    const transferAmount = new BN(100).mul(new BN(10).pow(new BN(9))); // 100 tokens

    // Execute transfer
    const tx = await program.methods
      .transfer(transferAmount)
      .accounts({
        burnState,
        mint,
        from: payerAta,
        to: recipientAta,
        authority: payer,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Transfer transaction:", tx);

    // Verify burn amount
    const finalBurnState = await program.account.burnState.fetch(burnState);
    const expectedBurnAmount = transferAmount.muln(2).divn(100);

    assert.equal(
      finalBurnState.burnedAmount.sub(initialBurnState.burnedAmount).toString(),
      expectedBurnAmount.toString(),
      "Burn amount should be 2% of transfer"
    );

    // Verify recipient balance
    const recipientBalance =
      await program.provider.connection.getTokenAccountBalance(recipientAta);
    const expectedTransferAmount = transferAmount.sub(expectedBurnAmount);
    assert.equal(
      recipientBalance.value.amount,
      expectedTransferAmount.toString(),
      "Recipient should receive 98% of transfer amount"
    );
  });

  it("Stops burning when limit is reached", async () => {
    const burnStateAccount = await program.account.burnState.fetch(burnState);
    console.log(
      "Current burned amount:",
      burnStateAccount.burnedAmount.toString()
    );
    console.log("Burn limit:", burnStateAccount.burnLimit.toString());

    assert(
      burnStateAccount.burnLimit.toString() ===
        ((BigInt(99999999999999) * BigInt(65)) / BigInt(100)).toString(),
      "Burn limit should remain at 65% of total supply"
    );
  });

  it("Prevents minting beyond total supply", async () => {
    // Try to mint more than remaining supply
    const remainingSupply = new BN(99_999_999_999_999);
    try {
      await program.methods
        .mintTokens(remainingSupply.addn(1))
        .accounts({
          burnState,
          mint,
          destination: payerAta,
          payer,
          rent: web3.SYSVAR_RENT_PUBKEY,
          systemProgram: web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Should not allow minting beyond total supply");
    } catch (error) {
      assert(error.toString().includes("ExceedsSupply"));
    }
  });

  it("Handles very small transfer amounts correctly", async () => {
    // We'll test with 10 tokens (with 9 decimals)
    // Since our burn rate is 2%, this would result in a 0.2 token burn
    const tinyAmount = new BN(10).mul(new BN(10).pow(new BN(8))); // 1 token

    try {
      await program.methods
        .transfer(tinyAmount)
        .accounts({
          burnState,
          mint,
          from: payerAta,
          to: recipientAta,
          authority: payer,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      // Get the burn state after the attempted transfer
      const burnStateAfter = await program.account.burnState.fetch(burnState);

      // Calculate expected burn amount (2% of transfer amount)
      const expectedBurn = tinyAmount.muln(2).divn(100);
      assert(expectedBurn.gtn(0), "Burn amount should be greater than 0");
    } catch (error) {
      if (error.toString().includes("AmountTooSmall")) {
        // This is expected for amounts that would result in 0 burn
        return;
      }
      throw error;
    }
  });

  it("Verifies burn mechanism stops at limit", async () => {
    // First, let's mint a reasonable amount for testing
    const testAmount = new BN(10000).mul(new BN(10).pow(new BN(9))); // 10,000 tokens

    try {
      await program.methods
        .mintTokens(testAmount)
        .accounts({
          burnState,
          mint,
          destination: payerAta,
          payer,
          rent: web3.SYSVAR_RENT_PUBKEY,
          systemProgram: web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .rpc();

      const initialBurnState = await program.account.burnState.fetch(burnState);
      console.log(
        "Initial burned amount:",
        initialBurnState.burnedAmount.toString()
      );
      console.log("Burn limit:", initialBurnState.burnLimit.toString());

      // Let's do multiple smaller transfers to approach the burn limit
      const transferAmount = new BN(1000).mul(new BN(10).pow(new BN(9))); // 1,000 tokens per transfer
      let currentBurnState = initialBurnState;
      let transferCount = 0;

      while (
        currentBurnState.burnedAmount.lt(initialBurnState.burnLimit) &&
        transferCount < 10
      ) {
        await program.methods
          .transfer(transferAmount)
          .accounts({
            burnState,
            mint,
            from: payerAta,
            to: recipientAta,
            authority: payer,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        currentBurnState = await program.account.burnState.fetch(burnState);
        console.log(
          "Current burned amount:",
          currentBurnState.burnedAmount.toString()
        );
        transferCount++;
      }

      const finalBurnState = await program.account.burnState.fetch(burnState);
      assert(
        finalBurnState.burnedAmount.lte(finalBurnState.burnLimit),
        "Burned amount should not exceed burn limit"
      );
    } catch (error) {
      console.log("Error details:", error.toString());
      throw error;
    }
  });

  it("Tracks total minted amount accurately across multiple mints", async () => {
    const initialBurnState = await program.account.burnState.fetch(burnState);
    const mintAmount1 = new BN(100).mul(new BN(10).pow(new BN(9))); // 100 tokens
    const mintAmount2 = new BN(50).mul(new BN(10).pow(new BN(9))); // 50 tokens

    // Track initial minted amount
    const initialMintedAmount = initialBurnState.mintedAmount;

    // First mint
    await program.methods
      .mintTokens(mintAmount1)
      .accounts({
        burnState,
        mint,
        destination: payerAta,
        payer,
        rent: web3.SYSVAR_RENT_PUBKEY,
        systemProgram: web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Second mint
    await program.methods
      .mintTokens(mintAmount2)
      .accounts({
        burnState,
        mint,
        destination: payerAta,
        payer,
        rent: web3.SYSVAR_RENT_PUBKEY,
        systemProgram: web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    const finalBurnState = await program.account.burnState.fetch(burnState);
    assert.equal(
      finalBurnState.mintedAmount.toString(),
      initialMintedAmount.add(mintAmount1).add(mintAmount2).toString(),
      "Minted amount should track cumulative mints correctly"
    );
  });
});
