/**
 * Runs backtests off the main event loop so WebSocket quotes, monitors and API requests keep flowing
 * while a long walk-forward simulation runs.
 *
 *  - Production: the worker is a sibling bundle (dist/workers/backtest-worker.js).
 *  - Development (tsx): worker threads do not get the TypeScript loader (a `.ts` entry fails with
 *    ERR_UNKNOWN_FILE_EXTENSION), so the worker is bundled once per process with esbuild into
 *    node_modules/.cache and started from there.
 *  - If a worker cannot be started at all, the backtest runs on the main thread instead of failing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { runBacktest, type AssetId, type BacktestConfig, type BacktestResult, type Candle, type Timeframe } from "@terminal/core";
import { repoRoot } from "../config";
import { logger } from "./logger";

const log = logger("backtest");

export type BacktestRunConfig = Partial<BacktestConfig> & { assetId: AssetId; timeframe: Timeframe };

const MAX_CONCURRENT = 2;
const TIMEOUT_MS = 180_000;
let running = 0;
const queue: (() => void)[] = [];
let devWorker: Promise<string> | null = null;
let warnedInline = false;

/** The worker module could not be loaded or died before reporting a result. */
class WorkerStartError extends Error {}

export async function resolveWorkerFile(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.join(here, "workers", "backtest-worker.js");
  if (fs.existsSync(bundled)) return bundled;
  if (!devWorker) {
    devWorker = (async () => {
      const entry = path.join(here, "..", "workers", "backtest-worker.ts");
      if (!fs.existsSync(entry)) throw new Error("backtest worker entry not found; run the build");
      const outfile = path.join(repoRoot, "node_modules", ".cache", "terminal", "backtest-worker.mjs");
      const { build } = await import("esbuild");
      await build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: "node",
        target: "node20",
        format: "esm",
        packages: "external",
        alias: { "@terminal/core": path.join(repoRoot, "packages", "core", "src", "index.ts") },
        logLevel: "silent",
      });
      return outfile;
    })();
    // A failed build must not be cached: the next backtest tries again.
    devWorker.catch(() => {
      devWorker = null;
    });
  }
  return devWorker;
}

function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) =>
    queue.push(() => {
      running++;
      resolve();
    }),
  );
}

function release() {
  running--;
  queue.shift()?.();
}

function runInWorker(file: string, candles: Candle[], config: BacktestRunConfig): Promise<BacktestResult> {
  return new Promise<BacktestResult>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(file, { workerData: { candles, config } });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`Backtest exceeded ${TIMEOUT_MS / 1000}s and was stopped; reduce bars or raise the signal step.`))), TIMEOUT_MS);
    worker.once("message", (msg: { ok: boolean; result?: BacktestResult; error?: string }) => finish(() => (msg.ok && msg.result ? resolve(msg.result) : reject(new Error(msg.error ?? "backtest failed")))));
    worker.once("error", (err) => finish(() => reject(new WorkerStartError(err.message))));
    worker.once("exit", (code) => {
      if (code !== 0) finish(() => reject(new WorkerStartError(`backtest worker exited with code ${code}`)));
    });
  });
}

function runInline(candles: Candle[], config: BacktestRunConfig, cause: unknown): BacktestResult {
  if (!warnedInline) {
    warnedInline = true;
    log.warn(`worker thread unavailable (${(cause as Error)?.message ?? cause}); running backtests on the main thread`);
  }
  return runBacktest(candles, config);
}

/** Run a backtest in a worker thread (bounded concurrency, hard timeout, main-thread fallback). */
export async function runBacktestInWorker(candles: Candle[], config: BacktestRunConfig, opts: { workerFile?: () => Promise<string> } = {}): Promise<BacktestResult> {
  await acquire();
  try {
    let file: string;
    try {
      file = await (opts.workerFile ?? resolveWorkerFile)();
    } catch (err) {
      return runInline(candles, config, err);
    }
    try {
      return await runInWorker(file, candles, config);
    } catch (err) {
      if (err instanceof WorkerStartError) return runInline(candles, config, err);
      throw err;
    }
  } finally {
    release();
  }
}
