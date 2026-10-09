import { appendFile, chmod } from "node:fs/promises";
import { join } from "node:path";

export type AuditEvent =
  | "session_started"
  | "connection_opened"
  | "auth_ok"
  | "auth_failed"
  | "transferred"
  | "rejected"
  | "closed"
  | "session_ended";

/**
 * One JSON object per line. It never carries the secret, the link, variable names or values.
 * `remote` (the peer's IP, when known) is personal data and is documented in SECURITY.md.
 */
export interface AuditEntry {
  v: 1;
  ts: string;
  session: string;
  event: AuditEvent;
  peer: string | null;
  remote: string | null;
  reason: string | null;
  keys: number | null;
  bytes: number | null;
  durationMs: number | null;
}

export const auditPath = (root: string) => join(root, ".envs/sharing-connections.ndjson");

export type AuditFields = Partial<Omit<AuditEntry, "v" | "ts" | "session" | "event">>;

/** Appends one event to `.envs/sharing-connections.ndjson` (created with 0600). */
export async function appendAudit(
  root: string,
  session: string,
  event: AuditEvent,
  fields: AuditFields = {},
  now: Date = new Date(),
) {
  const entry: AuditEntry = {
    v: 1,
    ts: now.toISOString(),
    session,
    event,
    peer: null,
    remote: null,
    reason: null,
    keys: null,
    bytes: null,
    durationMs: null,
    ...fields,
  };
  const path = auditPath(root);
  await appendFile(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
}
