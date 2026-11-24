import type { DatabaseSync } from "node:sqlite";
import type { ToolError } from "../gateway/types.js";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "finished"
  | "stopped"
  | "failed"
  | "cancelled";

/** Allowed state changes. Terminal states have none. */
const TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["waiting_approval", "waiting_input", "finished", "stopped", "failed", "cancelled"],
  waiting_approval: ["running", "stopped", "cancelled"],
  waiting_input: ["running", "stopped", "cancelled"],
  finished: [],
  stopped: [],
  failed: [],
  cancelled: [],
};

export interface Run {
  id: string;
  projectId: string;
  botId: string;
  botVersion: number;
  status: RunStatus;
  stepCount: number;
  maxSteps: number;
  costUsd: number;
  maxCostUsd: number;
  deadlineMs: number;
  createdAt: number;
  updatedAt: number;
}

export interface NewRun {
  id: string;
  projectId: string;
  botId: string;
  botVersion: number;
  maxSteps: number;
  maxCostUsd: number;
  deadlineMs: number;
}

interface RunRow {
  id: string;
  project_id: string;
  bot_id: string;
  bot_version: number;
  status: RunStatus;
  step_count: number;
  max_steps: number;
  cost_usd: number;
  max_cost_usd: number;
  deadline_ms: number;
  created_at: number;
  updated_at: number;
}

const toRun = (r: RunRow): Run => ({
  id: r.id,
  projectId: r.project_id,
  botId: r.bot_id,
  botVersion: r.bot_version,
  status: r.status,
  stepCount: r.step_count,
  maxSteps: r.max_steps,
  costUsd: r.cost_usd,
  maxCostUsd: r.max_cost_usd,
  deadlineMs: r.deadline_ms,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class RunStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  create(run: NewRun): Run {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, bot_id, bot_version, status, max_steps, max_cost_usd,
                           deadline_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.projectId, run.botId, run.botVersion, run.maxSteps, run.maxCostUsd, run.deadlineMs, t, t);
    return this.mustGet(run.id);
  }

  get(id: string): Run | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  /** Moves a run to a new state, or throws if that change is not allowed. */
  transition(id: string, to: RunStatus): Run {
    const run = this.mustGet(id);
    if (!TRANSITIONS[run.status].includes(to)) {
      throw new Error(`Run ${id} cannot go from ${run.status} to ${to}.`);
    }
    this.db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(to, this.now(), id);
    return this.mustGet(id);
  }

  /** Counts one model step. Called by the loop before each model call. */
  recordStep(id: string): void {
    this.db
      .prepare("UPDATE runs SET step_count = step_count + 1, updated_at = ? WHERE id = ?")
      .run(this.now(), id);
  }

  /** Adds money spent. Called by the loop after each model call. */
  recordCost(id: string, usd: number): void {
    this.db.prepare("UPDATE runs SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?").run(usd, this.now(), id);
  }

  /** Gateway check 1: the run is live and inside its step, time and money limits. */
  limitError(id: string): ToolError | null {
    const run = this.get(id);
    const stop = (message: string): ToolError => ({
      ok: false,
      code: "limit_reached",
      message,
      hint: "Stop and report what you have.",
    });
    if (!run) return stop("This run does not exist.");
    if (run.status !== "running") return stop(`This run is ${run.status}.`);
    if (run.stepCount >= run.maxSteps) return stop("The step limit for this run is reached.");
    if (run.costUsd >= run.maxCostUsd) return stop("The money limit for this run is reached.");
    if (this.now() > run.deadlineMs) return stop("The time limit for this run is reached.");
    return null;
  }

  private mustGet(id: string): Run {
    const run = this.get(id);
    if (!run) throw new Error(`Run ${id} does not exist.`);
    return run;
  }
}
