import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { AssetId, BacktestConfig, BacktestResult, Candle, Timeframe } from "@terminal/core";

const MAX_CONCURRENT = 2;
const TIMEOUT_MS = 180_000;
let running = 0;
const queue: (() => void)[] = [];

function workerFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Production bundle: dist/server.js + dist/workers/backtest-worker.js. Dev (tsx): src/lib → src/workers/*.ts.
  const candidates = [path.join(here, "workers", "backtest-worker.js"), path.join(here, "..", "workers", "backtest-worker.ts")];
  const found = candidates.find((f) => fs.existsSync(f));
  if (!found) throw new Error("backtest worker entry not found; run the build");
  return found;
}

/** Run a backtest in a worker thread (bounded concurrency, hard timeout). */
export function runBacktestInWorker(candles: Candle[], config: Partial<BacktestConfig> & { assetId: AssetId; timeframe: Timeframe }): Promise<BacktestResult> {
  return new Promise<BacktestResult>((resolve, reject) => {
    const start = () => {
      running++;
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        running--;
        clearTimeout(timer);
        fn();
        queue.shift()?.();
      };
      let worker: Worker;
      try {
        worker = new Worker(workerFile(), { workerData: { candles, config } });
      } catch (err) {
        done(() => reject(err as Error));
        return;
      }
      const timer = setTimeout(() => {
        void worker.terminate();
        done(() => reject(new Error(`Backtest exceeded ${TIMEOUT_MS / 1000}s and was stopped; reduce bars or raise the signal step.`)));
      }, TIMEOUT_MS);
      worker.once("message", (msg: { ok: boolean; result?: BacktestResult; error?: string }) => {
        done(() => (msg.ok && msg.result ? resolve(msg.result) : reject(new Error(msg.error ?? "backtest failed"))));
        void worker.terminate();
      });
      worker.once("error", (err) => done(() => reject(err)));
      worker.once("exit", (code) => {
        if (code !== 0) done(() => reject(new Error(`backtest worker exited with code ${code}`)));
      });
    };
    if (running < MAX_CONCURRENT) start();
    else queue.push(start);
  });
}
