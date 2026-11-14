/**
 * Economic calendar domain: normalised event shape plus rule-based relevance tagging
 * ("why it matters" for gold, silver and crypto). No forecasts or actuals are ever invented —
 * they are only present when a provider supplies them.
 */

export type Importance = "high" | "medium" | "low" | "holiday";
export type RelatedMarket = "gold" | "silver" | "btc" | "eth" | "crypto" | "usd" | "rates";

export interface EconEvent {
  id: string;
  title: string;
  country: string; // ISO-ish currency/country code e.g. USD, EUR
  time: number; // epoch ms
  allDay?: boolean;
  importance: Importance;
  previous?: string | null;
  forecast?: string | null;
  actual?: string | null;
  source: { provider: string; label: string; url?: string };
  /** True when the date comes from the issuing agency's published schedule. */
  official: boolean;
  relatedMarkets: RelatedMarket[];
  whyItMatters: string | null;
}

interface Rule {
  test: RegExp;
  markets: RelatedMarket[];
  why: string;
  importanceBoost?: Importance;
}

const RULES: Rule[] = [
  { test: /\b(FOMC|federal funds rate|fed(eral reserve)? (interest )?rate decision|fed chair|fomc press conference|fomc statement|fomc minutes|fed funds)\b/i, markets: ["gold", "silver", "btc", "eth", "crypto", "usd", "rates"], why: "Fed rate decisions and guidance move real yields and the dollar; gold and silver are sensitive to the path of real rates, and crypto reacts to liquidity expectations. Statements and press conferences often matter more than the decision itself.", importanceBoost: "high" },
  { test: /\b(CPI|consumer price index|core cpi)\b/i, markets: ["gold", "silver", "btc", "crypto", "usd", "rates"], why: "Inflation prints reset rate expectations. A hotter print tends to lift yields and the dollar (a headwind for gold and silver if the inverse relationship is holding); a softer print does the opposite. Crypto trades it as a liquidity signal.", importanceBoost: "high" },
  { test: /\b(PCE|personal consumption expenditures|core pce)\b/i, markets: ["gold", "silver", "usd", "rates", "crypto"], why: "PCE is the Fed's preferred inflation gauge, so it feeds directly into rate expectations and real yields.", importanceBoost: "high" },
  { test: /non-?farm (employment|payroll)|\bnfp\b|\bpayrolls?\b|employment situation|\bemployment change\b/i, markets: ["gold", "silver", "btc", "crypto", "usd", "rates"], why: "Payrolls set the tone for growth and rate expectations. Strong jobs → higher yields/dollar; weak jobs → easing bets. Gold and silver often see sharp two-way moves in the first minutes.", importanceBoost: "high" },
  { test: /\b(unemployment rate|average hourly earnings|jobless claims|jolts)\b/i, markets: ["gold", "silver", "usd", "rates"], why: "Labour-market data refines the growth and wage-inflation picture that drives rate pricing.", importanceBoost: undefined },
  { test: /\b(GDP|gross domestic product)\b/i, markets: ["gold", "silver", "usd", "rates", "crypto"], why: "Growth surprises shift the rate path and risk appetite.", importanceBoost: undefined },
  { test: /\b(PPI|producer price)\b/i, markets: ["gold", "silver", "usd", "rates"], why: "Pipeline inflation signal; a secondary input to rate expectations." },
  { test: /\b(ISM|PMI)\b/i, markets: ["usd", "rates", "gold", "silver"], why: "Business-survey momentum; moves yields and the dollar at the margin. Manufacturing surveys also speak to industrial demand, which matters more for silver than for gold." },
  { test: /\b(industrial production|manufacturing production|factory orders|durable goods)\b/i, markets: ["usd", "silver"], why: "Industrial activity gauge. More than half of silver demand is industrial, so factory data matters more for silver than for gold." },
  { test: /\b(retail sales)\b/i, markets: ["usd", "rates", "gold", "silver"], why: "Consumer demand gauge feeding growth and rate expectations." },
  { test: /\b(treasury|bond auction|note auction|10-y|30-y|2-y)\b/i, markets: ["rates", "gold", "silver"], why: "Auction demand can move yields, which feed the opportunity cost of holding gold and silver." },
  { test: /\b(powell|fed (governor|president|chair)|fomc member)\b/i, markets: ["gold", "silver", "usd", "rates", "crypto"], why: "Fed speakers can shift rate-cut/hike probabilities intraday." },
  { test: /\b(ecb|boe|boj|snb|rba|boc|rbnz)\b.*\b(rate|decision|statement|press)\b/i, markets: ["usd", "gold", "silver"], why: "Other central banks affect the dollar via cross rates (DXY is a basket), indirectly affecting gold and silver." },
  { test: /\b(bitcoin|crypto|etf|sec|stablecoin|digital asset)\b/i, markets: ["btc", "eth", "crypto"], why: "Direct crypto-market catalyst." },
  { test: /\b(bank holiday|holiday)\b/i, markets: [], why: "Reduced liquidity — thinner books, wider spreads, erratic moves." },
];

export function tagRelevance(title: string, country: string, importance: Importance): { relatedMarkets: RelatedMarket[]; whyItMatters: string | null; importance: Importance } {
  const markets = new Set<RelatedMarket>();
  let why: string | null = null;
  let imp = importance;
  for (const rule of RULES) {
    if (rule.test.test(title)) {
      rule.markets.forEach((m) => markets.add(m));
      if (!why) why = rule.why;
      if (rule.importanceBoost && country === "USD" && imp !== "holiday") imp = rule.importanceBoost;
    }
  }
  if (country === "USD" && (imp === "high" || imp === "medium") && markets.size === 0) {
    markets.add("usd");
    markets.add("gold");
    markets.add("silver");
    why = "US macro release — affects the dollar and rate expectations that gold and silver trade on.";
  }
  return { relatedMarkets: [...markets], whyItMatters: why, importance: imp };
}

export function normalizeImportance(raw: string): Importance {
  const r = raw.toLowerCase();
  if (r.includes("high") || r === "3") return "high";
  if (r.includes("med") || r === "2") return "medium";
  if (r.includes("holiday")) return "holiday";
  return "low";
}
