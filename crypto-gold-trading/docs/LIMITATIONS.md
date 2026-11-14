# Known limitations

Last reviewed: 2026-11-14. This file is the honest list of what the terminal does **not** do, or does
only approximately. Everything here is also surfaced in the UI next to the affected data.

## Market data

### Spot gold (XAU/USD) and spot silver (XAG/USD)
Both metals use the same sources and the same code path; everything in this section applies to each.
- **Sources.** History comes from the Dukascopy historical archive (bid side, 1-minute / 1-hour / daily
  files, UTC-aligned). The current hour is sampled every 15 s from Swissquote's public best-bid/offer
  feed (prime profile, mid of bid/ask for quotes, bid for candles). Neither is an exchange: spot gold
  and silver are OTC markets and every feed is one dealer's view. Quotes from different banks differ by
  a few cents. The archive's price scale was checked against real files for both metals, and every
  series is also compared with the live quote before it is used.
- **Publication delay.** Dukascopy publishes a completed hour/day with a delay (minutes to about an
  hour). Until then the series relies on the live sampler, which only holds data collected since the
  server started (persisted to `data/live-candles.json`, 10-day window). After a restart there can be a
  short gap at the end of the intraday chart until the archive catches up.
- **Daily bars are UTC-midnight bars**, not the 17:00 New York spot close that many publishers use.
  Daily changes and "previous close" can therefore differ slightly from published figures.
- **The change shown next to a metal price** is measured against the previous UTC daily close, and the
  range is that of the current UTC day (the last trading day while the market is closed). Neither is a
  rolling 24-hour window, unlike the crypto figures.
- **Market hours** are modelled as Sunday 22:00 UTC → Friday 22:00 UTC (quality `closed` outside that
  window). Holidays are not modelled; on a holiday the feed simply stops producing fresh timestamps and
  the sampler records nothing (it never fabricates bars), but the quality label may still read `live`.
- **Verification** compares Swissquote, gold-api.com (independent, keyless, unknown refresh cadence),
  the last Dukascopy hourly close and Twelve Data (if keyed). "Verified" means they agree within 0.5 %
  for gold and within 1.0 % for silver — it is a consistency check, not an official settlement price.
  Silver's tolerance is wider because the archive row is an hourly close that can be an hour or two
  old, and silver moves about twice as much as gold in that time.
- **Twelve Data** (optional key) becomes the primary quote/candle source for XAU/USD and XAG/USD; the
  Dukascopy + Swissquote chain is then the fallback and a verification input. Both metals are requested
  with the same key, so a free-tier request limit is reached sooner than with gold alone; a refused or
  unsupported request simply falls back to the keyless chain.

### Futures and tokenised metals
- **COMEX GC / MGC (gold) and SI / SIL (silver)** have no keyless, terms-compliant live source (Yahoo
  Finance was rejected because it requires bot-check circumvention). The terminal shows contract
  specifications only and never invents a futures price. A licensed feed (e.g. a CME-enabled Twelve
  Data plan) would be needed.
- **PAXG** (tokenised gold) is listed as its own asset and shown on the Gold page with its premium to
  spot. It is never used as a stand-in for XAU/USD anywhere in the data chain. Silver has no liquid
  tokenised counterpart on the venues this terminal reads, so the Silver page shows the gold/silver
  ratio in that place instead; no token, ETF or futures contract is ever used as XAG/USD.

### Silver specifics
- **Posture.** Silver is scored with exactly the gold method (trend 30 %, dollar 20 %, yields 20 %,
  momentum 15 %, volatility 15 %) on its own daily prices. Two things that move silver are not scored:
  it tends to amplify gold's moves, and more than half of its demand is industrial. The page says so
  next to the score; read it together with the gold posture and the ratio.
- **Gold/silver ratio.** The live value divides the two Swissquote mids; the one-year range and
  percentile use UTC-midnight daily closes of both archives and appear only when both daily histories
  are complete. It is a descriptive relative-value measure, not a signal, and it is not an input to any
  score or setup.
- **Contract sizes.** The CFD rows assume the common 5,000 oz standard lot and 500 oz mini lot with
  10:1 maximum leverage; brokers differ (1,000 oz and 50 oz lots exist), so check your own contract or
  use the custom specification. COMEX SI is 5,000 oz and SIL 1,000 oz, both on a $0.005 tick.
- **News and positioning.** No feed is about silver alone: silver headlines are the ones a keyword rule
  tags ("silver", "XAG", "precious metals") in the metals and macro feeds. CFTC positioning, exchange-
  traded product holdings and supply/demand data are not available without a dedicated provider.

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
- A provider failure is written to the terminal once and then at most every five minutes while it lasts,
  not once per request; identical request errors are written at most once a minute.
- The asset registry is rebuilt from today's Binance listing: delisted coins are not available, which is
  a survivorship bias for any multi-asset statistics.

