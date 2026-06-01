export type ShelfKind =
  | "scratch"
  | "backup"
  | "run-artifact"
  | "evidence"
  | "cache"
  | "quarantine"
  | "other";

export type CleanupAction = "trash" | "review" | "delete";
export type ShelfStatus = "active" | "review-required" | "trashed" | "cleanup-refused";
export type Retention =
  | { mode: "ttl"; ttl: string }
  | { mode: "retain-until"; retainUntil: string }
  | { mode: "manual-review" };

export type ShelfRecord = {
  id: string;
  path: string;
  kind: ShelfKind;
  reason: string;
  createdAt: string;
  retainUntil?: string;
  retention: Retention;
  cleanup: CleanupAction;
  owner: string;
  labels: string[];
  status: ShelfStatus;
  cleanupPlanId?: string;
  receiptPath?: string;
  cleanedAt?: string;
  targetPath?: string;
  cleanupReason?: string;
};

export type DueStatus = "due" | "manual-review" | "missing-path" | "kept";

export type DueEntry = {
  id: string;
  path: string;
  reason: string;
  cleanup: CleanupAction;
  dueStatus: DueStatus;
  retainUntil?: string;
};

export type CleanupPlanEntry = {
  id: string;
  path: string;
  action: CleanupAction;
  dueStatus: DueStatus;
};

export type CleanupPlan = {
  planId: string;
  generatedAt: string;
  ledgerPath: string;
  entries: CleanupPlanEntry[];
  skipped: Array<{ id: string; path: string; reason: string; dueStatus: DueStatus }>;
  planPath: string;
};
