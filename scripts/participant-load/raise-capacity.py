# Raise one event's participant capacity through the authenticated event API,
# preserving every other setting and using the optimistic revision check.
# Usage: python3 raise-capacity.py <event-id> <new-capacity>
# Env:   CIVIC_SPARK_LOAD_ORIGIN (default https://civic-spark.fly.dev)
#        CIVIC_SPARK_LOAD_ADMIN_EMAIL (an owner or admin of the event; required)
#        CIVIC_SPARK_LOAD_ADMIN_CODE_FILE (optional; see admin_session.py)
import os
import sys

from admin_session import AdminSession

event_id, capacity = sys.argv[1], int(sys.argv[2])
origin = os.environ.get("CIVIC_SPARK_LOAD_ORIGIN", "https://civic-spark.fly.dev")
admin = AdminSession(origin, os.environ["CIVIC_SPARK_LOAD_ADMIN_EMAIL"])
admin.sign_in()
status, state = admin.call("/api/state")
assert status == 200, (status, state)
event = next(e for e in state["events"] if e["id"] == event_id)
print("before", {"capacity": event["capacity"], "revision": event["revision"], "role": event.get("role")})
keys = ("name", "date", "timezone", "location", "address", "description", "startTime", "endTime", "budget", "projectBriefGuidance", "schedule")
body = {k: event[k] for k in keys}
body["capacity"] = capacity
body["expectedRevision"] = event["revision"]
status, updated = admin.call(f"/api/events/{event_id}", "PATCH", body)
if status == 200:
    print("after", {"capacity": updated.get("capacity"), "revision": updated.get("revision")})
else:
    print("failed", status, updated)
admin.sign_out()
