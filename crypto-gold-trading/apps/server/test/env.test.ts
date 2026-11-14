import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFiles } from "../src/lib/env";

describe("root env loading", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-env-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads .env from the given root regardless of the working directory", () => {
    fs.writeFileSync(path.join(dir, ".env"), "PORT=9001\nTWELVEDATA_API_KEY=abc # trailing comment\nEMPTY=\n");
    const target: NodeJS.ProcessEnv = {};
    expect(process.cwd()).not.toBe(dir);
    expect(loadEnvFiles(dir, target)).toEqual([".env"]);
    expect(target.PORT).toBe("9001");
    expect(target.TWELVEDATA_API_KEY).toBe("abc");
    expect(target.EMPTY).toBe("");
  });

  it(".env.local overrides .env, and real environment variables override both", () => {
    fs.writeFileSync(path.join(dir, ".env"), "PORT=9001\nHOST=127.0.0.1\nDEMO_MODE=auto\n");
    fs.writeFileSync(path.join(dir, ".env.local"), "PORT=9002\nDEMO_MODE=off\n");
    const target: NodeJS.ProcessEnv = { DEMO_MODE: "force" };
    expect(loadEnvFiles(dir, target)).toEqual([".env.local", ".env"]);
    expect(target.PORT).toBe("9002"); // .env.local wins over .env
    expect(target.HOST).toBe("127.0.0.1"); // only in .env
    expect(target.DEMO_MODE).toBe("force"); // already set → untouched
  });

  it("returns an empty list (and changes nothing) when no env file exists", () => {
    const target: NodeJS.ProcessEnv = { KEEP: "1" };
    expect(loadEnvFiles(dir, target)).toEqual([]);
    expect(target).toEqual({ KEEP: "1" });
  });
});
