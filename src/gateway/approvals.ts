import type { ToolDefinition } from "./definition.js";
import type { BotVersion } from "./grants.js";
import type { ToolError } from "./types.js";

/** What the owner approves. Built from facts, never from the model's prose. */
export interface PlanRecord {
  id: string;
  actions: string[];
  target: string;
  touches: string;
  rollback: string;
  source: { runId: string; cardId?: string; events: number[] };
  /** Hash of the target state when the plan was made. */
  stateHash: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

export type PlanStatus = "pending" | "approved" | "rejected" | "used";

export interface StoredPlan {
  plan: PlanRecord;
  status: PlanStatus;
  /** The owner's note when the plan was rejected. */
  note?: string;
}

export interface ApprovalStore {
  get(planId: string): StoredPlan | undefined;
  markUsed(planId: string): void;
  /** Hash of the target's state right now. */
  currentHash(plan: PlanRecord): Promise<string>;
}

export type ApprovalDecision =
  | { kind: "allow"; via: "none" | "plan" | "standing"; planId?: string }
  | { kind: "deny"; error: ToolError }
  | { kind: "hold"; reason: string };

const deny = (code: ToolError["code"], message: string, hint: string): ApprovalDecision => ({
  kind: "deny",
  error: { ok: false, code, message, hint },
});

/**
 * Gateway check 6 (risk and approval).
 * Safe and Contained pass. External needs an approved plan or a standing grant.
 * Destructive needs an approved plan every time; there are no standing grants.
 */
export async function checkApproval(
  bot: BotVersion,
  def: ToolDefinition,
  args: Record<string, unknown>,
  store: ApprovalStore,
  now: number,
): Promise<ApprovalDecision> {
  if (def.risk === "safe" || def.risk === "contained") return { kind: "allow", via: "none" };

  const planId = args["planId"];
  if (typeof planId !== "string") {
    if (def.risk === "external" && bot.standing?.includes(def.name)) {
      return { kind: "allow", via: "standing" };
    }
    return { kind: "hold", reason: `${def.name} needs the owner's approval.` };
  }

  const stored = store.get(planId);
  if (!stored) {
    return deny("needs_approval", "That plan does not exist.", "Make a plan first, then apply it.");
  }
  if (stored.status === "rejected") {
    return deny(
      "rejected",
      stored.note ? `The owner rejected this plan: ${stored.note}` : "The owner rejected this plan.",
      "Revise the plan using the note, or ask the owner.",
    );
  }
  if (stored.status === "used") {
    return deny("needs_approval", "This plan was already applied.", "Read the current state before doing more.");
  }
  if (now > stored.plan.expiresAt) {
    return deny("plan_expired", "The approved plan has expired.", "Make a new plan and ask for approval again.");
  }
  if ((await store.currentHash(stored.plan)) !== stored.plan.stateHash) {
    return deny(
      "needs_approval",
      "The target changed since the plan was made.",
      "Make a new plan from the current state.",
    );
  }
  if (stored.status === "pending") {
    return { kind: "hold", reason: `Plan ${planId} is waiting for the owner.` };
  }
  return { kind: "allow", via: "plan", planId };
}
