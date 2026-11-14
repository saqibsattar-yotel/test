# Architecture

```
crypto-gold-trading/
├─ packages/core/          Pure TypeScript analytics — no I/O, fully unit-tested
│  ├─ indicators/          SMA, EMA, RSI, MACD, Bollinger, ATR, VWAP, ADX, OBV, volume stats
│  ├─ structure/           swings, HH/HL/LH/LL, breakouts, S/R clustering, Fibonacci,
│  │                       liquidity zones, previous day/week levels, session ranges
│  ├─ quality/             candle/quote validation (fail closed)
│  ├─ regime/              crypto regime (ported) · macro-technical posture of a precious metal
│  │                       (one composite, scored separately for gold and for silver)
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
│  │                       Dukascopy archive (.bi5 → candles; paced downloads with per-file
│  │                       backoff, a pause-and-recover breaker and progress counts),
│  │                       Swissquote BBO (XAU, XAG + FX),
│  │                       gold-api.com (gold and silver verification), Treasury.gov, Frankfurter,
│  │                       FRED, calendar, RSS news
│  ├─ services/            market (unified interface + fallback chains + cache + demo),
│  │                       metals (spot XAU/USD and XAG/USD through one code path: archive series,
│  │                       live sampler, first-start download plan, verification, gold/silver
│  │                       ratio; plus the computed DXY),
│  │                       monitor (tracks saved setups against hub quotes, alerts, history),
│  │                       assets (live universe: Binance pairs + CoinGecko enrichment, search),
│  │                       analysis (wires core engines to data), ai (Claude + grounding),
│  │                       liquidations (force-order stream), alerts, user state
│  ├─ lib/                 warming (bounded waits: "still downloading" is answered in seconds and
│  │                       never replaced by demo data), env (root .env / .env.local loader),
│  │                       origin guard (local pages only:
│  │                       Host allowlist, Origin check, ALLOWED_ORIGINS), cache, http, logger, JSON store,
│  │                       backtest runner (worker thread; bundled with esbuild in dev, where
│  │                       tsx cannot load a TypeScript worker; main-thread fallback)
│  ├─ routes/              /api/* endpoints
│  └─ ws/                  /ws hub: Binance miniTicker fan-out, polled spot gold and silver,
│                          alerts, monitor events, status
└─ apps/web/               React 18 + Vite + Tailwind terminal UI
   ├─ dev/                 Vite dev plugin: holds /api until the API server is up, follows
   │                       PORT/HOST from the root env files, one-line proxy disconnect logs
   ├─ components/          ui kit, charts (lightweight-charts, recharts, SVG), layout, setups,
   │                       metals (the one workspace that both the Gold and the Silver page render)
   └─ pages/               Overview, Crypto, Gold, Silver, Setups (live / monitoring / history),
                           Technical, Intelligence, Risk, Journal, Performance, Backtest,
                           Settings
```

## Precious metals

Gold and silver are one feature with two instances, not two features. `METALS` in
`packages/core/src/types.ts` describes each (asset id, pair, code, standard lot); everything
else is keyed by it:

- **Data**: `services/metals.ts` builds every series, quote and verification for a `MetalId`.
  The archive downloader gives the metals priority over the dollar-index FX files, orders them
  by kind of file (prices and intraday charts, then hourly, then daily history) with gold ahead
  of silver inside each kind, and reports progress per metal.
- **API**: the same endpoints exist under both names, registered in a loop
  (`/api/market/{gold,silver}/verification`, `/api/market/{gold,silver}/instruments`,
  `/api/regime/{gold,silver}`), plus `/api/market/metals/ratio`.
- **Analysis**: `analyzeMetalRegime` scores the same five components on the metal's own daily
  prices; contract specifications, sizing preference (CFD lots) and session handling follow from
  `isMetalAsset` / `isMetalClass`.
- **UI**: `components/metals/MetalWorkspace.tsx` is the page; `pages/Gold.tsx` and
  `pages/Silver.tsx` only pass the metal. `lib/metals.ts` holds routes, names and colours.

Adding a third metal means one more entry in `METALS` (and its price scale in the archive
provider), not a third copy of anything.

## Principles

1. **Deterministic numbers, interpretive words.** Every price, level, indicator, score and
   size is computed in `packages/core` from provider data. The optional LLM only receives a
   fact sheet and its output is checked: any number not present in the facts triggers a
   retry and then a fallback to the rule-based explainer.
2. **Provenance everywhere.** Every payload carries a `DataSource` (provider, label,
   fetchedAt, asOf, quality ∈ live/delayed/stale/closed/proxy/demo/unavailable, proxy flag,
   note). The UI shows it on each card; stale and proxy data are flagged; demo data is loud;
   `closed` marks the weekend/session close of spot gold, spot silver and FX.
3. **Fail closed.** Candle series that fail validation produce NO TRADE; sparse regime
   inputs produce UNKNOWN; sizing that cannot afford one unit returns NO_TRADE with the
   full math; unknown gate inputs return REVIEW_REQUIRED.
4. **Provider independence.** `MarketDataService` exposes `getCandles/getQuotes/getFunding/
   getOpenInterest/getGlobal/getMacro`; providers implement small interfaces and are tried in
   order. Swapping or adding a provider does not touch analytics or UI.
5. **No execution.** There are no order buttons and no broker integration by design.
6. **Open universe, closed validation.** Asset ids are canonical `<BASE>USD` strings. The
   registry (`services/assets.ts`) decides what is supported; core metadata is curated for
   eleven assets (nine coins, gold and silver) and derived (precision, round-number step) from
   price for the rest.
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
`user.json` records one-time migrations it has received (`migrations`): a file written before
silver existed gets XAG/USD next to XAU/USD once, at server start.

## Testing

`npm test` runs Vitest across packages: indicator math against textbook values, structure
detection, DST-correct timezone conversion, data-quality failures, regime scoring (bull /
bear / sparse; gold and silver), sizing for spot, perp, gold and silver CFD lots, GC/MGC,
SI/SIL and CME BTC in several account currencies, gate and circuit breaker, journal
statistics, setup geometry invariants over many synthetic series, AI grounding, calendar
merge, RSS parsing, cache semantics, decoding of real archive files for both metals, the
archive downloader's backoff and ordering, first-start and gap behaviour, and the settings
migration.
