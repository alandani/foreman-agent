import { describe, expect, it } from "vitest";
import { checkToolDefinition } from "../../src/gateway/definition.js";
import { makeTool } from "./fixtures.js";

const longDescription = Array.from({ length: 61 }, () => "word").join(" ");

const cases: Array<{ name: string; tool: ReturnType<typeof makeTool>; problem: string | null }> = [
  { name: "valid tool", tool: makeTool(), problem: null },
  { name: "camel case name", tool: makeTool({ name: "readFile" }), problem: "name must be lower snake case" },
  { name: "description too long", tool: makeTool({ description: longDescription }), problem: "description has 61 words" },
  { name: "empty description", tool: makeTool({ description: "  " }), problem: "description is empty" },
  { name: "timeout too large", tool: makeTool({ timeoutS: 9999 }), problem: "timeoutS" },
  { name: "version zero", tool: makeTool({ version: 0 }), problem: "version" },
  {
    name: "string without a cap",
    tool: makeTool({
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        additionalProperties: false,
      },
    }),
    problem: "string property path needs maxLength or enum",
  },
  {
    name: "array without a cap",
    tool: makeTool({
      inputSchema: {
        type: "object",
        properties: { paths: { type: "array" } },
        additionalProperties: false,
      },
    }),
    problem: "array property paths needs maxItems",
  },
  {
    name: "extra properties allowed",
    tool: makeTool({
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
    }),
    problem: "additionalProperties to false",
  },
  {
    name: "required field missing from properties",
    tool: makeTool({
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", maxLength: 10 } },
        required: ["file"],
        additionalProperties: false,
      },
    }),
    problem: "required field file is not a property",
  },
];

describe("checkToolDefinition", () => {
  for (const c of cases) {
    it(c.name, () => {
      const problems = checkToolDefinition(c.tool);
      if (c.problem === null) {
        expect(problems).toEqual([]);
      } else {
        expect(problems.some((p) => p.includes(c.problem as string))).toBe(true);
      }
    });
  }
});
