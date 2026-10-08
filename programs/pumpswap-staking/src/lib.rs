use anchor_lang::prelude::*;
use anchor_spl::metadata::MetadataAccount;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use std::ops::Deref;

declare_id!("BYc1mF65g1JNr44BWefhnhKdPLDWbxcdUoKxcoDeZMWs");

const REWARD_SCALE: u128 = 1_000_000_000_000_000_000;

/// Maximum NFT boost allowed in basis points (10_000 bps = 100% extra rewards).
const MAX_NFT_BOOST_BPS: u16 = 10_000;

/// Basis point divisor used when scaling rewards by the NFT boost.
const BPS_DIVISOR: u16 = 10_000;

#[program]
pub mod pumpswap_staking {
    use super::*;

    pub fn initialize_platform(ctx: Context<InitializePlatform>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= 10_000, StakingError::InvalidFeeBps);

        let platform = &mut ctx.accounts.platform;
        platform.admin = ctx.accounts.admin.key();
        platform.fee_bps = fee_bps;
        platform.bump = ctx.bumps.platform;

        emit!(PlatformInitialized {
            admin: platform.admin,
            fee_bps,
        });

        Ok(())
    }

    pub fn create_pool(
        ctx: Context<CreatePool>,
        pool_id: u64,
        lock_duration: i64,
        reward_rate_per_second: u64,
    ) -> Result<()> {
        require!(lock_duration >= 0, StakingError::InvalidLockDuration);
        require!(reward_rate_per_second > 0, StakingError::InvalidRewardRate);

        let now = Clock::get()?.unix_timestamp;
        let pool = &mut ctx.accounts.pool;

        pool.authority = ctx.accounts.authority.key();
        pool.pool_id = pool_id;
        pool.staking_mint = ctx.accounts.staking_mint.key();
        pool.reward_mint = ctx.accounts.reward_mint.key();
        pool.staking_vault = ctx.accounts.staking_vault.key();
        pool.reward_vault = ctx.accounts.reward_vault.key();
        pool.lock_duration = lock_duration;
        pool.reward_rate_per_second = reward_rate_per_second;
        pool.total_staked = 0;
        pool.reward_per_token = 0;
        pool.last_update_timestamp = now;
        pool.paused = false;
        pool.frozen = false;
        pool.nft_collection = Pubkey::default();
        pool.nft_boost_bps = 0;
        pool.bump = ctx.bumps.pool;
        pool.staking_vault_bump = ctx.bumps.staking_vault;
        pool.reward_vault_bump = ctx.bumps.reward_vault;

        emit!(PoolCreated {
            pool: pool.key(),
            authority: pool.authority,
            pool_id,
            staking_mint: pool.staking_mint,
            reward_mint: pool.reward_mint,
            lock_duration,
            reward_rate_per_second,
        });

        Ok(())
    }

    pub fn set_pool_boost(
        ctx: Context<SetPoolBoost>,
        collection: Pubkey,
        boost_bps: u16,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;

        let (collection, boost_bps) = normalize_boost(collection, boost_bps)?;
        pool.nft_collection = collection;
        pool.nft_boost_bps = boost_bps;
        emit!(PoolBoostUpdated {
            pool: pool.key(),
            authority: ctx.accounts.authority.key(),
            collection: pool.nft_collection,
            boost_bps: pool.nft_boost_bps,
        });

        Ok(())
    }

    pub fn fund_rewards(ctx: Context<FundRewards>, amount: u64) -> Result<()> {
        require!(amount > 0, StakingError::InvalidAmount);

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.funder_reward_token_account.to_account_info(),
            mint: ctx.accounts.reward_mint.to_account_info(),
            to: ctx.accounts.reward_vault.to_account_info(),
            authority: ctx.accounts.funder.to_account_info(),
        };
        let cpi_program = ctx.accounts.reward_token_program.to_account_info();
        token_interface::transfer_checked(
            CpiContext::new(cpi_program, cpi_accounts),
            amount,
            ctx.accounts.reward_mint.decimals,
        )?;

        emit!(RewardsFunded {
            pool: ctx.accounts.pool.key(),
            funder: ctx.accounts.funder.key(),
            amount,
        });

        Ok(())
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, StakingError::InvalidAmount);

        let now = Clock::get()?.unix_timestamp;
        let pool = &mut ctx.accounts.pool;

        require!(!pool.paused, StakingError::PoolPaused);
        require!(!pool.frozen, StakingError::PoolFrozen);

        update_pool_rewards(pool, now)?;

        // --- NFT boost verification ---
        // The boost applied to a position always comes from the pool
        // configuration. Nothing here is supplied by the frontend.
        let nft_boost_enabled = pool.nft_collection != Pubkey::default() && pool.nft_boost_bps > 0;

        let nft_boost_bps = if nft_boost_enabled {
            require!(
                ctx.accounts.user_nft_token_account.is_some(),
                StakingError::NftBoostRequiresNft
            );
            require!(
                ctx.accounts.nft_metadata_account.is_some(),
                StakingError::NftBoostRequiresNft
            );

            let nft_token = ctx
                .accounts
                .user_nft_token_account
                .as_ref()
                .expect("missing nft token account");
            let nft_metadata = ctx
                .accounts
                .nft_metadata_account
                .as_ref()
                .expect("missing nft metadata account");

            // The NFT token account must belong to the staking user.
            require!(
                nft_token.owner == ctx.accounts.user.key(),
                StakingError::NftNotOwnedByUser
            );
            // The NFT token account must hold at least one token.
            require!(nft_token.amount >= 1, StakingError::NftNoBalance);

            // The metadata account must be the canonical Metaplex metadata PDA
            // for the NFT mint, and must describe that same mint.
            let metadata_program_id = anchor_spl::metadata::ID;
            let (metadata_pda, _) = Pubkey::find_program_address(
                &[
                    b"metadata",
                    metadata_program_id.as_ref(),
                    nft_token.mint.as_ref(),
                ],
                &metadata_program_id,
            );
            require!(
                nft_metadata.key() == metadata_pda,
                StakingError::NftMetadataMismatch
            );

            let metadata = nft_metadata.deref().deref();
            require!(
                metadata.mint == nft_token.mint,
                StakingError::NftMetadataMismatch
            );
            // The NFT must belong to a collection that is configured on the
            // pool and verified by the Metaplex authority.
            require!(
                metadata.collection.is_some(),
                StakingError::NftCollectionMissing
            );
            let collection = metadata
                .collection
                .as_ref()
                .expect("missing nft collection");
            require!(collection.verified, StakingError::NftCollectionUnverified);
            require!(
                collection.key == pool.nft_collection,
                StakingError::WrongNftCollection
            );

            pool.nft_boost_bps
        } else {
            0
        };

        let user_position = &mut ctx.accounts.user_position;

        if user_position.owner == Pubkey::default() {
            user_position.owner = ctx.accounts.user.key();
            user_position.pool = pool.key();
            user_position.bump = ctx.bumps.user_position;
            user_position.reward_debt = pool.reward_per_token;
        } else {
            require!(
                user_position.owner == ctx.accounts.user.key(),
                StakingError::Unauthorized
            );
            require!(user_position.pool == pool.key(), StakingError::InvalidPool);
        }

        settle_user_rewards(user_position, pool.reward_per_token)?;

        // Record the pool-configured boost for this position's future reward
        // accrual. When NFT boosting is disabled this is always 0.
        user_position.nft_boost_bps = nft_boost_bps;

        user_position.amount = user_position
            .amount
            .checked_add(amount)
            .ok_or(StakingError::MathOverflow)?;

        let new_unlock = now
            .checked_add(pool.lock_duration)
            .ok_or(StakingError::MathOverflow)?;

        if new_unlock > user_position.locked_until {
            user_position.locked_until = new_unlock;
        }

        user_position.reward_debt = pool.reward_per_token;

        pool.total_staked = pool
            .total_staked
            .checked_add(amount)
            .ok_or(StakingError::MathOverflow)?;

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.user_staking_token_account.to_account_info(),
            mint: ctx.accounts.staking_mint.to_account_info(),
            to: ctx.accounts.staking_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.staking_token_program.to_account_info();
        token_interface::transfer_checked(
            CpiContext::new(cpi_program, cpi_accounts),
            amount,
            ctx.accounts.staking_mint.decimals,
        )?;

        emit!(Staked {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            amount,
            total_staked: pool.total_staked,
        });

        Ok(())
    }

    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        require!(amount > 0, StakingError::InvalidAmount);

        let now = Clock::get()?.unix_timestamp;
        let pool = &mut ctx.accounts.pool;
        let user_position = &mut ctx.accounts.user_position;

        require!(
            user_position.owner == ctx.accounts.user.key(),
            StakingError::Unauthorized
        );
        require!(user_position.pool == pool.key(), StakingError::InvalidPool);
        require!(
            user_position.amount >= amount,
            StakingError::InsufficientStakedAmount
        );
        require!(
            now >= user_position.locked_until,
            StakingError::LockDurationNotMet
        );

        update_pool_rewards(pool, now)?;
        settle_user_rewards(user_position, pool.reward_per_token)?;

        user_position.amount = user_position
            .amount
            .checked_sub(amount)
            .ok_or(StakingError::MathOverflow)?;
        user_position.reward_debt = pool.reward_per_token;

        pool.total_staked = pool
            .total_staked
            .checked_sub(amount)
            .ok_or(StakingError::MathOverflow)?;

        let pool_authority = pool.authority;
        let pool_id_bytes = pool.pool_id.to_le_bytes();
        let bump = [pool.bump];
        let seeds: &[&[u8]] = &[
            b"pool",
            pool_authority.as_ref(),
            pool_id_bytes.as_ref(),
            &bump,
        ];
        let signer = &[seeds];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.staking_vault.to_account_info(),
            mint: ctx.accounts.staking_mint.to_account_info(),
            to: ctx.accounts.user_staking_token_account.to_account_info(),
            authority: pool.to_account_info(),
        };
        let cpi_program = ctx.accounts.staking_token_program.to_account_info();
        token_interface::transfer_checked(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer),
            amount,
            ctx.accounts.staking_mint.decimals,
        )?;

        emit!(Unstaked {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            amount,
            remaining_staked: user_position.amount,
            total_staked: pool.total_staked,
        });

        Ok(())
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool = &mut ctx.accounts.pool;
        let user_position = &mut ctx.accounts.user_position;

        require!(
            user_position.owner == ctx.accounts.user.key(),
            StakingError::Unauthorized
        );
        require!(user_position.pool == pool.key(), StakingError::InvalidPool);

        update_pool_rewards(pool, now)?;
        settle_user_rewards(user_position, pool.reward_per_token)?;

        let total_rewards = user_position.accrued_rewards;
        require!(total_rewards > 0, StakingError::NoRewardsToClaim);

        require!(
            ctx.accounts.reward_vault.amount >= total_rewards,
            StakingError::InsufficientRewardVaultBalance
        );

        user_position.accrued_rewards = 0;
        user_position.total_claimed = user_position
            .total_claimed
            .checked_add(total_rewards)
            .ok_or(StakingError::MathOverflow)?;
        user_position.reward_debt = pool.reward_per_token;

        let pool_authority = pool.authority;
        let pool_id_bytes = pool.pool_id.to_le_bytes();
        let bump = [pool.bump];
        let seeds: &[&[u8]] = &[
            b"pool",
            pool_authority.as_ref(),
            pool_id_bytes.as_ref(),
            &bump,
        ];
        let signer = &[seeds];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.reward_vault.to_account_info(),
            mint: ctx.accounts.reward_mint.to_account_info(),
            to: ctx.accounts.user_reward_token_account.to_account_info(),
            authority: pool.to_account_info(),
        };
        let cpi_program = ctx.accounts.reward_token_program.to_account_info();
        token_interface::transfer_checked(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer),
            total_rewards,
            ctx.accounts.reward_mint.decimals,
        )?;

        emit!(RewardsClaimed {
            pool: pool.key(),
            user: ctx.accounts.user.key(),
            amount: total_rewards,
            total_claimed: user_position.total_claimed,
        });

        Ok(())
    }

    pub fn pause_pool(ctx: Context<PausePool>, paused: bool) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.paused = paused;

        emit!(PoolStatusChanged {
            pool: pool.key(),
            authority: ctx.accounts.authority.key(),
            paused: pool.paused,
            frozen: pool.frozen,
        });

        Ok(())
    }

    pub fn emergency_freeze(ctx: Context<EmergencyFreeze>, frozen: bool) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.frozen = frozen;

        emit!(PoolStatusChanged {
            pool: pool.key(),
            authority: ctx.accounts.authority.key(),
            paused: pool.paused,
            frozen: pool.frozen,
        });

        Ok(())
    }
}

