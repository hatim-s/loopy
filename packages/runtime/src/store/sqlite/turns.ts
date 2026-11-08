import type { DurableTurn, DurableTurnStore } from "@loopy/core";
import { utc } from "../timestamps";
import type { SqlContext, SqlWrite } from "./context";

type TurnRow = {
  id: string;
  cursor: string | null;
  owner_token: string | null;
  heartbeat_at: string | null;
};

const TURN_COLUMNS = "r.id,t.cursor,r.owner_token,r.heartbeat_at";

const RUNNING_COUNT = "SELECT COUNT(*) AS count FROM runs WHERE status='running'";

/** Suspended runs whose owner did not release them after the suspension committed. */
export const STRANDED_TURNS = `SELECT ${TURN_COLUMNS} FROM runs r
  LEFT JOIN run_turns t ON r.id=t.run_id
  WHERE r.status='suspended' AND r.owner_token IS NOT NULL AND (t.next_at IS NULL OR t.next_at<=?)
  ORDER BY COALESCE(t.next_at,r.created_at),r.id LIMIT ?`;

export const RUNNING_TURNS = `SELECT ${TURN_COLUMNS} FROM runs r
  LEFT JOIN run_turns t ON r.id=t.run_id
  WHERE r.status='running' AND (t.next_at IS NULL OR t.next_at<=?)
  ORDER BY r.created_at,r.id LIMIT ?`;

// A failed turn waits for its deadline; a turn that only yielded may start again at once.
export const READY_TURNS = `SELECT ${TURN_COLUMNS} FROM runs r
  LEFT JOIN run_turns t ON r.id=t.run_id
  WHERE r.owner_token IS NULL AND (r.status='queued' OR (r.status='suspended' AND r.wake_at<=?))
  AND (t.error IS NULL OR t.next_at<=?)
  ORDER BY r.created_at,r.id LIMIT ?`;

const NEXT_TURN = `SELECT MIN(COALESCE(t.next_at,r.heartbeat_at,r.created_at)) AS at FROM runs r
  LEFT JOIN run_turns t ON r.id=t.run_id WHERE r.status='running'
  UNION ALL SELECT MIN(COALESCE(t.next_at,r.created_at)) FROM runs r
  LEFT JOIN run_turns t ON r.id=t.run_id WHERE r.status='suspended' AND r.owner_token IS NOT NULL
  UNION ALL SELECT MIN(MAX(CASE WHEN r.status='queued' THEN r.created_at ELSE r.wake_at END,
  CASE WHEN t.error IS NULL THEN r.created_at ELSE t.next_at END)) FROM runs r
  LEFT JOIN run_turns t ON r.id=t.run_id
  WHERE r.owner_token IS NULL AND (r.status='queued' OR r.status='suspended')
  AND (${RUNNING_COUNT})<?`;

function toTurn(row: TurnRow): DurableTurn {
  return {
    runId: row.id,
    cursor: row.cursor,
    owner:
      row.owner_token === null ? null : { token: row.owner_token, heartbeatAt: row.heartbeat_at },
  };
}

export function readStrandedTurns(ctx: SqlContext, now: string, limit: number): DurableTurn[] {
  return ctx.db.query<TurnRow, [string, number]>(STRANDED_TURNS).all(utc(now), limit).map(toTurn);
}

export function readDueTurns(ctx: SqlContext, now: string, concurrency: number): DurableTurn[] {
  const at = utc(now);
  const running = ctx.db.query<TurnRow, [string, number]>(RUNNING_TURNS).all(at, concurrency);

  const count = ctx.db.query<{ count: number }, []>(RUNNING_COUNT).get()?.count ?? 0;

  const ready = ctx.db
    .query<TurnRow, [string, string, number]>(READY_TURNS)
    .all(at, at, Math.max(0, concurrency - count));

  return [...running, ...ready].map(toTurn);
}

export function saveTurn(write: SqlWrite, turn: Parameters<DurableTurnStore["saveTurn"]>[0]): void {
  write.db
    .query(
      `INSERT INTO run_turns(run_id,next_at,cursor,error) VALUES (?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET next_at=excluded.next_at,cursor=excluded.cursor,error=excluded.error`,
    )
    .run(turn.runId, utc(turn.nextAt), turn.cursor, turn.error);
}

export function readNextTurnAt(ctx: SqlContext, concurrency: number): string | undefined {
  const deadlines = ctx.db
    .query<{ at: string | null }, [number]>(NEXT_TURN)
    .all(concurrency)
    .flatMap(({ at }) => (at === null ? [] : [Date.parse(at)]));

  return deadlines.length === 0 ? undefined : utc(Math.min(...deadlines));
}

export function readTurnErrors(ctx: SqlContext, limit: number) {
  return ctx.db
    .query<{ runId: string; error: string }, [number]>(
      "SELECT run_id AS runId,error FROM run_turns WHERE error IS NOT NULL ORDER BY run_id LIMIT ?",
    )
    .all(limit);
}
