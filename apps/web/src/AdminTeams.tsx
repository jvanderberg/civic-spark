import { Copy, GitBranch, Trash2, Users } from "lucide-react";
import { useState } from "react";
import type { TeamView } from "../../../packages/domain/src/access-types.ts";
import { api } from "./api.ts";
import { Badge, Empty, Field, Modal } from "./components.tsx";
import { RepositoryBrowser } from "./RepositoryBrowser.tsx";

export function AdminTeams({
  teams,
  refresh,
}: {
  teams: TeamView[];
  refresh: () => Promise<void>;
}) {
  const [repository, setRepository] = useState<TeamView | null>(null);
  const [copying, setCopying] = useState<TeamView | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function remove(team: TeamView) {
    if (
      !window.confirm(
        `Delete team “${team.name}” from this event?\n\nIts ${team.memberCount} members will lose access to this team's workspaces. The shared repository and private work will be retained on disk for recovery. Other teams and accounts are unaffected.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/teams/${team.id}`, "DELETE", { confirmed: true });
      setNotice(`Deleted ${team.name}.`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete team.");
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    if (!copying) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/teams/${copying.id}/copy`, "POST", { name });
      setCopying(null);
      setNotice(`Created ${name}. Members can now join the new team.`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not copy team.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="section">
      <div className="section-heading">
        <div>
          <h2>Teams & repositories</h2>
          <p>Open a team to browse its shared files, commits and diffs.</p>
        </div>
      </div>
      {error && !copying && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="team-grid">
        {teams.map((team) => (
          <article className="team-card" key={team.id}>
            <div className="team-card-top">
              <span className="team-number">{team.number}</span>
              <Badge>{team.memberCount} members</Badge>
            </div>
            <h3>{team.name}</h3>
            <p>{team.projectName}</p>
            <div className="member-names">
              <Users size={15} />
              {team.memberNames.join(", ") || "No members yet"}
            </div>
            <footer className="admin-team-actions">
              <button
                className="button small"
                type="button"
                disabled={busy}
                onClick={() => setRepository(team)}
              >
                <GitBranch size={14} />
                Repository
              </button>
              <button
                className="button small"
                type="button"
                disabled={busy}
                onClick={() => {
                  setError("");
                  setCopying(team);
                  setName(`${team.name.slice(0, 75)} copy`);
                }}
              >
                <Copy size={14} />
                Copy team
              </button>
              <button
                className="button small danger-button"
                type="button"
                disabled={busy}
                onClick={() => void remove(team)}
              >
                <Trash2 size={14} />
                Delete team
              </button>
            </footer>
          </article>
        ))}
      </div>
      {!teams.length && (
        <Empty title="No teams yet">Teams will appear here when participants create them.</Empty>
      )}
      {repository && teams.some((t) => t.id === repository.id) && (
        <RepositoryBrowser
          key={repository.id}
          team={repository}
          onClose={() => setRepository(null)}
        />
      )}
      {copying && (
        <Modal title={`Copy ${copying.name}`} onClose={() => !busy && setCopying(null)}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void copy();
            }}
          >
            <p>
              Start a separate team with the current shared project, brief and commit history.
              Members and private workspaces are not copied.
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <Field label="New team name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                minLength={2}
                maxLength={80}
                required
                disabled={busy}
              />
            </Field>
            <div className="form-actions">
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => setCopying(null)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={busy || name.trim().length < 2}
              >
                {busy ? "Copying…" : "Create copy"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
