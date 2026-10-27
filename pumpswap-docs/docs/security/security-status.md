---
title: Security Status
description: Current security testing, audit status, and deployment readiness for PumpSwap.
---

# Security Status

Security is a core consideration and non-negotiable foundation of Pumpswap's Solana staking infrastructure. The platform uses on-chain program instructions, strict account validation, token-program compatibility checks, and user-funds-safe administrative controls to manage staking operations.

**Security Principle: We ship secure, not fast. No audit = No mainnet.**

Security readiness is evaluated through development testing, transaction verification, public review, and independent audit.


## Current Testing

Pumpswap's staking platform has been battle-tested on Solana Devnet with 100+ test cases.

Testing and verification have covered:

- Staking pool creation and configuration with flexible APY
- Staking and unstaking operations with PDA validation
- Reward funding, claim logic, and vault accounting
- Reward vault configuration, token balances, and isolated vaults
- Pool and vault account relationships and authority checks
- Administrative controls, including emergency pause behavior - *Users can ALWAYS unstake & claim even when paused, only new staking is restricted*
- Full compatibility with SPL Token Program and Token-2022 including major extensions
- Arithmetic validation, re-entrancy protection, and state-transition security

Both SPL Token Program and Token-2022 have been tested successfully on Devnet with documented results.

Testing provides strong evidence of behavior in tested scenarios. Like all DeFi protocols (Uniswap, Raydium, Jupiter), testing alone does not prove absence of all bugs - which is why we require independent audit before mainnet.

## Independent Security Audit

An independent security audit is scheduled for Q4 2026 with a Tier-1 audit firm (OtterSec / Halborn / CertiK level).

**Current Status: Audit Preparation Complete → Auditor Engagement → Audit Execution → Public Report → Mainnet**

Until audit is completed and findings addressed, Pumpswap must not be described as independently audited. We will not misrepresent our audit status.

A Tier-1 security audit will examine:

- Instruction logic and strict account validation
- Authority and access-control enforcement (role-based, multi-sig)
- Staking and unstaking accounting with edge-case validation
- Reward calculations, distribution, and vault safety
- Token transfers and supported token programs (SPL + Token-2022)
- Token-2022 extension handling within supported scope
- NFT collection verification and boost accounting
- Administrative pause and emergency controls - verifying user-funds-safe design
- Arithmetic, state-transition, authorization vulnerabilities, and re-entrancy

**We will publish full audit report, scope, and remediation actions publicly on http://doc.pumpswap.biz and GitHub before mainnet.**


## Mainnet Readiness

Successful Devnet testing is an important milestone, but not sufficient for mainnet readiness. We follow institutional-grade mainnet readiness checklist:

**Before production deployment, Pumpswap will complete:**

1.  **Program Review:** Review of deployed program and account constraints - COMPLETED
2.  **Core Operations Verification:** Staking, unstaking, reward funding, claims - COMPLETED
3.  **Admin Permissions Validation:** Role-based access, emergency behavior, multi-sig setup - COMPLETED
4.  **Token Compatibility Testing:** Supported SPL and Token-2022 configurations - COMPLETED
5.  **Extension Assessment:** Relevant Token-2022 extensions validated before supporting - COMPLETED
6.  **Independent Security Audit:** Tier-1 audit + remediation + re-audit - SCHEDULED Q1 2027
7.  **Deployment Configuration:** Program upgrade authority, monitoring setup, operational readiness - PENDING AUDIT
8.  **Incident Response:** Monitoring, recovery procedures, bug bounty program, incident response plan - PENDING AUDIT

Production readiness will be assessed against actual deployed program and results of these checks. We will publish readiness report.

**Current: 5/8 Completed | 1/8 Scheduled | 2/8 Pending Audit**

## Responsible Disclosure

We welcome white-hat review. Security is community effort.

If you identify a potential security vulnerability:

- **Do NOT publicly share exploit details** that could put user funds at risk
- **Report privately** to: security@pumpswap.biz (or GitHub Security Advisory)
- Include clear description, reproduction steps, transaction/program details
- **Do NOT include private keys, seed phrases, or secrets**

We commit to:

- Acknowledge report within 48 hours
- Provide timeline for fix
- Publish fix and credit researcher (if desired)
- Reward via bug bounty post-mainnet

## Important Notice

Devnet testing does not guarantee software is free from vulnerabilities - true for every protocol.

Successful tests demonstrate observed behavior of specific scenarios. They do not replace comprehensive security review or independent audit.

**Until audit and readiness checklist are complete, users and project teams should not treat Devnet deployment as audited, production-ready financial service. Devnet is for testing, not for mainnet value.**

We build in public, we audit before mainnet, we prioritize user fund safety - always unstake & claim enabled even during emergency pause.

**Security Links:**

- GitHub: http://github.com/pumpswapeco/pumpswap
- Audit Status: http://doc.pumpswap.biz/security-status
- Bug Bounty: Coming with mainnet

