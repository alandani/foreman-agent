import { describe, expect, it } from "vitest";
import type { PlanRecord } from "../../src/gateway/approvals.js";
import { PlanStore } from "../../src/db/plans.js";
import { setup } from "./helpers.js";

const plan: PlanRecord = {
  id: "plan-1",
  actions: ["deploy web to staging"],
  target: "staging",
  touches: "web service",
  rollback: "redeploy previous image",
  source: { runId: "run-1", cardId: "card-9", events: [3, 4] },
  stateHash: "h1",
  expiresAt: 2_000_000,
};

function plans() {
  const { db, clock } = setup();
  return new PlanStore(db, clock.now, async () => "h1");
}

describe("PlanStore", () => {
  it("stores a plan as pending and reads it back whole", () => {
    const store = plans();
    store.create(plan);
    expect(store.get("plan-1")).toEqual({ plan, status: "pending" });
  });
  it("returns nothing for an unknown plan", () => {
    expect(plans().get("nope")).toBeUndefined();
  });
  it("records the owner's approval", () => {
    const store = plans();
    store.create(plan);
    store.decide("plan-1", "approved");
    expect(store.get("plan-1")?.status).toBe("approved");
  });
  it("records a rejection with the owner's note", () => {
    const store = plans();
    store.create(plan);
    store.decide("plan-1", "rejected", "wrong environment");
    expect(store.get("plan-1")).toMatchObject({ status: "rejected", note: "wrong environment" });
  });
  it("lets the owner decide only once", () => {
    const store = plans();
    store.create(plan);
    store.decide("plan-1", "approved");
    expect(() => store.decide("plan-1", "rejected")).toThrow();
  });
  it("marks an approved plan used, once", () => {
    const store = plans();
    store.create(plan);
    store.decide("plan-1", "approved");
    store.markUsed("plan-1");
    expect(store.get("plan-1")?.status).toBe("used");
    expect(() => store.markUsed("plan-1")).toThrow();
  });
  it("refuses to use a plan that was never approved", () => {
    const store = plans();
    store.create(plan);
    expect(() => store.markUsed("plan-1")).toThrow();
  });
  it("reads the target hash through the supplied function", async () => {
    expect(await plans().currentHash(plan)).toBe("h1");
  });
});
