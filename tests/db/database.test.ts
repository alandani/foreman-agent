import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";

describe("openDatabase", () => {
  it("creates the schema and records its version", () => {
    const db = openDatabase(":memory:");
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(1);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(["action_log", "plans", "run_events", "runs"]);
  });

  it("is safe to open twice without running the migration again", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-db-"));
    try {
      const file = path.join(dir, "app.db");
      openDatabase(file).close();
      const db = openDatabase(file);
      const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(v.user_version).toBe(1);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an event for a run that does not exist", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      db
        .prepare("INSERT INTO run_events (run_id, seq, kind, payload, created_at) VALUES ('ghost', 1, 'gateway', '{}', 0)")
        .run(),
    ).toThrow();
  });

  it("rejects an unknown run status", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      db
        .prepare(
          `INSERT INTO runs (id, project_id, bot_id, bot_version, status, max_steps, max_cost_usd, deadline_ms, created_at, updated_at)
           VALUES ('r', 'p', 'b', 1, 'sleeping', 1, 1, 1, 0, 0)`,
        )
        .run(),
    ).toThrow();
  });
});
