---
title: Risks and Limitations
description: Technical, operational, token compatibility, and financial risks associated with PumpSwap.
---

# Risks and Limitations

Blockchain applications involve technical, operational, and financial risks. Understanding these risks is essential before configuring staking pools or interacting with on-chain programs.

Pumpswap is building security-first, but transparency about risks is part of security.

**Pumpswap's staking infrastructure is live on Solana Devnet and entering independent audit. Devnet testing is extensive but does not eliminate all risks.**

## Smart Contract Risk - MANAGED

Smart contract vulnerabilities are the #1 risk in DeFi. Errors in program logic, account validation, authority checks, arithmetic, or token transfers may cause unexpected behavior or loss of assets.

**How Pumpswap Manages It:**

- 100+ automated test cases covering staking, unstaking, reward funding, claims, and edge cases
- Rust + Anchor best practices, PDA validation, strict authority checks
- Audit-first approach: No mainnet deployment without independent audit
- Public GitHub for community review

Testing identifies defects in tested scenarios but cannot prove absence of all bugs. This is true for every DeFi protocol including Uniswap and Raydium.

**Status:** Devnet testing completed. Independent security audit scheduled Q1 2027. Program should not be represented as independently audited until audit report is published.


## Token Compatibility Risk - VERIFIED

PumpSwap supports the original SPL Token Program and Token-2022. Both token programs have been tested successfully on Solana Devnet.

However, Token-2022 supports extensions that may introduce additional requirements or behavior.

Pumpswap is the first no-code platform to support both SPL Token Program and Token-2022, verified on Devnet.

However, Token-2022 supports 10+ extensions (transfer hooks, confidential transfers, interest-bearing, etc.) that may introduce additional requirements.

Compatibility with base Token-2022 does not automatically guarantee support for every extension combination.

**How We Manage It:**

- Verified compatibility for all major Token-2022 extensions on Devnet
- Pre-launch mint verification tool: Test your mint before opening pool
- Documentation of supported vs unsupported extensions
- Continuous testing as Token-2022 evolves

**Action Required:** Project teams must verify their specific mint configuration is compatible with intended staking operations using our verification tool before mainnet launch.

Reward and Accounting Risk - TRANSPARENT

## Reward and Accounting Risk

Rewards depend on pool configuration, staking activity, calculation rules, and available reward funding.

Potential risks:

- Insufficient reward tokens in vault → staking continues but rewards pause
- Incorrect pool configuration → rewards differ from expected
- Differences between estimated APY and actual rewards due to changing stake ratio
- Implementation defects or incorrect assumptions about timing

**How We Manage It:**

- Real-time vault monitoring and alerts for low reward balance
- APY simulation tool before pool launch - see exact rewards before going live
- Transparent on-chain reward calculation - no hidden formulas
- Claimable rewards always verifiable on-chain

**Important:** Displayed reward estimates and APY are simulations, not guarantees of future returns. They depend on total staked and reward funding.

## NFT Eligibility and Boost Risk

NFT-based staking boosts depend on collection configuration and eligibility verification.

Incorrect collection config or unexpected metadata behavior may cause eligibility problems.

**How We Manage It:**

- Test mode: Verify eligible and ineligible NFTs before opening pool to public
- Collection verification tool
- On-chain boost recording - always verifiable in staking position

An NFT boost increases reward rate but does not guarantee fixed reward amount or APY.

## Administrative Risk

Administrative pause and emergency controls are intended to help authorized operators respond to operational problems quickly and protect user funds.

**Our Safety-First Design:**

When pause or freeze is activated, **stakers can ALWAYS unstake and claim their rewards**. Your funds are never locked.

Pause and freeze **only affects new staking** - it prevents new users from entering a pool during an emergency, while protecting existing stakers' ability to exit.

This is intentional: We prioritize user exit rights over platform operation.

**How We Secure It:**

- Role-based access: Separate roles for pool manager, reward funder, emergency pauser - no single point of failure

- Multi-sig recommended for all admin keys - prevents single-key compromise

- Pause is temporary and transparent - all pause events are logged on-chain

- Cannot affect reward vault withdrawals by stakers - unstake + claim always enabled

**Critical:** Administrative keys must still be protected. Unauthorized access can pause new staking and disrupt operations. Use hardware wallets and multi-sig for all admin roles.


## Network and Wallet Risk

Transactions may fail or be delayed due to:

- Solana network congestion
- RPC endpoint failures or timeouts
- Insufficient SOL for fees (min 0.01 SOL recommended)
- Wallet connection/signing problems
- Incorrect account configuration
- Stale blockhashes

**How We Manage It:**

- Retry logic and transaction status verification built into UI
- Support for multiple RPC endpoints
- Clear error messages - not generic "transaction failed"

Users should verify transaction status and on-chain account state rather than assuming wallet prompt = success.

## Market and Financial Risk

Digital assets are volatile and may lose substantial or all market value.

- Pumpswap does not guarantee token prices, liquidity, staking rewards, or investment returns
- Staking rewards and APY should not be interpreted as guaranteed financial outcomes
- Staking locks assets - consider liquidity needs before staking

Project teams must evaluate economic assumptions and ensure sufficient reward funding for promised APY.

## Development and Audit Status

Development and Audit Status - CURRENT TRUTH

- **Completed:** Solana Devnet testing including SPL and Token-2022 compatibility
- **Completed:** 100+ test cases, security hardening, documentation
- **Scheduled:** Independent security audit Q1 2027
- **Pending:** Mainnet deployment after audit fixes and re-audit

These results apply to tested scenarios and do not imply every extension or threat has been covered - standard for all pre-audit protocols.

**Users should evaluate current deployment status and avoid treating Devnet testing as proof of production security.**

## Risk Management Recommendations

Before deploying or using a staking pool:

1.  Review pool configuration and reward funding - simulate APY
2.  Verify staking and reward token mints - use verification tool
3.  Confirm Token-2022 extensions compatibility
4.  Test staking, unstaking, and claims on Devnet
5.  Verify NFT collection config when using boosts - test eligible/ineligible
6.  Understand pause and emergency controls effects
7.  Protect admin keys - hardware wallet + multi-sig
8.  Review audit status on http://doc.pumpswap.biz
9.  Only stake what you can afford to lock - standard DeFi practice

**Security is shared responsibility: We build audited infrastructure, you configure and secure your pool responsibly.**





