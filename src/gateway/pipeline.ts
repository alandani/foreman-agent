import { checkApproval, type ApprovalStore } from "./approvals.js";
import type { ToolDefinition } from "./definition.js";
import { checkGrant, findTool, type BotVersion, type Registry } from "./grants.js";
import { resolveInside } from "./paths.js";
import { validateArgs } from "./schema.js";
import { scrub, shape } from "./shape.js";
import type { ToolError } from "./types.js";

/** Everything the gateway knows about the run making the call. */
export interface RunContext {
  runId: string;
  projectId: string;
  /** The run's worktree. */
  root: string;
  bot: BotVersion;
  registry: Registry;
  /** Paths relative to the root that writes may not touch. */
  protectedPaths: string[];
  /** Check 1: returns an error when the run is over a limit or no longer live. */
  limitError: () => ToolError | null;
}

export interface HandlerEnv {
  /** Path arguments, resolved and checked to sit inside the root. */
  paths: Record<string, string>;
  /** The credential value, present only for tools that name one. */
  credential?: string;
  idempotencyKey: string;
  signal: AbortSignal;
}

export type Handler = (args: Record<string, unknown>, env: HandlerEnv) => Promise<string>;

export type ReviewVerdict = "ok" | "flag" | "block";

export interface ToolSuccess {
  ok: true;
  statusLine: string;
  body: string;
  truncated: boolean;
  /** The sequence number of the call in the run log. */
  event: number;
}

export interface GatewayEvent {
  runId: string;
  seq: number;
  tool: string;
  toolVersion?: number;
  verdict: "allow" | "deny" | "hold";
  stage: string;
  code?: string;
  /** True when the call changed state outside the app's own bookkeeping. */
  changedState: boolean;
}

export interface Deps {
  now: () => number;
  approvals: ApprovalStore;
  results: {
    get(runId: string, seq: number): ToolSuccess | ToolError | undefined;
    put(runId: string, seq: number, result: ToolSuccess | ToolError): void;
  };
  vault: { resolve(label: string): string | undefined };
  handlers: Record<string, Handler>;
  /** Sees structured fields only. Can flag or block, never approve. */
  reviewer?: (def: ToolDefinition, args: Record<string, unknown>) => Promise<ReviewVerdict>;
  log: (event: GatewayEvent) => void;
}

export type Outcome =
  | { verdict: "allow"; result: ToolSuccess | ToolError }
  | { verdict: "deny"; error: ToolError }
  | { verdict: "hold"; reason: string; flags: string[] };

