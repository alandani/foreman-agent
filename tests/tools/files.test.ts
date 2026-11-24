import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkToolDefinition } from "../../src/gateway/definition.js";
import type { BotVersion } from "../../src/gateway/grants.js";
import { callTool, type Deps, type Outcome, type RunContext, type ToolSuccess } from "../../src/gateway/pipeline.js";
import { fileHandlers, fileTools } from "../../src/tools/files.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-files-"));
  fs.mkdirSync(path.join(root, "src/deep"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules/pkg"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/app.ts"), "const a = 1;\nconst b = 2;\nexport { a, b };\n");
  fs.writeFileSync(path.join(root, "src/deep/util.ts"), "export const Needle = 1;\nexport const needle2 = 2;\n");
  fs.writeFileSync(path.join(root, "node_modules/pkg/index.js"), "needle in modules");
  fs.writeFileSync(path.join(root, ".git/config"), "needle in git");
  fs.writeFileSync(path.join(root, "tests/app.test.ts"), "test('x', () => {});\n");
  fs.writeFileSync(path.join(root, "image.bin"), Buffer.from([1, 2, 0, 3, 4]));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const registry = new Map(fileTools.map((t) => [t.name, t]));
const bot: BotVersion = {
  tools: Object.fromEntries(fileTools.map((t) => [t.name, 1])),
  projects: ["proj"],
  riskCeiling: "contained",
};

function harness() {
  let n = 0;
  const results = new Map<string, unknown>();
  const deps: Deps = {
    now: () => 0,
    approvals: { get: () => undefined, markUsed: () => {}, currentHash: async () => "" },
    results: {
      get: (r, s) => results.get(`${r}:${s}`) as never,
      put: (r, s, v) => void results.set(`${r}:${s}`, v),
    },
    vault: { resolve: () => undefined },
    handlers: fileHandlers(root),
    log: () => {},
  };
  const ctx: RunContext = {
    runId: "r",
    projectId: "proj",
    root,
    bot,
    registry,
    protectedPaths: ["tests", ".git"],
    limitError: () => null,
  };
  return (tool: string, args: unknown): Promise<Outcome> => callTool(ctx, deps, { seq: ++n, tool, args });
}

async function ok(call: ReturnType<typeof harness>, tool: string, args: unknown): Promise<string> {
  const o = await call(tool, args);
  if (o.verdict !== "allow" || !o.result.ok) throw new Error(`call failed: ${JSON.stringify(o)}`);
  return (o.result as ToolSuccess).body;
}
async function failure(call: ReturnType<typeof harness>, tool: string, args: unknown): Promise<string> {
  const o = await call(tool, args);
  if (o.verdict === "deny") return `${o.error.code}: ${o.error.message}`;
  if (o.verdict === "allow" && !o.result.ok) return `${o.result.code}: ${o.result.message}`;
  throw new Error(`expected a failure, got ${JSON.stringify(o)}`);
}

describe("definitions", () => {
  for (const def of fileTools) {
    it(`${def.name} passes the definition check`, () => {
      expect(checkToolDefinition(def)).toEqual([]);
    });
  }
});

describe("list_files", () => {
  it("lists two levels by default and skips .git and node_modules", async () => {
    const out = await ok(harness(), "list_files", {});
    expect(out.split("\n")).toEqual(
      ["image.bin", "src/", "src/app.ts", "src/deep/", "tests/", "tests/app.test.ts"],
    );
  });
  it("respects depth", async () => {
    const c = harness();
    expect(await ok(c, "list_files", { depth: 1 })).not.toContain("src/app.ts");
    expect(await ok(c, "list_files", { depth: 3 })).toContain("src/deep/util.ts");
  });
  it("lists a subfolder", async () => {
    expect(await ok(harness(), "list_files", { path: "src/deep" })).toBe("src/deep/util.ts");
  });
  it("accepts the root as .", async () => {
    expect(await ok(harness(), "list_files", { path: "." })).toContain("src/");
  });
  it("refuses a file and a missing folder", async () => {
    const c = harness();
    expect(await failure(c, "list_files", { path: "src/app.ts" })).toContain("is a file");
    expect(await failure(c, "list_files", { path: "nope" })).toContain("does not exist");
  });
  it("refuses to leave the project", async () => {
    expect(await failure(harness(), "list_files", { path: "../" })).toContain("path_outside_project");
  });
  it("says so when a folder is empty", async () => {
    fs.mkdirSync(path.join(root, "empty"));
    expect(await ok(harness(), "list_files", { path: "empty" })).toContain("empty");
  });
});

