/**
 * AI narrative layer.
 *
 * The LLM receives ONLY a fact sheet of numbers computed by the deterministic engines and
 * is instructed to interpret, never invent. Every number in the output is checked against
 * the fact sheet (grounding check); if an ungrounded number appears, the request is
 * retried once with a stricter instruction and otherwise falls back to the rule-based
 * explainer. Without an API key the rule-based explainer is used and labelled.
 */
import Anthropic from "@anthropic-ai/sdk";
import { hashString } from "@terminal/core";
import { config } from "../config";
import { cache } from "../lib/cache";
import { logger } from "../lib/logger";

const log = logger("ai");

export interface Narrative {
  text: string;
  paragraphs: string[];
  mode: "llm" | "rule-based";
  model: string | null;
  grounded: boolean;
  ungroundedNumbers: string[];
  generatedAt: number;
  factsAsOf: number | null;
  disclaimer: string;
  usage?: { inputTokens: number; outputTokens: number; cacheRead: number };
  warning?: string;
}

const DISCLAIMER = "Research output for human review — not financial advice, not a signal, not an execution instruction. Numbers come from verified market data and deterministic calculations; the narrative is an interpretation and can be wrong.";

const SYSTEM = `You are the narrative layer of a crypto, gold and silver trading research terminal.

You will receive a FACT SHEET (JSON) produced by deterministic code from verified market data: prices, indicators, structure levels, regime scores, trade-plan levels and evidence lists.

Rules (strict):
1. Use ONLY numbers that appear in the fact sheet. Never compute, round differently, extrapolate or invent a price, level, percentage, date or statistic. If you need a number that is not present, describe it qualitatively instead.
2. Interpret and explain: what the evidence means, where supporting and opposing evidence conflict, what has to happen before action, and what would invalidate the thesis.
3. Never guarantee or imply a probability of profit. Quality scores are methodology assessments, not win probabilities.
4. Clearly separate verified data from interpretation ("the data shows..." vs "this suggests...").
5. If the fact sheet says data is stale, proxy or demo, say so prominently in the first sentence.
6. Write for a professional trader: dense, concrete, no hype, no emojis, no bullet points, no headings. 2–4 short paragraphs. British or American spelling is fine; be consistent.
7. Do not add disclaimers; the UI adds one.`;

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!config.hasAnthropic) return null;
  if (!client) client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 2 });
  return client;
}

/** Extract numeric tokens from text for the grounding check. */
export function extractNumbers(text: string): string[] {
  const matches = text.match(/-?\d[\d,]*\.?\d*/g) ?? [];
  return matches.map((m) => m.replace(/,/g, "")).filter((m) => m !== "" && m !== "-" && !/^0+$/.test(m));
}

function factNumbers(facts: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) {
      const variants = new Set<string>([String(v), v.toFixed(0), v.toFixed(1), v.toFixed(2), v.toFixed(3), v.toFixed(4), Math.round(v).toString(), (Math.round(v / 10) * 10).toString(), (Math.round(v / 100) * 100).toString()]);
      for (const s of variants) {
        out.add(s);
        out.add(s.replace(/\.0+$/, ""));
        out.add(s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
      }
    } else if (typeof v === "string") {
      for (const n of extractNumbers(v)) out.add(n);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(visit);
  };
  visit(facts);
  return out;
}

/** Numbers in `text` that cannot be matched to any number in `facts` (with tolerance for formatting). */
export function ungroundedNumbers(text: string, facts: unknown): string[] {
  const allowed = factNumbers(facts);
  const bad: string[] = [];
  for (const n of extractNumbers(text)) {
    const clean = n.replace(/^-/, "");
    if (allowed.has(clean) || allowed.has(n)) continue;
    const num = parseFloat(clean);
    // Small integers used as counts/ordinals (1-20), timeframe numbers and R multiples are tolerated.
    if (Number.isInteger(num) && num >= 0 && num <= 20) continue;
    if (/^\d{4}$/.test(clean) && num >= 2020 && num <= 2035) continue; // years
    // Accept if within 0.05% of any fact number (formatting differences)
    let close = false;
    for (const a of allowed) {
      const av = parseFloat(a);
      if (Number.isFinite(av) && av !== 0 && Math.abs(av - num) / Math.abs(av) < 0.0005) {
        close = true;
        break;
      }
    }
    if (!close) bad.push(n);
  }
  return [...new Set(bad)];
}

