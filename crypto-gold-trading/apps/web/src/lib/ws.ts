import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Quote } from "@terminal/core";
import { useUi } from "./store";
import type { TriggeredAlert } from "./api";
import { createReconnectingSocket } from "./socket";

type Msg = { type: "quote"; quote: Quote } | { type: "quotes"; quotes: Quote[] } | { type: "alert"; alert: TriggeredAlert } | { type: "status"; upstream: "live" | "polling" | "demo"; clients: number } | { type: "monitor"; item: unknown };

/**
 * True when the API answers. The socket is only dialled after this, so a server that is still starting
 * or restarting never receives a handshake it cannot complete. In development the Vite gate holds this
 * request until the API is up, which makes the first connection succeed on the first try.
 */
async function apiReady(): Promise<boolean> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Maintains one WebSocket to the server and feeds the UI store. */
export function useMarketSocket() {
  const upsert = useUi((s) => s.upsertQuotes);
  const setUpstream = useUi((s) => s.setUpstream);
  const pushToast = useUi((s) => s.pushToast);
  const setUnread = useUi((s) => s.setUnreadAlerts);
  const qc = useQueryClient();
  useEffect(() => {
    const socket = createReconnectingSocket({
      url: () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
      isReady: apiReady,
      onStatus: (status) => {
        if (status === "closed") setUpstream("disconnected");
      },
      onMessage: (data) => {
        try {
          const m = JSON.parse(data) as Msg;
          if (m.type === "quote") upsert([m.quote]);
          else if (m.type === "quotes") upsert(m.quotes);
          else if (m.type === "status") setUpstream(m.upstream);
          else if (m.type === "alert") {
            pushToast({ title: m.alert.kind === "setup_monitor" ? "Setup monitor" : "Alert", body: m.alert.message, tone: m.alert.kind === "setup_monitor" ? "bull" : "warning" });
            setUnread(useUi.getState().unreadAlerts + 1);
            void qc.invalidateQueries({ queryKey: ["alerts"] });
          } else if (m.type === "monitor") void qc.invalidateQueries({ queryKey: ["monitor"] });
        } catch {
          /* ignore malformed frames */
        }
      },
    });
    // start() is deferred and stop() cancels it, so React StrictMode's throwaway first mount opens nothing.
    socket.start();
    return () => socket.stop();
  }, [upsert, setUpstream, pushToast, setUnread, qc]);
}
