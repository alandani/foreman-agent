import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveInside } from "../../src/gateway/paths.js";

let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-paths-"));
  root = path.join(base, "worktree");
  outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export {};\n");
  fs.symlinkSync(outside, path.join(root, "link-out"));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const cases: Array<{ name: string; input: string; ok: boolean }> = [
  { name: "plain relative file", input: "src/app.ts", ok: true },
  { name: "new file in existing dir", input: "src/new.ts", ok: true },
  { name: "new file in new dir", input: "docs/new/readme.md", ok: true },
  { name: "dot-dot escapes root", input: "src/../../etc/hosts", ok: false },
  { name: "bare dot-dot", input: "..", ok: false },
  { name: "absolute path", input: "/etc/hosts", ok: false },
  { name: "empty path", input: "", ok: false },
  { name: "NUL byte", input: "src/app.ts\0.png", ok: false },
  { name: "symlink leading out", input: "link-out/secret.txt", ok: false },
];

describe("resolveInside", () => {
  for (const c of cases) {
    it(c.name, () => {
      const result = resolveInside(root, c.input);
      expect(result.ok).toBe(c.ok);
      if (!result.ok) expect(result.code).toBe("path_outside_project");
    });
  }
});
