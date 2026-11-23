import type { Risk } from "./types.js";

export const RISKS: readonly Risk[] = ["safe", "contained", "external", "destructive"];

/** What a call may touch. Used by the grant check. */
export type Scope = "project_files" | "sandbox" | "service" | "app_data";

/**
 * One tool definition. The model sees only name, description and inputSchema;
 * everything else is for the gateway and never enters the context.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: Risk;
  scope: Scope;
  timeoutS: number;
  maxOutputTokens: number;
  idempotent: boolean;
  /** A vault label, never a value. */
  credential?: string;
  version: number;
}

const NAME_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const MAX_DESCRIPTION_WORDS = 60;

/**
 * Definition check: returns a list of problems, empty when the definition is
 * acceptable. Runs when a tool is added or changed, not on every call.
 */
export function checkToolDefinition(def: ToolDefinition): string[] {
  const problems: string[] = [];

  if (!NAME_RE.test(def.name) || def.name.length > 40) {
    problems.push("name must be lower snake case and at most 40 characters");
  }

  const words = def.description.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) problems.push("description is empty");
  if (words > MAX_DESCRIPTION_WORDS) {
    problems.push(`description has ${words} words; the limit is ${MAX_DESCRIPTION_WORDS}`);
  }

  if (!RISKS.includes(def.risk)) problems.push(`unknown risk level: ${String(def.risk)}`);
  if (!Number.isInteger(def.timeoutS) || def.timeoutS < 1 || def.timeoutS > 600) {
    problems.push("timeoutS must be an integer from 1 to 600");
  }
  if (!Number.isInteger(def.maxOutputTokens) || def.maxOutputTokens < 1 || def.maxOutputTokens > 20000) {
    problems.push("maxOutputTokens must be an integer from 1 to 20000");
  }
  if (!Number.isInteger(def.version) || def.version < 1) {
    problems.push("version must be an integer of at least 1");
  }

  checkSchema(def.inputSchema, problems);
  return problems;
}

function checkSchema(schema: Record<string, unknown>, problems: string[]): void {
  if (schema["type"] !== "object") {
    problems.push("inputSchema must have type object");
    return;
  }
  if (schema["additionalProperties"] !== false) {
    problems.push("inputSchema must set additionalProperties to false");
  }
  const props = schema["properties"];
  if (typeof props !== "object" || props === null) {
    problems.push("inputSchema must list its properties");
    return;
  }
  for (const [key, raw] of Object.entries(props)) {
    const prop = raw as Record<string, unknown>;
    const type = prop["type"];
    if (typeof type !== "string") {
      problems.push(`property ${key} needs a type`);
    } else if (type === "string" && prop["maxLength"] === undefined && prop["enum"] === undefined) {
      problems.push(`string property ${key} needs maxLength or enum`);
    } else if (type === "array" && prop["maxItems"] === undefined) {
      problems.push(`array property ${key} needs maxItems`);
    }
  }
  const required = schema["required"];
  if (Array.isArray(required)) {
    for (const key of required) {
      if (!(String(key) in props)) problems.push(`required field ${String(key)} is not a property`);
    }
  }
}
