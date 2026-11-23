import { describe, expect, it } from "vitest";
import { checkGrant, findTool, type BotVersion, type Registry } from "../../src/gateway/grants.js";
import { makeTool } from "./fixtures.js";

const read = makeTool();
const push = makeTool({ name: "git_push_branch", risk: "external", scope: "service" });
const registry: Registry = new Map([
  [read.name, read],
  [push.name, push],
]);

const bot: BotVersion = {
  tools: { read_file: 1, git_push_branch: 1 },
  projects: ["proj-a"],
  riskCeiling: "contained",
};

describe("findTool", () => {
  it("finds a listed tool at its pinned version", () => {
    const r = findTool(registry, bot, "read_file");
    expect(r.ok).toBe(true);
  });
  it("denies a tool the bot does not list, and names the valid ones", () => {
    const r = findTool(registry, bot, "delete_everything");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("not_granted");
      expect(r.hint).toContain("git_push_branch, read_file");
    }
  });
  it("denies a listed tool missing from the registry", () => {
    const r = findTool(new Map(), bot, "read_file");
    expect(r.ok).toBe(false);
  });
  it("denies when the tool version differs from the pinned one", () => {
    const r = findTool(new Map([[read.name, makeTool({ version: 2 })]]), bot, "read_file");
    expect(r.ok).toBe(false);
  });
});

describe("checkGrant", () => {
  it("allows a granted project at or below the ceiling", () => {
    expect(checkGrant(bot, read, "proj-a").ok).toBe(true);
  });
  it("denies another project", () => {
    const r = checkGrant(bot, read, "proj-b");
    expect(r.ok).toBe(false);
  });
  it("denies a tool above the risk ceiling even if listed", () => {
    const r = checkGrant(bot, push, "proj-a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("risk ceiling");
  });
  it("allows the same tool when the ceiling is raised", () => {
    expect(checkGrant({ ...bot, riskCeiling: "external" }, push, "proj-a").ok).toBe(true);
  });
});
