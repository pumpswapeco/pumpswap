export declare function sleep(ms: number): Promise<void>;
export declare const withRetry: <T>(fn: () => Promise<T>, options?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    backoffFactor?: number;
}) => Promise<T>;
//# sourceMappingURL=sleep.d.ts.map