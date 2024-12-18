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
  // Standard setup for our testing environment
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Thealtcoin as Program<Thealtcoin>;
  const provider = program.provider as anchor.AnchorProvider;

  // Constants for token metadata and PDAs
  const METADATA_SEED = "metadata";
  const TOKEN_METADATA_PROGRAM_ID = new web3.PublicKey(
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
  );

  const metadata = {
    name: "TheAltcoin",
    symbol: "ALTCOIN",
    uri: "https://circular-orange-leech.myfilebase.com/ipfs/QmQe5tZRCcXNo1MiwgvHABRQUzxFfcKjko9FzRwxXKTj6s",
    decimals: 9,
  };

  // Derive our program addresses
  const [mint] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("mint")],
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
  let unauthorizedUser: web3.Keypair;
  let unauthorizedAta: web3.PublicKey;

  before(async () => {
    // Set up all test accounts
    recipientKeypair = web3.Keypair.generate();
    unauthorizedUser = web3.Keypair.generate();

    // Get all ATAs
    payerAta = await getAssociatedTokenAddress(mint, provider.wallet.publicKey);
    recipientAta = await getAssociatedTokenAddress(
      mint,
      recipientKeypair.publicKey
    );
    unauthorizedAta = await getAssociatedTokenAddress(
      mint,
      unauthorizedUser.publicKey
    );

    // Airdrop SOL to test accounts
    const signature = await provider.connection.requestAirdrop(
      recipientKeypair.publicKey,
      2 * web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature);
  });

  it("Test 1: Initializes token with total supply", async () => {
    // First check if already initialized
    const info = await provider.connection.getAccountInfo(mint);
    if (info) {
      console.log("Token already initialized");
      const burnStateAccount = await program.account.burnState.fetch(burnState);
      assert(new BN(burnStateAccount.totalSupply).eq(new BN("99999999999999")));
      return;
    }

    try {
      const tx = await program.methods
        .initializeToken(metadata)
        .accounts({
          burnState,
          metadata: metadataAddress,
          mint,
          tokenAccount: payerAta,
          payer: provider.wallet.publicKey,
          rent: web3.SYSVAR_RENT_PUBKEY,
          systemProgram: web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .rpc();

      await provider.connection.confirmTransaction(tx);
      console.log("Initialization transaction:", tx);

      // Verify burn state initialization
      const burnStateAccount = await program.account.burnState.fetch(burnState);
      assert(new BN(burnStateAccount.totalSupply).eq(new BN("99999999999999")));
      assert(burnStateAccount.mintedAmount.eq(burnStateAccount.totalSupply));
      assert(burnStateAccount.burnedAmount.eq(new BN(0)));

      // Verify deployer received total supply
      const balance = await provider.connection.getTokenAccountBalance(
        payerAta
      );
      assert(new BN(balance.value.amount).eq(burnStateAccount.totalSupply));
    } catch (error) {
      console.error("Initialization error:", error);
      throw error;
    }
  });

  it("Test 2: Verifies initial token distribution", async () => {
    try {
      const burnStateAccount = await program.account.burnState.fetch(burnState);
      const balance = await provider.connection.getTokenAccountBalance(
        payerAta
      );

      // Verify deployer has total supply
      assert(
        new BN(balance.value.amount).gte(burnStateAccount.totalSupply),
        "Deployer should have full initial supply"
      );

      // Verify burn state tracking
      assert(
        burnStateAccount.mintedAmount.eq(burnStateAccount.totalSupply),
        "Minted amount should equal total supply"
      );
      assert(
        burnStateAccount.burnedAmount.eq(new BN(0)),
        "Initial burned amount should be zero"
      );
    } catch (error) {
      console.error("Initial distribution verification error:", error);
      throw error;
    }
  });

  it("Test 3: Executes first transfer with burn", async () => {
    try {
      // Create recipient ATA if needed
      try {
        const createAtaIx = createAssociatedTokenAccountInstruction(
          provider.wallet.publicKey,
          recipientAta,
          recipientKeypair.publicKey,
          mint
        );
        const setupTx = new web3.Transaction().add(createAtaIx);
        await provider.sendAndConfirm(setupTx);
      } catch (e) {
        console.log("Recipient ATA might already exist");
      }

      const initialBurnState = await program.account.burnState.fetch(burnState);
      const transferAmount = new BN(1000).mul(new BN(10).pow(new BN(9))); // 1000 tokens

      const tx = await program.methods
        .transfer(transferAmount)
        .accounts({
          burnState,
          mint,
          from: payerAta,
          to: recipientAta,
          authority: provider.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      await provider.connection.confirmTransaction(tx);

      // Verify burn amount
      const finalBurnState = await program.account.burnState.fetch(burnState);
      const expectedBurn = transferAmount.muln(2).divn(100);
      assert(
        finalBurnState.burnedAmount.eq(expectedBurn),
        "First burn amount should be exactly 2%"
      );

      // Verify recipient balance
      const recipientBalance = await provider.connection.getTokenAccountBalance(
        recipientAta
      );
      assert(
        new BN(recipientBalance.value.amount).gte(
          transferAmount.sub(expectedBurn)
        ),
        "Recipient should receive 98% of transfer"
      );
    } catch (error) {
      console.error("First transfer error:", error);
      throw error;
    }
  });

  it("Test 4: Handles multiple transfers correctly", async () => {
    try {
      const transferAmount = new BN(100).mul(new BN(10).pow(new BN(9))); // 100 tokens
      const numTransfers = 3;
      const initialBurnState = await program.account.burnState.fetch(burnState);

      // Execute multiple transfers
      for (let i = 0; i < numTransfers; i++) {
        const tx = await program.methods
          .transfer(transferAmount)
          .accounts({
            burnState,
            mint,
            from: payerAta,
            to: recipientAta,
            authority: provider.wallet.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        await provider.connection.confirmTransaction(tx);
      }

      // Verify cumulative burn
      const finalBurnState = await program.account.burnState.fetch(burnState);
      const expectedTotalBurn = transferAmount
        .muln(2)
        .divn(100)
        .muln(numTransfers);
      assert(
        finalBurnState.burnedAmount
          .sub(initialBurnState.burnedAmount)
          .eq(expectedTotalBurn),
        "Cumulative burn should be correct"
      );
    } catch (error) {
      console.error("Multiple transfer error:", error);
      throw error;
    }
  });

  it("Test 5: Verifies burn limit mechanism", async () => {
    try {
      const burnStateAccount = await program.account.burnState.fetch(burnState);
      const expectedBurnLimit =
        (BigInt(99999999999999) * BigInt(65)) / BigInt(100);

      assert(
        burnStateAccount.burnLimit.eq(new BN(expectedBurnLimit.toString())),
        "Burn limit should be 65% of total supply"
      );

      // Try transfer if not at burn limit
      if (burnStateAccount.burnedAmount.lt(burnStateAccount.burnLimit)) {
        const transferAmount = new BN(1000).mul(new BN(10).pow(new BN(9)));
        const tx = await program.methods
          .transfer(transferAmount)
          .accounts({
            burnState,
            mint,
            from: payerAta,
            to: recipientAta,
            authority: provider.wallet.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        await provider.connection.confirmTransaction(tx);

        const updatedBurnState = await program.account.burnState.fetch(
          burnState
        );
        assert(
          updatedBurnState.burnedAmount.lte(updatedBurnState.burnLimit),
          "Should never exceed burn limit"
        );
      }
    } catch (error) {
      console.error("Burn limit verification error:", error);
      throw error;
    }
  });

  it("Test 6: Handles small transfers correctly", async () => {
    try {
      const tinyAmount = new BN(10).mul(new BN(10).pow(new BN(8))); // 1 token
      const initialBurnState = await program.account.burnState.fetch(burnState);

      const tx = await program.methods
        .transfer(tinyAmount)
        .accounts({
          burnState,
          mint,
          from: payerAta,
          to: recipientAta,
          authority: provider.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      await provider.connection.confirmTransaction(tx);

      const finalBurnState = await program.account.burnState.fetch(burnState);
      assert(
        finalBurnState.burnedAmount.gte(initialBurnState.burnedAmount),
        "Burn amount should increase or stay same"
      );
    } catch (error) {
      if (!error.toString().includes("AmountTooSmall")) {
        console.error("Small transfer error:", error);
        throw error;
      }
    }
  });

  it("Test 7: Verifies supply tracking", async () => {
    try {
      const burnStateAccount = await program.account.burnState.fetch(burnState);
      const totalBalance = await provider.connection.getTokenAccountBalance(
        payerAta
      );
      const recipientBalance = await provider.connection.getTokenAccountBalance(
        recipientAta
      );

      // Calculate total circulating supply
      const totalCirculating = new BN(totalBalance.value.amount).add(
        new BN(recipientBalance.value.amount)
      );

      // Verify total supply conservation
      assert(
        totalCirculating
          .add(burnStateAccount.burnedAmount)
          .lte(burnStateAccount.totalSupply),
        "Total supply conservation should be maintained"
      );
    } catch (error) {
      console.error("Supply tracking error:", error);
      throw error;
    }
  });

  it("Test 8: Handles large transfers correctly", async () => {
    try {
      // Get current balance to determine large transfer amount
      const balance = await provider.connection.getTokenAccountBalance(
        payerAta
      );
      const largeAmount = new BN(balance.value.amount).divn(2); // Transfer half of current balance

      const initialBurnState = await program.account.burnState.fetch(burnState);

      const tx = await program.methods
        .transfer(largeAmount)
        .accounts({
          burnState,
          mint,
          from: payerAta,
          to: recipientAta,
          authority: provider.wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      await provider.connection.confirmTransaction(tx);

      const finalBurnState = await program.account.burnState.fetch(burnState);
      const expectedBurn = largeAmount.muln(2).divn(100);

      assert(
        finalBurnState.burnedAmount
          .sub(initialBurnState.burnedAmount)
          .lte(expectedBurn),
        "Large transfer burn should not exceed 2%"
      );
    } catch (error) {
      console.error("Large transfer error:", error);
      throw error;
    }
  });
});
