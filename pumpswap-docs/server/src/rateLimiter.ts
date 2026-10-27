import { config } from "./config";
import type { RateLimitState, ServerConfig } from "./types";

export class RateLimiter {
  private state: Map<string, RateLimitState>;
  private windowMs: number;
  private maxRequests: number;

  constructor(config: ServerConfig) {
    this.state = new Map();
    this.windowMs = config.rateLimitWindowMs;
    this.maxRequests = config.rateLimitMaxRequests;
  }

  isAllowed(key: string): { allowed: boolean; remaining: number; resetTime: number } {
    const now = Date.now();
    const existing = this.state.get(key);

    if (!existing || now - existing.windowStart > this.windowMs) {
      this.state.set(key, {
        count: 1,
        windowStart: now,
        lastReset: now,
      });
      return { allowed: true, remaining: this.maxRequests - 1, resetTime: now + this.windowMs };
    }

    if (existing.count >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetTime: existing.windowStart + this.windowMs,
      };
    }

    existing.count++;
    return {
      allowed: true,
      remaining: this.maxRequests - existing.count,
      resetTime: existing.windowStart + this.windowMs,
    };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, state] of this.state.entries()) {
      if (now - state.windowStart > this.windowMs) {
        this.state.delete(key);
      }
    }
  }

  reset(key: string): void {
    this.state.delete(key);
  }
}

export const rateLimiter = new RateLimiter(config);