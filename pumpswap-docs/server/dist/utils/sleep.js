"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withRetry = void 0;
exports.sleep = sleep;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
const withRetry = async (fn, options = {}) => {
    const { maxRetries = 3, baseDelayMs = 1000, maxDelayMs = 30000, backoffFactor = 2, } = options;
    let lastError;
    let delay = baseDelayMs;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastError = err;
            if (attempt === maxRetries)
                break;
            await sleep(delay);
            delay = Math.min(delay * backoffFactor, maxDelayMs);
        }
    }
    throw lastError;
};
exports.withRetry = withRetry;
//# sourceMappingURL=sleep.js.map