fn update_pool_rewards(pool: &mut Account<Pool>, now: i64) -> Result<()> {
    let elapsed = now
        .checked_sub(pool.last_update_timestamp)
        .ok_or(StakingError::MathOverflow)?;

    require!(elapsed >= 0, StakingError::MathOverflow);

    if elapsed == 0 || pool.total_staked == 0 {
        pool.last_update_timestamp = now;
        return Ok(());
    }

    let elapsed_u128 = u128::try_from(elapsed).map_err(|_| StakingError::MathOverflow)?;

    let numerator = elapsed_u128
        .checked_mul(pool.reward_rate_per_second as u128)
        .ok_or(StakingError::MathOverflow)?
        .checked_mul(REWARD_SCALE)
        .ok_or(StakingError::MathOverflow)?;

    let increment = numerator
        .checked_div(pool.total_staked as u128)
        .ok_or(StakingError::MathOverflow)?;

    pool.reward_per_token = pool
        .reward_per_token
        .checked_add(increment)
        .ok_or(StakingError::MathOverflow)?;

    pool.last_update_timestamp = now;

    Ok(())
}

fn normalize_boost(collection: Pubkey, boost_bps: u16) -> Result<(Pubkey, u16)> {
    require!(boost_bps <= MAX_NFT_BOOST_BPS, StakingError::InvalidNftBoost);

    if boost_bps == 0 {
        return Ok((Pubkey::default(), 0));
    }

    require!(collection != Pubkey::default(), StakingError::InvalidNftBoost);
    Ok((collection, boost_bps))
}

