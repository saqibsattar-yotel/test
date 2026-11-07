# Attribution

This project studies and adapts methodology from **tradermonty/claude-trading-skills**
(https://github.com/tradermonty/claude-trading-skills), released under the MIT License,
Copyright (c) 2026 TraderMonty. The MIT notice is reproduced below as required.

Nothing was copied verbatim; the concepts below were re-implemented in TypeScript for
crypto and gold markets. Where thresholds or weights were preserved they are noted.

| Reference skill | Where it lives here | What was kept / adapted |
|---|---|---|
| `crypto-regime-analyzer` | `packages/core/src/regime/crypto.ts` | The 6-component model, weights (25/20/15/15/15/10), every threshold table, proportional weight redistribution and the fail-closed UNKNOWN rule (≥4 components, ≥65% weight). Adapted: a BTC/alt-basket relative-strength proxy supplies dominance *direction* until 31 real dominance observations accumulate; the result is labelled when the proxy is used. |
| `position-sizer` / `futures-position-sizer` | `packages/core/src/risk/index.ts` | Fixed-fractional risk budget, floor-never-round-up quantity, multiplier/tick awareness, hard tick-grid rejection for exchange futures, `NO_TRADE` when the budget cannot afford one unit, static margin note for futures. Contract specs for GC (100 oz, 0.10 tick) and CME BTC (5 BTC, $5 tick) reuse the reference table's verified values (2026-07-17). Added: XAU CFD lots, micro contracts, perpetual leverage/liquidation estimate, account-currency conversion. |
| `pre-trade-discipline-gate` | `packages/core/src/risk/gate.ts` | GO / NO_GO / REVIEW_REQUIRED decision model, written-plan/stop/size checks, planned-vs-actual risk, revenge window, regime and circuit-breaker inputs. |
| `drawdown-circuit-breaker` | `packages/core/src/risk/gate.ts` | Default rules (daily −2% halt, 2 consecutive losers → 24h cooldown, weekly −5%, monthly −8%), strictest-state-wins ordering. Accounting zone is configurable (UTC default for 24/7 crypto). |
| `technical-analyst` | `packages/core/src/mtf`, `packages/core/src/structure` | Trend classification by HH/HL/LH/LL, S/R significance by touches and recency, MA alignment and slope, volume confirmation, scenario framing with explicit invalidation levels. Re-cast as a multi-timeframe engine for intraday-to-weekly data. |
| `trader-memory-core` / `signal-postmortem` | `packages/core/src/journal` | Journal lifecycle (open → closed), cumulative P&L and R-multiple, MAE/MFE fields, outcome classification (TRUE/FALSE_POSITIVE, NEUTRAL, REGIME_MISMATCH), performance summary. |
| `data-quality-checker` | `packages/core/src/quality` | Fail-closed validation of candle series (monotonic time, OHLC consistency, non-finite values, gaps, staleness) before any analysis runs. |

## Other third-party components

- **lightweight-charts** (TradingView, Apache License 2.0) — candlestick and indicator rendering.
- **Recharts** (MIT) — performance charts.
- **Fastify**, **React**, **Vite**, **Tailwind CSS**, **TanStack Query**, **Zustand**, **Zod**, **fast-xml-parser**, **lucide-react** — MIT.
- **@anthropic-ai/sdk** (MIT) — optional narrative generation.

## Data sources

Binance public market data, CoinGecko free API, alternative.me Fear & Greed, US Treasury
daily yield-curve feeds, ECB reference rates via Frankfurter, Forex Factory weekly
calendar feed, publisher RSS feeds, and optionally Twelve Data, FRED and the Anthropic API.
Each payload in the UI names its provider and timestamp. Check each provider's terms for
your own deployment.

## MIT License notice for tradermonty/claude-trading-skills

MIT License

Copyright (c) 2026 TraderMonty

Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
