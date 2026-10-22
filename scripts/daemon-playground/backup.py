import json
import os
import sqlite3
import sys
from contextlib import closing
from urllib.parse import quote


def readonly(path):
    return sqlite3.connect(f"file:{quote(path, safe='/')}?mode=ro", uri=True)


def sidecars(path):
    return [
        {"suffix": suffix, "bytes": os.stat(path + suffix).st_size}
        for suffix in ["-wal", "-shm", "-journal"]
        if os.path.exists(path + suffix)
    ]


def rows(connection):
    return [
        {"id": run_id, "status": status}
        for run_id, status in connection.execute("SELECT id,status FROM runs ORDER BY id")
    ]


request = json.load(sys.stdin)
source = request["source"]
destination = request["destination"]
if os.path.exists(destination):
    raise RuntimeError("Diagnostic destination already exists; preserve it and choose a new path.")

before = sidecars(source)
with closing(readonly(source)) as original:
    original.execute("BEGIN")
    source_rows = rows(original)
    with closing(sqlite3.connect(destination)) as copied:
        original.backup(copied)
        copied.commit()
        destination_journal = copied.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
    original.rollback()

with closing(readonly(destination)) as copied:
    integrity = copied.execute("PRAGMA integrity_check").fetchone()[0]
    copied_rows = rows(copied)

expected = request["apiRuns"]
api_match = None if expected is None else copied_rows == sorted(expected, key=lambda run: run["id"])
print(json.dumps({
    "method": "sqlite3_backup from read-only source after owned daemon exit",
    "source": source,
    "destination": destination,
    "destinationJournal": destination_journal,
    "sidecarsBefore": before,
    "sidecarsAfter": sidecars(source),
    "sourceRows": source_rows,
    "copiedRows": copied_rows,
    "integrity": integrity,
    "matchesSource": source_rows == copied_rows,
    "matchesApi": api_match,
    "matches45ApiRuns": len(copied_rows) == 45 and api_match is True,
}))