fn calculate_reward_accrual(amount: u64, delta: u128, boost_bps: u16) -> Result<u128> {
    let base_reward = (amount as u128)
        .checked_mul(delta)
        .ok_or(StakingError::MathOverflow)?
        .checked_div(REWARD_SCALE)
        .ok_or(StakingError::MathOverflow)?;

    if boost_bps == 0 {
        return Ok(base_reward);
    }

    let boost_factor = (BPS_DIVISOR as u128)
        .checked_add(boost_bps as u128)
        .ok_or(StakingError::MathOverflow)?;
    base_reward
        .checked_mul(boost_factor)
        .ok_or(StakingError::MathOverflow)?
        .checked_div(BPS_DIVISOR as u128)
        .ok_or(StakingError::MathOverflow.into())
}

fn settle_user_rewards(
    user_position: &mut Account<UserPosition>,
    reward_per_token: u128,
) -> Result<()> {
    require!(
        reward_per_token >= user_position.reward_debt,
        StakingError::MathOverflow
    );

    let delta = reward_per_token
        .checked_sub(user_position.reward_debt)
        .ok_or(StakingError::MathOverflow)?;

    if delta > 0 && user_position.amount > 0 {
        let accrued_u128 = calculate_reward_accrual(
            user_position.amount,
            delta,
            user_position.nft_boost_bps,
        )?;
        let accrued = u64::try_from(accrued_u128).map_err(|_| StakingError::MathOverflow)?;

        user_position.accrued_rewards = user_position
            .accrued_rewards
            .checked_add(accrued)
            .ok_or(StakingError::MathOverflow)?;
    }

    user_position.reward_debt = reward_per_token;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_and_position_account_sizes_include_nft_fields() {
        assert_eq!(Pool::LEN, 255);
        assert_eq!(UserPosition::LEN, 115);
    }

    #[test]
    fn boost_normalization_rejects_excessive_values_and_zero_collection() {
        let collection = Pubkey::new_unique();
        assert_eq!(normalize_boost(Pubkey::default(), 0).unwrap(), (Pubkey::default(), 0));
        assert_eq!(normalize_boost(collection, 10_000).unwrap(), (collection, 10_000));
        assert!(normalize_boost(collection, 10_001).is_err());
        assert!(normalize_boost(Pubkey::default(), 1).is_err());
    }

    #[test]
    fn no_boost_preserves_base_reward() {
        let one_reward = REWARD_SCALE / 10;
        assert_eq!(calculate_reward_accrual(10, one_reward, 0).unwrap(), 1);
        assert_eq!(
            calculate_reward_accrual(10, REWARD_SCALE, 0).unwrap(),
            10
        );
    }

    #[test]
    fn boost_uses_checked_basis_point_math() {
        assert_eq!(calculate_reward_accrual(10, REWARD_SCALE, 5_000).unwrap(), 15);
        assert_eq!(calculate_reward_accrual(10, REWARD_SCALE, 10_000).unwrap(), 20);
    }

    #[test]
    fn boost_does_not_change_zero_reward() {
        assert_eq!(
            calculate_reward_accrual(u64::MAX, 0, 10_000).unwrap(),
            0
        );
    }

    #[test]
    fn disabled_boost_keeps_reward_factor_at_10000() {
        let amount = 123_u64;
        let delta = REWARD_SCALE
            .checked_mul(7)
            .expect("test delta must fit");
        let reward = calculate_reward_accrual(amount, delta, 0).unwrap();
        let base_reward = (amount as u128) * delta / REWARD_SCALE;
        let factor = BPS_DIVISOR as u128;

        assert_eq!(normalize_boost(Pubkey::default(), 0).unwrap(), (Pubkey::default(), 0));
        assert_eq!(reward, base_reward * factor / factor);
    }

    #[test]
    fn valid_boost_normalization_preserves_collection_and_bps() {
        let collection = Pubkey::new_unique();
        assert_eq!(normalize_boost(collection, 2_500).unwrap(), (collection, 2_500));
    }

    #[test]
    fn reward_accrual_rejects_checked_multiplication_overflow() {
        assert!(calculate_reward_accrual(u64::MAX, u128::MAX, 0).is_err());
    }

}