function isProtected(rel: string, protectedPaths: string[]): boolean {
  const norm = rel.replace(/^\.\//, "").replace(/\/+$/, "");
  return protectedPaths.some((p) => norm === p || norm.startsWith(`${p}/`));
}

/**
 * The one function every tool call goes through. Checks run cheapest first and
 * the first failure stops the call. Returns allow, deny or hold.
 */
export async function callTool(
  ctx: RunContext,
  deps: Deps,
  req: { seq: number; tool: string; args: unknown },
): Promise<Outcome> {
  const { seq } = req;
  let def: ToolDefinition | undefined;

  const done = (
    verdict: GatewayEvent["verdict"],
    stage: string,
    extra: { code?: string; changedState?: boolean } = {},
  ) => {
    const event: GatewayEvent = {
      runId: ctx.runId,
      seq,
      tool: req.tool,
      verdict,
      stage,
      changedState: extra.changedState ?? false,
    };
    if (def) event.toolVersion = def.version;
    if (extra.code) event.code = extra.code;
    deps.log(event);
  };
  const deny = (stage: string, error: ToolError): Outcome => {
    done("deny", stage, { code: error.code });
    return { verdict: "deny", error };
  };

  // 1. The run is live and inside its limits.
  const limit = ctx.limitError();
  if (limit) return deny("run_limits", limit);

  // 8 (early). A finished call returns its stored result; nothing runs twice.
  const stored = deps.results.get(ctx.runId, seq);
  if (stored) {
    done("allow", "duplicate");
    return { verdict: "allow", result: stored };
  }

  // 2. The tool exists in this bot version, at the pinned tool version.
  const found = findTool(ctx.registry, ctx.bot, req.tool);
  if (!found.ok) return deny("tool_exists", found);
  def = found.def;

  // 3. Schema.
  const valid = validateArgs(def, req.args);
  if (!valid.ok) return deny("schema", valid);
  const args = req.args as Record<string, unknown>;

  // 4. Grant: project and risk ceiling.
  const granted = checkGrant(ctx.bot, def, ctx.projectId);
  if (!granted.ok) return deny("grant", granted);
  if (def.credential && !ctx.bot.credentials?.includes(def.credential)) {
    return deny("grant", {
      ok: false,
      code: "not_granted",
      message: `Tool ${def.name} needs a credential this bot does not have.`,
      hint: "Ask the owner to grant it.",
    });
  }

  // 5. Project root: every path stays inside the worktree; protected files are not written.
  const paths: Record<string, string> = {};
  for (const field of def.pathFields ?? []) {
    const value = args[field];
    if (typeof value !== "string") continue;
    const resolved = resolveInside(ctx.root, value);
    if (!resolved.ok) return deny("project_root", resolved);
    if (def.writes && isProtected(value, ctx.protectedPaths)) {
      return deny("project_root", {
        ok: false,
        code: "protected_file",
        message: `${value} is a protected file.`,
        hint: "Choose a different file; protected files are changed only by the owner.",
      });
    }
    paths[field] = resolved.abs;
  }

  // 6. Risk and approval.
  const decision = await checkApproval(ctx.bot, def, args, deps.approvals, deps.now());
  if (decision.kind === "deny") return deny("approval", decision.error);

  // 7. Reviewer, for External and Destructive calls. Can flag or block, never approve.
  const flags: string[] = [];
  if ((def.risk === "external" || def.risk === "destructive") && deps.reviewer) {
    const review = await deps.reviewer(def, args);
    if (review === "block") {
      return deny("reviewer", {
        ok: false,
        code: "rejected",
        message: "The automated review blocked this call.",
        hint: "Change the approach or ask the owner.",
      });
    }
    if (review === "flag") flags.push("The automated review flagged this call.");
  }

  if (decision.kind === "hold" || (decision.kind === "allow" && decision.via === "standing" && flags.length > 0)) {
    const reason = decision.kind === "hold" ? decision.reason : `${def.name} was flagged and needs the owner.`;
    done("hold", "approval");
    return { verdict: "hold", reason, flags };
  }

  // 9. Credentials, resolved last so a denied call never reads the vault.
  let secret: string | undefined;
  if (def.credential) {
    secret = deps.vault.resolve(def.credential);
    if (secret === undefined) {
      return deny("credentials", {
        ok: false,
        code: "not_granted",
        message: `The credential for ${def.name} is missing or revoked.`,
        hint: "Ask the owner to check the credential.",
      });
    }
  }

  // 10. Execute with the tool's timeout.
  const handler = deps.handlers[def.name];
  if (!handler) {
    return deny("execute", {
      ok: false,
      code: "not_granted",
      message: `Tool ${def.name} has no handler.`,
      hint: "Use another tool.",
    });
  }
  const secrets = secret === undefined ? [] : [secret];
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: ToolSuccess | ToolError;
  try {
    const env: HandlerEnv = {
      paths,
      idempotencyKey: `${ctx.runId}:${seq}`,
      signal: controller.signal,
    };
    if (secret !== undefined) env.credential = secret;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("__timeout__"));
      }, def!.timeoutS * 1000);
    });
    const raw = await Promise.race([handler(args, env), timeout]);

    // 11. Shape the result: scrub, clean, cap, add a status line.
    const shaped = shape(scrub(raw, secrets), def.maxOutputTokens);
    result = {
      ok: true,
      statusLine: `${def.name} ok${shaped.truncated ? ", output truncated" : ""}`,
      body: shaped.body,
      truncated: shaped.truncated,
      event: seq,
    };
    if (decision.kind === "allow" && decision.planId) deps.approvals.markUsed(decision.planId);
  } catch (err) {
    const timedOut = err instanceof Error && err.message === "__timeout__";
    const message = timedOut
      ? `${def.name} timed out after ${def.timeoutS} seconds.`
      : scrub(err instanceof Error ? err.message : String(err), secrets);
    result = {
      ok: false,
      code: timedOut ? "timeout" : "tool_error",
      message,
      hint: timedOut ? "Try a smaller step." : "Read the message, then change the call or ask the owner.",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }

  // 12. Log; store the result so a repeat of this call returns it.
  deps.results.put(ctx.runId, seq, result);
  done("allow", "execute", {
    changedState: def.risk !== "safe" && result.ok,
    ...(result.ok ? {} : { code: result.code }),
  });
  return { verdict: "allow", result };
}
