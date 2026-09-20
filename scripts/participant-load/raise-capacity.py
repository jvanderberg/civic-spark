# Raise one event's participant capacity through the authenticated event API,
# preserving every other setting and using the optimistic revision check.
# Usage: python3 raise-capacity.py <event-id> <new-capacity>
# Env:   CIVIC_SPARK_LOAD_ORIGIN (default https://civic-spark.fly.dev)
#        CIVIC_SPARK_LOAD_ADMIN_EMAIL (demo admin identity; required)
import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.request

event_id, capacity = sys.argv[1], int(sys.argv[2])
origin = os.environ.get("CIVIC_SPARK_LOAD_ORIGIN", "https://civic-spark.fly.dev")
admin = os.environ["CIVIC_SPARK_LOAD_ADMIN_EMAIL"]
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
req = urllib.request.Request(
    origin + "/api/demo/sign-in",
    data=json.dumps({"email": admin, "name": ""}).encode(),
    headers={"content-type": "application/json"},
    method="POST",
)
op.open(req).read()
state = json.load(op.open(origin + "/api/state"))
event = next(e for e in state["events"] if e["id"] == event_id)
print("before", {"capacity": event["capacity"], "revision": event["revision"], "role": event.get("role")})
keys = ("name", "date", "timezone", "location", "address", "description", "startTime", "endTime", "budget", "projectBriefGuidance", "schedule")
body = {k: event[k] for k in keys}
body["capacity"] = capacity
body["expectedRevision"] = event["revision"]
req = urllib.request.Request(
    f"{origin}/api/events/{event_id}",
    data=json.dumps(body).encode(),
    headers={"content-type": "application/json"},
    method="PATCH",
)
try:
    with op.open(req) as r:
        updated = json.load(r)
        print("after", {"capacity": updated.get("capacity"), "revision": updated.get("revision")})
except urllib.error.HTTPError as e:
    print("failed", e.code, e.read(300).decode())
