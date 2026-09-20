import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, apiStatus } from "./api.ts";
import { useSystemTheme } from "./theme.ts";
import "./terminal.css";

export function Terminal({
  workspace,
  available,
  visible,
}: {
  workspace: string;
  available: boolean;
  visible: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [activated, setActivated] = useState(visible);
  useEffect(() => {
    if (visible) setActivated(true);
  }, [visible]);
  const [status, setStatus] = useState("Disconnected");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const activity = useRef({ visible });
  activity.current = { visible };
  const controls = useRef({ open: () => {}, retry: () => {}, disconnect: () => {} });
  const terminalRef = useRef<Xterm | null>(null);
  const touch = useRef<{ x: number; y: number; started: number } | null>(null);
  const focusInput = () => {
    if (connected) terminalRef.current?.focus();
  };
  const theme = useSystemTheme();
  const palette = useMemo(
    () =>
      theme === "dark"
        ? {
            background: "#1e1e1e",
            foreground: "#d4d4d4",
            cursor: "#d4d4d4",
            selectionBackground: "#264f78",
          }
        : {
            background: "#ffffff",
            foreground: "#24292e",
            cursor: "#24292e",
            selectionBackground: "#caddf2",
          },
    [theme],
  );
  const latestPalette = useRef(palette);
  latestPalette.current = palette;
  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = palette;
  }, [palette]);
  useEffect(() => {
    if (!activated || !available || !host.current) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let pending = false;
    let blocked = false;
    let manuallyDisconnected = false;
    let attempts = 0;
    let generation = 0;
    let readySince = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    const terminal = new Xterm({
      fontSize: 13,
      cursorBlink: true,
      scrollback: 2000,
      theme: latestPalette.current,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    // Keep xterm's native input/IME path. Mobile keyboards need an editable
    // textarea focused synchronously from a gesture, not after tool preparation.
    terminal.textarea?.setAttribute("inputmode", "text");
    const beforeInput = (event: InputEvent) => {
      // Some virtual keyboards supply edit intentions without keydown. Xterm
      // handles text and composition itself, but only recognizes insertText in
      // its input listener. Cancel these edits so its keyCode=229 fallback cannot
      // also send the textarea mutation. Hardware keys are canceled by xterm
      // before beforeinput; composing text must remain entirely under its care.
      if (!event.cancelable || event.isComposing || socket?.readyState !== WebSocket.OPEN) return;
      const data =
        event.inputType === "deleteContentBackward"
          ? "\x7f"
          : ["insertLineBreak", "insertParagraph"].includes(event.inputType)
            ? "\r"
            : null;
      if (data) {
        event.preventDefault();
        terminal.input(data, true);
      }
    };
    terminal.textarea?.addEventListener("beforeinput", beforeInput);
    terminalRef.current = terminal;
    const focusDesktopInput = () => {
      // Automatic focus cannot summon a phone keyboard and may steal focus on
      // reconnect. Touch users focus directly with a tap or the keyboard action.
      if (!window.matchMedia("(pointer: coarse)").matches) terminal.focus();
    };
    setConnected(false);
    setBusy(false);
    setStatus("Disconnected");
    const resize = () => {
      if (host.current?.offsetWidth && host.current.offsetHeight) {
        fit.fit();
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const fail = (message: string) => {
      blocked = true;
      setBusy(false);
      setStatus(message);
    };
    const retry = () => {
      if (attempts >= 3) {
        fail("Could not reconnect to the terminal. Retry to resume your shell.");
        return;
      }
      attempts += 1;
      setBusy(true);
      setStatus(`Reconnecting (${attempts}/3)`);
      retryTimer = setTimeout(
        () => {
          retryTimer = undefined;
          void connect();
        },
        1000 * 2 ** (attempts - 1),
      );
    };
    const connect = async () => {
      if (disposed || pending || blocked || manuallyDisconnected || socket || retryTimer) return;
      pending = true;
      const attempt = ++generation;
      setBusy(true);
      setStatus(attempts ? `Reconnecting (${attempts}/3)` : "Preparing tools");
      try {
        await api(`/workspaces/${workspace}/agent/prepare`, "POST");
        if (disposed || attempt !== generation) return;
        pending = false;
        const url = new URL(`/api/workspaces/${workspace}/terminal`, location.href);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const connection = new WebSocket(url);
        socket = connection;
        setStatus(attempts ? `Reconnecting (${attempts}/3)` : "Connecting");
        openTimer = setTimeout(() => {
          if (socket !== connection || disposed) return;
          connection.onclose = null;
          connection.close();
          socket = null;
          retry();
        }, 15000);
        connection.onopen = () => {
          if (socket !== connection || disposed) return;
          clearTimeout(openTimer);
          readySince = Date.now();
          setConnected(true);
          setBusy(false);
          setStatus("Connected");
          // The server replays its shell buffer when reattaching.
          terminal.reset();
          resize();
          if (activity.current.visible) focusDesktopInput();
        };
        connection.onmessage = (event) => {
          if (socket !== connection || disposed) return;
          const message = JSON.parse(event.data);
          if (message.type === "output") terminal.write(message.data);
        };
        connection.onclose = (event) => {
          if (socket !== connection || disposed) return;
          clearTimeout(openTimer);
          socket = null;
          setConnected(false);
          if ([1008, 4001, 4003, 4401, 4403].includes(event.code)) {
            fail("This session no longer has workspace access. Sign in again to continue.");
            return;
          }
          if (readySince && Date.now() - readySince > 30000) attempts = 0;
          readySince = 0;
          retry();
        };
        connection.onerror = () => {
          // Close reports access failure or schedules a bounded transient retry.
        };
      } catch (error) {
        if (disposed || attempt !== generation) return;
        pending = false;
        // A just-woken Sprite can fail its first preparation upstream; use the
        // bounded reconnect budget before showing that as an error. Auth and
        // installation failures keep their actual message.
        const status = apiStatus(error);
        if ((status === undefined || status >= 500) && attempts < 3) {
          retry();
          return;
        }
        fail(error instanceof Error ? error.message : "Could not prepare terminal tools.");
      }
    };
    controls.current = {
      open: () => {
        resize();
        if (socket?.readyState === WebSocket.OPEN) focusDesktopInput();
        else void connect();
      },
      retry: () => {
        blocked = false;
        manuallyDisconnected = false;
        attempts = 0;
        void connect();
      },
      disconnect: () => {
        manuallyDisconnected = true;
        generation += 1;
        pending = false;
        clearTimeout(retryTimer);
        retryTimer = undefined;
        clearTimeout(openTimer);
        if (socket) {
          socket.onclose = null;
          socket.close();
          socket = null;
        }
        setConnected(false);
        setBusy(false);
        setStatus("Disconnected · reconnect to resume");
      },
    };
    const input = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "input", data }));
    });
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    void connect();
    return () => {
      disposed = true;
      generation += 1;
      clearTimeout(retryTimer);
      clearTimeout(openTimer);
      controls.current = { open: () => {}, retry: () => {}, disconnect: () => {} };
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      input.dispose();
      terminal.textarea?.removeEventListener("beforeinput", beforeInput);
      observer.disconnect();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [workspace, available, activated]);
  // A hidden terminal still streams tmux output through the server. Detach a
  // few seconds after the tab is hidden and reattach to the same tmux session
  // when it is shown again; nothing typed is lost.
  const detachedWhileHidden = useRef(false);
  useEffect(() => {
    if (!available) return;
    if (visible) {
      if (detachedWhileHidden.current) {
        detachedWhileHidden.current = false;
        controls.current.retry();
      } else controls.current.open();
      return;
    }
    const timer = setTimeout(() => {
      detachedWhileHidden.current = true;
      controls.current.disconnect();
    }, 5000);
    return () => clearTimeout(timer);
  }, [visible, available]);
  return (
    <section className="workspace-panel terminal-panel" hidden={!visible}>
      <div className="section-heading">
        <div>
          <h2>Your Sprite terminal</h2>
          <p>
            Run Claude, OpenCode, Python, or other project tools. The shell stays in your Sprite
            when you close this view.
          </p>
        </div>
        <div className="button-row terminal-actions">
          <button
            type="button"
            className="button"
            disabled={!connected}
            onClick={() => {
              // A dismissed phone keyboard can leave the textarea active.
              // Refocus during this same gesture to request the keyboard again.
              terminalRef.current?.blur();
              focusInput();
            }}
          >
            Type in terminal
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!available || busy}
            onClick={() => {
              if (connected) controls.current.disconnect();
              else controls.current.retry();
            }}
          >
            {connected ? "Disconnect" : busy ? "Connecting…" : "Reconnect terminal"}
          </button>
        </div>
      </div>
      {!available ? (
        <p role="status">A running Sprite and an open event are required for terminal access.</p>
      ) : (
        <p role="status">{status}</p>
      )}
      <div
        ref={host}
        className="sprite-terminal"
        onTouchStart={(event) => {
          const first = event.touches[0];
          touch.current =
            event.touches.length === 1 && first
              ? { x: first.clientX, y: first.clientY, started: Date.now() }
              : null;
        }}
        onTouchMove={(event) => {
          const first = event.touches[0];
          if (
            !first ||
            (touch.current &&
              Math.hypot(first.clientX - touch.current.x, first.clientY - touch.current.y) > 10)
          )
            touch.current = null;
        }}
        onTouchCancel={() => {
          touch.current = null;
        }}
        onTouchEnd={(event) => {
          const tap = touch.current;
          touch.current = null;
          // Leave scrolling, long-press selection, links and pinch zoom to xterm/browser.
          if (
            tap &&
            !event.touches.length &&
            Date.now() - tap.started < 400 &&
            !terminalRef.current?.hasSelection() &&
            !(event.target instanceof Element && event.target.closest("a"))
          )
            focusInput();
        }}
      />
    </section>
  );
}
