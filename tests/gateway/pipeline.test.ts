import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalStore, PlanRecord, StoredPlan } from "../../src/gateway/approvals.js";
import type { ToolDefinition } from "../../src/gateway/definition.js";
import type { BotVersion, Registry } from "../../src/gateway/grants.js";
import {
  callTool,
  type Deps,
  type GatewayEvent,
  type Handler,
  type RunContext,
  type ToolSuccess,
} from "../../src/gateway/pipeline.js";
import type { ToolError } from "../../src/gateway/types.js";
import { makeTool } from "./fixtures.js";

const NOW = 5_000_000;
let base: string;
let root: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-pipeline-"));
  root = path.join(base, "worktree");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const pathSchema = {
  type: "object",
  properties: { path: { type: "string", maxLength: 300 }, text: { type: "string", maxLength: 1000 } },
  required: ["path"],
  additionalProperties: false,
};

const readFile = makeTool({ pathFields: ["path"] });
const writeFile = makeTool({
  name: "write_file",
  risk: "contained",
  inputSchema: pathSchema,
  pathFields: ["path"],
  writes: true,
  idempotent: false,
});
const applyDeploy = makeTool({
  name: "apply_deploy",
  risk: "external",
  scope: "service",
  idempotent: false,
  inputSchema: {
    type: "object",
    properties: { planId: { type: "string", maxLength: 80 } },
    additionalProperties: false,
  },
  credential: "deploy_key",
});
const slow = makeTool({
  name: "run_shell",
  risk: "contained",
  timeoutS: 1,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
});

const tools: ToolDefinition[] = [readFile, writeFile, applyDeploy, slow];
const registry: Registry = new Map(tools.map((t) => [t.name, t]));

const bot: BotVersion = {
  tools: { read_file: 1, write_file: 1, apply_deploy: 1, run_shell: 1 },
  projects: ["proj"],
  riskCeiling: "external",
  credentials: ["deploy_key"],
};

const plan: PlanRecord = {
  id: "plan-1",
  actions: ["deploy"],
  target: "staging",
  touches: "web",
  rollback: "redeploy previous",
  source: { runId: "run-1", events: [1] },
  stateHash: "h",
  expiresAt: NOW + 60_000,
};

let events: GatewayEvent[];
let calls: number;
let used: string[];
let planStatus: StoredPlan["status"];
let results: Map<string, ToolSuccess | ToolError>;
let handlers: Record<string, Handler>;
let reviewer: Deps["reviewer"];
let secretValue: string | undefined;
let limitError: ToolError | null;

beforeEach(() => {
  events = [];
  calls = 0;
  used = [];
  planStatus = "approved";
  results = new Map();
  reviewer = undefined;
  secretValue = "sekret-deploy-key";
  limitError = null;
  handlers = {
    read_file: async () => {
      calls++;
      return "file text";
    },
    write_file: async () => {
      calls++;
      return "written";
    },
    apply_deploy: async (_args, env) => {
      calls++;
      return `deployed with ${env.credential}`;
    },
    run_shell: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 3000));
      return "late";
    },
  };
});

function makeCtx(): RunContext {
  return {
    runId: "run-1",
    projectId: "proj",
    root,
    bot,
    registry,
    protectedPaths: ["tests/acceptance", "ci.yml"],
    limitError: () => limitError,
  };
}

function makeDeps(): Deps {
  const approvals: ApprovalStore = {
    get: (id) => (id === plan.id ? { plan, status: planStatus } : undefined),
    markUsed: (id) => void used.push(id),
    currentHash: async () => "h",
  };
  const deps: Deps = {
    now: () => NOW,
    approvals,
    results: {
      get: (runId, seq) => results.get(`${runId}:${seq}`),
      put: (runId, seq, r) => void results.set(`${runId}:${seq}`, r),
    },
    vault: { resolve: (label) => (label === "deploy_key" ? secretValue : undefined) },
    handlers,
    log: (e) => void events.push(e),
  };
  if (reviewer) deps.reviewer = reviewer;
  return deps;
}

const call = (seq: number, tool: string, args: unknown) => callTool(makeCtx(), makeDeps(), { seq, tool, args });

