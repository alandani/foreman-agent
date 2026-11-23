import { describe, expect, it } from "vitest";
import {
  checkApproval,
  type ApprovalStore,
  type PlanRecord,
  type PlanStatus,
  type StoredPlan,
} from "../../src/gateway/approvals.js";
import type { BotVersion } from "../../src/gateway/grants.js";
import { makeTool } from "./fixtures.js";

const NOW = 1_000_000;

const plan: PlanRecord = {
  id: "plan-1",
  actions: ["deploy web to staging"],
  target: "staging",
  touches: "web service, about 30 seconds of downtime",
  rollback: "redeploy the previous image",
  source: { runId: "run-1", events: [4, 5] },
  stateHash: "hash-a",
  expiresAt: NOW + 60_000,
};

function store(status: PlanStatus, opts: { hash?: string; plan?: PlanRecord; note?: string } = {}): ApprovalStore {
  const stored: StoredPlan = { plan: opts.plan ?? plan, status };
  if (opts.note) stored.note = opts.note;
  return {
    get: (id) => (id === plan.id ? stored : undefined),
    markUsed: () => undefined,
    currentHash: async () => opts.hash ?? "hash-a",
  };
}

const bot: BotVersion = { tools: {}, projects: ["p"], riskCeiling: "destructive", standing: ["git_push_branch"] };
const apply = makeTool({ name: "apply_deploy", risk: "external" });
const destroy = makeTool({ name: "apply_infra_change", risk: "destructive" });
const push = makeTool({ name: "git_push_branch", risk: "external" });

describe("checkApproval", () => {
  it("lets safe and contained tools through", async () => {
    for (const risk of ["safe", "contained"] as const) {
      const d = await checkApproval(bot, makeTool({ risk }), {}, store("approved"), NOW);
      expect(d.kind).toBe("allow");
    }
  });
  it("holds an external tool with no plan and no standing grant", async () => {
    const d = await checkApproval(bot, apply, {}, store("approved"), NOW);
    expect(d.kind).toBe("hold");
  });
  it("allows an external tool with a standing grant", async () => {
    const d = await checkApproval(bot, push, {}, store("approved"), NOW);
    expect(d).toEqual({ kind: "allow", via: "standing" });
  });
  it("never lets a standing grant cover a destructive tool", async () => {
    const withStanding: BotVersion = { ...bot, standing: ["apply_infra_change"] };
    const d = await checkApproval(withStanding, destroy, {}, store("approved"), NOW);
    expect(d.kind).toBe("hold");
  });
  it("allows an approved, fresh plan whose target has not changed", async () => {
    const d = await checkApproval(bot, apply, { planId: "plan-1" }, store("approved"), NOW);
    expect(d).toEqual({ kind: "allow", via: "plan", planId: "plan-1" });
  });
  it("holds a plan that is still pending", async () => {
    const d = await checkApproval(bot, apply, { planId: "plan-1" }, store("pending"), NOW);
    expect(d.kind).toBe("hold");
  });
  it("denies an unknown plan", async () => {
    const d = await checkApproval(bot, apply, { planId: "nope" }, store("approved"), NOW);
    expect(d.kind).toBe("deny");
  });
  it("denies a rejected plan and passes the owner's note back", async () => {
    const d = await checkApproval(bot, apply, { planId: "plan-1" }, store("rejected", { note: "wrong env" }), NOW);
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") {
      expect(d.error.code).toBe("rejected");
      expect(d.error.message).toContain("wrong env");
    }
  });
  it("denies a plan that was already applied", async () => {
    const d = await checkApproval(bot, apply, { planId: "plan-1" }, store("used"), NOW);
    expect(d.kind).toBe("deny");
  });
  it("denies an expired plan", async () => {
    const d = await checkApproval(bot, apply, { planId: "plan-1" }, store("approved"), NOW + 120_000);
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.error.code).toBe("plan_expired");
  });
  it("denies a plan whose target changed since it was made", async () => {
    const d = await checkApproval(bot, apply, { planId: "plan-1" }, store("approved", { hash: "hash-b" }), NOW);
    expect(d.kind).toBe("deny");
  });
});
