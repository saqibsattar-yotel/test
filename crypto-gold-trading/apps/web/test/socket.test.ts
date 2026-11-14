import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReconnectingSocket, type SocketLike, type SocketStatus } from "../src/lib/socket";

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0; // CONNECTING
  closeCalls = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  /** Handshake completed. */
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(data: unknown) {
    this.onmessage?.({ data });
  }
  /** The server or the network dropped the connection. */
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
  close() {
    this.closeCalls++;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }
}

function setup(overrides: Partial<Parameters<typeof createReconnectingSocket>[0]> = {}) {
  const messages: string[] = [];
  const statuses: SocketStatus[] = [];
  const isReady = vi.fn(async () => true);
  const socket = createReconnectingSocket({
    url: () => "ws://test/ws",
    isReady,
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    createSocket: (url) => new FakeSocket(url),
    ...overrides,
  });
  return { socket, messages, statuses, isReady };
}
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe("reconnecting socket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens exactly one socket for mount → unmount → mount in the same tick (React StrictMode)", async () => {
    const { socket, isReady } = setup();
    socket.start();
    socket.stop();
    socket.start();
    await tick();
    expect(isReady).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].closeCalls).toBe(0);
  });

  it("never opens a socket when stopped before the deferred start runs", async () => {
    const { socket, isReady } = setup();
    socket.start();
    socket.stop();
    await tick(60_000);
    expect(isReady).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("does not dial until the API is ready, retrying with backoff", async () => {
    const isReady = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("network")).mockResolvedValue(true);
    const { socket, statuses } = setup({ isReady });
    socket.start();
    await tick();
    expect(isReady).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(statuses).toEqual(["closed"]);
    await tick(999);
    expect(isReady).toHaveBeenCalledTimes(1);
    await tick(1); // 1 s backoff elapsed → second readiness check throws → treated as not ready
    expect(isReady).toHaveBeenCalledTimes(2);
    expect(FakeSocket.instances).toHaveLength(0);
    await tick(1999);
    expect(isReady).toHaveBeenCalledTimes(2);
    await tick(1); // 2 s backoff elapsed → ready → dial
    expect(isReady).toHaveBeenCalledTimes(3);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("reconnects with capped exponential backoff and resets the delay once a connection opens", async () => {
    const { socket, statuses } = setup({ maxDelayMs: 4000 });
    socket.start();
    await tick();
    const [first] = FakeSocket.instances;
    first.open();
    expect(statuses).toEqual(["open"]);
    first.drop();
    expect(statuses).toEqual(["open", "closed"]);
    await tick(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1].drop(); // failed before opening → next wait doubles
    await tick(1999);
    expect(FakeSocket.instances).toHaveLength(2);
    await tick(1);
    expect(FakeSocket.instances).toHaveLength(3);
    FakeSocket.instances[2].drop();
    await tick(4000);
    expect(FakeSocket.instances).toHaveLength(4);
    FakeSocket.instances[3].drop();
    await tick(3999); // capped at 4 s, not 8 s
    expect(FakeSocket.instances).toHaveLength(4);
    await tick(1);
    expect(FakeSocket.instances).toHaveLength(5);
    FakeSocket.instances[4].open(); // success resets the backoff
    FakeSocket.instances[4].drop();
    await tick(1000);
    expect(FakeSocket.instances).toHaveLength(6);
  });

  it("stop() during the readiness check never opens a socket", async () => {
    let resolveReady!: (v: boolean) => void;
    const { socket } = setup({ isReady: () => new Promise<boolean>((r) => (resolveReady = r)) });
    socket.start();
    await tick();
    socket.stop();
    resolveReady(true);
    await tick(60_000);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("stop() while connecting closes after the handshake instead of aborting it", async () => {
    const { socket, statuses } = setup();
    socket.start();
    await tick();
    const [s] = FakeSocket.instances;
    socket.stop();
    expect(s.closeCalls).toBe(0); // still handshaking: not aborted
    s.open();
    expect(s.closeCalls).toBe(1);
    await tick(60_000);
    expect(FakeSocket.instances).toHaveLength(1); // no reconnect after stop
    expect(statuses).toEqual([]); // and no status noise from the discarded socket
  });

  it("stop() on an open socket closes it once, ignores later frames and never reconnects", async () => {
    const { socket, messages } = setup();
    socket.start();
    await tick();
    const [s] = FakeSocket.instances;
    s.open();
    s.message("one");
    s.message(new ArrayBuffer(2)); // binary frames are ignored
    socket.stop();
    s.message("after stop");
    expect(messages).toEqual(["one"]);
    expect(s.closeCalls).toBe(1);
    await tick(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("can be restarted after stop()", async () => {
    const { socket } = setup();
    socket.start();
    await tick();
    FakeSocket.instances[0].open();
    socket.stop();
    socket.start();
    socket.start(); // idempotent
    await tick();
    expect(FakeSocket.instances).toHaveLength(2);
  });
});