export function ruleBasedNarrative(paragraphs: string[], factsAsOf: number | null, warning?: string): Narrative {
  return { text: paragraphs.join("\n\n"), paragraphs, mode: "rule-based", model: null, grounded: true, ungroundedNumbers: [], generatedAt: Date.now(), factsAsOf, disclaimer: DISCLAIMER, warning };
}

export interface NarrativeRequest {
  kind: "setup" | "briefing" | "mtf" | "regime" | "gold" | "silver" | "news";
  facts: unknown;
  fallback: string[]; // rule-based paragraphs
  factsAsOf: number | null;
  instruction: string; // task-specific instruction
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
  cacheTtlMs?: number;
}

export async function narrate(req: NarrativeRequest): Promise<Narrative> {
  const c = getClient();
  if (!c) return ruleBasedNarrative(req.fallback, req.factsAsOf, "No ANTHROPIC_API_KEY configured — showing the deterministic rule-based explanation.");
  const key = `ai:${req.kind}:${hashString(JSON.stringify(req.facts))}`;
  const ttl = req.cacheTtlMs ?? 10 * 60_000;
  try {
    const res = await cache.getOrLoad<Narrative>(key, ttl, async () => {
      let strict = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await c.beta.messages.create({
          model: config.ANTHROPIC_MODEL,
          max_tokens: req.maxTokens ?? 2000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: req.effort ?? "low" },
          system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: `${req.instruction}${strict}\n\nFACT SHEET:\n${JSON.stringify(req.facts, null, 1)}` }],
        });
        if (response.stop_reason === "refusal") {
          log.warn(`model refused (${response.stop_details?.category ?? "unknown"})`);
          return ruleBasedNarrative(req.fallback, req.factsAsOf, "The model declined this request; showing the rule-based explanation.");
        }
        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        const bad = ungroundedNumbers(text, req.facts);
        const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, cacheRead: response.usage.cache_read_input_tokens ?? 0 };
        if (bad.length === 0) {
          return { text, paragraphs: text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean), mode: "llm", model: response.model, grounded: true, ungroundedNumbers: [], generatedAt: Date.now(), factsAsOf: req.factsAsOf, disclaimer: DISCLAIMER, usage };
        }
        log.warn(`ungrounded numbers in attempt ${attempt + 1}: ${bad.join(", ")}`);
        strict = `\n\nIMPORTANT: your previous answer contained numbers not present in the fact sheet (${bad.join(", ")}). Rewrite using only fact-sheet numbers; otherwise describe qualitatively.`;
        if (attempt === 1) {
          return { ...ruleBasedNarrative(req.fallback, req.factsAsOf), warning: `LLM output contained numbers not found in the verified facts (${bad.join(", ")}); the deterministic explanation is shown instead.`, ungroundedNumbers: bad, usage };
        }
      }
      return ruleBasedNarrative(req.fallback, req.factsAsOf);
    });
    return res.value;
  } catch (err) {
    const message = err instanceof Anthropic.AuthenticationError ? "Anthropic API key rejected" : err instanceof Anthropic.RateLimitError ? "Anthropic rate limit reached" : err instanceof Anthropic.APIError ? `Anthropic API error ${err.status}` : (err as Error).message;
    log.error("narrative generation failed", err);
    return ruleBasedNarrative(req.fallback, req.factsAsOf, `${message} — showing the rule-based explanation.`);
  }
}

export function aiStatus() {
  return { enabled: config.hasAnthropic, model: config.hasAnthropic ? config.ANTHROPIC_MODEL : null, mode: config.hasAnthropic ? "llm" : "rule-based", grounding: "numeric grounding check against the fact sheet, one retry, then deterministic fallback" };
}
