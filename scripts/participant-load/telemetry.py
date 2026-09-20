"""Per-minute host telemetry from loop and relay records.
Usage: python3 telemetry.py backend.jsonl <start-iso>"""
import json, sys, collections
path, start = sys.argv[1], sys.argv[2]
recs = [json.loads(l) for l in open(path) if l.strip()]
run = [r for r in recs if r['at'] >= start]
def pct(v, q):
    v = sorted(v); return v[min(len(v)-1, int(len(v)*q))] if v else None
loops = [r for r in run if r['event'] == 'loop']
relays = [r for r in run if r['event'] == 'relay']
by = collections.defaultdict(list)
for l in loops: by[l['at'][11:16]].append(l)
print("minute | main cpu% med/max | p99 delay med/max | children | sockets | agentLines | termChunks | termBytesKB | sessionReq | spawns | http | httpKB | eventsOpen | eventsPushed")
for m in sorted(by):
    ls = by[m]
    def s(k): return sum(l.get(k, 0) for l in ls)
    cpu = [l['cpuPercent'] for l in ls]; p99 = [l['loopP99Ms'] for l in ls]
    print(f"{m} | {pct(cpu,.5)}/{max(cpu)} | {pct(p99,.5)}/{max(p99)} | {max(l['children'] for l in ls)} | {max(l['sockets'] for l in ls)} | {s('agentLines')} | {s('terminalChunks')} | {s('terminalBytes')//1024} | {s('sessionRequests')} | {s('processSpawns')} | {s('httpRequests')} | {s('httpBytes')//1024} | {max(l.get('eventsOpen',0) for l in ls)} | {max(l.get('eventsPushed',0) for l in ls)}")
if relays:
    rb = collections.defaultdict(list)
    for r in relays: rb[(r['at'][11:16], r.get('worker'))].append(r)
    print("\nrelay workers: minute worker | cpu% med/max | p99 delay max | agents | terminals | helpers | commands")
    for (m, w) in sorted(rb):
        rs = rb[(m, w)]; cpu = [r.get('cpuPercent', 0) for r in rs]
        print(f"{m} w{w} | {pct(cpu,.5)}/{max(cpu)} | {max(r.get('loopP99Ms',0) for r in rs)} | {max(r.get('agents',0) for r in rs)} | {max(r.get('terminals',0) for r in rs)} | {max(r.get('helpers',0) for r in rs)} | {sum(r.get('commands',0) for r in rs)}")
print("\nrelay.worker events:", [(r['at'][11:19], r.get('phase'), r.get('outcome'), r.get('exitCode')) for r in run if r['event'] == 'relay.worker'][:10])
