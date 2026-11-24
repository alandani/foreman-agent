import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventStore } from "../../src/db/events.js";
import { PlanStore } from "../../src/db/plans.js";
import { RunStore } from "../../src/db/runs.js";
import { openDatabase } from "../../src/db/database.js";
import type { PlanRecord } from "../../src/gateway/approvals.js";
import type { BotVersion } from "../../src/gateway/grants.js";
import { callTool, type Deps, type RunContext } from "../../src/gateway/pipeline.js";
import { makeTool } from "../gateway/fixtures.js";
import { newRun, makeClock, T0 } from "./helpers.js";

let base: string;
let root: string;
beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-int-"));
  root = path.join(base, "wt");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const writeFile = makeTool({
  name: "write_file",
  risk: "contained",
  idempotent: false,
  writes: true,
  pathFields: ["path"],
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", maxLength: 200 } },
    required: ["path"],
    additionalProperties: false,
  },
});
const applyDeploy = makeTool({
  name: "apply_deploy",
  risk: "external",
  idempotent: false,
  inputSchema: {
    type: "object",
    properties: { planId: { type: "string", maxLength: 80 } },
    required: ["planId"],
    additionalProperties: false,
  },
});
const registry = new Map([
  [writeFile.name, writeFile],
  [applyDeploy.name, applyDeploy],
]);
const bot: BotVersion = { tools: { write_file: 1, apply_deploy: 1 }, projects: ["proj"], riskCeiling: "external" };

const plan: PlanRecord = {
  id: "plan-1",
  actions: ["deploy"],
  target: "staging",
  touches: "web",
  rollback: "redeploy previous",
  source: { runId: "run-1", events: [1] },
  stateHash: "h1",
  expiresAt: T0 + 30_000,
};

function wire(file = ":memory:") {
  const db = openDatabase(file);
  const clock = makeClock();
  const runs = new RunStore(db, clock.now);
  const plans = new PlanStore(db, clock.now, async () => "h1");
  const events = new EventStore(db, clock.now, (id) => runs.get(id)?.projectId ?? "unknown");
  let handlerCalls = 0;
  const deps: Deps = {
    now: clock.now,
    approvals: plans,
    results: events.results,
    vault: { resolve: () => undefined },
    handlers: {
      write_file: async () => {
        handlerCalls++;
        return "written";
      },
      apply_deploy: async () => {
        handlerCalls++;
        return "deployed";
      },
    },
    log: events.log,
  };
  const ctx: RunContext = {
    runId: "run-1",
    projectId: "proj",
    root,
    bot,
    registry,
    protectedPaths: [],
    limitError: () => runs.limitError("run-1"),
  };
  return { db, clock, runs, plans, events, deps, ctx, calls: () => handlerCalls };
}

describe("gateway with real stores", () => {
  it("runs a contained call, logs it, and writes a readable action log row", async () => {
    const w = wire();
    w.runs.create(newRun());
    w.runs.transition("run-1", "running");
    const o = await callTool(w.ctx, w.deps, { seq: 1, tool: "write_file", args: { path: "src/a.ts" } });
    expect(o.verdict).toBe("allow");
    expect(w.events.actionsFor("run-1")).toEqual([{ seq: 1, tool: "write_file", description: "write_file src/a.ts" }]);
  });

  it("applies an approved plan once and refuses the same plan a second time", async () => {
    const w = wire();
    w.runs.create(newRun());
    w.runs.transition("run-1", "running");
    w.plans.create(plan);
    const early = await callTool(w.ctx, w.deps, { seq: 1, tool: "apply_deploy", args: { planId: "plan-1" } });
    expect(early.verdict).toBe("hold");
    w.plans.decide("plan-1", "approved");
    const first = await callTool(w.ctx, w.deps, { seq: 2, tool: "apply_deploy", args: { planId: "plan-1" } });
    expect(first.verdict).toBe("allow");
    const second = await callTool(w.ctx, w.deps, { seq: 3, tool: "apply_deploy", args: { planId: "plan-1" } });
    expect(second.verdict).toBe("deny");
    expect(w.calls()).toBe(1);
  });

  it("refuses an expired plan", async () => {
    const w = wire();
    w.runs.create(newRun({ deadlineMs: T0 + 10 * 60_000 }));
    w.runs.transition("run-1", "running");
    w.plans.create(plan);
    w.plans.decide("plan-1", "approved");
    w.clock.advance(31_000);
    const o = await callTool(w.ctx, w.deps, { seq: 1, tool: "apply_deploy", args: { planId: "plan-1" } });
    expect(o.verdict === "deny" && o.error.code).toBe("plan_expired");
  });

  it("refuses every call once the run is waiting for approval", async () => {
    const w = wire();
    w.runs.create(newRun());
    w.runs.transition("run-1", "running");
    w.runs.transition("run-1", "waiting_approval");
    const o = await callTool(w.ctx, w.deps, { seq: 1, tool: "write_file", args: { path: "src/a.ts" } });
    expect(o.verdict).toBe("deny");
    expect(w.calls()).toBe(0);
  });

  it("refuses calls after the step limit", async () => {
    const w = wire();
    w.runs.create(newRun({ maxSteps: 1 }));
    w.runs.transition("run-1", "running");
    w.runs.recordStep("run-1");
    const o = await callTool(w.ctx, w.deps, { seq: 1, tool: "write_file", args: { path: "src/a.ts" } });
    expect(o.verdict === "deny" && o.error.code).toBe("limit_reached");
  });

  it("survives a restart: a repeated call returns the stored result without running again", async () => {
    const file = path.join(base, "restart.db");
    const a = wire(file);
    a.runs.create(newRun());
    a.runs.transition("run-1", "running");
    await callTool(a.ctx, a.deps, { seq: 1, tool: "write_file", args: { path: "src/a.ts" } });
    a.db.close();

    const b = wire(file);
    const again = await callTool(b.ctx, b.deps, { seq: 1, tool: "write_file", args: { path: "src/a.ts" } });
    expect(again.verdict).toBe("allow");
    expect(b.calls()).toBe(0);
  });
});