#[derive(Accounts)]
pub struct InitializePlatform<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Platform::LEN,
        seeds = [b"platform"],
        bump
    )]
    pub platform: Account<'info, Platform>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool_id: u64)]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mint::token_program = staking_token_program)]
    pub staking_mint: InterfaceAccount<'info, Mint>,

    #[account(mint::token_program = reward_token_program)]
    pub reward_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = 8 + Pool::LEN,
        seeds = [b"pool", authority.key().as_ref(), &pool_id.to_le_bytes()],
        bump
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        init,
        payer = authority,
        token::mint = staking_mint,
        token::authority = pool,
        token::token_program = staking_token_program,
        seeds = [b"staking_vault", pool.key().as_ref()],
        bump
    )]
    pub staking_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        token::mint = reward_mint,
        token::authority = pool,
        token::token_program = reward_token_program,
        seeds = [b"reward_vault", pool.key().as_ref()],
        bump
    )]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,

    pub staking_token_program: Interface<'info, TokenInterface>,
    pub reward_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundRewards<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(mut)]
    pub pool: Account<'info, Pool>,

    #[account(
        constraint = reward_mint.key() == pool.reward_mint
            @ StakingError::InvalidMint,
        mint::token_program = reward_token_program
    )]
    pub reward_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = reward_mint,
        token::authority = funder,
        token::token_program = reward_token_program
    )]
    pub funder_reward_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = reward_mint,
        token::authority = pool,
        token::token_program = reward_token_program,
        seeds = [b"reward_vault", pool.key().as_ref()],
        bump = pool.reward_vault_bump
    )]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,

    pub reward_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub pool: Account<'info, Pool>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserPosition::LEN,
        seeds = [b"user_position", pool.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_position: Account<'info, UserPosition>,

    #[account(
        constraint = staking_mint.key() == pool.staking_mint
            @ StakingError::InvalidMint,
        mint::token_program = staking_token_program
    )]
    pub staking_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = staking_mint,
        token::authority = user,
        token::token_program = staking_token_program
    )]
    pub user_staking_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = staking_mint,
        token::authority = pool,
        token::token_program = staking_token_program,
        seeds = [b"staking_vault", pool.key().as_ref()],
        bump = pool.staking_vault_bump
    )]
    pub staking_vault: InterfaceAccount<'info, TokenAccount>,

    pub staking_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    // These accounts are optional so ordinary staking does not require NFT
    // accounts. When a pool boost is enabled, both are required and verified
    // on-chain. InterfaceAccount accepts legacy SPL Token or Token-2022.
    pub user_nft_token_account: Option<InterfaceAccount<'info, TokenAccount>>,
    pub nft_metadata_account: Option<Account<'info, MetadataAccount>>,
}

