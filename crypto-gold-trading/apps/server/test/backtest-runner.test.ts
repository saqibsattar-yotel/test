import { describe, it, expect } from "vitest";
import { demoCandles, runBacktest } from "@terminal/core";
import { resolveWorkerFile, runBacktestInWorker, type BacktestRunConfig } from "../src/lib/backtest-runner";

const candles = demoCandles("BTCUSD", "4h", 500, Date.UTC(2026, 0, 1));
const cfg: BacktestRunConfig = { assetId: "BTCUSD", timeframe: "4h", stepBars: 4, warmupBars: 150 };
const comparable = <T extends { durationMs: number }>(r: T) => ({ ...r, durationMs: 0 });

describe("backtest runner", () => {
  it("bundles the TypeScript worker for development and runs it in a worker thread", async () => {
    const file = await resolveWorkerFile();
    expect(file.endsWith("backtest-worker.mjs")).toBe(true); // running from sources → esbuild bundle, not a .ts entry
    const result = await runBacktestInWorker(candles, cfg);
    expect(result.bars).toBe(500);
    expect(result.config.assetId).toBe("BTCUSD");
    expect(result.all.trades).toBe(result.trades.length);
    // The worker must produce exactly what the engine produces in-process.
    expect(comparable(result)).toEqual(comparable(runBacktest(candles, cfg)));
  }, 60_000);

  it("falls back to the main thread when the worker cannot be started", async () => {
    const viaMissingFile = await runBacktestInWorker(candles, cfg, { workerFile: async () => "/nonexistent/backtest-worker.mjs" });
    expect(viaMissingFile.bars).toBe(500);
    const viaFailedBuild = await runBacktestInWorker(candles, cfg, {
      workerFile: async () => {
        throw new Error("build failed");
      },
    });
    expect(comparable(viaFailedBuild)).toEqual(comparable(viaMissingFile));
  }, 60_000);

  it("queues runs beyond the concurrency limit and completes all of them", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => runBacktestInWorker(candles, cfg)));
    expect(results).toHaveLength(5);
    expect(new Set(results.map((r) => r.trades.length)).size).toBe(1);
  }, 120_000);
});
