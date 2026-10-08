/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/pumpswap_staking.json`.
 */
export type PumpswapStaking = {
  "address": "BYc1mF65g1JNr44BWefhnhKdPLDWbxcdUoKxcoDeZMWs",
  "metadata": {
    "name": "pumpswapStaking",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "No-code Solana staking infrastructure for project founders"
  },
  "instructions": [
    {
      "name": "claimRewards",
      "discriminator": [
        4,
        144,
        132,
        71,
        116,
        23,
        151,
        80
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "userPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "rewardMint"
        },
        {
          "name": "userRewardTokenAccount",
          "writable": true
        },
        {
          "name": "rewardVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "rewardTokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "createPool",
      "discriminator": [
        233,
        146,
        209,
        142,
        207,
        104,
        64,
        188
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "stakingMint"
        },
        {
          "name": "rewardMint"
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              },
              {
                "kind": "arg",
                "path": "pool_id"
              }
            ]
          }
        },
        {
          "name": "stakingVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  105,
                  110,
                  103,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "rewardVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "stakingTokenProgram"
        },
        {
          "name": "rewardTokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "poolId",
          "type": "u64"
        },
        {
          "name": "lockDuration",
          "type": "i64"
        },
        {
          "name": "rewardRatePerSecond",
          "type": "u64"
        }
      ]
    },
    {
      "name": "emergencyFreeze",
      "discriminator": [
        179,
        69,
        168,
        100,
        173,
        7,
        136,
        112
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "pool",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "frozen",
          "type": "bool"
        }
      ]
    },
    {
      "name": "fundRewards",
      "discriminator": [
        114,
        64,
        163,
        112,
        175,
        167,
        19,
        121
      ],
      "accounts": [
        {
          "name": "funder",
          "writable": true,
          "signer": true
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "rewardMint"
        },
        {
          "name": "funderRewardTokenAccount",
          "writable": true
        },
        {
          "name": "rewardVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "rewardTokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initializePlatform",
      "discriminator": [
        119,
        201,
        101,
        45,
        75,
        122,
        89,
        3
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "platform",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  116,
                  102,
                  111,
                  114,
                  109
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "feeBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "pausePool",
      "discriminator": [
        160,
        15,
        12,
        189,
        160,
        0,
        243,
        245
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "pool",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setPoolBoost",
      "discriminator": [
        10,
        115,
        152,
        139,
        90,
        173,
        186,
        116
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "pool",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "collection",
          "type": "pubkey"
        },
        {
          "name": "boostBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "stake",
      "discriminator": [
        206,
        176,
        202,
        18,
        200,
        209,
        179,
        108
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "userPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "stakingMint"
        },
        {
          "name": "userStakingTokenAccount",
          "writable": true
        },
        {
          "name": "stakingVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  105,
                  110,
                  103,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "stakingTokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "userNftTokenAccount",
          "optional": true
        },
        {
          "name": "nftMetadataAccount",
          "optional": true
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "unstake",
      "discriminator": [
        90,
        95,
        107,
        42,
        205,
        124,
        50,
        225
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "userPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "stakingMint"
        },
        {
          "name": "userStakingTokenAccount",
          "writable": true
        },
        {
          "name": "stakingVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  105,
                  110,
                  103,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "stakingTokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "Platform",
      "discriminator": [
        77,
        92,
        204,
        58,
        187,
        98,
        91,
        12
      ]
    },
    {
      "name": "Pool",
      "discriminator": [
        241,
        154,
        109,
        4,
        17,
        177,
        109,
        188
      ]
    },
    {
      "name": "UserPosition",
      "discriminator": [
        251,
        248,
        209,
        245,
        83,
        234,
        17,
        27
      ]
    }
  ],
  "events": [
    {
      "name": "PlatformInitialized",
      "discriminator": [
        16,
        222,
        212,
        5,
        213,
        140,
        112,
        162
      ]
    },
    {
      "name": "PoolBoostUpdated",
      "discriminator": [
        205,
        116,
        70,
        75,
        95,
        248,
        75,
        184
      ]
    },
    {
      "name": "PoolCreated",
      "discriminator": [
        202,
        44,
        41,
        88,
        104,
        220,
        157,
        82
      ]
    },
    {
      "name": "PoolStatusChanged",
      "discriminator": [
        148,
        190,
        81,
        62,
        81,
        239,
        137,
        188
      ]
    },
    {
      "name": "RewardsClaimed",
      "discriminator": [
        75,
        98,
        88,
        18,
        219,
        112,
        88,
        121
      ]
    },
    {
      "name": "RewardsFunded",
      "discriminator": [
        84,
        233,
        245,
        203,
        228,
        147,
        165,
        92
      ]
    },
    {
      "name": "Staked",
      "discriminator": [
        11,
        146,
        45,
        205,
        230,
        58,
        213,
        240
      ]
    },
    {
      "name": "Unstaked",
      "discriminator": [
        27,
        179,
        156,
        215,
        47,
        71,
        195,
        7
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "PoolPaused",
      "msg": "Pool is currently paused"
    },
    {
      "code": 6001,
      "name": "PoolFrozen",
      "msg": "Pool is emergency frozen"
    },
    {
      "code": 6002,
      "name": "InvalidAmount",
      "msg": "Invalid amount specified"
    },
    {
      "code": 6003,
      "name": "InvalidLockDuration",
      "msg": "Invalid lock duration"
    },
    {
      "code": 6004,
      "name": "InvalidRewardRate",
      "msg": "Invalid reward rate"
    },
    {
      "code": 6005,
      "name": "InvalidFeeBps",
      "msg": "Invalid platform fee"
    },
    {
      "code": 6006,
      "name": "InsufficientStakedAmount",
      "msg": "Insufficient staked amount"
    },
    {
      "code": 6007,
      "name": "LockDurationNotMet",
      "msg": "Lock duration has not been met yet"
    },
    {
      "code": 6008,
      "name": "NoRewardsToClaim",
      "msg": "No rewards available to claim"
    },
    {
      "code": 6009,
      "name": "InsufficientRewardVaultBalance",
      "msg": "Insufficient reward vault balance"
    },
    {
      "code": 6010,
      "name": "MathOverflow",
      "msg": "Math arithmetic overflow"
    },
    {
      "code": 6011,
      "name": "Unauthorized",
      "msg": "Unauthorized access"
    },
    {
      "code": 6012,
      "name": "InvalidMint",
      "msg": "Invalid token mint"
    },
    {
      "code": 6013,
      "name": "InvalidOwner",
      "msg": "Invalid token account owner"
    },
    {
      "code": 6014,
      "name": "InvalidPool",
      "msg": "Invalid pool association"
    },
    {
      "code": 6015,
      "name": "UnauthorizedNftBoostUpdate",
      "msg": "Only the pool authority can update the NFT boost"
    },
    {
      "code": 6016,
      "name": "InvalidNftBoost",
      "msg": "Invalid NFT boost value"
    },
    {
      "code": 6017,
      "name": "NftBoostRequiresNft",
      "msg": "NFT boost is enabled: an NFT is required to stake"
    },
    {
      "code": 6018,
      "name": "InvalidNftTokenAccount",
      "msg": "Invalid NFT token account"
    },
    {
      "code": 6019,
      "name": "NftNotOwnedByUser",
      "msg": "NFT token account is not owned by the staking user"
    },
    {
      "code": 6020,
      "name": "NftNoBalance",
      "msg": "NFT token account has no token balance"
    },
    {
      "code": 6021,
      "name": "NftMetadataMismatch",
      "msg": "NFT token does not match the metadata account"
    },
    {
      "code": 6022,
      "name": "NftCollectionMissing",
      "msg": "NFT metadata has no collection"
    },
    {
      "code": 6023,
      "name": "NftCollectionUnverified",
      "msg": "NFT collection is not verified"
    },
    {
      "code": 6024,
      "name": "WrongNftCollection",
      "msg": "NFT belongs to a different collection"
    }
  ],
  "types": [
    {
      "name": "Platform",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "PlatformInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "feeBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "Pool",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "poolId",
            "type": "u64"
          },
          {
            "name": "stakingMint",
            "type": "pubkey"
          },
          {
            "name": "rewardMint",
            "type": "pubkey"
          },
          {
            "name": "stakingVault",
            "type": "pubkey"
          },
          {
            "name": "rewardVault",
            "type": "pubkey"
          },
          {
            "name": "lockDuration",
            "type": "i64"
          },
          {
            "name": "rewardRatePerSecond",
            "type": "u64"
          },
          {
            "name": "totalStaked",
            "type": "u64"
          },
          {
            "name": "rewardPerToken",
            "type": "u128"
          },
          {
            "name": "lastUpdateTimestamp",
            "type": "i64"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "frozen",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "stakingVaultBump",
            "type": "u8"
          },
          {
            "name": "rewardVaultBump",
            "type": "u8"
          },
          {
            "name": "nftCollection",
            "type": "pubkey"
          },
          {
            "name": "nftBoostBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "PoolBoostUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "collection",
            "type": "pubkey"
          },
          {
            "name": "boostBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "PoolCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "poolId",
            "type": "u64"
          },
          {
            "name": "stakingMint",
            "type": "pubkey"
          },
          {
            "name": "rewardMint",
            "type": "pubkey"
          },
          {
            "name": "lockDuration",
            "type": "i64"
          },
          {
            "name": "rewardRatePerSecond",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "PoolStatusChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "frozen",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "RewardsClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "totalClaimed",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "RewardsFunded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "funder",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "Staked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "totalStaked",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "Unstaked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "remainingStaked",
            "type": "u64"
          },
          {
            "name": "totalStaked",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "UserPosition",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "lockedUntil",
            "type": "i64"
          },
          {
            "name": "rewardDebt",
            "type": "u128"
          },
          {
            "name": "accruedRewards",
            "type": "u64"
          },
          {
            "name": "totalClaimed",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "nftBoostBps",
            "type": "u16"
          }
        ]
      }
    }
  ]
};