#[derive(Accounts)]
pub struct SetPoolBoost<'info> {
    #[account(
        constraint = authority.key() == pool.authority
            @ StakingError::UnauthorizedNftBoostUpdate
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [b"user_position", pool.key().as_ref(), user.key().as_ref()],
        bump = user_position.bump
    )]
    pub user_position: Account<'info, UserPosition>,

    #[account(
        constraint = staking_mint.key() == pool.staking_mint
            @ StakingError::InvalidMint,
        mint::token_program = staking_token_program
    )]
    pub staking_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = staking_mint,
        token::authority = user,
        token::token_program = staking_token_program
    )]
    pub user_staking_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = staking_mint,
        token::authority = pool,
        token::token_program = staking_token_program,
        seeds = [b"staking_vault", pool.key().as_ref()],
        bump = pool.staking_vault_bump
    )]
    pub staking_vault: InterfaceAccount<'info, TokenAccount>,

    pub staking_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [b"user_position", pool.key().as_ref(), user.key().as_ref()],
        bump = user_position.bump
    )]
    pub user_position: Account<'info, UserPosition>,

    #[account(
        constraint = reward_mint.key() == pool.reward_mint
            @ StakingError::InvalidMint,
        mint::token_program = reward_token_program
    )]
    pub reward_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = reward_mint,
        token::authority = user,
        token::token_program = reward_token_program
    )]
    pub user_reward_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = reward_mint,
        token::authority = pool,
        token::token_program = reward_token_program,
        seeds = [b"reward_vault", pool.key().as_ref()],
        bump = pool.reward_vault_bump
    )]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,

    pub reward_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct PausePool<'info> {
    #[account(
        constraint = authority.key() == pool.authority @ StakingError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct EmergencyFreeze<'info> {
    #[account(
        constraint = authority.key() == pool.authority @ StakingError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub pool: Account<'info, Pool>,
}

