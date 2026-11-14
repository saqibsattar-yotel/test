import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadEnvFiles } from "./lib/env";
import { parseAllowedOrigins } from "./lib/origin-guard";

/** Repository root: both src/config.ts and dist/server.js sit at depth apps/server/<dir>/. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Env files are read from the repository root whatever the working directory is (the dev script runs
 * from apps/server). Real environment variables win, then .env.local, then .env.
 */
export const loadedEnvFiles = loadEnvFiles(repoRoot);

const schema = z.object({
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default("127.0.0.1"),
  DATA_DIR: z.string().default("./data"),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  TWELVEDATA_API_KEY: z.string().optional().default(""),
  FRED_API_KEY: z.string().optional().default(""),
  CALENDAR_FF_FEED: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
  DEMO_MODE: z.enum(["auto", "force", "off"]).default("auto"),
  ALLOWED_ORIGINS: z.string().optional().default(""),
  LOG_LEVEL: z.string().default("info"),
});

const parsed = schema.parse(process.env);

export const config = {
  ...parsed,
  dataDir: path.isAbsolute(parsed.DATA_DIR) ? parsed.DATA_DIR : path.resolve(repoRoot, parsed.DATA_DIR),
  webDist: path.resolve(repoRoot, "apps/web/dist"),
  hasAnthropic: parsed.ANTHROPIC_API_KEY.length > 0,
  hasTwelveData: parsed.TWELVEDATA_API_KEY.length > 0,
  hasFred: parsed.FRED_API_KEY.length > 0,
  /** Which browser origins and Host names may use the API (localhost always may). */
  originPolicy: parseAllowedOrigins(parsed.ALLOWED_ORIGINS, parsed.HOST),
};

export type AppConfig = typeof config;

/** Feature availability summary exposed to the UI (never includes key values). */
export function featureFlags() {
  return {
    ai: { enabled: config.hasAnthropic, model: config.hasAnthropic ? config.ANTHROPIC_MODEL : null, fallback: "rule-based explainer" },
    goldSpot: { provider: config.hasTwelveData ? "twelvedata+dukascopy+swissquote" : "dukascopy+swissquote", proxy: false },
    macro: { yields: config.hasFred ? "fred" : "treasury.gov", dollarIndex: "ice-formula-dukascopy+swissquote" },
    calendar: { officialSchedule: true, forexFactoryFeed: config.CALENDAR_FF_FEED },
    demoMode: config.DEMO_MODE,
  };
}
