"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateLimiter = exports.RateLimiter = void 0;
const config_1 = require("./config");
class RateLimiter {
    state;
    windowMs;
    maxRequests;
    constructor(config) {
        this.state = new Map();
        this.windowMs = config.rateLimitWindowMs;
        this.maxRequests = config.rateLimitMaxRequests;
    }
    isAllowed(key) {
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
    cleanup() {
        const now = Date.now();
        for (const [key, state] of this.state.entries()) {
            if (now - state.windowStart > this.windowMs) {
                this.state.delete(key);
            }
        }
    }
    reset(key) {
        this.state.delete(key);
    }
}
exports.RateLimiter = RateLimiter;
exports.rateLimiter = new RateLimiter(config_1.config);
//# sourceMappingURL=rateLimiter.js.map