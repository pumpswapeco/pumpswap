---
title: Token Compatibility
description: PumpSwap support for the original SPL Token Program and Token-2022, including Devnet testing and token-extension considerations.
---

# Token Compatibility

Pumpswap supports both Solana token standards: the original *SPL Token Program* and *Token-2022 Program*. This allows any Solana project to launch a staking pool without changing their token standard.

## Supported Standards

Capability	SPL Token	Token-2022
Staking / Unstaking	✅	✅
Reward Funding & Claims	✅	✅
NFT Boosts	✅	✅
White-Label Pools	✅	✅
Both standards are live on Devnet via `liquidpump.app`.

## Why Two Standards?

- **SPL Token:** The original, most widely used standard. Simple and battle-tested.
- **Token-2022:** The new standard with extensions like transfer hooks, interest-bearing tokens, and confidential transfers.

Pumpswap automatically detects the token program from the mint and uses the correct program for all vault operations.

Token-2022 Extensions

Support for Token-2022 includes support for most common extensions. However, some extensions introduce extra transfer rules.

Pumpswap handles:
- Transfer Fee, Non-Transferable, Permanent Delegate, Metadata
- Interest-bearing is calculated at transfer time

**Not supported by default:** Confidential transfers and custom transfer hooks that require additional accounts. If your token uses a custom hook, contact us to verify compatibility before mainnet.

## How It Works

1.  **Select Tokens**- Choose staking token (e.g., your token) and reward token (e.g., USDC, SOL, your token)
2.  **Detect Program** - Pumpswap reads mint owner: `Tokenkeg...` = SPL, `TokenzQd...` = Token-2022
3.  **Create Vaults** - PDA vaults are created with the correct token program
4.  **Stake & Earn** - All operations use program-aware CPIs

A pool can mix standards: e.g., Stake SPL Token, Earn Token-2022 reward.


### Current Status

- ✅ SPL: Fully supported
- ✅ Token-2022: Fully supported (common extensions)
- ✅ Live on Devnet: `liquidpump.app`
- ⏳ Mainnet: Awaiting security audit

Devnet testing validates functionality. Mainnet deployment requires audit completion.


