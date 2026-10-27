import type { ServerConfig } from "./types";
export declare class RateLimiter {
    private state;
    private windowMs;
    private maxRequests;
    constructor(config: ServerConfig);
    isAllowed(key: string): {
        allowed: boolean;
        remaining: number;
        resetTime: number;
    };
    cleanup(): void;
    reset(key: string): void;
}
export declare const rateLimiter: RateLimiter;
//# sourceMappingURL=rateLimiter.d.ts.map