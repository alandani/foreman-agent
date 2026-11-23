import type { ToolDefinition } from "../../src/gateway/definition.js";

export function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "read_file",
    description: "Reads a file or a line range inside the project and returns its text.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", maxLength: 300 },
        startLine: { type: "integer", minimum: 1 },
        mode: { type: "string", enum: ["full", "range"] },
      },
      required: ["path"],
      additionalProperties: false,
    },
    risk: "safe",
    scope: "project_files",
    timeoutS: 30,
    maxOutputTokens: 4000,
    idempotent: true,
    version: 1,
    ...overrides,
  };
}