#[account]
pub struct Platform {
    pub admin: Pubkey,
    pub fee_bps: u16,
    pub bump: u8,
}

impl Platform {
    pub const LEN: usize = 32 + 2 + 1;
}

#[account]
pub struct Pool {
    pub authority: Pubkey,
    pub pool_id: u64,
    pub staking_mint: Pubkey,
    pub reward_mint: Pubkey,
    pub staking_vault: Pubkey,
    pub reward_vault: Pubkey,
    pub lock_duration: i64,
    pub reward_rate_per_second: u64,
    pub total_staked: u64,
    pub reward_per_token: u128,
    pub last_update_timestamp: i64,
    pub paused: bool,
    pub frozen: bool,
    pub bump: u8,
    pub staking_vault_bump: u8,
    pub reward_vault_bump: u8,
    pub nft_collection: Pubkey,
    pub nft_boost_bps: u16,
}

impl Pool {
    pub const LEN: usize =
        32 + 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 16 + 8 + 1 + 1 + 1 + 1 + 1 + 32 + 2;
}

#[account]
pub struct UserPosition {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub amount: u64,
    pub locked_until: i64,
    pub reward_debt: u128,
    pub accrued_rewards: u64,
    pub total_claimed: u64,
    pub bump: u8,
    pub nft_boost_bps: u16,
}

