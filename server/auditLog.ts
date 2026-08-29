/**
 * Global (cross-organization) audit log / changelog.
 *
 * A single append-only JSON-Lines file so the orga portal's Changelog tab
 * can filter by organization and time range without scanning every
 * organization's data directory. Not per-org on purpose — the whole point
 * is a cross-hierarchy view.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const AUDIT_LOG_FILE = path.join(DATA_DIR, 'auditLog.jsonl');

export type ActorType = 'platform' | 'admin' | 'legacy';

export interface ChangeLogEntry {
  id: string;
  timestamp: string;
  organizationId: string | null;
  organizationName: string | null;
  actorType: ActorType;
  actorName: string;
  actorEmail?: string;
  area: string;
  summary: string;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function logChange(entry: Omit<ChangeLogEntry, 'id' | 'timestamp'>): void {
  try {
    ensureDataDir();
    const full: ChangeLogEntry = {
      id: `chg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify(full) + '\n', 'utf-8');
  } catch (err) {
    // Never let audit logging break the actual request it's attached to.
    console.error('[auditLog] failed to write entry:', err);
  }
}

export function logChanges(entries: Omit<ChangeLogEntry, 'id' | 'timestamp'>[]): void {
  for (const e of entries) logChange(e);
}

export interface ChangeLogQuery {
  organizationId?: string;
  from?: string; // ISO date
  to?: string;   // ISO date
}

export function queryChangeLog(query: ChangeLogQuery): ChangeLogEntry[] {
  ensureDataDir();
  if (!fs.existsSync(AUDIT_LOG_FILE)) return [];
  let lines: string[];
  try {
    lines = fs.readFileSync(AUDIT_LOG_FILE, 'utf-8').split('\n').filter(Boolean);
  } catch {
    return [];
  }

  const entries: ChangeLogEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch { /* skip corrupt line */ }
  }

  return entries
    .filter(e => !query.organizationId || e.organizationId === query.organizationId)
    .filter(e => !query.from || e.timestamp >= query.from)
    .filter(e => !query.to || e.timestamp <= query.to)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
