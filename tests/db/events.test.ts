import { describe, expect, it } from "vitest";
import { EventStore } from "../../src/db/events.js";
import type { GatewayEvent, ToolSuccess } from "../../src/gateway/pipeline.js";
import { setup } from "./helpers.js";

function store() {
  const { db, clock } = setup();
  return { db, events: new EventStore(db, clock.now, () => "proj") };
}

const base: GatewayEvent = { runId: "run-1", seq: 1, tool: "read_file", verdict: "allow", stage: "execute", changedState: false };

describe("EventStore.log", () => {
  it("writes one gateway row per event", () => {
    const { db, events } = store();
    events.log(base);
    events.log({ ...base, seq: 2, verdict: "deny", stage: "schema", code: "schema" });
    const rows = db.prepare("SELECT seq, kind FROM run_events ORDER BY id").all() as Array<{ seq: number; kind: string }>;
    expect(rows).toEqual([
      { seq: 1, kind: "gateway" },
      { seq: 2, kind: "gateway" },
    ]);
  });
  it("leaves the action log empty for reads", () => {
    const { events } = store();
    events.log(base);
    expect(events.actionsFor("run-1")).toEqual([]);
  });
  it("adds an action log row with a readable description when state changed", () => {
    const { events } = store();
    events.log({ ...base, seq: 4, tool: "edit_file", toolVersion: 2, changedState: true, summary: "edit_file src/app.ts" });
    expect(events.actionsFor("run-1")).toEqual([{ seq: 4, tool: "edit_file", description: "edit_file src/app.ts" }]);
  });
  it("falls back to the tool name when there is no summary", () => {
    const { events } = store();
    events.log({ ...base, tool: "apply_deploy", changedState: true });
    expect(events.actionsFor("run-1")[0]?.description).toBe("apply_deploy");
  });
});

describe("EventStore.results", () => {
  const ok: ToolSuccess = { ok: true, statusLine: "read_file ok", body: "text", truncated: false, event: 5 };
  it("returns nothing for a call that has no result", () => {
    expect(store().events.results.get("run-1", 5)).toBeUndefined();
  });
  it("stores and returns a result", () => {
    const { events } = store();
    events.results.put("run-1", 5, ok);
    expect(events.results.get("run-1", 5)).toEqual(ok);
  });
  it("stores an error result", () => {
    const { events } = store();
    const err = { ok: false as const, code: "timeout" as const, message: "slow", hint: "retry" };
    events.results.put("run-1", 6, err);
    expect(events.results.get("run-1", 6)).toEqual(err);
  });
  it("keeps results apart by run and sequence", () => {
    const { events } = store();
    events.results.put("run-1", 5, ok);
    expect(events.results.get("run-1", 6)).toBeUndefined();
  });
});
