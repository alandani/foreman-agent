import { openDatabase } from "../../src/db/database.js";
import { RunStore, type NewRun } from "../../src/db/runs.js";

export const T0 = 1_000_000;

export function makeClock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

export const newRun = (overrides: Partial<NewRun> = {}): NewRun => ({
  id: "run-1",
  projectId: "proj",
  botId: "coder",
  botVersion: 1,
  maxSteps: 3,
  maxCostUsd: 1,
  deadlineMs: T0 + 60_000,
  ...overrides,
});

export function setup(opts: { runStatus?: "running" | "queued" } = {}) {
  const db = openDatabase(":memory:");
  const clock = makeClock();
  const runs = new RunStore(db, clock.now);
  runs.create(newRun());
  if (opts.runStatus !== "queued") runs.transition("run-1", "running");
  return { db, clock, runs };
}
