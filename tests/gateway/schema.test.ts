import { describe, expect, it } from "vitest";
import { validateArgs } from "../../src/gateway/schema.js";
import { makeTool } from "./fixtures.js";

const tool = makeTool();

const cases: Array<{ name: string; args: unknown; ok: boolean; mentions?: string }> = [
  { name: "valid arguments", args: { path: "src/app.ts" }, ok: true },
  { name: "valid with optional fields", args: { path: "a.ts", startLine: 3, mode: "range" }, ok: true },
  { name: "missing required field", args: {}, ok: false, mentions: "path" },
  { name: "wrong type", args: { path: 12 }, ok: false, mentions: "path" },
  { name: "string too long", args: { path: "x".repeat(301) }, ok: false, mentions: "path" },
  { name: "value outside enum", args: { path: "a.ts", mode: "other" }, ok: false, mentions: "mode" },
  { name: "unknown field", args: { path: "a.ts", force: true }, ok: false, mentions: "force" },
  { name: "not an object", args: "src/app.ts", ok: false },
  { name: "null arguments", args: null, ok: false },
];

describe("validateArgs", () => {
  for (const c of cases) {
    it(c.name, () => {
      const result = validateArgs(tool, c.args);
      expect(result.ok).toBe(c.ok);
      if (!result.ok) {
        expect(result.code).toBe("schema");
        if (c.mentions) expect(result.message).toContain(c.mentions);
      }
    });
  }
});
