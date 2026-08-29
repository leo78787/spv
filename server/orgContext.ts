/**
 * Per-request "current organization" context, propagated implicitly via
 * Node's AsyncLocalStorage so that db.ts/portalAuth.ts (and everything they
 * call transitively — including code that resumes later via setTimeout/
 * setInterval/promises, e.g. background optimiser jobs or debounced
 * notifications started from within a request) can resolve which
 * organization's data files to read/write WITHOUT threading an orgId
 * parameter through every function signature in the codebase.
 *
 * Established once per request by authMiddleware / portalAuthMiddleware
 * (server/index.ts) after resolving the caller's organization from their
 * token. Background jobs that don't originate from a request (the backup
 * schedule in server/backup.ts) establish it explicitly per organization
 * via runWithOrg().
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface OrgContext {
  organizationId: string;
}

const storage = new AsyncLocalStorage<OrgContext>();

/** The organization id for the currently executing request/job. Throws if called outside any org context — a programming error (a handler that forgot auth middleware, or a background job that forgot runWithOrg). */
export function currentOrgId(): string {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error('No organization context is active — this code path must run inside runWithOrg(...) (normally established by authMiddleware/portalAuthMiddleware).');
  }
  return ctx.organizationId;
}

/** Returns the current organization id, or null if no context is active (for call sites that have a legitimate no-context case, e.g. the initial account-lookup during login). */
export function currentOrgIdOrNull(): string | null {
  return storage.getStore()?.organizationId ?? null;
}

/** Run fn with the given organization set as the current context for its entire (possibly async) lifetime. */
export function runWithOrg<T>(organizationId: string, fn: () => T): T {
  return storage.run({ organizationId }, fn);
}
