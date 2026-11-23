/** Risk level of a tool. Set in the tool definition, never by the model. */
export type Risk = "safe" | "contained" | "external" | "destructive";

/** The three outcomes of the gateway pipeline. */
export type Verdict = "allow" | "deny" | "hold";

/** Fixed list of error codes returned to the model. */
export type ErrorCode =
  | "schema"
  | "not_granted"
  | "path_outside_project"
  | "protected_file"
  | "needs_approval"
  | "rejected"
  | "timeout"
  | "limit_reached"
  | "unknown_outcome";

/** A denial is a normal tool result, not an exception. */
export interface ToolError {
  ok: false;
  code: ErrorCode;
  message: string;
  hint: string;
}
