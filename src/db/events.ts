import type { DatabaseSync } from "node:sqlite";
import type { GatewayEvent, ToolSuccess } from "../gateway/pipeline.js";
import type { ToolError } from "../gateway/types.js";

type Result = ToolSuccess | ToolError;

/**
 * run_events keeps every gateway decision and every full result, so a cleared
 * result can be fetched again. action_log keeps one readable row per change.
 * Credential values never reach either table; results are scrubbed first.
 */
export class EventStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    private readonly projectId: (runId: string) => string,
  ) {}

  /** Gateway step 12. One row per call, plus an action_log row if it changed state. */
  log = (event: GatewayEvent): void => {
    const t = this.now();
    this.db
      .prepare("INSERT INTO run_events (run_id, seq, kind, payload, created_at) VALUES (?, ?, 'gateway', ?, ?)")
      .run(event.runId, event.seq, JSON.stringify(event), t);
    if (event.changedState) {
      this.db
        .prepare(
          `INSERT INTO action_log (run_id, seq, tool, tool_version, project_id, description, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.runId,
          event.seq,
          event.tool,
          event.toolVersion ?? null,
          this.projectId(event.runId),
          event.summary ?? event.tool,
          t,
        );
    }
  };

  results = {
    get: (runId: string, seq: number): Result | undefined => {
      const row = this.db
        .prepare(
          "SELECT payload FROM run_events WHERE run_id = ? AND seq = ? AND kind = 'result' ORDER BY id DESC LIMIT 1",
        )
        .get(runId, seq) as { payload: string } | undefined;
      return row ? (JSON.parse(row.payload) as Result) : undefined;
    },
    put: (runId: string, seq: number, result: Result): void => {
      this.db
        .prepare("INSERT INTO run_events (run_id, seq, kind, payload, created_at) VALUES (?, ?, 'result', ?, ?)")
        .run(runId, seq, JSON.stringify(result), this.now());
    },
  };

  /** What the owner reads: the changes a run made, oldest first. */
  actionsFor(runId: string): Array<{ seq: number; tool: string; description: string }> {
    return this.db
      .prepare("SELECT seq, tool, description FROM action_log WHERE run_id = ? ORDER BY id")
      .all(runId) as Array<{ seq: number; tool: string; description: string }>;
  }
}
