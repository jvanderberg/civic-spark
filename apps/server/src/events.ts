import type { WebSocket } from "ws";
import { diagnostic } from "../../../packages/diagnostics/src/index.ts";
import type { Identity } from "../../../packages/domain/src/access-types.ts";

// One lightweight socket per open workspace tab replaces the fixed status
// timers. Frames carry only a scope name and a timestamp; the browser fetches
// the affected resource through the ordinary authorized routes.
export const eventScopes = ["files", "preview", "agent-git", "team"] as const;
export type EventScope = (typeof eventScopes)[number];
/** Opaque per-scope state summaries; a changed value means the scope changed. */
export type Fingerprints = Partial<Record<EventScope, string>>;
export type ChangeNotifier = {
  /** Something in this workspace changed; bursts may be coalesced for `coalesceMs`. */
  changed(id: string, scope: EventScope, coalesceMs?: number): void;
  /** The shared team repository advanced; every workspace on the team is told. */
  shared(id: string): void;
};
export const silentNotifier: ChangeNotifier = { changed() {}, shared() {} };

type Channel = {
  owner: Identity;
  generation: number;
  clients: Set<WebSocket>;
  fingerprints: Map<EventScope, string>;
  coalesced: Map<EventScope, { last: number; timer?: NodeJS.Timeout }>;
  probeTimer?: NodeJS.Timeout;
  probing: boolean;
};
const tickMs = 5000;
export class WorkspaceEvents {
  constructor(
    private allowed: (id: string) => boolean = () => true,
    // Host-side check for state the host cannot observe directly (a preview
    // process ending inside the Sprite, a teammate's push). It runs only while
    // at least one socket is attached and execution is allowed, and pushes
    // only when a fingerprint differs from the previous observation.
    private probe?: (
      id: string,
      owner: Identity,
      previous: Fingerprints,
    ) => Promise<Fingerprints | undefined>,
    private probeIntervalMs = 30000,
    private generation: (id: string) => number = () => 0,
  ) {}
  private channels = new Map<string, Channel>();
  /** Notification frames sent to sockets since start. */
  pushed = 0;
  get open() {
    let count = 0;
    for (const channel of this.channels.values()) count += channel.clients.size;
    return count;
  }
  subscribers(id: string) {
    return this.channels.get(id)?.clients.size ?? 0;
  }
  attach(id: string, owner: Identity, socket: WebSocket, authorized: () => Promise<boolean>) {
    if (!this.allowed(id)) throw new Error("Workspace execution is paused");
    const generation = this.generation(id);
    let channel = this.channels.get(id);
    if (channel && (channel.generation !== generation || channel.owner.id !== owner.id)) {
      this.stop(id);
      channel = undefined;
    }
    if (!channel) {
      channel = {
        owner,
        generation,
        clients: new Set(),
        fingerprints: new Map(),
        coalesced: new Map(),
        probing: false,
      };
      this.channels.set(id, channel);
    }
    const active = channel;
    active.clients.add(socket);
    const attachedAt = Date.now();
    socket.once("close", (code: number) =>
      diagnostic({
        event: "ws",
        channel: "events",
        workspaceId: id,
        code,
        durationMs: Date.now() - attachedAt,
      }),
    );
    const live = () =>
      socket.readyState === 1 &&
      active.clients.has(socket) &&
      this.channels.get(id) === active &&
      this.allowed(id) &&
      this.generation(id) === active.generation;
    const check = async () => {
      try {
        if (live() && (await authorized()) && live()) return true;
      } catch {
        /* Fail closed. */
      }
      socket.close(1008, "Workspace access ended");
      return false;
    };
    // Local checks every 5 s; the session lookup only every 30 s.
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      if (ticks % 6 === 0) void check();
      else if (!live()) socket.close(1008, "Workspace access ended");
    }, tickMs);
    // The channel is push-only; inbound frames carry nothing the server needs.
    socket.on("message", () => {});
    const detached = () => {
      clearInterval(timer);
      active.clients.delete(socket);
      if (!active.clients.size && this.channels.get(id) === active) this.remove(id, active);
    };
    socket.on("close", detached);
    socket.on("error", detached);
    if (active.clients.size === 1) this.scheduleProbe(id, active, 0);
  }
  private remove(id: string, channel: Channel) {
    if (channel.probeTimer) clearTimeout(channel.probeTimer);
    channel.probeTimer = undefined;
    for (const entry of channel.coalesced.values()) if (entry.timer) clearTimeout(entry.timer);
    channel.coalesced.clear();
    if (this.channels.get(id) === channel) this.channels.delete(id);
  }
  private scheduleProbe(id: string, channel: Channel, delay: number) {
    if (!this.probe || channel.probeTimer) return;
    channel.probeTimer = setTimeout(() => {
      channel.probeTimer = undefined;
      void this.runProbe(id, channel);
    }, delay);
  }
  private async runProbe(id: string, channel: Channel) {
    if (!this.probe || this.channels.get(id) !== channel || !channel.clients.size) return;
    if (channel.probing) return;
    channel.probing = true;
    try {
      if (this.allowed(id) && this.generation(id) === channel.generation) {
        const observed = await this.probe(
          id,
          channel.owner,
          Object.fromEntries(channel.fingerprints),
        );
        if (this.channels.get(id) === channel && observed)
          for (const scope of eventScopes) {
            const value = observed[scope];
            if (value === undefined) continue;
            const previous = channel.fingerprints.get(scope);
            channel.fingerprints.set(scope, value);
            if (previous !== undefined && previous !== value) this.send(id, channel, scope);
          }
      }
    } catch {
      /* A failed check keeps the previous observation; the next one retries. */
    } finally {
      channel.probing = false;
      if (this.channels.get(id) === channel && channel.clients.size)
        this.scheduleProbe(id, channel, this.probeIntervalMs);
    }
  }
  /** Tells every attached socket of the workspace that `scope` changed. */
  publish(id: string, scope: EventScope, coalesceMs = 0) {
    const channel = this.channels.get(id);
    if (!channel) return;
    // The host already knows this scope changed; the next probe re-baselines
    // silently instead of announcing the same change again.
    channel.fingerprints.delete(scope);
    const entry = channel.coalesced.get(scope);
    const now = Date.now();
    if (coalesceMs > 0 && entry && now - entry.last < coalesceMs) {
      if (!entry.timer)
        entry.timer = setTimeout(
          () => {
            entry.timer = undefined;
            if (this.channels.get(id) === channel) this.send(id, channel, scope);
          },
          entry.last + coalesceMs - now,
        );
      return;
    }
    if (entry?.timer) clearTimeout(entry.timer);
    this.send(id, channel, scope);
  }
  private send(_id: string, channel: Channel, scope: EventScope) {
    const entry = channel.coalesced.get(scope) ?? { last: 0 };
    entry.last = Date.now();
    entry.timer = undefined;
    channel.coalesced.set(scope, entry);
    const frame = JSON.stringify({ type: "changed", scope, at: new Date().toISOString() });
    for (const client of channel.clients) {
      if (client.readyState !== 1) continue;
      if (client.bufferedAmount > 65536) client.close(1013, "Reconnect to catch up");
      else {
        client.send(frame);
        this.pushed += 1;
      }
    }
  }
  stop(id: string) {
    const channel = this.channels.get(id);
    if (!channel) return;
    this.remove(id, channel);
    for (const socket of channel.clients) socket.close(1008, "Sprite paused; reload to resume");
    channel.clients.clear();
  }
  close() {
    for (const [id, channel] of this.channels) {
      this.remove(id, channel);
      for (const socket of channel.clients) socket.close();
    }
    this.channels.clear();
  }
}
