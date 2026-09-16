import {
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  Compass,
  FolderOpen,
  GitBranch,
  LayoutDashboard,
  Leaf,
  LogOut,
  MapPin,
  Plus,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type {
  PortalState,
  SessionView,
  TeamView,
} from "../../../packages/domain/src/access-types.ts";
import type { Contribution, Event } from "../../../packages/domain/src/types.ts";
import { api } from "./api.ts";
import { Badge, Empty, Field, initials, Modal } from "./components.tsx";
import { Workspace } from "./Workspace.tsx";

type Tab = "discover" | "teams" | "admin" | "schedule";
const nextStatus = {
  draft: "registration",
  registration: "live",
  live: "closed",
  closed: null,
} as const;
const nextLabel = {
  draft: "Open registration",
  registration: "Start event",
  live: "Close event",
  closed: "Event closed",
};

export function App() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [state, setState] = useState<PortalState | null>(null);
  const [eventId, setEventId] = useState("");
  const [tab, setTab] = useState<Tab>("discover");
  const [modal, setModal] = useState<"event" | "team" | null>(null);
  const [projectChoice, setProjectChoice] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(() =>
    new URLSearchParams(window.location.hash.slice(1)).get("workspace"),
  );
  const [addingAdmin, setAddingAdmin] = useState(false);
  const [review, setReview] = useState<Contribution | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    new URLSearchParams(window.location.search).has("error")
      ? "That sign-in link has expired or already been used. Request a new one below."
      : "",
  );
  const [sentTo, setSentTo] = useState("");
  const refresh = useCallback(async () => {
    const current = await api<SessionView>("/session");
    setSession(current);
    if (!current.user) {
      setState(null);
      setWorkspaceId(null);
      return;
    }
    const data = await api<PortalState>("/state");
    setState(data);
    const requestedWorkspace = new URLSearchParams(window.location.hash.slice(1)).get("workspace");
    const reopened = data.myWorkspaces.find((w) => w.id === requestedWorkspace);
    setEventId(
      (id) =>
        reopened?.eventId ??
        (data.events.some((e) => e.id === id) ? id : (data.events[0]?.id ?? "")),
    );
    setWorkspaceId((id) => (data.myWorkspaces.some((w) => w.id === id) ? id : null));
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    url.hash = workspaceId ? new URLSearchParams({ workspace: workspaceId }).toString() : "";
    window.history.replaceState(null, "", url);
  }, [workspaceId]);
  useEffect(() => {
    void refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);
  useEffect(() => {
    if (!session?.user) return;
    const timer = setInterval(() => void refresh().catch((e: Error) => setError(e.message)), 5000);
    return () => clearInterval(timer);
  }, [session?.user, refresh]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }
  function signIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email")).trim().toLowerCase();
    void run(async () => {
      if (session?.authMode === "prototype") {
        await api("/prototype/sign-in", "POST", {
          email,
          name: String(form.get("name") ?? "").trim(),
        });
        return;
      }
      await api("/auth/sign-in/magic-link", "POST", {
        email,
        name: String(form.get("name") ?? "").trim(),
        callbackURL: window.location.origin,
        errorCallbackURL: window.location.origin,
      });
      setSentTo(email);
    });
  }
  const event = state?.events.find((e) => e.id === eventId);
  const teams = state?.teams.filter((t) => t.eventId === eventId) ?? [];
  const myTeams = teams.filter((t) => t.joined);
  const members = state?.members.filter((m) => m.eventId === eventId) ?? [];
  const admin = event?.role === "admin";
  const activeTab = tab === "admin" && !admin ? "discover" : tab;
  const workspace = state?.myWorkspaces.find((w) => w.id === workspaceId);
  const canJoin =
    event?.status === "registration" ||
    event?.status === "live" ||
    (admin && event?.status === "draft");
  const contributions =
    state?.contributions.filter(
      (c) =>
        c.eventId === eventId && (activeTab === "admin" || myTeams.some((t) => t.id === c.teamId)),
    ) ?? [];
  function startTeam(projectId?: string) {
    setProjectChoice(projectId ?? event?.projects[0]?.id ?? "custom");
    setModal("team");
  }
  function openTeam(team: TeamView) {
    const own = state?.myWorkspaces.find((w) => w.teamId === team.id);
    if (!own) return;
    setWorkspaceId(own.id);
  }
  function submitEvent(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void run(async () => {
      const created = await api<Event>("/events", "POST", {
        name: form.get("name"),
        date: form.get("date"),
        timezone: form.get("timezone"),
        location: form.get("location"),
        capacity: Number(form.get("capacity")),
        budget: Number(form.get("budget")),
        templateId: form.get("templateId"),
      });
      setEventId(created.id);
      setModal(null);
      setTab("admin");
    });
  }
  function submitTeam(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void run(async () => {
      await api("/teams", "POST", {
        eventId,
        name: form.get("name"),
        ...(projectChoice === "custom"
          ? { customProject: { name: form.get("projectName"), brief: form.get("brief") } }
          : { projectId: projectChoice }),
      });
      setModal(null);
      setTab("teams");
    });
  }
  function teamCard(team: TeamView) {
    return (
      <article className="team-card" key={team.id}>
        <div className="team-card-top">
          <span className="team-number">{String(team.number).padStart(2, "0")}</span>
          <Badge tone={team.joined ? "green" : "neutral"}>
            {team.joined
              ? "Your team"
              : `${team.memberCount} ${team.memberCount === 1 ? "member" : "members"}`}
          </Badge>
        </div>
        <h3>{team.name}</h3>
        <p className="project-name">{team.projectName}</p>
        <p className="team-brief">{team.projectBrief}</p>
        <div className="member-names">
          <Users size={15} />
          <span>{team.memberNames.join(", ") || "Be the first to join"}</span>
        </div>
        <footer>
          {team.joined ? (
            <button type="button" className="button primary" onClick={() => openTeam(team)}>
              <FolderOpen size={16} /> Open my workspace
            </button>
          ) : (
            <button
              type="button"
              className="button"
              disabled={busy || !canJoin}
              onClick={() =>
                void run(async () => {
                  await api(`/teams/${team.id}/join`, "POST");
                  setTab("teams");
                })
              }
            >
              Join team <ArrowRight size={15} />
            </button>
          )}
          {team.joined && (
            <a className="text-link" href={`/api/teams/${team.id}/export`}>
              Team ZIP
            </a>
          )}
        </footer>
      </article>
    );
  }
  function reviews() {
    return (
      contributions.length > 0 && (
        <section className="section">
          <div className="section-heading">
            <div>
              <h2>Shared team changes</h2>
              <p>Contributions people have chosen to share with their team.</p>
            </div>
          </div>
          <div className="people-list">
            {contributions.map((c) => (
              <div className="person-row" key={c.id}>
                <GitBranch size={18} />
                <div className="person-name">
                  <strong>{c.title}</strong>
                  <span>{teams.find((t) => t.id === c.teamId)?.name}</span>
                </div>
                <Badge tone={c.status === "accepted" ? "green" : "amber"}>
                  {c.status === "accepted" ? "Shared" : c.status}
                </Badge>
                <button type="button" className="button small" onClick={() => setReview(c)}>
                  View changes
                </button>
              </div>
            ))}
          </div>
        </section>
      )
    );
  }
  if (!session)
    return (
      <div className="login-shell">
        <Empty title={error ? "Could not connect" : "Opening your workspace…"}>
          {error || "Checking your session."}
        </Empty>
      </div>
    );
  if (!session.user)
    return (
      <div className="login-shell">
        <div className="login-brand">
          <Leaf size={25} /> Civic Spark
        </div>
        <section className="login-card">
          <span className="eyebrow">MAKE SOMETHING TOGETHER</span>
          <h1>
            Your ideas.
            <br />
            Your teams.
            <br />
            Your workspace.
          </h1>
          <p>
            Join a community event, find a project, and build together. Everything you need is in
            your browser.
          </p>
          {sentTo ? (
            <div className="email-sent" role="status">
              <h2>Check your email</h2>
              <p>
                We sent a sign-in link to <strong>{sentTo}</strong>. Open it to verify your email
                and continue.
              </p>
              <p>The link is valid for 10 minutes and works once.</p>
              <button type="button" className="text-link" onClick={() => setSentTo("")}>
                Use another email or request a new link
              </button>
            </div>
          ) : (
            <form className="login-actions" onSubmit={signIn}>
              <Field label="Email address">
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="you@example.com"
                />
              </Field>
              <Field label="Name (optional, for your first visit)">
                <input
                  name="name"
                  autoComplete="name"
                  maxLength={80}
                  placeholder="How your teammates will know you"
                />
              </Field>
              <button
                type="submit"
                className="button primary email-sign-in"
                disabled={busy || (session.authMode !== "prototype" && !session.emailSignIn)}
              >
                {busy
                  ? "Please wait…"
                  : session.authMode === "prototype"
                    ? "Enter prototype"
                    : "Email me a sign-in link"}
              </button>
              <p className="small-text muted">
                {session.authMode === "prototype"
                  ? "Local prototype: enter any email. No verification email is sent. Use the same email to return to your account."
                  : "New here? Your first sign-in link also creates and verifies your account."}
              </p>
            </form>
          )}
          {session.authMode !== "prototype" && !session.emailSignIn && (
            <p className="auth-pending" role="status">
              Email sign-in is being configured. Please check back with your event organizer.
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <p className="login-fineprint">
            <ShieldCheck size={15} /> Your workspace belongs to you. Sign in to access it.
          </p>
        </section>
      </div>
    );
  if (workspace)
    return (
      <Workspace
        key={workspace.id}
        participant={workspace}
        eventClosed={event?.status === "closed"}
        spritesEnabled={state?.capabilities.sprites ?? false}
        onClose={() => setWorkspaceId(null)}
        onChanged={refresh}
      />
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-mark">
            <Leaf size={21} />
          </span>
          Civic Spark
        </a>
        <div className="sidebar-group">
          <p className="eyebrow">YOUR EVENT</p>
          <div className="event-picker">
            <select
              aria-label="Select event"
              value={eventId}
              onChange={(e) => {
                setEventId(e.target.value);
                setTab("discover");
              }}
            >
              {!state?.events.length && <option value="">Choose or create an event</option>}
              {state?.events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
            <ChevronDown size={14} />
          </div>
          <button type="button" className="new-event-link" onClick={() => setModal("event")}>
            <Plus size={14} /> Create an event
          </button>
        </div>
        <nav className="main-nav" aria-label="Event navigation">
          <button
            type="button"
            className={activeTab === "discover" ? "active" : ""}
            onClick={() => setTab("discover")}
          >
            <Compass size={19} /> Explore projects
          </button>
          <button
            type="button"
            className={activeTab === "teams" ? "active" : ""}
            onClick={() => setTab("teams")}
          >
            <FolderOpen size={19} /> My teams <span className="nav-count">{myTeams.length}</span>
          </button>
          <button
            type="button"
            className={activeTab === "schedule" ? "active" : ""}
            onClick={() => setTab("schedule")}
          >
            <CalendarDays size={19} /> Event schedule
          </button>
          {admin && (
            <button
              type="button"
              className={activeTab === "admin" ? "active" : ""}
              onClick={() => setTab("admin")}
            >
              <LayoutDashboard size={19} /> Admin overview
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="identity-card">
            <span className="avatar">{initials(session.user.name)}</span>
            <div>
              <strong>{session.user.name}</strong>
              <span title={session.user.email}>{session.user.email}</span>
            </div>
          </div>
          <button
            type="button"
            className="new-event-link"
            onClick={() =>
              void run(async () => {
                await api("/auth/sign-out", "POST", {});
                setSentTo("");
                setState(null);
                setWorkspaceId(null);
              })
            }
          >
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span>
            {session.authMode === "prototype"
              ? "Local prototype · email identity"
              : activeTab === "admin"
                ? "Event administration"
                : "Your event space"}
          </span>
          <Badge tone={admin ? "green" : "neutral"}>{admin ? "Event admin" : "Participant"}</Badge>
        </header>
        <main>
          {error && (
            <div role="alert" className="error global-error">
              {error}
            </div>
          )}
          {!state ? (
            <Empty title="Loading your events…">Retrieving your teams and workspaces.</Empty>
          ) : !event ? (
            <section className="welcome">
              <span className="welcome-icon">
                <Leaf size={34} />
              </span>
              <h1>Welcome, {session.user.name.split(" ")[0]}.</h1>
              <p>There are no open events yet. Create one to bring your community together.</p>
              <button type="button" className="button primary" onClick={() => setModal("event")}>
                <Plus size={17} /> Create your first event
              </button>
            </section>
          ) : (
            <>
              <section className="page-heading">
                <div>
                  <div className="button-row">
                    <p className="eyebrow">
                      {activeTab === "admin"
                        ? "YOUR EVENT AT A GLANCE"
                        : "BUILD SOMETHING THAT MATTERS"}
                    </p>
                    <Badge>
                      {event.status === "registration" ? "Registration open" : event.status}
                    </Badge>
                  </div>
                  <h1>{event.name}</h1>
                  <div className="event-meta">
                    <span>
                      <CalendarDays size={15} />
                      {new Date(`${event.date}T12:00:00Z`).toLocaleDateString("en-US", {
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                        timeZone: "UTC",
                      })}
                    </span>
                    <span>
                      <MapPin size={15} />
                      {event.location}
                    </span>
                  </div>
                </div>
                {activeTab === "admin" ? (
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy || event.status === "closed"}
                    onClick={() => {
                      const status = nextStatus[event.status];
                      if (
                        status &&
                        (status !== "closed" ||
                          window.confirm(
                            "End editing and joining for this event? Saved work will remain available.",
                          ))
                      )
                        void run(async () => {
                          await api(`/events/${event.id}/status`, "POST", { status });
                        });
                    }}
                  >
                    {nextLabel[event.status]}
                    <ArrowRight size={16} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button primary"
                    disabled={!canJoin}
                    onClick={() => startTeam()}
                  >
                    <Plus size={16} /> Create a team
                  </button>
                )}
              </section>
              {activeTab === "discover" && (
                <>
                  <section className="intro-strip">
                    <Compass size={24} />
                    <div>
                      <h2>Find your people. Pick a project.</h2>
                      <p>
                        Join a team already exploring an idea, or start one of your own. You can
                        belong to more than one team.
                      </p>
                    </div>
                  </section>
                  <section className="section">
                    <div className="section-heading">
                      <div>
                        <h2>Projects to explore</h2>
                        <p>A starting point, a question, or an idea worth investigating.</p>
                      </div>
                    </div>
                    <div className="project-grid">
                      {event.projects.map((p, i) => (
                        <article className="project-card" key={p.id}>
                          <span className="project-index">
                            PROJECT {String(i + 1).padStart(2, "0")}
                          </span>
                          <h2>{p.name}</h2>
                          <p>{p.description}</p>
                          <div className="button-row">
                            {p.tags.map((tag) => (
                              <Badge key={tag}>{tag}</Badge>
                            ))}
                          </div>
                          <footer>
                            <span>
                              {teams.filter((t) => t.projectId === p.id).length} teams exploring
                            </span>
                            <button
                              type="button"
                              className="text-link"
                              disabled={!canJoin}
                              onClick={() => startTeam(p.id)}
                            >
                              Start a team <ArrowRight size={14} />
                            </button>
                          </footer>
                        </article>
                      ))}
                    </div>
                  </section>
                  <section className="section">
                    <div className="section-heading">
                      <div>
                        <h2>Teams you can join</h2>
                        <p>
                          Every team has a shared project and personal workspaces for its members.
                        </p>
                      </div>
                    </div>
                    {teams.length ? (
                      <div className="team-grid">{teams.map(teamCard)}</div>
                    ) : (
                      <Empty title="Start the first team">
                        Choose a project above, or create a team with your own project brief.
                      </Empty>
                    )}
                  </section>
                </>
              )}
              {activeTab === "teams" && (
                <>
                  <section className="intro-strip">
                    <FolderOpen size={24} />
                    <div>
                      <h2>Your teams, your workspaces</h2>
                      <p>
                        Open your own working copy for a team. Your teammates have independent
                        workspaces.
                      </p>
                    </div>
                  </section>
                  <section className="section">
                    {myTeams.length ? (
                      <div className="team-grid">{myTeams.map(teamCard)}</div>
                    ) : (
                      <Empty title="You haven’t joined a team yet">
                        Explore the projects to join an existing team or start your own.
                      </Empty>
                    )}
                  </section>
                  {reviews()}
                </>
              )}
              {activeTab === "admin" && (
                <>
                  <section className="metrics" aria-label="Event totals">
                    <Metric
                      label="People in teams"
                      value={members.filter((m) => m.teamIds.length).length}
                      detail={`of ${event.capacity} places`}
                    />
                    <Metric label="Teams" value={teams.length} detail="across your event" />
                    <Metric
                      label="Event admins"
                      value={members.filter((m) => m.role === "admin").length}
                      detail="with management access"
                    />
                    <Metric
                      label="Shared changes"
                      value={contributions.filter((c) => c.status === "accepted").length}
                      detail="published by team members"
                    />
                  </section>
                  <section className="section">
                    <div className="section-heading">
                      <div>
                        <h2>People & event roles</h2>
                        <p>
                          People join with their own accounts. Manage roles and correct team
                          memberships here.
                        </p>
                      </div>
                      <button type="button" className="button" onClick={() => setAddingAdmin(true)}>
                        <Plus size={15} /> Add admin
                      </button>
                    </div>
                    <div className="people-list">
                      {members.map((m) => (
                        <div className="admin-member" key={m.userId}>
                          <div className="person-row">
                            <span className="avatar">{initials(m.name)}</span>
                            <div className="person-name">
                              <strong>
                                {m.name}
                                {m.userId === session.user?.id ? " (you)" : ""}
                              </strong>
                              <span>{m.email}</span>
                            </div>
                            <Badge tone={m.role === "admin" ? "green" : "neutral"}>{m.role}</Badge>
                            <button
                              type="button"
                              className="button small"
                              disabled={
                                busy ||
                                (m.role === "admin" &&
                                  members.filter((x) => x.role === "admin").length === 1)
                              }
                              onClick={() =>
                                void run(async () => {
                                  await api(`/events/${eventId}/members/${m.userId}/role`, "POST", {
                                    role: m.role === "admin" ? "member" : "admin",
                                  });
                                })
                              }
                            >
                              {m.role === "admin" ? "Remove admin role" : "Make admin"}
                            </button>
                          </div>
                          <div className="membership-chips">
                            {m.teamIds.length ? (
                              m.teamIds.map((id) => (
                                <span className="membership-chip" key={id}>
                                  {teams.find((t) => t.id === id)?.name}
                                  <button
                                    type="button"
                                    disabled={busy}
                                    aria-label={`Remove ${m.name} from ${teams.find((t) => t.id === id)?.name}`}
                                    onClick={() => {
                                      if (
                                        window.confirm(
                                          `Remove ${m.name} from this team? Their saved work will be kept.`,
                                        )
                                      )
                                        void run(async () => {
                                          await api(`/teams/${id}/members/${m.userId}`, "DELETE");
                                        });
                                    }}
                                  >
                                    <X size={13} />
                                  </button>
                                </span>
                              ))
                            ) : (
                              <span className="small-text muted">No team memberships</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                  <section className="section">
                    <div className="section-heading">
                      <div>
                        <h2>Teams across the event</h2>
                        <p>
                          Shared project details and membership. Personal files stay in each
                          member’s workspace.
                        </p>
                      </div>
                    </div>
                    <div className="team-grid">
                      {teams.map((t) => (
                        <article className="team-card" key={t.id}>
                          <div className="team-card-top">
                            <span className="team-number">{t.number}</span>
                            <Badge>{t.memberCount} members</Badge>
                          </div>
                          <h3>{t.name}</h3>
                          <p>{t.projectName}</p>
                          <div className="member-names">
                            <Users size={15} />
                            {t.memberNames.join(", ")}
                          </div>
                          <footer>
                            <a className="text-link" href={`/api/teams/${t.id}/export`}>
                              Download team ZIP
                            </a>
                          </footer>
                        </article>
                      ))}
                    </div>
                  </section>
                  {reviews()}
                </>
              )}
              {activeTab === "schedule" && (
                <section className="section">
                  <div className="section-heading">
                    <div>
                      <h2>The day of your event</h2>
                      <p>All times in {event.timezone}.</p>
                    </div>
                  </div>
                  <div className="timeline">
                    {event.schedule.length ? (
                      event.schedule.map((s) => (
                        <article className="timeline-item" key={s.time}>
                          <time>{s.time}</time>
                          <span className="timeline-dot" />
                          <div>
                            <h3>{s.title}</h3>
                            <p>{s.description}</p>
                          </div>
                        </article>
                      ))
                    ) : (
                      <Empty title="Schedule coming soon">
                        Your organizer hasn’t published a schedule yet.
                      </Empty>
                    )}
                  </div>
                </section>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>Make something together.</span>
            <span>Signed in as {session.user.email}</span>
          </footer>
        </main>
      </div>
      {modal && (
        <Modal
          title={modal === "event" ? "Create an event" : "Start a team"}
          onClose={() => !busy && setModal(null)}
        >
          {error && (
            <p className="error modal-error" role="alert">
              {error}
            </p>
          )}
          {modal === "event" ? (
            <form className="form" onSubmit={submitEvent}>
              <p className="form-intro">
                You’ll be this event’s first admin. You can give other members admin access after
                they join.
              </p>
              <Field label="Starting point">
                <select name="templateId" defaultValue="blank">
                  {state?.templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Event name">
                <input name="name" required minLength={2} maxLength={100} />
              </Field>
              <div className="form-grid">
                <Field label="Date">
                  <input
                    name="date"
                    type="date"
                    required
                    defaultValue={new Date().toISOString().slice(0, 10)}
                  />
                </Field>
                <Field label="Timezone">
                  <input name="timezone" required defaultValue="America/Chicago" />
                </Field>
              </div>
              <Field label="Location">
                <input name="location" required minLength={2} />
              </Field>
              <div className="form-grid">
                <Field label="Participant capacity">
                  <input
                    name="capacity"
                    type="number"
                    required
                    min={1}
                    max={500}
                    defaultValue={40}
                  />
                </Field>
                <Field label="Planned model budget ($)">
                  <input
                    name="budget"
                    type="number"
                    required
                    min={0}
                    max={10000}
                    defaultValue={20}
                  />
                </Field>
              </div>
              <div className="form-actions">
                <button type="submit" className="button primary" disabled={busy}>
                  Create event <ArrowRight size={15} />
                </button>
              </div>
            </form>
          ) : (
            <form className="form" onSubmit={submitTeam}>
              <p className="form-intro">
                Choose a shared project for your team. You’ll join automatically and get your own
                workspace.
              </p>
              <Field label="Team name">
                <input name="name" required minLength={2} maxLength={80} />
              </Field>
              <Field label="Project">
                <select value={projectChoice} onChange={(e) => setProjectChoice(e.target.value)}>
                  {event?.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value="custom">My own project idea</option>
                </select>
              </Field>
              {projectChoice === "custom" && (
                <>
                  <Field label="Project title">
                    <input name="projectName" required minLength={2} maxLength={100} />
                  </Field>
                  <Field label="Project brief">
                    <textarea
                      name="brief"
                      required
                      minLength={20}
                      maxLength={10000}
                      rows={5}
                      placeholder="What do you want to explore or build? Include useful data sources and what a good result would look like."
                    />
                  </Field>
                </>
              )}
              <div className="form-actions">
                <button type="submit" className="button primary" disabled={busy}>
                  Create and join team <ArrowRight size={15} />
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
      {addingAdmin && (
        <Modal title="Add an event admin" onClose={() => setAddingAdmin(false)}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void run(async () => {
                await api(`/events/${eventId}/admins`, "POST", { email: form.get("email") });
                setAddingAdmin(false);
              });
            }}
          >
            <p className="form-intro">
              Enter the verified email they use to sign in here. They don’t need to join a team
              first.
            </p>
            <Field label="Admin email">
              <input name="email" type="email" required />
            </Field>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button type="submit" className="button primary" disabled={busy}>
                Give admin access
              </button>
            </div>
          </form>
        </Modal>
      )}
      {review && (
        <Modal wide title={review.title} onClose={() => setReview(null)}>
          <div className="review-content">
            <p>
              {review.status === "accepted"
                ? "Committed and pushed to the shared team repository."
                : "This earlier contribution has not been published to the shared team version."}
            </p>
            <pre className="diff">{review.diff}</pre>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {review.status !== "accepted" && (
              <div className="form-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || event?.status === "closed"}
                  onClick={() =>
                    void run(async () => {
                      await api(`/contributions/${review.id}/accept`, "POST");
                      setReview(null);
                    })
                  }
                >
                  <Check size={16} />
                  Accept into team version
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
function Metric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <article className="metric">
      <div>
        <span>{label}</span>
        <Users size={17} />
      </div>
      <strong>{String(value).padStart(2, "0")}</strong>
      <p>{detail}</p>
    </article>
  );
}
