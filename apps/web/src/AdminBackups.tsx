import { Download, Plus, RotateCcw, Trash2, Upload } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { BackupSummary, RestoreReport } from "../../../packages/backup/src/live.ts";
import type { BackupStatus } from "../../server/src/backups.ts";
import { api } from "./api.ts";
import { Badge, Empty, Modal } from "./components.tsx";
import "./backups.css";

type RestoreResult = RestoreReport & { restarting: boolean };
function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
const when = (iso: string) => new Date(iso).toLocaleString();

async function waitForRestart(signal: { cancelled: boolean }) {
  const healthy = async () => {
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      return response.ok;
    } catch {
      return false;
    }
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let wentDown = false;
  const started = Date.now();
  while (!signal.cancelled && Date.now() - started < 180000) {
    await sleep(1500);
    const ok = await healthy();
    if (!ok) wentDown = true;
    else if (wentDown) return true;
  }
  return false;
}

export function AdminBackups({ eventId }: { eventId: string }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [restoring, setRestoring] = useState<BackupSummary | null>(null);
  const [restarting, setRestarting] = useState<RestoreResult | null>(null);
  const [restartOutcome, setRestartOutcome] = useState<"waiting" | "manual" | "timeout">("waiting");
  const fileInput = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    setStatus(await api<BackupStatus>(`/events/${eventId}/backups`));
  }, [eventId]);
  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, [load]);
  useEffect(() => {
    if (!restarting) return;
    if (!restarting.restarting) {
      setRestartOutcome("manual");
      return;
    }
    const signal = { cancelled: false };
    void waitForRestart(signal).then((restarted) => {
      if (signal.cancelled) return;
      if (restarted) window.location.reload();
      else setRestartOutcome("timeout");
    });
    return () => {
      signal.cancelled = true;
    };
  }, [restarting]);

  async function act(task: () => Promise<string>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setNotice(await task());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The backup action could not complete.");
    } finally {
      setBusy(false);
    }
  }
  const create = () =>
    act(async () => {
      await api<BackupSummary>(`/events/${eventId}/backups`, "POST", {});
      return "Backup created.";
    });
  const remove = (backup: BackupSummary) => {
    if (
      !window.confirm(
        `Delete the backup from ${when(backup.createdAt)}?\n\nThis removes the stored copy on the server. Downloaded copies are unaffected.`,
      )
    )
      return;
    void act(async () => {
      await api(`/events/${eventId}/backups/${backup.backupId}`, "DELETE", { confirmed: true });
      return "Backup deleted.";
    });
  };
  const upload = (file: File) =>
    act(async () => {
      const response = await fetch(`/api/events/${eventId}/backups/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/x-tar" },
        body: file,
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : `Upload failed (HTTP ${response.status}).`;
        throw new Error(message);
      }
      return "Backup uploaded and verified.";
    });
  const discard = () =>
    act(async () => {
      await api(`/events/${eventId}/backups/pending/discard`, "POST", { confirmed: true });
      return "Staged restore discarded. The current data remains in use.";
    });
  async function confirmRestore() {
    if (!restoring) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<RestoreResult>(
        `/events/${eventId}/backups/${restoring.backupId}/restore`,
        "POST",
        { confirmed: true },
      );
      setRestoring(null);
      setRestarting(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The restore could not start.");
    } finally {
      setBusy(false);
    }
  }

  if (restarting)
    return (
      <section className="section backups" aria-labelledby="backup-title">
        <h2 id="backup-title">Restoring backup</h2>
        <div className="backup-restart" role="status" aria-live="polite">
          {restartOutcome === "waiting" && (
            <p>
              The application is restarting with the data from {when(restarting.createdAt)}. This
              page reloads when it is back. Everyone will need to sign in again.
            </p>
          )}
          {restartOutcome === "manual" && (
            <p>
              The restore is staged. Restart the Civic Spark server to apply it; the restore
              completes on startup and the current data is kept beside it.
            </p>
          )}
          {restartOutcome === "timeout" && (
            <p>The application has not come back yet. Check the server, then reload this page.</p>
          )}
          <RestoreDetails report={restarting} />
        </div>
      </section>
    );

  return (
    <section className="section backups" aria-labelledby="backup-title">
      <div className="section-heading">
        <div>
          <h2 id="backup-title">Backups</h2>
          <p>
            Copies of this installation: accounts, events, projects, teams, memberships and shared
            repositories. Private Sprite files, saved model keys, agent conversations and sign-in
            tokens are not included.
          </p>
        </div>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void load().catch((e: Error) => setError(e.message))}
        >
          Refresh
        </button>
      </div>
      <div className="button-row backup-actions-row">
        <button
          type="button"
          className="button primary"
          disabled={busy || Boolean(status?.pending)}
          onClick={() => void create()}
        >
          <Plus size={15} /> Create backup
        </button>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          <Upload size={15} /> Upload backup
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".tar,application/x-tar"
          hidden
          aria-label="Backup archive file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
      </div>
      {busy && (
        <p role="status" className="backup-progress">
          Working… large installations can take a few minutes.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {status?.pending && (
        <div className="backup-pending" role="status">
          <p>
            A restore of the backup from {when(status.pending.requestedAt)} is waiting for the
            server to restart. Restart it to apply the restore, or discard the staged copy.
          </p>
          <button type="button" className="button" disabled={busy} onClick={() => void discard()}>
            Discard staged restore
          </button>
        </div>
      )}
      {status?.lastRestore && (
        <details className="backup-last-restore">
          <summary>
            Last restore applied{" "}
            {status.lastRestore.appliedAt ? when(status.lastRestore.appliedAt) : ""}
          </summary>
          <RestoreDetails report={status.lastRestore} />
        </details>
      )}
      {status && (
        <dl className="backup-config">
          <dt>Stored in</dt>
          <dd>{status.directory}</dd>
          {status.replacedRoots.length > 0 && (
            <>
              <dt>Replaced data kept</dt>
              <dd>{status.replacedRoots.join(", ")}</dd>
            </>
          )}
        </dl>
      )}
      {status && status.backups.length === 0 ? (
        <Empty title="No backups yet">
          Create a backup to keep a copy on the server, then download it to store a copy elsewhere.
        </Empty>
      ) : (
        status && (
          <table className="backup-list">
            <thead>
              <tr>
                <th scope="col">Created</th>
                <th scope="col">Contents</th>
                <th scope="col">Size</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {status.backups.map((backup) => (
                <tr key={backup.backupId}>
                  <td className="backup-created">
                    <span>{when(backup.createdAt)}</span>
                    <small>
                      {backup.consistency === "live-online-snapshot" ? "Live" : "Offline"} · release{" "}
                      {backup.release.slice(0, 7)}
                    </small>
                  </td>
                  <td className="backup-contents">
                    <span className="backup-mobile-label">Contents</span>
                    {backup.events} events · {backup.teams} teams · {backup.users} accounts ·{" "}
                    {backup.repositories} repositories
                    {backup.reservations > 0 && <Badge>{backup.reservations} Sprites</Badge>}
                  </td>
                  <td className="backup-size">
                    <span className="backup-mobile-label">Size</span>
                    {bytes(backup.bytes)}
                  </td>
                  <td className="backup-actions">
                    <a
                      className="button small"
                      href={`/api/events/${eventId}/backups/${backup.backupId}/download`}
                      download={`civic-spark-backup-${backup.backupId}.tar`}
                    >
                      <Download size={14} /> Download
                    </a>
                    <button
                      type="button"
                      className="button small"
                      disabled={busy || Boolean(status.pending)}
                      onClick={() => setRestoring(backup)}
                    >
                      <RotateCcw size={14} /> Restore
                    </button>
                    <button
                      type="button"
                      className="button small"
                      disabled={busy}
                      onClick={() => remove(backup)}
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
      {status && status.unreadable.length > 0 && (
        <p className="backup-list-note">
          {status.unreadable.length} stored {status.unreadable.length === 1 ? "entry" : "entries"}{" "}
          {status.unreadable.length === 1 ? "is" : "are"} damaged or incomplete:{" "}
          {status.unreadable.join(", ")}
        </p>
      )}
      {restoring && (
        <Modal title="Restore backup" onClose={() => setRestoring(null)}>
          <div className="form backup-restore-body">
            <p>
              Replace all current data on this installation with the backup from{" "}
              <strong>{when(restoring.createdAt)}</strong>.
            </p>
            <ul>
              <li>
                Everything changed since then is removed from the live data: events, projects,
                teams, memberships, shared commits and Sprite assignments. The current data is kept
                on the server beside the restored copy.
              </li>
              <li>The application restarts and every session is signed out.</li>
              <li>
                Sprites created after the backup keep running but are no longer tracked; Sprites
                deleted after it show as missing until their owners rebuild from shared work.
              </li>
              <li>
                Private Sprite files, saved model keys and agent conversations are not restored.
              </li>
            </ul>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="form-actions backup-restore-actions">
            <button type="button" className="button" onClick={() => setRestoring(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void confirmRestore()}
            >
              Restore and restart
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function RestoreDetails({ report }: { report: RestoreReport }) {
  return (
    <dl className="backup-report">
      <dt>Backup</dt>
      <dd>{when(report.createdAt)}</dd>
      <dt>Requested by</dt>
      <dd>{report.requestedBy.email}</dd>
      {report.warnings.map((warning) => (
        <Item key={warning} label="Warning">
          {warning}
        </Item>
      ))}
      {report.untrackedSprites.length > 0 && (
        <Item label="Untracked Sprites">
          {report.untrackedSprites.join(", ")}. They were created after the backup and are no longer
          assigned to a workspace; delete them with the provider tools when no longer needed.
        </Item>
      )}
      {report.releasedReservations.length > 0 && (
        <Item label="Missing Sprites">
          {report.releasedReservations.join(", ")}. These were deleted after the backup; their
          owners can rebuild from shared work.
        </Item>
      )}
      {report.previewOriginsPreserved > 0 && (
        <Item label="Preview origins">
          {report.previewOriginsPreserved} newer permanent preview origins were kept.
        </Item>
      )}
    </dl>
  );
}
function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
