/**
 * Loads environment files from an explicit directory (the repository root) instead of the working
 * directory. `npm run dev` starts the server with cwd = apps/server, so a cwd-relative lookup
 * (`import "dotenv/config"`) silently skipped the root .env in development.
 *
 * Precedence, highest first: real environment variables > .env.local > .env.
 * A variable that is already set is never overridden.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

/** Files read from the root, highest priority first. */
export const ENV_FILES = [".env.local", ".env"] as const;

/** Loads the env files found in `root` into `target` and returns the names that were loaded. */
export function loadEnvFiles(root: string, target: NodeJS.ProcessEnv = process.env): string[] {
  const loaded: string[] = [];
  for (const name of ENV_FILES) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const result = dotenv.config({ path: file, processEnv: target as Record<string, string> });
    if (!result.error) loaded.push(name);
  }
  return loaded;
}
