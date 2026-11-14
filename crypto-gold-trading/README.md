# Aurum Terminal — Crypto, Gold & Silver Trading Intelligence

A research and decision-support terminal for **spot gold (XAU/USD), spot silver (XAG/USD) and
every cryptocurrency with a Binance USDT spot market (≈500 coins, from BTC and ETH to POL, ENA,
SUI, HYPE…)**: live
market data with provenance, multi-timeframe technical analysis,
transparent regime scoring, structured AI trade plans (entry · stop · TP1/2/3 · quality
score · NO TRADE), deterministic position sizing with real contract specifications, an
economic calendar from official schedules, news intelligence, a trade journal and
performance analytics.

It is **not** a signal service and it **never executes trades**. Quality scores are
methodology assessments, not probabilities of profit.

Architecture and risk methodology are adapted from
[tradermonty/claude-trading-skills](https://github.com/tradermonty/claude-trading-skills)
(MIT) — see [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md).

## Quick start

Requires Node.js 20 or newer (`nvm use` picks it up from `.nvmrc`). Nothing else: no database, no
API keys, no `.env` needed. A fresh clone runs on macOS, Linux and Windows with:

```bash
npm install
cp .env.example .env        # optional keys; everything runs keyless
npm run dev                 # server on :8787, web on :5173 (proxied)
```

Open http://localhost:5173. First run shows a short guided setup.

First start on a new computer: crypto is live within seconds. Spot gold and silver history is
downloaded once in the background from a public archive (usually well under a minute). The app stays
fully usable meanwhile, shows a "First start on this computer" notice with progress until both metals
are ready, and fills the gold and silver panels in as each part arrives (prices and intraday charts
first, gold before silver). The dollar-index history follows quietly afterwards; until it is there the
dollar index shows its live value and uses ECB reference rates for history. Everything is cached under
`data/cache/`, so later starts are instant.

An installation that was set up before silver was added downloads the silver history once on its next
start, and gets XAG/USD next to XAU/USD in the followed assets and the watchlist (once; removing it
afterwards sticks).

The archive limits how much one internet connection may download. If it refuses or drops downloads,
the app does not hammer it: a failed file is retried after 30 seconds, then 1, 2, 4, 8 and at most
10 minutes; a burst of failures pauses all downloads for a while and halves the pace afterwards. The
terminal shows a line or two about it, not one per file. Gold or silver history that still has gaps
after a few minutes is shown flagged, and trade setups for that metal are withheld until it is
complete. If none of it could be downloaded at all, the metal's charts and analysis say "unavailable"
with the reason (never a demo chart), its live price keeps working, and everything fills in by itself
when the archive answers. With a `TWELVEDATA_API_KEY` gold and silver quotes and charts come from Twelve Data first
(when the key's plan covers the symbol) and do not wait for the archive.

Development notes:

- `.env` is read from the repository root in every mode (`npm run dev`, `npm start`, tests). An
  optional, git-ignored `.env.local` overrides it, and real environment variables override both.
  The server logs which files it loaded (`environment: .env …`).
- Saving `.env` restarts the API automatically; the Vite proxy follows `PORT` / `HOST` from it.
- Vite is ready before the API. Requests to `/api` made while the API is starting or restarting are
  held until it is up (20 s budget, then a clear 503) instead of failing with proxy errors, and the
  live-quote WebSocket connects only once the API answers.

Production build:

```bash
npm run build               # builds the web app and bundles the server
npm start                   # serves API + UI on http://127.0.0.1:8787
```

Tests and typecheck:

```bash
npm test
npm run typecheck
```

## Asset universe

The server builds a live registry from Binance's tradable USDT spot pairs (fiat, stablecoin
and leveraged products excluded) enriched with CoinGecko names, ranks and market caps, plus
spot gold (XAU/USD) and spot silver (XAG/USD). Any asset can be searched from the command
palette (`⌘K`) or the asset pickers on the Crypto, Technical, Setups, Journal, Risk, Alerts,
Watchlist and Settings screens; the server validates ids against the registry (unknown ids
return 404, never demo data) and streams quotes for whatever is opened. A curated core set
(BTC, ETH, SOL, BNB, XRP, ADA, DOGE, AVAX, LINK, XAU, XAG) carries hand-tuned metadata and
anchors the regime models.

Gold and silver are treated alike everywhere: each has its own analysis page, posture score,
price verification, contract specifications and journal class. They are the genuine spot
metals, never a token, an ETF or a futures contract standing in for them.

## What runs without any key

| Feature | Source |
|---|---|
| Asset universe (≈500 coins) | Binance exchangeInfo + CoinGecko top-250 (names, ranks) |
| Crypto prices, candles, 24h stats | Binance public API + WebSocket (Bybit / Coinbase fallback) |
| Funding, open interest, long/short, liquidations | Binance USDⓈ-M public endpoints and force-order stream |
| Market cap, BTC dominance, top coins | CoinGecko free API |
| Fear & Greed | alternative.me |
| Spot gold (XAU/USD) and spot silver (XAG/USD) quotes & history | **Dukascopy historical archive** (bid candles, minute → daily) + **Swissquote public BBO** live sampling; cross-checked against gold-api.com on the Gold and Silver pages. PAXG is listed separately as tokenised gold and is never used for XAU/USD, and nothing stands in for XAG/USD; COMEX GC/MGC and SI/SIL are specs-only (no keyless live feed) |
| Gold/silver ratio | The two spot quotes divided (XAU/USD ÷ XAG/USD), with its place in the last year of daily closes from the same archive |
| Treasury yields, real yields | home.treasury.gov daily XML feeds |
| US Dollar Index | **ICE formula on the six constituent FX rates** — Swissquote live quotes now, Dukascopy FX archives for history (labelled "computed, not the ICE print"); ECB-fixing version kept as a daily cross-check |
| Economic calendar | Fed / BLS / BEA published schedules (`data/official-schedule.json`) + Forex Factory weekly feed for forecast/previous |
| News | Publisher RSS feeds |
| AI narratives | Deterministic rule-based explainer, labelled as such |

## Optional keys (`.env`)

| Variable | Unlocks |
|---|---|
| `TWELVEDATA_API_KEY` | Twelve Data becomes the primary XAU/USD and XAG/USD source and an extra verification input (Dukascopy + Swissquote stay as fallback, also for a symbol the key's plan does not include). Free key: register at [twelvedata.com/register](https://twelvedata.com/register), then copy it from the API keys page |
| `FRED_API_KEY` | FRED DGS10 / DGS2 / DFII10 and the broad dollar index. Free key: sign in at [fredaccount.stlouisfed.org/apikeys](https://fredaccount.stlouisfed.org/apikeys) and request one |
| `ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL`, default `claude-opus-5-5`) | Claude-written narratives from the computed fact sheet, with numeric grounding checks |
| `CALENDAR_FF_FEED=false` | Disable the Forex Factory feed |
| `ALLOWED_ORIGINS` | Extra browser origins allowed to call the API, comma-separated (for a LAN device, custom hostname or reverse proxy). Pages served from this machine are always allowed; every other website is refused |
| `DEMO_MODE=auto\|force\|off` | `auto` falls back to labelled demo data for a coin only when all its providers fail; gold and silver are never replaced by demo data in this mode (missing history is reported as unavailable). `force` shows demo data for everything; `off` never does |

Keys stay on the server; the browser only ever sees `/api/features` flags.

## Sections

Overview · Crypto Analysis · Gold Analysis (spot vs futures vs tokenised, price verification,
dollar index) · Silver Analysis (the same workspace on spot XAG/USD: spot vs futures, price
verification, the gold/silver ratio, dollar index) · AI Trade Setups (live plans with indicator
contributions, MTF confirmation, evidence sufficiency and data status; Monitoring and History
tabs that follow entry, stop and TP1–TP3 against live prices — levels only, no orders) ·
Technical Analysis · Market Intelligence (crypto, gold, silver & macro, calendar, news) · Risk
Calculator (spot, perps, XAU and XAG CFD lots, COMEX GC/MGC and SI/SIL, CME BTC/MBT; discipline
gate; circuit breaker) · Trade Journal · Performance Analytics (crypto, gold and silver
side by side) · Backtesting (walk-forward, fees/slippage, in-sample vs out-of-sample) · Settings.

Keyboard: `g` then a letter jumps between sections, `⌘K` opens the command palette, `t`
toggles the theme, `a` opens alerts, `?` lists shortcuts.

## Honesty rules baked in

- Every live-data panel shows provider, quality (live / delayed / stale / closed / proxy /
  DEMO) and the data timestamp.
- Setups separate **calculated facts** (contributions, levels, MTF agreement, data freshness)
  from **AI interpretation**; actionable LONG/SHORT requires sufficient evidence and
  multi-timeframe confirmation, otherwise the status is WAIT or NO TRADE.
- Monitoring and backtesting never claim an execution: "entry reached" means the price
  traded through a level, nothing more.
- Stale candles ⇒ NO TRADE. Sparse regime inputs ⇒ UNKNOWN. Unaffordable size ⇒ NO_TRADE
  with the full math shown.
- Forecasts and actuals appear only when a provider supplies them — never estimated.
- Margin is an estimate for CFDs/perps and is deliberately not computed for exchange futures.
- The LLM cannot introduce a number that is not in the verified fact sheet.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module layout and data flow, and
[docs/LIMITATIONS.md](docs/LIMITATIONS.md) for the maintained list of known approximations.

## Disclaimer

Educational and research use only. Not financial advice. Trading involves risk, including
loss of principal. All decisions remain yours.
