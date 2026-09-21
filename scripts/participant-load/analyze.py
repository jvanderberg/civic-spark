"""Correlate browser-side request logs with backend diagnostic records.

Usage: python3 analyze.py <cohort-dir> [backend.jsonl]
Prints a markdown report; writes correlation.json next to backend.jsonl.
Only structured metadata is read; no bodies or secrets exist in either input.
"""
import json, pathlib, sys, statistics, collections

cohort = pathlib.Path(sys.argv[1])
backend_path = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path(__file__).with_name('backend.jsonl')
backend = [json.loads(l) for l in backend_path.read_text().splitlines() if l.strip()]
by_request = collections.defaultdict(list)
for rec in backend:
    if rec.get('requestId'):
        by_request[rec['requestId']].append(rec)

people = sorted(p for p in cohort.iterdir() if p.is_dir())
# Real-data evidence from the ZIP inspection (recorded by newer runners; absent in older results).
_data = []
for _p in people:
    _r = _p / 'result.json'
    if _r.exists():
        _z = (json.loads(_r.read_text()).get('zip') or {}).get('data')
        if _z is not None:
            _data.append((_p.name, _z.get('files', 0), _z.get('sources', False)))
if _data:
    print(f"Data evidence: {sum(1 for _, f, _s in _data if f)} of {len(_data)} archives carry files under public/data; "
          f"{sum(1 for _, _f, s in _data if s)} include SOURCES.md; without data: {[n for n, f, _s in _data if not f]}")

run_start = None
report = {'people': {}, 'backend': {}}
out = []

def pct(values, q):
    if not values: return None
    values = sorted(values)
    return values[min(len(values) - 1, int(round(q * (len(values) - 1))))]

for person in people:
    steps = [json.loads(l) for l in (person / 'steps.jsonl').read_text().splitlines() if l.strip()] if (person / 'steps.jsonl').exists() else []
    requests = [json.loads(l) for l in (person / 'requests.jsonl').read_text().splitlines() if l.strip()] if (person / 'requests.jsonl').exists() else []
    result = json.loads((person / 'result.json').read_text()) if (person / 'result.json').exists() else None
    for r in requests:
        run_start = min(run_start, r['at']) if run_start else r['at']
    errors = [r for r in requests if not (200 <= r['status'] < 400)]
    err_by_route = collections.Counter(f"{r['method']} {r['path']} -> {r['status']}" for r in errors)
    correlated = []
    for r in errors:
        recs = by_request.get(r.get('requestId') or '', [])
        correlated.append({
            'at': r['at'], 'step': r['step'], 'method': r['method'], 'path': r['path'], 'status': r['status'],
            'requestId': r.get('requestId'),
            'backendHttp': [x for x in recs if x['event'] == 'http'],
            'backendCommands': [x for x in recs if x['event'] == 'sprite.command'],
            'backendOperations': [x for x in recs if x['event'] == 'sprite.operation'],
        })
    trace_ids = {r['traceId'] for r in requests if r.get('traceId')}
    trace_backend = [x for x in backend if x.get('traceId') in trace_ids]
    slow_cmds = [x for x in trace_backend if x['event'] == 'sprite.command']
    non_ok_cmds = [x for x in slow_cmds if x.get('outcome') != 'ok']
    non_ok_ops = [x for x in trace_backend if x['event'] == 'sprite.operation' and x.get('outcome') != 'ok']
    # Note: status/statusLabel keys vary; step records may use different names, keep raw.
    report['people'][person.name] = {
        'result': result,
        'steps': steps,
        'requestCount': len(requests),
        'errorCount': len(errors),
        'errorsByRoute': dict(err_by_route),
        'correlatedErrors': correlated,
        'backendNonOkCommands': non_ok_cmds,
        'backendNonOkOperations': non_ok_ops,
        'commandQueueMs': {'max': max((x.get('queueMs', 0) for x in slow_cmds), default=0), 'p95': pct([x.get('queueMs', 0) for x in slow_cmds], 0.95)},
        'commandExecutionMs': {'max': max((x.get('executionMs', 0) for x in slow_cmds), default=0), 'p95': pct([x.get('executionMs', 0) for x in slow_cmds], 0.95)},
        'traceIds': sorted(trace_ids),
    }
    out.append(f"## {person.name}")
    out.append(f"- result: {json.dumps({k: v for k, v in (result or {}).items() if k in ('ok','success','status','durationMs','totalMs','failedStep','error')}) if result else 'no result.json (unfinished)'}")
    out.append(f"- requests: {len(requests)}, non-2xx/3xx: {len(errors)}")
    for k, v in err_by_route.items():
        out.append(f"  - {v} x {k}")
    for c in correlated:
        http = c['backendHttp']
        srv = f"backend route {http[0]['route']} status {http[0]['status']} in {http[0]['durationMs']}ms" if http else 'NO backend http record for this requestId'
        out.append(f"  - {c['at']} {c['step']} {c['method']} {c['path']} {c['status']} requestId={c['requestId']}: {srv}; commands={len(c['backendCommands'])} ops={[(o['script'],o['operation'],o['outcome'],o.get('status')) for o in c['backendOperations']]}")
    if non_ok_cmds: out.append(f"- backend non-ok sprite commands: {len(non_ok_cmds)} {[x.get('outcome') for x in non_ok_cmds]}")
    if non_ok_ops: out.append(f"- backend non-ok sprite operations: {[(x['script'],x['operation'],x['outcome'],x.get('status')) for x in non_ok_ops]}")
    out.append(f"- sprite command queue ms max/p95: {report['people'][person.name]['commandQueueMs']}; execution ms max/p95: {report['people'][person.name]['commandExecutionMs']}")

