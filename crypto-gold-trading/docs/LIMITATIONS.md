# Known limitations

Last reviewed: 2026-11-07. This file is the honest list of what the terminal does **not** do, or does
only approximately. Everything here is also surfaced in the UI next to the affected data.

## Market data

### Spot gold (XAU/USD)
- **Sources.** History comes from the Dukascopy historical archive (bid side, 1-minute / 1-hour / daily
  files, UTC-aligned). The current hour is sampled every 15 s from Swissquote's public best-bid/offer
  feed (prime profile, mid of bid/ask for quotes, bid for candles). Neither is an exchange: spot gold is
  an OTC market and every feed is one dealer's view. Quotes from different banks differ by a few cents.
- **Publication delay.** Dukascopy publishes a completed hour/day with a delay (minutes to about an
  hour). Until then the series relies on the live sampler, which only holds data collected since the
  server started (persisted to `data/live-candles.json`, 10-day window). After a restart there can be a
  short gap at the end of the intraday chart until the archive catches up.
- **Daily bars are UTC-midnight bars**, not the 17:00 New York spot close that many publishers use.
  Daily changes and "previous close" can therefore differ slightly from published figures.
- **Market hours** are modelled as Sunday 22:00 UTC → Friday 22:00 UTC (quality `closed` outside that
  window). Holidays are not modelled; on a holiday the feed simply stops producing fresh timestamps and
  the sampler records nothing (it never fabricates bars), but the quality label may still read `live`.
- **Verification** compares Swissquote, gold-api.com (independent, keyless, unknown refresh cadence),
  the last Dukascopy hourly close and Twelve Data (if keyed). "Verified" means they agree within 0.5 %
  — it is a consistency check, not an official settlement price.
- **Twelve Data** (optional key) becomes the primary quote/candle source for XAU/USD; the
  Dukascopy + Swissquote chain is then the fallback and a verification input.

### Gold futures and tokenised gold
- **COMEX GC / MGC** have no keyless, terms-compliant live source (Yahoo Finance was rejected because
  it requires bot-check circumvention). The terminal shows contract specifications only and never
  invents a futures price. A licensed feed (e.g. a CME-enabled Twelve Data plan) would be needed.
- **PAXG** (tokenised gold) is listed as its own asset and shown on the Gold page with its premium to
  spot. It is never used as a stand-in for XAU/USD anywhere in the data chain.

### US Dollar Index (DXY)
- The live value applies the ICE formula to six live bank quotes (Swissquote); history applies the same
  formula to the six Dukascopy archives (intersection of timestamps, bar closes). This is the index
  **definition**, not the licensed ICE Data Services print; expect a difference of a few hundredths and
  larger differences around the ICE settlement time (17:00 New York) versus UTC-midnight bars.
- Dukascopy's `USDIDX` instrument was probed and found to be a flat placeholder; it is not used.
- The ECB-fixing synthetic DXY (Frankfurter) is kept only as a daily cross-check and is labelled as such.
- With `FRED_API_KEY` the FRED broad trade-weighted dollar index remains available in the macro layer;
  it is a different index and is labelled separately.

### Crypto
- Binance USDT pairs are treated as USD; 24-hour windows are rolling, not sessions.
- Bybit/Coinbase fallbacks cover fewer symbols; funding/open interest come from Binance futures only.
- Demo mode (labelled `DEMO` everywhere) is used only when every provider fails and `DEMO_MODE` allows it.
- The asset registry is rebuilt from today's Binance listing: delisted coins are not available, which is
  a survivorship bias for any multi-asset statistics.

### Archive loading
- Dukascopy files are fetched with at most three parallel downloads (the CDN answers bursts with
  HTTP 503; transient errors are retried with backoff). The server pre-warms spot gold and the dollar
  index at start-up; on a machine with an empty cache that first pre-warm takes about five to six
  minutes (two years of daily bars for six FX pairs), during which the DXY panels show a short-TTL
  partial result and heal automatically. Completed periods are cached as JSON under
  `data/cache/dukascopy/` and never re-fetched, so later starts are instant; the current period is
  re-checked every 5–10 minutes.
- The last bar of a session can be a single closing quote captured from the live feed (e.g. the
  Friday 22:00 UTC quote), which is why it may show open = close and a volume of one tick.

## Analysis
- The setup engine is deterministic and rule-based. Evidence-sufficiency thresholds (≥ 3 supporting
  items, weight ≥ 40, trend/structure category present, supporting ≥ 1.5× opposing) and the MTF
  confirmation rule are heuristics; they are not calibrated per asset.
- Liquidity zones are equal-high/equal-low clusters from candles; there is no order-book data for gold
  and only Binance liquidation prints for crypto.
- AI narratives are interpretation. Every number in them must appear in the fact sheet (one retry, then a
  rule-based fallback); refusals and outages fall back to the rule-based explainer. The AI never changes
  a level, a score or a status.

## Trade monitoring
- Levels are checked against the hub's latest quote every 3 s. Moves between two checks can be missed;
  a gap through the entry zone is treated as filled at the zone edge; a bar that touches both stop and
  target between checks is resolved stop-first. Spot gold monitors do not advance while the market is
  closed.
- Outcome R follows the ladder convention (thirds at TP1/TP2/TP3, stop to breakeven after TP1) and
  ignores fees, slippage and funding. No monitor ever places, assumes or reports an order.

## Backtesting
- Walk-forward over closed bars only; the signal for bar *t* is generated from bars ≤ *t* and filled from
  bar *t+1* (market: next open plus slippage; limit: when touched). Higher timeframes are resampled
  from the same window, so the context seen by the engine is exactly what would have been visible.
- Intrabar resolution is conservative (stop before target when both are touched). No partial fills,
  no funding costs for perpetuals, no exchange outages, single asset per run.
- History depth: Binance up to 3 000 bars (paged); gold hourly up to 12 months and daily about 2 years
  from Dukascopy. Fewer than 20 trades, or an out-of-sample expectancy well below in-sample, is flagged.
- Fees default to 5 bps per side and 3 bps slippage; set them for your venue.

## Calendar and news
- Fed / BLS / BEA dates come from published schedules in `data/official-schedule.json` and must be
  refreshed when the agencies publish next year's calendars. The Forex Factory weekly feed is optional.
- News relevance tags are rule-based keyword matches, not sentiment analysis.

## Operations and security
- API keys are read from `.env` on the server and never sent to the browser. The server has no
  authentication and is intended to run locally.
- Browser access is limited to pages served from this machine, plus origins listed in
  `ALLOWED_ORIGINS`: other websites receive 403 for HTTP requests, CORS preflights and WebSocket
  handshakes, and unknown `Host` names are refused to stop DNS rebinding. This is not authentication:
  any program that can reach the port (curl, another local user, another device when
  `HOST=0.0.0.0`) can still use the API, so keep `HOST=127.0.0.1` unless LAN access is needed.
- Development mode: a request that is in flight at the moment the API restarts fails once (queries are
  retried by the UI); requests made while the API is down are held for up to 20 s, then answered 503.
- All user data (journal, settings, monitors, alerts) lives in JSON files under `data/`.
