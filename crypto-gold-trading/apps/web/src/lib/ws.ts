import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Quote } from "@terminal/core";
import { useUi } from "./store";
import type { TriggeredAlert } from "./api";

type Msg = { type: "quote"; quote: Quote } | { type: "quotes"; quotes: Quote[] } | { type: "alert"; alert: TriggeredAlert } | { type: "status"; upstream: "live" | "polling" | "demo"; clients: number } | { type: "monitor"; item: unknown };

/** Maintains one WebSocket to the server and feeds the UI store. */
export function useMarketSocket() {
  const upsert = useUi((s) => s.upsertQuotes);
  const setUpstream = useUi((s) => s.setUpstream);
  const pushToast = useUi((s) => s.pushToast);
  const setUnread = useUi((s) => s.setUnreadAlerts);
  const qc = useQueryClient();
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let delay = 1000;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        delay = 1000;
      };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data) as Msg;
          if (m.type === "quote") upsert([m.quote]);
          else if (m.type === "quotes") upsert(m.quotes);
          else if (m.type === "status") setUpstream(m.upstream);
          else if (m.type === "alert") {
            pushToast({ title: m.alert.kind === "setup_monitor" ? "Setup monitor" : "Alert", body: m.alert.message, tone: m.alert.kind === "setup_monitor" ? "bull" : "warning" });
            setUnread(useUi.getState().unreadAlerts + 1);
            void qc.invalidateQueries({ queryKey: ["alerts"] });
          } else if (m.type === "monitor") void qc.invalidateQueries({ queryKey: ["monitor"] });
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setUpstream("disconnected");
        setTimeout(connect, delay);
        delay = Math.min(15_000, delay * 2);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [upsert, setUpstream, pushToast, setUnread, qc]);
}
