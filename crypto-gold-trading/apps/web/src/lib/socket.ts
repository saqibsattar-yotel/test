/**
 * Framework-free reconnecting WebSocket client.
 *
 *  - It dials only after `isReady()` resolves true (the API answers), so a server that is still starting
 *    or restarting never sees aborted handshakes, and the dev proxy has nothing to complain about.
 *  - `start()` is deferred by one tick and `stop()` cancels it. React StrictMode mounts every effect
 *    twice in development (mount → unmount → mount); the throwaway first mount therefore never opens a
 *    socket. Opening and immediately closing one mid-handshake is what made the Vite proxy log
 *    "ws proxy socket error: write EPIPE" on every page load.
 *  - After `stop()` nothing reconnects. A socket that is still connecting is closed as soon as it opens
 *    instead of being aborted mid-handshake.
 */
export interface SocketLike {
  readyState: number;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketStatus = "open" | "closed";

export interface ReconnectingSocketOptions {
  url: () => string;
  /** Resolves true when the server is reachable. A rejection counts as "not ready". */
  isReady: () => Promise<boolean>;
  onMessage: (data: string) => void;
  onStatus?: (status: SocketStatus) => void;
  createSocket?: (url: string) => SocketLike;
  minDelayMs?: number;
  maxDelayMs?: number;
}

const CONNECTING = 0;

export function createReconnectingSocket(options: ReconnectingSocketOptions) {
  const minDelay = options.minDelayMs ?? 1000;
  const maxDelay = options.maxDelayMs ?? 15_000;
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);

  let socket: SocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let delay = minDelay;
  /** Bumped by every start() and stop(); async work from an older generation is discarded. */
  let generation = 0;

  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void dial();
    }, ms);
  };

  /** Capped exponential backoff: 1 s, 2 s, 4 s … 15 s; reset when a connection opens. */
  const retry = () => {
    const wait = delay;
    delay = Math.min(maxDelay, delay * 2);
    schedule(wait);
  };

  const dial = async () => {
    const gen = generation;
    if (stopped) return;
    let ready = false;
    try {
      ready = await options.isReady();
    } catch {
      ready = false;
    }
    if (stopped || gen !== generation) return;
    if (!ready) {
      options.onStatus?.("closed");
      retry();
      return;
    }
    let s: SocketLike;
    try {
      s = createSocket(options.url());
    } catch {
      options.onStatus?.("closed");
      retry();
      return;
    }
    socket = s;
    s.onopen = () => {
      delay = minDelay;
      options.onStatus?.("open");
    };
    s.onmessage = (ev) => {
      if (typeof ev.data === "string") options.onMessage(ev.data);
    };
    s.onerror = () => {
      try {
        s.close();
      } catch {
        /* already closing */
      }
    };
    s.onclose = () => {
      if (socket === s) socket = null;
      if (stopped || gen !== generation) return;
      options.onStatus?.("closed");
      retry();
    };
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      generation++;
      delay = minDelay;
      schedule(0);
    },
    stop() {
      stopped = true;
      generation++;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const s = socket;
      socket = null;
      if (!s) return;
      s.onmessage = null;
      s.onerror = null;
      s.onclose = null;
      if (s.readyState === CONNECTING) {
        // Let the handshake finish, then close cleanly.
        s.onopen = () => s.close();
      } else {
        s.onopen = null;
        s.close();
      }
    },
  };
}
