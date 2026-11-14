import { Loader2 } from "lucide-react";
import { useWarmup } from "@/lib/queries";

/**
 * Shown while the one-time history download runs on a machine that has never started the terminal
 * (or whenever a download takes unusually long). Without it the gold panels would just look stuck.
 */
export function FirstStartNotice() {
  const { data } = useWarmup();
  if (!data?.warming) return null;
  const takingLong = data.startedAt !== null && Date.now() - data.startedAt > 20_000;
  if (!data.firstRun && !takingLong) return null;
  const done = data.steps.filter((s) => s.state === "done").length;
  const current = data.steps.find((s) => s.state === "running");
  return (
    <div role="status" aria-live="polite" className="border-b border-line bg-surface-2 px-3 sm:px-4 lg:px-6 py-2 text-xs text-ink-2 flex items-start gap-2">
      <Loader2 className="h-3.5 w-3.5 mt-0.5 shrink-0 animate-spin text-accent" />
      <p>
        <span className="font-medium text-ink-1">First start on this computer.</span> Gold and dollar-index history is being downloaded once ({done} of {data.steps.length} parts ready
        {current ? `, now: ${current.label}` : ""}; {data.files.downloaded} files so far{data.files.failed ? `, ${data.files.failed} to retry` : ""}). Crypto is live already. Gold panels fill in by themselves as each part finishes, and
        later starts are instant.
      </p>
    </div>
  );
}
