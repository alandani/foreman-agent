import type { DatabaseSync } from "node:sqlite";
import type { ApprovalStore, PlanRecord, PlanStatus, StoredPlan } from "../gateway/approvals.js";

interface PlanRow {
  record: string;
  status: PlanStatus;
  note: string | null;
}

/** Plan records and the owner's decisions. Implements the gateway's ApprovalStore. */
export class PlanStore implements ApprovalStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    /** Reads the target's state hash right now. Supplied by whatever knows the target. */
    private readonly hashTarget: (plan: PlanRecord) => Promise<string>,
  ) {}

  create(plan: PlanRecord): void {
    this.db
      .prepare("INSERT INTO plans (id, run_id, record, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .run(plan.id, plan.source.runId, JSON.stringify(plan), this.now());
  }

  get(planId: string): StoredPlan | undefined {
    const row = this.db.prepare("SELECT record, status, note FROM plans WHERE id = ?").get(planId) as
      | PlanRow
      | undefined;
    if (!row) return undefined;
    const stored: StoredPlan = { plan: JSON.parse(row.record) as PlanRecord, status: row.status };
    if (row.note) stored.note = row.note;
    return stored;
  }

  /** The owner's answer. Only a pending plan can be decided. */
  decide(planId: string, decision: "approved" | "rejected", note?: string): void {
    const res = this.db
      .prepare("UPDATE plans SET status = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(decision, note ?? null, this.now(), planId);
    if (res.changes === 0) throw new Error(`Plan ${planId} is not pending.`);
  }

  /** One use only. Fails if the plan was not approved or was already used. */
  markUsed(planId: string): void {
    const res = this.db
      .prepare("UPDATE plans SET status = 'used' WHERE id = ? AND status = 'approved'")
      .run(planId);
    if (res.changes === 0) throw new Error(`Plan ${planId} is not approved.`);
  }

  currentHash(plan: PlanRecord): Promise<string> {
    return this.hashTarget(plan);
  }
}
