import { useEffect, useRef, useState } from "react";

// One change-notification socket per open workspace, shared by every panel
// that used to run its own status timer. The server sends only a scope name
// and a timestamp; panels fetch the affected resource themselves. "resync"
// means notifications may have been missed (tab was hidden, socket dropped).
export type WorkspaceEventScope = "files" | "preview" | "agent-git" | "team";
export type WorkspaceSignal = WorkspaceEventScope | "resync";
type Listener = (signal: WorkspaceSignal) => void;
type Connection = {
  workspace: string;
  listeners: Set<Listener>;
  watchers: Set<(connected: boolean) => void>;
  socket: WebSocket | null;
  timer: ReturnType<typeof setTimeout> | null;
  attempts: number;
  blocked: boolean;
  gap: boolean;
  connected: boolean;
};
const scopes = new Set<string>(["files", "preview", "agent-git", "team"]);
const accessCodes = [1008, 4001, 4003, 4401, 4403];
const maxAttempts = 6;
const connections = new Map<string, Connection>();
let listening = false;

function emit(connection: Connection, signal: WorkspaceSignal) {
  for (const listener of [...connection.listeners]) listener(signal);
}
function setConnected(connection: Connection, value: boolean) {
  if (connection.connected === value) return;
  connection.connected = value;
  for (const watcher of [...connection.watchers]) watcher(value);
}
function schedule(connection: Connection) {
  if (
    connection.timer ||
    connection.blocked ||
    document.hidden ||
    !connection.listeners.size ||
    connection.attempts >= maxAttempts
  )
    return;
  connection.attempts += 1;
  // Jittered exponential backoff, capped at 30 s and six attempts; safety
  // polls and the next visibility change cover the gap after that.
  const base = Math.min(30000, 1000 * 2 ** (connection.attempts - 1));
  connection.timer = setTimeout(
    () => {
      connection.timer = null;
      connect(connection);
    },
    base * (0.75 + Math.random() * 0.5),
  );
}
function connect(connection: Connection) {
  if (
    connection.socket ||
    connection.timer ||
    connection.blocked ||
    document.hidden ||
    !connection.listeners.size
  )
    return;
  const url = new URL(`/api/workspaces/${connection.workspace}/events`, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch {
    schedule(connection);
    return;
  }
  connection.socket = socket;
  socket.onopen = () => {
    if (connection.socket !== socket) return;
    connection.attempts = 0;
    setConnected(connection, true);
    if (connection.gap) {
      connection.gap = false;
      emit(connection, "resync");
    }
  };
  socket.onmessage = (message) => {
    if (connection.socket !== socket) return;
    try {
      const data = JSON.parse(String(message.data)) as { type?: unknown; scope?: unknown };
      if (data.type === "changed" && typeof data.scope === "string" && scopes.has(data.scope))
        emit(connection, data.scope as WorkspaceEventScope);
    } catch {
      /* Unknown frames carry nothing to act on. */
    }
  };
  socket.onclose = (event) => {
    if (connection.socket !== socket) return;
    connection.socket = null;
    setConnected(connection, false);
    if (accessCodes.includes(event.code)) {
      // Access ended or the workspace was held; the parent view reflects that
      // through its own state and re-enables the channel after a wake.
      connection.blocked = true;
      return;
    }
    connection.gap = true;
    schedule(connection);
  };
  socket.onerror = () => {
    /* The close event schedules the bounded retry. */
  };
}
function disconnect(connection: Connection) {
  if (connection.timer) clearTimeout(connection.timer);
  connection.timer = null;
  const socket = connection.socket;
  connection.socket = null;
  setConnected(connection, false);
  if (!socket) return;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
  // Closing during the handshake logs a browser error; let it finish first.
  if (socket.readyState === WebSocket.CONNECTING) socket.onopen = () => socket.close(1000);
  else socket.close(1000);
}
function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      for (const connection of connections.values()) disconnect(connection);
      return;
    }
    for (const connection of connections.values()) {
      connection.attempts = 0;
      connection.blocked = false;
      emit(connection, "resync");
      connect(connection);
    }
  });
  window.addEventListener("online", () => {
    for (const connection of connections.values()) {
      if (connection.socket) continue;
      connection.attempts = 0;
      connection.gap = true;
      connect(connection);
    }
  });
}
export function subscribeWorkspaceEvents(
  workspace: string,
  listener: Listener,
  watcher: (connected: boolean) => void,
) {
  listen();
  let connection = connections.get(workspace);
  if (!connection) {
    connection = {
      workspace,
      listeners: new Set(),
      watchers: new Set(),
      socket: null,
      timer: null,
      attempts: 0,
      blocked: false,
      gap: false,
      connected: false,
    };
    connections.set(workspace, connection);
  }
  const active = connection;
  active.listeners.add(listener);
  active.watchers.add(watcher);
  watcher(active.connected);
  if (!active.socket && !active.timer) {
    active.attempts = 0;
    active.blocked = false;
    connect(active);
  }
  return () => {
    active.listeners.delete(listener);
    active.watchers.delete(watcher);
    if (active.listeners.size) return;
    disconnect(active);
    if (connections.get(workspace) === active) connections.delete(workspace);
  };
}
/** Subscribes while `enabled`; returns whether the shared socket is open. */
export function useWorkspaceEvents(
  workspace: string,
  enabled: boolean,
  onSignal: (signal: WorkspaceSignal) => void,
) {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onSignal);
  handler.current = onSignal;
  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }
    return subscribeWorkspaceEvents(workspace, (signal) => handler.current(signal), setConnected);
  }, [workspace, enabled]);
  return connected;
}
