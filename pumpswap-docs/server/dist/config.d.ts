import type { ConfigValidationError, ServerConfig } from "./types";
export declare const REQUIRED_ENV_VARS: readonly ["GEMINI_API_KEY", "GEMINI_EMBED_MODEL", "INDEX_PATH"];
export type EnvVarName = (typeof REQUIRED_ENV_VARS)[number];
export declare function validateConfig(): ConfigValidationError | null;
export declare function getConfig(): ServerConfig;
export declare const config: ServerConfig;
//# sourceMappingURL=config.d.ts.map