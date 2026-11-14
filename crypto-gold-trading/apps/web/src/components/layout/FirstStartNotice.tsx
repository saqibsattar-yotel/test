import { AlertTriangle, Loader2 } from "lucide-react";
import { useWarmup } from "@/lib/queries";
import { capital, describeGaps, describeUnavailable, describeWarmup } from "@/lib/warmup";

/**
 * Shown while gold or silver history is being downloaded on a machine that has never run the terminal
 * (or when an update takes unusually long), so the metal panels do not just look stuck. It covers the
 * metals only: the dollar-index history downloads afterwards in the background and is reported on its
 * own card.
 */
export function FirstStartNotice() {
  const { data } = useWarmup();
  if (!data) return null;

  if (data.warming) {
    const takingLong = data.startedAt !== null && Date.now() - data.startedAt > 20_000;
    const w = describeWarmup(data);
    if (!w.once && !takingLong) return null;
    return (
      <div role="status" aria-live="polite" className="border-b border-line bg-surface-2 px-3 sm:px-4 lg:px-6 py-2 text-xs text-ink-2 flex items-start gap-2">
        <Loader2 className="h-3.5 w-3.5 mt-0.5 shrink-0 animate-spin text-accent" />
        <p>
          <span className="font-medium text-ink-1">{w.title}</span> {capital(w.names)} history is being downloaded{w.once ? " once" : ""} ({w.partsDone} of {w.partsTotal} parts ready
          {w.current ? `, now: ${w.current}` : ""}; {w.files.done} of {w.files.total} files). Crypto is live already. {capital(w.names)} panels fill in by themselves as each part arrives{w.once ? ", and later starts are instant" : ""}.
          {w.slow && <span className="text-ink-1"> The archive is answering slowly right now, so this is taking longer than usual. Nothing is wrong, and it keeps retrying by itself.</span>}
        </p>
      </div>
    );
  }

  const out = describeUnavailable(data);
  if (out.metals.length) {
    return (
      <div role="status" aria-live="polite" className="border-b border-line bg-surface-2 px-3 sm:px-4 lg:px-6 py-2 text-xs text-ink-2 flex items-start gap-2">
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warn" />
        <p>
          <span className="font-medium text-ink-1">{capital(out.names)} history could not be downloaded yet.</span> The archive is not answering, so {out.names} charts, posture and trade setups are unavailable for now. Live {out.names} prices are unaffected, and nothing is
          shown in place of the missing history. The download is retried automatically{out.retryInSeconds !== null && out.retryInSeconds > 0 ? ` (next attempt in about ${out.retryInSeconds < 90 ? `${out.retryInSeconds} s` : `${Math.round(out.retryInSeconds / 60)} min`})` : ""}; this notice disappears when the history has arrived.
        </p>
      </div>
    );
  }

  const gaps = describeGaps(data);
  if (gaps.metals.length) {
    return (
      <div role="status" aria-live="polite" className="border-b border-line bg-surface-2 px-3 sm:px-4 lg:px-6 py-2 text-xs text-ink-2 flex items-start gap-2">
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warn" />
        <p>
          <span className="font-medium text-ink-1">Some {gaps.names} history is still missing.</span> The archive is refusing {gaps.failing > 0 ? `${gaps.failing} file${gaps.failing === 1 ? "" : "s"}` : "some files"} for now, so {gaps.names} charts can show gaps and {gaps.names} trade setups are
          withheld. The missing files are retried automatically and this notice disappears when they have arrived.
        </p>
      </div>
    );
  }

  return null;
}
