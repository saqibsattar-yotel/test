# Aurum Terminal — Crypto & Gold Trading Intelligence

A research and decision-support terminal for **XAU/USD and every cryptocurrency with a
Binance USDT spot market (≈500 coins, from BTC and ETH to POL, ENA, SUI, HYPE…)**: live
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

```bash
npm install
cp .env.example .env        # optional keys; everything runs keyless
npm run dev                 # server on :8787, web on :5173 (proxied)
```

Open http://localhost:5173. First run shows a short guided setup.

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
XAU/USD. Any asset can be searched from the command palette (`⌘K`) or the asset pickers on
the Crypto, Technical, Setups, Journal, Risk, Alerts, Watchlist and Settings screens; the
server validates ids against the registry (unknown ids return 404, never demo data) and
streams quotes for whatever is opened. A curated core set (BTC, ETH, SOL, BNB, XRP, ADA,
DOGE, AVAX, LINK, XAU) carries hand-tuned metadata and anchors the regime model.

## What runs without any key

| Feature | Source |
|---|---|
| Asset universe (≈500 coins) | Binance exchangeInfo + CoinGecko top-250 (names, ranks) |
| Crypto prices, candles, 24h stats | Binance public API + WebSocket (Bybit / Coinbase fallback) |
| Funding, open interest, long/short, liquidations | Binance USDⓈ-M public endpoints and force-order stream |
| Market cap, BTC dominance, top coins | CoinGecko free API |
| Fear & Greed | alternative.me |
| Spot gold (XAU/USD) quotes & history | **Dukascopy historical archive** (bid candles, minute → daily) + **Swissquote public BBO** live sampling; cross-checked against gold-api.com on the Gold page. PAXG is listed separately as tokenised gold and is never used for XAU/USD; COMEX GC/MGC are specs-only (no keyless live feed) |
| Treasury yields, real yields | home.treasury.gov daily XML feeds |
| US Dollar Index | **ICE formula on the six constituent FX rates** — Swissquote live quotes now, Dukascopy FX archives for history (labelled "computed, not the ICE print"); ECB-fixing version kept as a daily cross-check |
| Economic calendar | Fed / BLS / BEA published schedules (`data/official-schedule.json`) + Forex Factory weekly feed for forecast/previous |
| News | Publisher RSS feeds |
| AI narratives | Deterministic rule-based explainer, labelled as such |

## Optional keys (`.env`)

| Variable | Unlocks |
|---|---|
| `TWELVEDATA_API_KEY` | Twelve Data becomes the primary XAU/USD source and an extra verification input (Dukascopy + Swissquote stay as fallback) |
| `FRED_API_KEY` | FRED DGS10 / DGS2 / DFII10 and the broad dollar index |
| `ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL`, default `claude-opus-5-5`) | Claude-written narratives from the computed fact sheet, with numeric grounding checks |
| `CALENDAR_FF_FEED=false` | Disable the Forex Factory feed |
| `DEMO_MODE=auto\|force\|off` | `auto` falls back to labelled demo data only when all providers fail |

Keys stay on the server; the browser only ever sees `/api/features` flags.

## Sections

Overview · Crypto Analysis · Gold Analysis (spot vs futures vs tokenised, price verification,
dollar index) · AI Trade Setups (live plans with indicator contributions, MTF confirmation,
evidence sufficiency and data status; Monitoring and History tabs that follow entry, stop and
TP1–TP3 against live prices — levels only, no orders) · Technical Analysis · Market
Intelligence (crypto, gold & macro, calendar, news) · Risk Calculator (spot, perps, XAU CFD
lots, GC/MGC, CME BTC/MBT; discipline gate; circuit breaker) · Trade Journal · Performance
Analytics · Backtesting (walk-forward, fees/slippage, in-sample vs out-of-sample) · Settings.

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
