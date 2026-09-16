import { useCallback, useEffect, useState } from "react";
import type { SpriteInventory } from "../../../packages/domain/src/lifecycle.ts";
import { SPRITE_PRICING } from "../../../packages/domain/src/lifecycle.ts";
import { api } from "./api.ts";
import { Badge, Modal } from "./components.tsx";

const timestamp = (value: string | null) => (value ? new Date(value).toLocaleString() : "Unknown");
export function AdminSprites({
  eventId,
  refresh,
}: {
  eventId: string;
  refresh: () => Promise<void>;
}) {
  const [inventory, setInventory] = useState<SpriteInventory | null>(null);
  const [action, setAction] = useState<"pause-sprites" | "pause-event" | "unpause-event" | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const data = await api<SpriteInventory>(`/events/${eventId}/sprites`);
    setInventory(data);
  }, [eventId]);
  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, [load]);
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ failures?: number }>(`/events/${eventId}/execution`, "POST", {
        action,
      });
      setAction(null);
      setNotice(
        result.failures
          ? `${result.failures} Sprite pauses need a retry. Access remains blocked.`
          : action === "unpause-event"
            ? "Workspaces can resume when their owners reload."
            : "Workspace access paused. Provider sleep follows when runtime activity stops.",
      );
      await refresh();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pause could not complete. Retry.");
    } finally {
      setBusy(false);
    }
  }
  const label =
    action === "pause-sprites"
      ? "Pause all Sprites"
      : action === "pause-event"
        ? "Pause hackathon"
        : "Unpause hackathon";
  return (
    <section className="section sprite-inventory" aria-labelledby="sprite-title">
      <div className="section-heading">
        <div>
          <h2 id="sprite-title">Workspace Sprites</h2>
          <p>Runtime status for this event’s allocated workspaces.</p>
        </div>
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
          onClick={() => setAction("pause-sprites")}
        >
          Pause all Sprites
        </button>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => setAction(inventory?.event.paused ? "unpause-event" : "pause-event")}
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
          <p className="small-text muted">
            {inventory.sprites.length} allocated · Status refresh does not open a workspace.
            Background polling is not participant activity.
          </p>
          <div className="sprite-grid">
            {inventory.sprites.map((row) => (
              <article className="sprite-card" key={row.workspaceId}>
                <h3>{row.team}</h3>
                <p>
                  {row.owner}
                  {!row.membershipActive && " · Retained workspace"}
                </p>
                <code>{row.spriteName}</code>
                <div className="button-row">
                  <Badge tone={row.provider.status === "running" ? "green" : "neutral"}>
                    {row.provider.status}
                  </Badge>
                  <span>{row.working ? "Model turn in progress" : "No model turn observed"}</span>
                </div>
                <dl>
                  <dt>Created · provider</dt>
                  <dd>{timestamp(row.provider.createdAt)}</dd>
                  <dt>Updated · provider</dt>
                  <dd>{timestamp(row.provider.updatedAt)}</dd>
                  <dt>Status observed</dt>
                  <dd>{timestamp(row.provider.observedAt)}</dd>
                  <dt>Last participant use · portal</dt>
                  <dd>{timestamp(row.runtime.lastUsedAt)}</dd>
                  <dt>Runtime start / active hours</dt>
                  <dd>Not supplied by provider metadata</dd>
                  <dt>Pause</dt>
                  <dd>
                    {row.runtime.stopState === "failed"
                      ? "Needs retry"
                      : row.runtime.held
                        ? "Access paused"
                        : "On demand"}
                  </dd>
                  <dt>Cost estimate</dt>
                  <dd>
                    Total unknown. CPU only:{" "}
                    {row.cpuLifetimeCeilingUsd === null
                      ? "no allocation date available"
                      : `$0–$${row.cpuLifetimeCeilingUsd.toFixed(2)} allocation-age ceiling`}
                    .
                  </dd>
                </dl>
                {row.provider.error && <p role="status">{row.provider.error}</p>}
                {row.runtime.stopError && <p className="error">{row.runtime.stopError}</p>}
              </article>
            ))}
          </div>
          {!inventory.sprites.length && <p>No Sprites have been allocated for this event.</p>}
          <details>
            <summary>Cost and sleep estimates</summary>
            <p>
              CPU bounds assume between zero and eight fully used CPUs for the entire allocation
              age, including unknown sleep time. They are not a total charge. Actual CPU seconds,
              memory GB-hours, active history and stored bytes are unavailable here.
            </p>
            <p>
              Provider sleep has no compute charges; stored data can still cost money. Rates in USD
              as of {SPRITE_PRICING.asOf}: ${SPRITE_PRICING.cpuHour}/CPU-hour, $
              {SPRITE_PRICING.memoryGbHour}/memory GB-hour, ${SPRITE_PRICING.hotStorageGbHour}/hot
              storage GB-hour and ${SPRITE_PRICING.coldStorageGbHour}/cold storage GB-hour. Model
              charges, plan allowances and other hosting costs are excluded.{" "}
              <a href={SPRITE_PRICING.source} target="_blank" rel="noreferrer">
                Official pricing
              </a>
            </p>
            <p>
              Sprites suspend automatically after about 30 seconds without provider activity. Civic
              Spark releases inactive workspace polling after {inventory.idleMinutes} minutes.
              Active model turns, recent terminal input/output and recent preview use delay idle
              release.
            </p>
          </details>
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
            <p>
              {action === "pause-sprites"
                ? "Interrupt agents, terminals and previews for this event. Saved files and conversations remain. Owners can reload their workspaces to resume."
                : action === "pause-event"
                  ? "Interrupt agents, terminals and previews and block workspace execution until an admin unpauses. Shared team source remains available to download. Saved files and conversations remain."
                  : "Allow owners to resume their existing workspaces on demand. This does not start all Sprites."}
            </p>
            {action !== "unpause-event" && (
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
                className="button primary"
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
