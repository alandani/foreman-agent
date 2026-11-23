import { Ajv } from "ajv";
import type { ToolDefinition } from "./definition.js";
import type { ToolError } from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = new Map<string, ReturnType<Ajv["compile"]>>();

export type SchemaResult = { ok: true } | ToolError;

/**
 * Gateway check 3 (schema): the arguments must match the tool's inputSchema.
 * A bad call is rejected here, before anything touches the disk or the vault.
 */
export function validateArgs(def: ToolDefinition, args: unknown): SchemaResult {
  const key = `${def.name}@${def.version}`;
  let validate = validators.get(key);
  if (!validate) {
    validate = ajv.compile(def.inputSchema);
    validators.set(key, validate);
  }
  if (validate(args)) return { ok: true };

  const lines = (validate.errors ?? []).slice(0, 5).map((e) => {
    const where = e.instancePath === "" ? "arguments" : e.instancePath.slice(1).replaceAll("/", ".");
    const extra =
      e.keyword === "additionalProperties"
        ? ` (${String((e.params as { additionalProperty?: string }).additionalProperty)})`
        : "";
    return `${where}: ${e.message ?? "invalid"}${extra}`;
  });
  return {
    ok: false,
    code: "schema",
    message: lines.join("; "),
    hint: "Fix the listed fields and call the tool again.",
  };
}
