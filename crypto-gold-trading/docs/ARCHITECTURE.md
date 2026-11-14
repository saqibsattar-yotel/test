# Architecture

```
crypto-gold-trading/
├─ packages/core/          Pure TypeScript analytics — no I/O, fully unit-tested
│  ├─ indicators/          SMA, EMA, RSI, MACD, Bollinger, ATR, VWAP, ADX, OBV, volume stats
│  ├─ structure/           swings, HH/HL/LH/LL, breakouts, S/R clustering, Fibonacci,
│  │                       liquidity zones, previous day/week levels, session ranges
│  ├─ quality/             candle/quote validation (fail closed)
│  ├─ regime/              crypto regime (ported) · gold macro-technical posture
│  ├─ mtf/                 multi-timeframe analyzer
│  ├─ setups/              deterministic trade-setup engine (entry, SL, TP1-3, score, status)
│  ├─ risk/                position sizing + instrument specs · discipline gate · circuit breaker
│  ├─ journal/             trade records, performance statistics, outcome classification
│  ├─ monitor/             level-monitoring state machine (entry, TP1–3, stop, expiry; events)
│  ├─ backtest/            walk-forward backtester (closed-bar signals, fees/slippage, IS/OOS)
│  ├─ calendar/            event model + relevance rules
│  ├─ explain/             rule-based narrative (LLM fallback and fact sheet)
│  └─ demo/                seeded synthetic data (always labelled DEMO)
├─ apps/server/            Fastify API + WebSocket hub (Node 20)
│  ├─ providers/           Binance, Bybit, Coinbase, CoinGecko, alternative.me, Twelve Data,
│  │                       Dukascopy archive (.bi5 → candles), Swissquote BBO (XAU + FX),
│  │                       gold-api.com (verification), Treasury.gov, Frankfurter, FRED,
│  │                       calendar, RSS news
│  ├─ services/            market (unified interface + fallback chains + cache + demo),
│  │                       gold (spot XAU/USD chain, live sampler, computed DXY, verification),
│  │                       monitor (tracks saved setups against hub quotes, alerts, history),
│  │                       assets (live universe: Binance pairs + CoinGecko enrichment, search),
│  │                       analysis (wires core engines to data), ai (Claude + grounding),
│  │                       liquidations (force-order stream), alerts, user state
│  ├─ lib/                 env (root .env / .env.local loader), origin guard (local pages only:
│  │                       Host allowlist, Origin check, ALLOWED_ORIGINS), cache, http, logger, JSON store,
│  │                       backtest runner (worker thread; bundled with esbuild in dev, where
│  │                       tsx cannot load a TypeScript worker; main-thread fallback)
│  ├─ routes/              /api/* endpoints
│  └─ ws/                  /ws hub: Binance miniTicker fan-out, polled spot gold, alerts,
│                          monitor events, status
└─ apps/web/               React 18 + Vite + Tailwind terminal UI
   ├─ dev/                 Vite dev plugin: holds /api until the API server is up, follows
   │                       PORT/HOST from the root env files, one-line proxy disconnect logs
   ├─ components/          ui kit, charts (lightweight-charts, recharts, SVG), layout, setups
   └─ pages/               Overview, Crypto, Gold, Setups (live / monitoring / history),
                           Technical, Intelligence, Risk, Journal, Performance, Backtest,
                           Settings
```

## Principles

1. **Deterministic numbers, interpretive words.** Every price, level, indicator, score and
   size is computed in `packages/core` from provider data. The optional LLM only receives a
   fact sheet and its output is checked: any number not present in the facts triggers a
   retry and then a fallback to the rule-based explainer.
2. **Provenance everywhere.** Every payload carries a `DataSource` (provider, label,
   fetchedAt, asOf, quality ∈ live/delayed/stale/closed/proxy/demo/unavailable, proxy flag,
   note). The UI shows it on each card; stale and proxy data are flagged; demo data is loud;
   `closed` marks the weekend/session close of spot gold and FX.
3. **Fail closed.** Candle series that fail validation produce NO TRADE; sparse regime
   inputs produce UNKNOWN; sizing that cannot afford one unit returns NO_TRADE with the
   full math; unknown gate inputs return REVIEW_REQUIRED.
4. **Provider independence.** `MarketDataService` exposes `getCandles/getQuotes/getFunding/
   getOpenInterest/getGlobal/getMacro`; providers implement small interfaces and are tried in
   order. Swapping or adding a provider does not touch analytics or UI.
5. **No execution.** There are no order buttons and no broker integration by design.
6. **Open universe, closed validation.** Asset ids are canonical `<BASE>USD` strings. The
   registry (`services/assets.ts`) decides what is supported; core metadata is curated for
   ten assets and derived (precision, round-number step) from price for the rest.
   `/api/assets?q=` powers every picker; the WebSocket hub subscribes to streams on demand
   (`ensureSubscribed`) and drops idle ones after two hours.

## Data flow

```
providers ──► MarketDataService (TTL cache, stale-while-error, demo fallback)
                     │
                     ▼
            analysis service ──► core engines (MTF, regime, setups, levels)
                     │                      │
                     ▼                      ▼
              /api routes ◄──── ai service (fact sheet → Claude → grounding check)
                     │
   WebSocket hub ◄───┘ (quotes, alerts, status)   ──►   React UI (TanStack Query + Zustand)
```

## Caching & rate limits

| Data | TTL | Notes |
|---|---|---|
| Candles | 30s (5m) … 1h (1w) | one request per asset/timeframe |
| Quotes (REST) | 5s | WebSocket stream is primary |
| Funding / OI | 60–120s | |
| CoinGecko global / markets | 3–5 min | free-tier friendly |
| Macro (Treasury, ECB, FRED) | 6h | daily series |
| Calendar | 1h | official schedule file + weekly feed |
| News | 10 min | |
| Regime / analysis / setups | 10 min / 45s / 60s | |
| AI narratives | 10–30 min per fact-sheet hash | |

## Persistence

JSON documents with atomic writes under `DATA_DIR` (default `./data`): `user.json`
(settings, watchlist, alerts, saved setups/analyses), `journal.json`,
`dominance-history.json`. `data/official-schedule.json` ships with verified release dates.

## Testing

`npm test` runs Vitest across packages: indicator math against textbook values, structure
detection, DST-correct timezone conversion, data-quality failures, regime scoring (bull /
bear / sparse), sizing for spot, perp, CFD lots, GC/MGC and CME BTC in several account
currencies, gate and circuit breaker, journal statistics, setup geometry invariants over
many synthetic series, AI grounding, calendar merge, RSS parsing, cache semantics.
