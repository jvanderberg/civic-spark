# Delete every Sprite and every team of one event through the admin APIs.
# Projects, the event and accounts are kept. Sprite deletion is the app's own
# two-step flow (provider destroy, then finish/reset). Sequential because the
# lifecycle serializes Sprite operations per event.
#
# Usage: python3 cleanup-event.py <event-id>
# Env:   CIVIC_SPARK_LOAD_ORIGIN (default https://civic-spark.fly.dev)
#        CIVIC_SPARK_LOAD_ADMIN_EMAIL (demo admin identity; required)
# Afterwards compare `sprite -o <org> list` with the app: provider orphans are
# destroyed by hand, never by this script.
import json, os, sys, time, urllib.request, urllib.error, http.cookiejar
event_id = sys.argv[1]
origin = os.environ.get("CIVIC_SPARK_LOAD_ORIGIN", "https://civic-spark.fly.dev")
admin = os.environ["CIVIC_SPARK_LOAD_ADMIN_EMAIL"]
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(origin + path, data=data, headers={"content-type": "application/json"} if data else {}, method=method)
    try:
        with op.open(req, timeout=600) as r:
            text = r.read().decode()
            return r.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        try: return e.code, json.loads(text)
        except ValueError: return e.code, {"error": text[:200]}
call("/api/demo/sign-in", "POST", {"email": admin, "name": ""})
def inventory():
    status, body = call(f"/api/events/{event_id}/sprites")
    assert status == 200, (status, body)
    return body.get("sprites", body) if isinstance(body, dict) else body
rows = inventory()
print("sprite rows before:", len(rows))
destroyed = finished = failures = 0
for round_ in range(6):
    rows = inventory()
    if not rows: break
    for row in rows:
        wid, gen = row["workspaceId"], row["runtime"]["generation"]
        for attempt in range(20):
            status, body = call(f"/api/events/{event_id}/sprites/{wid}", "POST", {"action": "delete", "generation": gen})
            if status == 409 and "in progress" in str(body):
                time.sleep(3); continue
            break
        state = row["runtime"].get("deletion") or {}
        label = "finish" if state.get("state") == "deleted" and state.get("reset") else "destroy"
        print(f"{label} {wid[:8]} gen {gen} -> {status} {json.dumps(body)[:120]}")
        if status == 200:
            if label == "destroy": destroyed += 1
            else: finished += 1
        else:
            failures += 1
    time.sleep(2)
rows = inventory()
print("sprite rows after:", len(rows), "destroyed", destroyed, "finished", finished, "failures", failures)
status, state = call("/api/state")
teams = [t for t in state["teams"] if t["eventId"] == event_id]
print("teams before:", len(teams))
deleted = 0
for t in teams:
    status, body = call(f"/api/teams/{t['id']}", "DELETE", {"confirmed": True})
    print("team", t["name"][:40], "->", status, json.dumps(body)[:80])
    if status == 200: deleted += 1
status, state = call("/api/state")
print("teams after:", len([t for t in state["teams"] if t["eventId"] == event_id]), "deleted", deleted)
ev = next(e for e in state["events"] if e["id"] == event_id)
print("projects kept:", len(ev["projects"]), "capacity", ev["capacity"])
