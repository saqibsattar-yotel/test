/**
 * Worker-thread entry: runs a backtest off the main event loop so WebSocket quotes, monitors and
 * API requests keep flowing while a long walk-forward simulation runs.
 */
import { parentPort, workerData } from "node:worker_threads";
import { runBacktest, type AssetId, type BacktestConfig, type Candle, type Timeframe } from "@terminal/core";

const { candles, config } = workerData as { candles: Candle[]; config: Partial<BacktestConfig> & { assetId: AssetId; timeframe: Timeframe } };
try {
  const result = runBacktest(candles, config);
  parentPort?.postMessage({ ok: true, result });
} catch (err) {
  parentPort?.postMessage({ ok: false, error: (err as Error).message });
}
