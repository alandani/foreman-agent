import { DatabaseSync } from "node:sqlite";

/** Schema version history. Each entry runs once, in order, inside a transaction. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE runs (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL,
    bot_id        TEXT NOT NULL,
    bot_version   INTEGER NOT NULL,
    status        TEXT NOT NULL CHECK (status IN
      ('queued','running','waiting_approval','waiting_input','finished','stopped','failed','cancelled')),
    step_count    INTEGER NOT NULL DEFAULT 0,
    max_steps     INTEGER NOT NULL,
    cost_usd      REAL NOT NULL DEFAULT 0,
    max_cost_usd  REAL NOT NULL,
    deadline_ms   INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE run_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    seq         INTEGER NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('gateway','result')),
    payload     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX run_events_lookup ON run_events (run_id, seq, kind);

  CREATE TABLE plans (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    record      TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','used')),
    note        TEXT,
    created_at  INTEGER NOT NULL,
    decided_at  INTEGER
  );

  CREATE TABLE action_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT NOT NULL REFERENCES runs(id),
    seq           INTEGER NOT NULL,
    tool          TEXT NOT NULL,
    tool_version  INTEGER,
    project_id    TEXT NOT NULL,
    description   TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX action_log_run ON action_log (run_id, seq);
  `,
];

/** Opens a database (a file path or ":memory:") and brings it to the latest schema. */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