impl UserPosition {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 16 + 8 + 8 + 1 + 2;
}

#[event]
pub struct PlatformInitialized {
    pub admin: Pubkey,
    pub fee_bps: u16,
}

#[event]
pub struct PoolCreated {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub pool_id: u64,
    pub staking_mint: Pubkey,
    pub reward_mint: Pubkey,
    pub lock_duration: i64,
    pub reward_rate_per_second: u64,
}

#[event]
pub struct PoolBoostUpdated {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub collection: Pubkey,
    pub boost_bps: u16,
}

#[event]
pub struct RewardsFunded {
    pub pool: Pubkey,
    pub funder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Staked {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
}

#[event]
pub struct Unstaked {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub remaining_staked: u64,
    pub total_staked: u64,
}

#[event]
pub struct RewardsClaimed {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub total_claimed: u64,
}

#[event]
pub struct PoolStatusChanged {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub paused: bool,
    pub frozen: bool,
}

#[error_code]
pub enum StakingError {
    #[msg("Pool is currently paused")]
    PoolPaused,
    #[msg("Pool is emergency frozen")]
    PoolFrozen,
    #[msg("Invalid amount specified")]
    InvalidAmount,
    #[msg("Invalid lock duration")]
    InvalidLockDuration,
    #[msg("Invalid reward rate")]
    InvalidRewardRate,
    #[msg("Invalid platform fee")]
    InvalidFeeBps,
    #[msg("Insufficient staked amount")]
    InsufficientStakedAmount,
    #[msg("Lock duration has not been met yet")]
    LockDurationNotMet,
    #[msg("No rewards available to claim")]
    NoRewardsToClaim,
    #[msg("Insufficient reward vault balance")]
    InsufficientRewardVaultBalance,
    #[msg("Math arithmetic overflow")]
    MathOverflow,
    #[msg("Unauthorized access")]
    Unauthorized,
    #[msg("Invalid token mint")]
    InvalidMint,
    #[msg("Invalid token account owner")]
    InvalidOwner,
    #[msg("Invalid pool association")]
    InvalidPool,
    #[msg("Only the pool authority can update the NFT boost")]
    UnauthorizedNftBoostUpdate,
    #[msg("Invalid NFT boost value")]
    InvalidNftBoost,
    #[msg("NFT boost is enabled: an NFT is required to stake")]
    NftBoostRequiresNft,
    #[msg("Invalid NFT token account")]
    InvalidNftTokenAccount,
    #[msg("NFT token account is not owned by the staking user")]
    NftNotOwnedByUser,
    #[msg("NFT token account has no token balance")]
    NftNoBalance,
    #[msg("NFT token does not match the metadata account")]
    NftMetadataMismatch,
    #[msg("NFT metadata has no collection")]
    NftCollectionMissing,
    #[msg("NFT collection is not verified")]
    NftCollectionUnverified,
    #[msg("NFT belongs to a different collection")]
    WrongNftCollection,
}
