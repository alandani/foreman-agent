import { describe, expect, it } from "vitest";
import type { RunStatus } from "../../src/db/runs.js";
import { setup, T0 } from "./helpers.js";

describe("RunStore transitions", () => {
  it("starts queued", () => {
    const { runs } = setup({ runStatus: "queued" });
    expect(runs.get("run-1")?.status).toBe("queued");
  });

  const allowed: Array<[RunStatus, RunStatus]> = [
    ["running", "waiting_approval"],
    ["running", "waiting_input"],
    ["running", "finished"],
    ["running", "failed"],
    ["waiting_approval", "running"],
    ["waiting_input", "running"],
  ];
  for (const [from, to] of allowed) {
    it(`allows ${from} to ${to}`, () => {
      const { db, runs } = setup();
      db.prepare("UPDATE runs SET status = ? WHERE id = 'run-1'").run(from);
      expect(runs.transition("run-1", to).status).toBe(to);
    });
  }

  const refused: Array<[RunStatus, RunStatus]> = [
    ["queued", "finished"],
    ["finished", "running"],
    ["cancelled", "running"],
    ["failed", "running"],
    ["waiting_approval", "finished"],
  ];
  for (const [from, to] of refused) {
    it(`refuses ${from} to ${to}`, () => {
      const { db, runs } = setup();
      db.prepare("UPDATE runs SET status = ? WHERE id = 'run-1'").run(from);
      expect(() => runs.transition("run-1", to)).toThrow();
    });
  }

  it("refuses to move a run that does not exist", () => {
    const { runs } = setup();
    expect(() => runs.transition("ghost", "running")).toThrow();
  });
});

describe("RunStore.limitError", () => {
  it("is null for a live run inside its limits", () => {
    const { runs } = setup();
    expect(runs.limitError("run-1")).toBeNull();
  });
  it("stops a run that is not running", () => {
    const { runs } = setup();
    runs.transition("run-1", "waiting_approval");
    expect(runs.limitError("run-1")?.message).toContain("waiting_approval");
  });
  it("stops a run that does not exist", () => {
    const { runs } = setup();
    expect(runs.limitError("ghost")?.code).toBe("limit_reached");
  });
  it("stops at the step limit", () => {
    const { runs } = setup();
    for (let i = 0; i < 3; i++) runs.recordStep("run-1");
    expect(runs.limitError("run-1")?.message).toContain("step limit");
  });
  it("stops at the money limit", () => {
    const { runs } = setup();
    runs.recordCost("run-1", 0.6);
    expect(runs.limitError("run-1")).toBeNull();
    runs.recordCost("run-1", 0.4);
    expect(runs.limitError("run-1")?.message).toContain("money limit");
  });
  it("stops after the deadline", () => {
    const { runs, clock } = setup();
    clock.advance(60_001);
    expect(runs.limitError("run-1")?.message).toContain("time limit");
    expect(clock.now()).toBeGreaterThan(T0);
  });
  it("counts steps and cost", () => {
    const { runs } = setup();
    runs.recordStep("run-1");
    runs.recordCost("run-1", 0.25);
    const run = runs.get("run-1");
    expect(run?.stepCount).toBe(1);
    expect(run?.costUsd).toBeCloseTo(0.25);
  });
});
