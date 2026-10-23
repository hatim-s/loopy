from pathlib import Path
import datetime
import hashlib
import json
import math
import sqlite3
from urllib.parse import quote

root = Path.cwd()
directory = root / '.notes/cloud/evidence/architecture'
state = root / '.loopy/playground-daemon-architecture'
home = state / 'home'
backup = state / 'daemon-readonly.sqlite'
report = json.loads((directory / 'playground-daemon.json').read_text())
full = json.loads((directory / 'playground-daemon-executions.json').read_text())['records']
audit_path = directory / 'playground-daemon-offline-checks.json'
audit = json.loads(audit_path.read_text())
summary = json.loads((directory / 'playground-daemon-semantics.json').read_text())
preflight = json.loads((directory / 'playground-daemon-preflight.json').read_text())
revisions = {row['slug']: row['revision'] for row in preflight['revisions']}


def compact(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False)


def execution_key(value):
    return '/'.join([compact(value['runId']), compact(value['nodeId'])] + [
        compact([scope['nodeId'], scope['index']]) for scope in value['scope']
    ])


def moment(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))


def distribution(values):
    values = sorted(values)
    return dict(count=len(values), min=values[0], p50=values[math.ceil(len(values) * .5) - 1],
                p95=values[math.ceil(len(values) * .95) - 1], max=values[-1])


by_id = {row['id']: row for row in full}
assert len(by_id) == 45 and set(by_id) == {row['run']['id'] for row in report['records']}
physical = list((home / 'receipts').rglob('*.json'))
used, joins, timings, retries, controls = set(), [], [], [], []
latest_total = attempt_total = log_total = 0

for row in report['records']:
    run = row['run']
    complete = by_id[run['id']]
    assert complete['slug'] == row['slug'] and complete['revision'] == revisions[row['slug']]
    saved = json.loads((Path(run['workspace']) / '.loopy/loopies' / (row['slug'] + '.json')).read_text())
    assert saved['revision'] == complete['revision']
    graph = {node['id']: node for node in saved['graph']['nodes']}
    nodes = {execution_key(node['key']): node for node in complete['nodes']}
    attempts = {(execution_key(node['key']), node['attempt']): node for node in complete['attempts']}
    assert len(nodes) == len(complete['nodes']) and len(attempts) == len(complete['attempts'])
    latest_total += len(nodes)
    attempt_total += len(attempts)
    log_total += len(complete['logs'])
    for key, node in nodes.items():
        assert node['key']['runId'] == run['id'] and node['key']['nodeId'] in graph
        assert attempts[(key, node['attempt'])] == node
        assert sorted(attempt for identity, attempt in attempts if identity == key) == list(range(1, node['attempt'] + 1))
    inventory = {item['path']: item for item in row['receipts']}
    expected_paths = set()
    for (key, attempt), node in attempts.items():
        external = graph[node['key']['nodeId']]['kind'] in ['code', 'command']
        assert (node['receipt'] == 'finished') == external
        if not external:
            continue
        relative = Path('receipts') / quote(run['id'], safe="-_.!~*'()").replace('.', '%2E') / quote(key, safe="-_.!~*'()") / (str(attempt) + '.json')
        path = home / relative
        assert path.is_file() and not path.is_symlink()
        content = path.read_bytes()
        receipt = json.loads(content)
        item = inventory[relative.as_posix()]
        assert receipt['kind'] == item['kind'] == 'finished'
        assert execution_key(receipt['executionKey']) == key
        assert receipt['attempt'] == attempt == item['attempt']
        assert item['key'] == receipt['executionKey']
        assert hashlib.sha256(content).hexdigest() == item['sha256']
        result = receipt['result']
        if result['kind'] == 'succeeded':
            assert node['status'] == 'succeeded' and node['output'] == result['output']
        else:
            assert node['status'] in ['retrying', 'failed'] and node['error'] == result['error']
        expected_paths.add(relative.as_posix())
        used.add(path)
        joins.append(dict(runId=run['id'], executionKey=key, attempt=attempt, path=relative.as_posix(),
                          sha256=item['sha256'], resultKind=result['kind'], storedStatus=node['status']))
    assert set(inventory) == expected_paths
    assert [log['seq'] for log in complete['logs']] == list(range(1, len(complete['logs']) + 1))
    positions = set()
    for log in complete['logs']:
        assert log['runId'] == run['id']
        position = log['position']
        assert position['kind'] == 'node'
        identity = (position['executionKey'], position['attempt'], position['index'])
        assert identity not in positions and identity[:2] in attempts
        positions.add(identity)
    assert row['matched'] and run['status'] == row['expectedStatus']
    if row['expectedFailure']:
        assert row['expectedFailure'] in run['error']
        failed = [node for node in complete['nodes'] if node['status'] == 'failed']
        assert failed and all(node['error']['code'] == 'execution' and row['expectedFailure'] in node['error']['message'] for node in failed)
        controls.append(dict(runId=run['id'], slug=row['slug'], ordinal=row['input']['ordinal'],
                             marker=row['expectedFailure'], failedNodeIds=[node['key']['nodeId'] for node in failed]))
    first = min(node['startedAt'] for node in complete['nodes'])
    assert row['firstNodeStartedAt'] is not None
    assert row['firstNodeStartedAt'] == first == min(node['startedAt'] for node in complete['attempts'])
    delay = round((moment(first) - moment(run['createdAt'])).total_seconds() * 1000)
    assert delay >= 0
    timings.append(dict(runId=run['id'], slug=row['slug'], createdAt=run['createdAt'],
                        firstNodeStartedAt=first, firstNodeDelayMs=delay, admissionMs=row['admissionMs']))
    if row['slug'] == 'playground-b-retry-marker':
        retried = [node for node in complete['nodes'] if node['key']['nodeId'].endswith(':retry-update')]
        assert len(retried) == 1 and retried[0]['attempt'] == 2
        retries.append(dict(runId=run['id'], attempts=[attempt for identity, attempt in attempts if identity == execution_key(retried[0]['key'])]))

