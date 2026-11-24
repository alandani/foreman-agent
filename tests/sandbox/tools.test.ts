import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkToolDefinition } from "../../src/gateway/definition.js";
import type { BotVersion } from "../../src/gateway/grants.js";
import { callTool, type Deps, type Outcome, type RunContext, type ToolSuccess } from "../../src/gateway/pipeline.js";
import type { ExecRequest, ExecResult, Sandbox } from "../../src/sandbox/sandbox.js";
import { formatResult, sandboxHandlers, sandboxTools, shellQuote } from "../../src/tools/sandbox.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-sbt-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.txt"), "x");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

class FakeSandbox implements Sandbox {
  seen: ExecRequest[] = [];
  constructor(private result: Partial<ExecResult> | Error = {}) {}
  async exec(req: ExecRequest): Promise<ExecResult> {
    this.seen.push(req);
    if (this.result instanceof Error) throw this.result;
    return { exitCode: 0, output: "hello\n", timedOut: false, truncated: false, durationMs: 1200, ...this.result };
  }
}

function harness(sandbox: Sandbox) {
  const registry = new Map(sandboxTools.map((t) => [t.name, t]));
  const bot: BotVersion = { tools: { run_shell: 1, run_tests: 1 }, projects: ["proj"], riskCeiling: "contained" };
  const results = new Map<string, unknown>();
  const deps: Deps = {
    now: () => 0,
    approvals: { get: () => undefined, markUsed: () => {}, currentHash: async () => "" },
    results: { get: (r, s) => results.get(`${r}:${s}`) as never, put: (r, s, v) => void results.set(`${r}:${s}`, v) },
    vault: { resolve: () => undefined },
    handlers: sandboxHandlers({ root, protectedPaths: ["tests"], sandbox, testCommand: "npm test --" }),
    log: () => {},
  };
  const ctx: RunContext = { runId: "r1", projectId: "proj", root, bot, registry, protectedPaths: ["tests"], limitError: () => null };
  let n = 0;
  return (tool: string, args: unknown): Promise<Outcome> => callTool(ctx, deps, { seq: ++n, tool, args });
}
const body = (o: Outcome) => {
  if (o.verdict !== "allow" || !o.result.ok) throw new Error(JSON.stringify(o));
  return (o.result as ToolSuccess).body;
};

describe("definitions", () => {
  for (const def of sandboxTools) {
    it(`${def.name} passes the definition check`, () => expect(checkToolDefinition(def)).toEqual([]));
  }
});

describe("shellQuote", () => {
  it("keeps a value as one literal word", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's $(x)")).toBe(`'it'\\''s $(x)'`);
  });
});

describe("formatResult", () => {
  const base: ExecResult = { exitCode: 0, output: "", timedOut: false, truncated: false, durationMs: 1500 };
  it("shows exit code and says when there is no output", () => {
    expect(formatResult(base, 120, 200)).toBe("Exit code: 0 (1.5s)\n(no output)");
  });
  it("reports a timeout", () => {
    expect(formatResult({ ...base, exitCode: null, timedOut: true, output: "part" }, 30, 200)).toBe(
      "Timed out after 30 seconds and was killed.\npart",
    );
  });
  it("notes cut output", () => {
    expect(formatResult({ ...base, output: "x", truncated: true }, 1, 200)).toContain("output cut at 200 KB");
  });
});

describe("run_shell", () => {
  it("runs a command in the sandbox with the run's settings", async () => {
    const sb = new FakeSandbox();
    const out = body(await harness(sb)("run_shell", { command: "ls" }));
    expect(out).toBe("Exit code: 0 (1.2s)\nhello");
    expect(sb.seen[0]).toMatchObject({
      root, protectedPaths: ["tests"], cwd: "", command: "ls", timeoutS: 120, network: "off", name: "foreman-r1-1",
    });
  });
  it("returns a failing exit code as a result the model can read", async () => {
    const out = body(await harness(new FakeSandbox({ exitCode: 2, output: "boom" }))("run_shell", { command: "false" }));
    expect(out).toContain("Exit code: 2");
    expect(out).toContain("boom");
  });
  it("maps cwd to a path relative to the project", async () => {
    const sb = new FakeSandbox();
    await harness(sb)("run_shell", { command: "ls", cwd: "src" });
    expect(sb.seen[0]!.cwd).toBe("src");
  });
  it("uses the timeout the model asked for", async () => {
    const sb = new FakeSandbox();
    await harness(sb)("run_shell", { command: "sleep 1", timeoutSeconds: 7 });
    expect(sb.seen[0]!.timeoutS).toBe(7);
  });
  it("refuses a cwd outside the project, a file, and a missing folder", async () => {
    const call = harness(new FakeSandbox());
    const code = async (args: unknown) => {
      const o = await call("run_shell", args);
      return o.verdict === "deny" ? o.error.code : o.verdict === "allow" && !o.result.ok ? o.result.message : "ok";
    };
    expect(await code({ command: "ls", cwd: "../" })).toBe("path_outside_project");
    expect(await code({ command: "ls", cwd: "src/a.txt" })).toContain("is a file");
    expect(await code({ command: "ls", cwd: "nope" })).toContain("does not exist");
  });
  it("refuses an empty command, a huge timeout and extra arguments", async () => {
    const call = harness(new FakeSandbox());
    for (const args of [{ command: "" }, { command: "x", timeoutSeconds: 9999 }, { command: "x", network: "on" }]) {
      const o = await call("run_shell", args);
      expect(o.verdict === "deny" && o.error.code).toBe("schema");
    }
  });
  it("turns a sandbox failure into a tool error", async () => {
    const o = await harness(new FakeSandbox(new Error("Docker was not found")))("run_shell", { command: "ls" });
    expect(o.verdict === "allow" && !o.result.ok && o.result.code).toBe("tool_error");
  });
});

describe("run_tests", () => {
  it("runs the project test command in the root", async () => {
    const sb = new FakeSandbox();
    await harness(sb)("run_tests", {});
    expect(sb.seen[0]).toMatchObject({ command: "npm test --", cwd: "", timeoutS: 300 });
  });
  it("adds the filter as one quoted word", async () => {
    const sb = new FakeSandbox();
    await harness(sb)("run_tests", { filter: "parses 'x'; rm -rf /" });
    expect(sb.seen[0]!.command).toBe(`npm test -- 'parses '\\''x'\\''; rm -rf /'`);
  });
});
