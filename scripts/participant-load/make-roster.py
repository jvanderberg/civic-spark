# Generate a cohort roster for scripts/participant-load-cohort.ts.
#
# Usage:
#   python3 make-roster.py --prefix cohorth --count 50 --out artifacts/participant-load/cohort-inputs-h \
#       [--event "Day in Our Data"] [--base-url https://civic-spark.fly.dev] [--auth demo] [--canary]
#
# Every person gets a fresh identity (<prefix>-<date>-pNN@example.test), a unique
# team name and one of the event's projects in rotation. The runner rejects
# identities that already own a workspace, so never reuse a prefix against the
# same instance. --canary also writes <out>-canary/ with a single separate
# identity to run before the full cohort. Keys never go into these files: each
# person points at the CIVIC_SPARK_LOAD_GLM_KEY environment variable.
import argparse, datetime, json, pathlib

DEFAULT_PROJECTS = [
    "Your first project", "Is my assessment fair?", "Where does my tax dollar go?",
    "Where is business activity changing?", "Can a kid bike to school safely?",
    "Can I park here right now?", "Which bus stops need help?", "Are the worst alleys getting fixed?",
    "Build the Oak Park transit dashboard", "Oak Park over time", "How are our schools doing?",
    "How resilient is our urban forest?", "Build an architecture walking tour",
    "What do our commissions do?", "Oak Park crime data explorer", "What does ECHO see?",
]
PROMPT = ("Read PROJECT.md and the existing repository, then implement a small working React and TypeScript MVP "
          "for this specific project. Choose one useful core interaction from the brief and a clear mobile-ready screen. "
          "Use static sample data, clearly labelled, without external data downloads or follow-up questions. Include a "
          "README explaining the MVP scope, sample-data limitations and how to run it. Preserve hello.txt containing "
          "exactly 42. Keep this first MVP small enough to finish promptly. If you make a local commit, use exactly MVP "
          "as its message. Do not publish; I will use Share.")

parser = argparse.ArgumentParser()
parser.add_argument("--prefix", required=True)
parser.add_argument("--count", type=int, required=True)
parser.add_argument("--out", required=True)
parser.add_argument("--event", default="Day in Our Data")
parser.add_argument("--base-url", default="https://civic-spark.fly.dev")
parser.add_argument("--auth", default="demo")
parser.add_argument("--date", default=datetime.date.today().strftime("%Y%m%d"))
parser.add_argument("--projects", help="comma-separated project names; defaults to the sixteen Day in Our Data projects")
parser.add_argument("--credential-env", default="CIVIC_SPARK_LOAD_GLM_KEY")
parser.add_argument("--canary", action="store_true")
args = parser.parse_args()
projects = [p.strip() for p in args.projects.split(",")] if args.projects else DEFAULT_PROJECTS
label = args.prefix.capitalize()

def person(identity, name, team, index):
    return {
        "version": 1,
        "id": identity,
        "baseUrl": args.base_url,
        "authMode": args.auth,
        "eventName": args.event,
        "projectName": projects[index % len(projects)],
        "participant": {"name": name, "email": f"{identity}@example.test"},
        "teamName": team,
        "credentialEnv": args.credential_env,
        "prompt": PROMPT,
        "browser": {"width": 1440, "height": 900, "theme": "light" if index % 2 == 0 else "dark"},
    }

def write(directory, people):
    directory = pathlib.Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    names = []
    for n, entry in enumerate(people, start=1):
        name = f"person-{n:02d}.json"
        (directory / name).write_text(json.dumps(entry, indent=2) + "\n")
        names.append(name)
    (directory / "roster.json").write_text(json.dumps(names, indent=2) + "\n")
    print(directory, len(people), "people")

write(args.out, [
    person(f"{args.prefix}-{args.date}-p{n:02d}", f"{label} test {n:02d}", f"{label} test {args.date} {n:02d}", n - 1)
    for n in range(1, args.count + 1)
])
if args.canary:
    write(f"{args.out}-canary", [
        person(f"{args.prefix}-canary-{args.date}-p01", f"{label} canary 01", f"{label} canary {args.date} 01", len(projects) // 2)
    ])
