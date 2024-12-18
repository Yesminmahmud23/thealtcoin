use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    metadata::{
        create_metadata_accounts_v3, mpl_token_metadata::types::DataV2, CreateMetadataAccountsV3,
        Metadata as Metaplex,
    },
    token::{self, burn, mint_to, Burn, Mint, MintTo, Token, TokenAccount, Transfer},
};

declare_id!("38m5iMhNn13EfKF1uUqX2HLAGgqpmiNDxtSJSJsJKhaD");

#[program]
mod thealtcoin {
    use super::*;

    pub fn initialize_token(
        ctx: Context<InitializeToken>,
        metadata: InitTokenParams,
    ) -> Result<()> {
        // Initialize burn state with our tokenomics parameters
        let burn_state = &mut ctx.accounts.burn_state;
        burn_state.total_supply = 99_999_999_999_999;
        burn_state.burned_amount = 0;
        burn_state.burn_limit = (burn_state.total_supply as f64 * 0.65) as u64;
        burn_state.mint = ctx.accounts.mint.key();
        burn_state.minted_amount = 0; // Start with 0 minted tokens

        // Create metadata for the token
        let token_data = DataV2 {
            name: metadata.name,
            symbol: metadata.symbol,
            uri: metadata.uri,
            seller_fee_basis_points: 0,
            creators: None,
            collection: None,
            uses: None,
        };

        let seeds = &["mint".as_bytes(), &[ctx.bumps.mint]];
        let signer = [&seeds[..]];

        // Create metadata accounts through Metaplex
        let metadata_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_metadata_program.to_account_info(),
            CreateMetadataAccountsV3 {
                metadata: ctx.accounts.metadata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                mint_authority: ctx.accounts.mint.to_account_info(),
                update_authority: ctx.accounts.mint.to_account_info(),
                payer: ctx.accounts.payer.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
            &signer,
        );

        create_metadata_accounts_v3(metadata_ctx, token_data, false, true, None)?;

        msg!("THEALTCOIN initialized successfully. Ready for minting.");
        Ok(())
    }

    pub fn mint_tokens(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
        let burn_state = &mut ctx.accounts.burn_state;

        // Check if minting would exceed total supply
        require!(
            burn_state
                .minted_amount
                .checked_add(amount)
                .ok_or(ErrorCode::NumericalOverflow)?
                <= burn_state.total_supply,
            ErrorCode::ExceedsSupply
        );

        let seeds = &["mint".as_bytes(), &[ctx.bumps.mint]];
        let signer = [&seeds[..]];

        // Mint the requested amount
        mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.mint.to_account_info(),
                },
                &signer,
            ),
            amount,
        )?;

        // Update the minted amount tracker
        burn_state.minted_amount = burn_state
            .minted_amount
            .checked_add(amount)
            .ok_or(ErrorCode::NumericalOverflow)?;

        msg!(
            "Minted {} tokens. Total minted: {}",
            amount,
            burn_state.minted_amount
        );
        Ok(())
    }

    pub fn transfer(ctx: Context<TransferTokens>, amount: u64) -> Result<()> {
        let burn_state = &mut ctx.accounts.burn_state;

        // Calculate burn amount (2% of transfer)
        let burn_amount = (amount as f64 * 0.02) as u64;
        let transfer_amount = amount
            .checked_sub(burn_amount)
            .ok_or(ErrorCode::AmountTooSmall)?;

        // Only burn if we haven't reached the burn limit
        if burn_state.burned_amount < burn_state.burn_limit {
            burn(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.mint.to_account_info(),
                        from: ctx.accounts.from.to_account_info(),
                        authority: ctx.accounts.authority.to_account_info(),
                    },
                ),
                burn_amount,
            )?;

            burn_state.burned_amount = burn_state
                .burned_amount
                .checked_add(burn_amount)
                .ok_or(ErrorCode::NumericalOverflow)?;

            msg!(
                "Burned {} tokens. Total burned: {}",
                burn_amount,
                burn_state.burned_amount
            );
        }

        // Transfer the remaining tokens
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.from.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            transfer_amount,
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(params: InitTokenParams)]
pub struct InitializeToken<'info> {
    #[account(
        init,
        seeds = [b"burn_state", mint.key().as_ref()],
        bump,
        payer = payer,
        space = 8 + BurnState::LEN
    )]
    pub burn_state: Account<'info, BurnState>,

    /// CHECK: This is safe as it's handled by anchor
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    #[account(
        init,
        seeds = [b"mint"],
        bump,
        payer = payer,
        mint::decimals = params.decimals,
        mint::authority = mint,
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = payer,
    )]
    pub token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub token_metadata_program: Program<'info, Metaplex>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct TransferTokens<'info> {
    #[account(
        mut,
        seeds = [b"burn_state", mint.key().as_ref()],
        bump,
    )]
    pub burn_state: Account<'info, BurnState>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub from: Account<'info, TokenAccount>,

    #[account(mut)]
    pub to: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MintTokens<'info> {
    #[account(
        mut,
        seeds = [b"burn_state", mint.key().as_ref()],
        bump
    )]
    pub burn_state: Account<'info, BurnState>,

    #[account(
        mut,
        seeds = [b"mint"],
        bump,
        mint::authority = mint,
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = payer,
    )]
    pub destination: Account<'info, TokenAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[account]
pub struct BurnState {
    pub total_supply: u64,
    pub burned_amount: u64,
    pub burn_limit: u64,
    pub mint: Pubkey,
    pub minted_amount: u64,
}

impl BurnState {
    pub const LEN: usize = 8 + // discriminator
        8 + // total_supply
        8 + // burned_amount
        8 + // burn_limit
        32 + // mint
        8; // minted_amount
}

#[derive(AnchorSerialize, AnchorDeserialize, Debug, Clone)]
pub struct InitTokenParams {
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub decimals: u8,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Amount too small for burn calculation")]
    AmountTooSmall,
    #[msg("Numerical overflow")]
    NumericalOverflow,
    #[msg("Exceeds maximum supply")]
    ExceedsSupply,
}

