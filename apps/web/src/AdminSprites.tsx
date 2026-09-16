import { useCallback, useEffect, useState } from "react";
import type { SpriteInventory } from "../../../packages/domain/src/lifecycle.ts";
import { api } from "./api.ts";
import { Badge, Modal } from "./components.tsx";
import "./sprite-inventory.css";

type Row = SpriteInventory["sprites"][number];
type Action =
  | { kind: "pause-sprites" | "pause-event" | "unpause-event" }
  | { kind: "pause" | "delete"; row: Row };
function elapsed(hours: number | null) {
  if (hours === null) return "—";
  if (hours < 1) return `${Math.floor(hours * 60)}m`;
  if (hours < 24) return `${Math.floor(hours)}h ${Math.floor(hours * 60) % 60}m`;
  return `${Math.floor(hours / 24)}d ${Math.floor(hours) % 24}h`;
}
function status(row: Row) {
  if (row.runtime.deletion?.state === "failed") return "Delete needs retry";
  if (row.runtime.deletion?.state === "pending") return "Deleting…";
  if (row.runtime.deletion?.state === "deleted")
    return row.runtime.deletion.replacementReserved ? "Rebuilding" : "Deleted";
  if (row.runtime.stopState === "failed") return "Pause needs retry";
  if (row.runtime.stopState === "pending") return "Pausing…";
  if (row.working) return `${row.provider.status} · Working`;
  return row.runtime.held ? `${row.provider.status} · Paused` : row.provider.status;
}
export function AdminSprites({
  eventId,
  refresh,
}: {
  eventId: string;
  refresh: () => Promise<void>;
}) {
  const [inventory, setInventory] = useState<SpriteInventory | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setInventory(await api<SpriteInventory>(`/events/${eventId}/sprites`));
  }, [eventId]);
  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, [load]);
  const label =
    action?.kind === "pause"
      ? "Pause Sprite"
      : action?.kind === "delete"
        ? "Delete Sprite"
        : action?.kind === "pause-sprites"
          ? "Pause all Sprites"
          : action?.kind === "pause-event"
            ? "Pause hackathon"
            : "Unpause hackathon";
  async function confirm() {
    if (!action) return;
    setBusy(true);
    setError("");
    try {
      const result =
        "row" in action
          ? await api<{ failures: number }>(
              `/events/${eventId}/sprites/${action.row.workspaceId}`,
              "POST",
              {
                action: action.kind,
                generation: action.row.runtime.generation,
              },
            )
          : await api<{ failures?: number }>(`/events/${eventId}/execution`, "POST", {
              action: action.kind,
            });
      setAction(null);
      setNotice(
        result.failures
          ? "Some actions need a retry. Affected workspaces remain blocked."
          : action.kind === "delete"
            ? "Sprite deleted. Shared team Git remains."
            : action.kind === "unpause-event"
              ? "Owners can reopen their workspaces."
              : "Workspace access paused.",
      );
      await refresh();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action could not complete. Retry.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="section sprite-inventory" aria-labelledby="sprite-title">
      <div className="section-heading">
        <h2 id="sprite-title">Workspace Sprites</h2>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void load().catch((e: Error) => setError(e.message))}
        >
          Refresh status
        </button>
      </div>
      <div className="button-row">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => setAction({ kind: "pause-sprites" })}
        >
          Pause all Sprites
        </button>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() =>
            setAction({ kind: inventory?.event.paused ? "unpause-event" : "pause-event" })
          }
        >
          {inventory?.event.paused ? "Unpause hackathon" : "Pause hackathon"}
        </button>
        {inventory?.event.paused && <Badge tone="amber">Hackathon paused</Badge>}
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!inventory ? (
        <p>Loading Sprite status…</p>
      ) : (
        <>
          <p className="small-text muted sprite-list-note">{inventory.sprites.length} workspaces</p>
          <table className="sprite-list" aria-label="Event Sprites">
            <thead>
              <tr>
                <th scope="col">Owner / team</th>
                <th scope="col">Status</th>
                <th scope="col">Runtime</th>
                <th scope="col">Estimated cost</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {inventory.sprites.map((row) => (
                <tr key={row.workspaceId} data-workspace={row.workspaceId}>
                  <th
                    scope="row"
                    className="sprite-identity"
                    title={`${row.spriteName}${row.membershipActive ? "" : " · Retained workspace"}`}
                  >
                    <span>{row.owner}</span>
                    <small>{row.team}</small>
                  </th>
                  <td
                    className="sprite-status"
                    title={
                      row.runtime.deletion?.error ??
                      row.runtime.stopError ??
                      row.provider.error ??
                      `Provider observed ${new Date(row.provider.observedAt).toLocaleString()}`
                    }
                  >
                    {status(row)}
                  </td>
                  <td
                    className="sprite-time"
                    title={
                      row.provider.createdAt
                        ? `Since ${new Date(row.provider.createdAt).toLocaleString()}`
                        : "Start unavailable"
                    }
                  >
                    <span className="sprite-mobile-label">Runtime </span>
                    {elapsed(row.assumedRuntimeHours)}
                  </td>
                  <td className="sprite-cost">
                    <span className="sprite-mobile-label">Est. </span>
                    {row.estimatedUsd === null
                      ? "—"
                      : new Intl.NumberFormat("en-US", {
                          style: "currency",
                          currency: "USD",
                        }).format(row.estimatedUsd)}
                  </td>
                  <td className="sprite-actions">
                    <button
                      type="button"
                      className="button"
                      disabled={
                        busy ||
                        Boolean(
                          row.runtime.deletion &&
                            !(
                              row.runtime.deletion.state === "deleted" &&
                              row.runtime.deletion.replacementReserved
                            ),
                        )
                      }
                      onClick={() => setAction({ kind: "pause", row })}
                    >
                      {row.runtime.stopState === "failed" ? "Retry pause" : "Pause"}
                    </button>
                    <button
                      type="button"
                      className="button danger"
                      disabled={
                        busy ||
                        (row.runtime.deletion?.state === "deleted" &&
                          !row.runtime.deletion.replacementReserved)
                      }
                      onClick={() => setAction({ kind: "delete", row })}
                    >
                      {row.runtime.deletion?.state === "failed" ? "Retry delete" : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!inventory.sprites.length && <p>No Sprites have been allocated for this event.</p>}
        </>
      )}
      {action && (
        <Modal
          title={label}
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <div className="modal-body">
            {"row" in action && (
              <p>
                <strong>{action.row.owner}</strong> · {action.row.team}
              </p>
            )}
            <p>
              {action.kind === "delete"
                ? "Permanently delete this Sprite and its unshared private files, saved keys and conversation history. Shared team Git remains. The owner can reopen a new workspace from shared Git."
                : action.kind === "pause"
                  ? "Interrupt this workspace’s agents, terminal and preview. Saved files and conversations remain. Its owner can reopen it unless the hackathon is paused."
                  : action.kind === "pause-sprites"
                    ? "Interrupt agents, terminals and previews for this event. Saved files and conversations remain. Owners can reload their workspaces to resume."
                    : action.kind === "pause-event"
                      ? "Interrupt agents, terminals and previews and block workspace execution until an admin unpauses. Shared team source remains available to download. Saved files and conversations remain."
                      : "Allow owners to resume their workspaces on demand. This does not start all Sprites."}
            </p>
            {action.kind.startsWith("pause") && (
              <p>Unsaved changes inside running programs may be lost.</p>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setAction(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`button ${action.kind === "delete" ? "danger" : "primary"}`}
                disabled={busy}
                onClick={() => void confirm()}
              >
                {busy ? "Please wait…" : label}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