assert set(physical) == used and len(joins) == len(physical) == 178
assert len(controls) == 6 and len(retries) == 9
for slug in revisions:
    group = [row for row in report['records'] if row['slug'] == slug]
    assert len(group) == 9 and sorted(row['input']['ordinal'] for row in group) == list(range(1, 10))
    for row in group:
        value = row['input']
        assert value['batch'] == 'playground-daemon-45'
        assert value['fail'] == (value['ordinal'] == 5)
        assert value['items'] == [3, 7, 11, value['ordinal']]
holds = [row for row in report['records'] if row['hold']]
assert len(holds) == 9 and all(row['slug'] == 'playground-c-security-review' for row in holds)
assert all(row['hold']['approved'] == (row['input']['ordinal'] != 8) and 10000 <= row['hold']['heldMs'] < 12500 for row in holds)
for before in report['restartProof']['before']:
    restarted = next(row for row in report['records'] if row['run']['id'] == report['restartProof']['runId'])
    assert any(after['path'] == before['path'] and after['sha256'] == before['sha256'] for after in restarted['receipts'])
assert latest_total == summary['latestExecutions'] == 457
assert attempt_total == summary['executionAttempts'] == 466
assert log_total == summary['logs'] == 400 and summary['verifiedFiles'] == 272
assert distribution([row['firstNodeDelayMs'] for row in timings]) == summary['firstRecordedNodeDelayMs']
database = sqlite3.connect('file:' + quote(str(backup), safe='/') + '?mode=ro', uri=True)
try:
    assert database.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
    actual = [dict(id=identity, status=status) for identity, status in database.execute('SELECT id,status FROM runs ORDER BY id')]
    assert actual == sorted(report['apiRuns'], key=lambda row: row['id'])
finally:
    database.close()

audit.update(phase='offline-verification-complete', verifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
             fullExecutionIdentityChecks=dict(runs=45, latestExecutions=latest_total, attempts=attempt_total,
                 scopedExecutions=sum(bool(node['key']['scope']) for row in full for node in row['nodes']), logs=log_total,
                 contiguousAttemptHistories=True, latestRecordsMatchLastAttempt=True, logPositionsUniqueAndReferToStoredAttempts=True),
             receiptJoins=joins, allPhysicalReceiptsMatched=len(physical), receiptResultMatchesStoredAttempt=True,
             controlledFailures=controls, retryChecks=retries, all45RevisionsMatchPreflightAndSavedGraph=True,
             holds=[dict(runId=row['run']['id'], ordinal=row['input']['ordinal'], **row['hold']) for row in holds],
             perRunFirstNodeTimings=timings, firstNodeDelayMs=distribution([row['firstNodeDelayMs'] for row in timings]),
             oldDelayComparison=dict(source='.notes/cloud/playground-daemon.md', oldMinMs=4791, oldMedianMs=4876,
                 oldMaxMs=4997, oldRunCount=45, qualification='Old values are retained report measurements; old state/database were not opened. First recorded node timing is not worker dispatch, maximum throughput, or a hardware-matched cloud comparison.'),
             backupSha256AfterAllChecks=hashlib.sha256(backup.read_bytes()).hexdigest(),
             primarySha256AfterAllChecks=hashlib.sha256((directory / 'playground-daemon.json').read_bytes()).hexdigest())
assert audit['backupSha256Before'] == audit['backupSha256AfterAllChecks']
assert audit['primarySha256Before'] == audit['primarySha256AfterAllChecks']
audit['diagnosticFilesAfterAllChecks'] = {str(path): dict(bytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest())
                                        for path in sorted(state.glob('daemon-readonly.sqlite*'), key=str) if path.is_file()}
assert audit['diagnosticFilesAfterAllChecks'] == audit['diagnosticFilesBeforeAnalyze']
audit['verificationScriptSha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
audit_path.write_text(json.dumps(audit, indent=2) + '\n')
print(json.dumps(dict(result='all offline checks passed', latestExecutions=latest_total, attempts=attempt_total,
    scopedExecutions=audit['fullExecutionIdentityChecks']['scopedExecutions'], logs=log_total, receiptJoins=len(joins),
    controlledFailures=len(controls), retryRuns=len(retries), holds=len(holds),
    holdDistributionMs=distribution([row['hold']['heldMs'] for row in holds]), firstNodeDelayMs=audit['firstNodeDelayMs'],
    backupHashUnchanged=True, diagnosticSidecarsUnchanged=True, primaryEvidenceUnchanged=True), indent=2))