### Archive loading and first start
- Completed periods are cached as JSON under `data/cache/dukascopy/` and never re-fetched, so only
  the first start on a machine downloads much: about 25 to 50 files each for gold and silver (more late
  in a trading day, when today's completed hours are fetched one by one) and about 30 to 160 for the
  dollar index (four completed months plus the days of the current month, for six FX pairs).
  Afterwards the daily cost is one file per metal per trading hour and six FX files per day. An
  installation that predates silver downloads the silver files once on its next start.
- Order and pace: the metals before FX; among the metals, prices and intraday charts first, then
  hourly, then daily history, with gold ahead of silver inside each of those steps and recent files
  before old ones; at most three downloads at a time (two for FX), one start per 150 ms for the metals
  and per 350 ms for FX.
- The archive limits how much one connection may download, and that limit is not published. When a
  download fails, the file is left alone for 30 seconds, then 1, 2, 4, 8 and at most 10 minutes. Five
  failures within 30 seconds pause every download for a minute (longer if the archive says so, and
  doubling up to 10 minutes while nothing at all gets through); afterwards downloads resume one at a
  time at half the previous pace, which recovers only gradually. A first start on a connection that is
  already being limited can therefore take many minutes; it completes by itself.
- No request waits for a download. Gold and silver endpoints answer `202 Accepted` with
  `warming: true` after at most 2.5 seconds, the UI keeps its loading state and asks again, composite
  answers (overview, setups, intelligence) are returned without the part that is still downloading and
  refreshed every few seconds, and nothing is replaced by demo data while warming. One metal never
  waits for the other.
- Gaps: a gold or silver series whose first load is missing files is held back for four minutes while
  they are retried. After that it is served flagged as incomplete, with a visible warning, a
  provisional posture for that metal and its setups forced to NO TRADE, until the missing files have
  arrived.
- Nothing at all: if the archive has delivered none of a metal's history when those four minutes are
  over, that metal's charts, analysis, posture and setups answer "unavailable" with the reason (HTTP
  202 with `unavailable: true`, because the server keeps trying) until the archive responds; a notice
  says so and the terminal reports it once. The live price
  is still shown, without a change figure, because its previous close is unknown.
- Gold and silver are never replaced by demo data in the default `DEMO_MODE=auto`, neither their
  history nor their price: the other half (the real price, or the real chart) is on the same screen and
  a synthetic stand-in next to it would mislead. `DEMO_MODE=force` shows labelled demo data for
  everything, metals included.
- Dollar index: the close-based history is used only when every file of all six pairs is present.
  Until then, and whenever the archive is unreachable, the index shows its live value and the analysis
  uses the ECB reference-rate series (fixed at 14:15 CET, so its daily values differ slightly from
  closes). The history ends at the last completed day; today is covered by the live value only.

## Analysis
- The setup engine is deterministic and rule-based. Evidence-sufficiency thresholds (≥ 3 supporting
  items, weight ≥ 40, trend/structure category present, supporting ≥ 1.5× opposing) and the MTF
  confirmation rule are heuristics; they are not calibrated per asset.
- Liquidity zones are equal-high/equal-low clusters from candles; there is no order-book data for gold
  or silver and only Binance liquidation prints for crypto.
- Round-number levels use a fixed step per metal: $50 for gold and $1 for silver.
- AI narratives are interpretation. Every number in them must appear in the fact sheet (one retry, then a
  rule-based fallback); refusals and outages fall back to the rule-based explainer. The AI never changes
  a level, a score or a status.

## Trade monitoring
- Levels are checked against the hub's latest quote every 3 s. Moves between two checks can be missed;
  a gap through the entry zone is treated as filled at the zone edge; a bar that touches both stop and
  target between checks is resolved stop-first. Spot gold and silver monitors do not advance while the
  market is closed.
- Outcome R follows the ladder convention (thirds at TP1/TP2/TP3, stop to breakeven after TP1) and
  ignores fees, slippage and funding. No monitor ever places, assumes or reports an order.

## Backtesting
- Walk-forward over closed bars only; the signal for bar *t* is generated from bars ≤ *t* and filled from
  bar *t+1* (market: next open plus slippage; limit: when touched). Higher timeframes are resampled
  from the same window, so the context seen by the engine is exactly what would have been visible.
- Intrabar resolution is conservative (stop before target when both are touched). No partial fills,
  no funding costs for perpetuals, no exchange outages, single asset per run.
- History depth: Binance up to 3 000 bars (paged); gold and silver hourly up to 12 months and daily
  about 2 years from Dukascopy. Fewer than 20 trades, or an out-of-sample expectancy well below in-sample, is flagged.
- Fees default to 5 bps per side and 3 bps slippage; set them for your venue.

## Calendar and news
- Fed / BLS / BEA dates come from published schedules in `data/official-schedule.json` and must be
  refreshed when the agencies publish next year's calendars. The Forex Factory weekly feed is optional.
- News relevance tags are rule-based keyword matches, not sentiment analysis.
- Calendar events are tagged for silver wherever they are tagged for gold (both trade on the dollar and
  rate expectations), plus industrial releases for silver alone. The tags say that a release matters to
  a market, not which way it will move it.

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