# Backend totals within run window
window = [x for x in backend if run_start and x['at'] >= run_start]
http_counts = collections.Counter((x['route'], x['status']) for x in window if x['event'] == 'http')
non2xx = {k: v for k, v in http_counts.items() if not (200 <= k[1] < 400)}
cmd_outcomes = collections.Counter(x.get('outcome') for x in window if x['event'] == 'sprite.command')
op_outcomes = collections.Counter((x.get('script'), x.get('operation'), x.get('outcome'), x.get('status')) for x in window if x['event'] == 'sprite.operation' and x.get('outcome') != 'ok')
all_cmds = [x for x in window if x['event'] == 'sprite.command']
report['backend'] = {
    'runStart': run_start, 'records': len(window),
    'httpNon2xx': {f"{k[0]} {k[1]}": v for k, v in non2xx.items()},
    'commandOutcomes': dict(cmd_outcomes),
    'operationNonOk': [{'script': k[0], 'operation': k[1], 'outcome': k[2], 'status': k[3], 'count': v} for k, v in op_outcomes.items()],
    'queueMs': {'max': max((x.get('queueMs', 0) for x in all_cmds), default=0), 'p95': pct([x.get('queueMs', 0) for x in all_cmds], 0.95), 'median': statistics.median([x.get('queueMs', 0) for x in all_cmds]) if all_cmds else None},
    'executionMs': {'max': max((x.get('executionMs', 0) for x in all_cmds), default=0), 'p95': pct([x.get('executionMs', 0) for x in all_cmds], 0.95)},
    'httpDurationMsMax': max((x.get('durationMs', 0) for x in window if x['event'] == 'http'), default=0),
}
out.insert(0, f"# Backend summary since {run_start}\n- records: {len(window)}\n- http non-2xx: {report['backend']['httpNon2xx']}\n- sprite command outcomes: {dict(cmd_outcomes)}\n- sprite operation non-ok: {report['backend']['operationNonOk']}\n- command queueMs: {report['backend']['queueMs']}; executionMs: {report['backend']['executionMs']}; slowest http: {report['backend']['httpDurationMsMax']}ms\n")
print('\n'.join(out))
(backend_path.with_name('correlation.json')).write_text(json.dumps(report, indent=1))