describe("callTool: deny paths", () => {
  it("denies when the run is over its limits, before anything else", async () => {
    limitError = { ok: false, code: "limit_reached", message: "Step limit reached.", hint: "Stop." };
    const o = await call(1, "read_file", { path: "src/a.ts" });
    expect(o.verdict).toBe("deny");
    expect(calls).toBe(0);
  });
  it("denies an unknown tool", async () => {
    const o = await call(1, "format_disk", {});
    expect(o.verdict === "deny" && o.error.code).toBe("not_granted");
  });
  it("denies bad arguments", async () => {
    const o = await call(1, "read_file", { path: 12 });
    expect(o.verdict === "deny" && o.error.code).toBe("schema");
    expect(calls).toBe(0);
  });
  it("denies a path outside the worktree", async () => {
    const o = await call(1, "read_file", { path: "../../etc/hosts" });
    expect(o.verdict === "deny" && o.error.code).toBe("path_outside_project");
    expect(calls).toBe(0);
  });
  it("denies a write to a protected file", async () => {
    const o = await call(1, "write_file", { path: "tests/acceptance/card-1.test.ts", text: "x" });
    expect(o.verdict === "deny" && o.error.code).toBe("protected_file");
    expect(calls).toBe(0);
  });
  it("allows reading a protected file", async () => {
    const o = await call(1, "read_file", { path: "ci.yml" });
    expect(o.verdict).toBe("allow");
  });
  it("denies a tool that needs a credential the bot lacks", async () => {
    const noCred: Registry = registry;
    const o = await callTool(
      { ...makeCtx(), bot: { ...bot, credentials: [] }, registry: noCred },
      makeDeps(),
      { seq: 1, tool: "apply_deploy", args: { planId: "plan-1" } },
    );
    expect(o.verdict === "deny" && o.error.code).toBe("not_granted");
  });
  it("denies when the vault no longer has the credential", async () => {
    secretValue = undefined;
    const o = await call(1, "apply_deploy", { planId: "plan-1" });
    expect(o.verdict === "deny" && o.error.code).toBe("not_granted");
    expect(calls).toBe(0);
  });
  it("denies when the reviewer blocks an external call", async () => {
    reviewer = async () => "block";
    const o = await call(1, "apply_deploy", { planId: "plan-1" });
    expect(o.verdict === "deny" && o.error.code).toBe("rejected");
    expect(calls).toBe(0);
  });
});

describe("callTool: approval", () => {
  it("holds an external call that has no plan", async () => {
    const o = await call(1, "apply_deploy", {});
    expect(o.verdict).toBe("hold");
    expect(calls).toBe(0);
  });
  it("holds a pending plan and passes reviewer flags to the card", async () => {
    planStatus = "pending";
    reviewer = async () => "flag";
    const o = await call(1, "apply_deploy", { planId: "plan-1" });
    expect(o.verdict).toBe("hold");
    if (o.verdict === "hold") expect(o.flags.length).toBe(1);
  });
  it("runs an approved plan, injects the credential and marks the plan used", async () => {
    const o = await call(1, "apply_deploy", { planId: "plan-1" });
    expect(o.verdict).toBe("allow");
    expect(calls).toBe(1);
    expect(used).toEqual(["plan-1"]);
  });
  it("does not let a reviewer flag block an already approved plan", async () => {
    reviewer = async () => "flag";
    const o = await call(1, "apply_deploy", { planId: "plan-1" });
    expect(o.verdict).toBe("allow");
  });
});

describe("callTool: execution and results", () => {
  it("runs a safe call and returns a shaped result", async () => {
    const o = await call(1, "read_file", { path: "src/a.ts" });
    expect(o.verdict).toBe("allow");
    if (o.verdict === "allow" && o.result.ok) {
      expect(o.result.body).toBe("file text");
      expect(o.result.event).toBe(1);
    }
  });
  it("scrubs the credential out of the result", async () => {
    const o = await call(1, "apply_deploy", { planId: "plan-1" });
    if (o.verdict === "allow" && o.result.ok) {
      expect(o.result.body).not.toContain("sekret-deploy-key");
      expect(o.result.body).toContain("[redacted]");
    }
  });
  it("scrubs the credential out of an error message", async () => {
    handlers["apply_deploy"] = async (_a, env) => {
      throw new Error(`login failed for ${env.credential}`);
    };
    const o = await call(1, "apply_deploy", { planId: "plan-1" });
    if (o.verdict === "allow" && !o.result.ok) {
      expect(o.result.code).toBe("tool_error");
      expect(o.result.message).not.toContain("sekret-deploy-key");
    } else {
      throw new Error("expected an error result");
    }
    expect(used).toEqual([]);
  });
  it("caps long output", async () => {
    handlers["read_file"] = async () => "x".repeat(100_000);
    const o = await call(1, "read_file", { path: "src/a.ts" });
    if (o.verdict === "allow" && o.result.ok) expect(o.result.truncated).toBe(true);
    else throw new Error("expected a result");
  });
  it("times out a slow tool with a timeout error", async () => {
    const o = await call(1, "run_shell", {});
    expect(o.verdict === "allow" && !o.result.ok && o.result.code).toBe("timeout");
  }, 5000);
  it("returns the stored result for a repeated call and runs the tool once", async () => {
    await call(7, "write_file", { path: "src/new.ts", text: "x" });
    const again = await call(7, "write_file", { path: "src/new.ts", text: "x" });
    expect(calls).toBe(1);
    expect(again.verdict).toBe("allow");
  });
});

describe("callTool: logging", () => {
  it("writes exactly one event per call with the verdict and stage", async () => {
    await call(1, "read_file", { path: "src/a.ts" });
    await call(2, "read_file", { path: 5 });
    await call(3, "apply_deploy", {});
    expect(events.map((e) => [e.seq, e.verdict, e.stage])).toEqual([
      [1, "allow", "execute"],
      [2, "deny", "schema"],
      [3, "hold", "approval"],
    ]);
  });
  it("marks state-changing calls and leaves reads unmarked", async () => {
    await call(1, "read_file", { path: "src/a.ts" });
    await call(2, "write_file", { path: "src/new.ts", text: "x" });
    expect(events.map((e) => e.changedState)).toEqual([false, true]);
  });
  it("records the tool version on every call that found its tool", async () => {
    await call(1, "read_file", { path: "src/a.ts" });
    expect(events[0]?.toolVersion).toBe(1);
  });
});