describe("read_file", () => {
  it("returns numbered lines with a header", async () => {
    const out = await ok(harness(), "read_file", { path: "src/app.ts" });
    expect(out).toBe("src/app.ts, lines 1-3 of 3\n1\tconst a = 1;\n2\tconst b = 2;\n3\texport { a, b };");
  });
  it("reads a range", async () => {
    const out = await ok(harness(), "read_file", { path: "src/app.ts", startLine: 2, endLine: 2 });
    expect(out).toContain("2\tconst b = 2;");
    expect(out).not.toContain("1\tconst a");
  });
  it("tells the model where to continue when it stops short", async () => {
    fs.writeFileSync(path.join(root, "big.txt"), Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join("\n"));
    const out = await ok(harness(), "read_file", { path: "big.txt" });
    expect(out.split("\n")[0]).toContain("continue at line 2001");
  });
  it("refuses binary files, folders, missing files and big files", async () => {
    const c = harness();
    expect(await failure(c, "read_file", { path: "image.bin" })).toContain("binary");
    expect(await failure(c, "read_file", { path: "src" })).toContain("is a folder");
    expect(await failure(c, "read_file", { path: "gone.ts" })).toContain("does not exist");
    fs.writeFileSync(path.join(root, "huge.txt"), "x".repeat(1_000_001));
    expect(await failure(c, "read_file", { path: "huge.txt" })).toContain("1 MB");
  });
  it("refuses lines past the end and a backwards range", async () => {
    const c = harness();
    expect(await failure(c, "read_file", { path: "src/app.ts", startLine: 9 })).toContain("only 3 lines");
    expect(await failure(c, "read_file", { path: "src/app.ts", startLine: 3, endLine: 2 })).toContain("before");
  });
  it("does not read .git", async () => {
    expect(await failure(harness(), "read_file", { path: ".git/config" })).toContain(".git");
  });
  it("stops a symlink that points out of the project", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-out-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    try {
      expect(await failure(harness(), "read_file", { path: "link.txt" })).toContain("path_outside_project");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("search_code", () => {
  it("finds literal matches with path and line", async () => {
    const out = await ok(harness(), "search_code", { pattern: "const b" });
    expect(out).toBe("src/app.ts:2: const b = 2;");
  });
  it("is case sensitive unless asked", async () => {
    const c = harness();
    expect(await ok(c, "search_code", { pattern: "needle" })).toBe("src/deep/util.ts:2: export const needle2 = 2;");
    const both = await ok(c, "search_code", { pattern: "needle", ignoreCase: true });
    expect(both.split("\n")).toHaveLength(2);
  });
  it("skips .git, node_modules and binary files", async () => {
    const out = await ok(harness(), "search_code", { pattern: "needle", ignoreCase: true });
    expect(out).not.toContain("node_modules");
    expect(out).not.toContain(".git");
  });
  it("treats regex characters literally by default", async () => {
    expect(await ok(harness(), "search_code", { pattern: "{ a, b }" })).toContain("src/app.ts:3");
    expect(await ok(harness(), "search_code", { pattern: "a.*b" })).toBe("No matches.");
  });
  it("supports regex when asked", async () => {
    expect(await ok(harness(), "search_code", { pattern: "const [ab] =", regex: true })).toContain("src/app.ts:1");
  });
  it("rejects a broken regex", async () => {
    expect(await failure(harness(), "search_code", { pattern: "(", regex: true })).toContain("not a valid regular expression");
  });
  it("limits results and says so", async () => {
    fs.writeFileSync(path.join(root, "many.txt"), Array.from({ length: 30 }, () => "hit").join("\n"));
    const out = await ok(harness(), "search_code", { pattern: "hit", maxResults: 5 });
    expect(out.split("\n")).toHaveLength(6);
    expect(out).toContain("stopped at 5 results");
  });
  it("searches one folder or one file", async () => {
    const c = harness();
    expect(await ok(c, "search_code", { pattern: "export", path: "src/deep" })).not.toContain("src/app.ts");
    expect(await ok(c, "search_code", { pattern: "export", path: "src/app.ts" })).toBe("src/app.ts:3: export { a, b };");
  });
});

describe("edit_file", () => {
  it("replaces one exact match", async () => {
    const c = harness();
    const out = await ok(c, "edit_file", { path: "src/app.ts", oldText: "const b = 2;", newText: "const b = 3;" });
    expect(out).toContain("Edited src/app.ts");
    expect(fs.readFileSync(path.join(root, "src/app.ts"), "utf8")).toBe("const a = 1;\nconst b = 3;\nexport { a, b };\n");
  });
  it("keeps dollar signs in the new text as they are", async () => {
    await ok(harness(), "edit_file", { path: "src/app.ts", oldText: "const a = 1;", newText: "const a = '$&$1';" });
    expect(fs.readFileSync(path.join(root, "src/app.ts"), "utf8")).toContain("const a = '$&$1';");
  });
  it("fails when the text is missing or ambiguous, and leaves the file alone", async () => {
    const c = harness();
    const before = fs.readFileSync(path.join(root, "src/app.ts"), "utf8");
    expect(await failure(c, "edit_file", { path: "src/app.ts", oldText: "nope", newText: "x" })).toContain("not found");
    expect(await failure(c, "edit_file", { path: "src/app.ts", oldText: "const", newText: "let" })).toContain("more than once");
    expect(fs.readFileSync(path.join(root, "src/app.ts"), "utf8")).toBe(before);
  });
  it("fails on a missing file", async () => {
    expect(await failure(harness(), "edit_file", { path: "gone.ts", oldText: "a", newText: "b" })).toContain("does not exist");
  });
  it("is refused on protected files and outside the project", async () => {
    const c = harness();
    expect(await failure(c, "edit_file", { path: "tests/app.test.ts", oldText: "x", newText: "y" })).toContain("protected_file");
    expect(await failure(c, "edit_file", { path: "../x.ts", oldText: "x", newText: "y" })).toContain("path_outside_project");
  });
  it("leaves no temp files behind", async () => {
    await ok(harness(), "edit_file", { path: "src/app.ts", oldText: "const a = 1;", newText: "const a = 9;" });
    expect(fs.readdirSync(path.join(root, "src")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("write_file", () => {
  it("creates a file and its folders", async () => {
    const out = await ok(harness(), "write_file", { path: "src/new/dir/x.ts", content: "hello" });
    expect(out).toContain("Created src/new/dir/x.ts");
    expect(fs.readFileSync(path.join(root, "src/new/dir/x.ts"), "utf8")).toBe("hello");
  });
  it("replaces an existing file and says so", async () => {
    const out = await ok(harness(), "write_file", { path: "src/app.ts", content: "new" });
    expect(out).toContain("Replaced src/app.ts");
    expect(fs.readFileSync(path.join(root, "src/app.ts"), "utf8")).toBe("new");
  });
  it("refuses a folder, protected files, .git and the outside", async () => {
    const c = harness();
    expect(await failure(c, "write_file", { path: "src", content: "x" })).toContain("is a folder");
    expect(await failure(c, "write_file", { path: "tests/new.test.ts", content: "x" })).toContain("protected_file");
    expect(await failure(c, "write_file", { path: ".git/hooks/pre-commit", content: "x" })).toContain("protected_file");
    expect(await failure(c, "write_file", { path: "../evil.sh", content: "x" })).toContain("path_outside_project");
    expect(fs.existsSync(path.join(root, "..", "evil.sh"))).toBe(false);
  });
  it("refuses unknown arguments and oversize content", async () => {
    const c = harness();
    expect(await failure(c, "write_file", { path: "a.txt", content: "x", mode: "append" })).toContain("schema");
    expect(await failure(c, "write_file", { path: "a.txt", content: "x".repeat(200_001) })).toContain("schema");
  });
});
