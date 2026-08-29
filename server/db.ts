/**
 * Simple JSON-file persistence for the application state — now multi-tenant.
 *
 * Each organization gets its own directory: data/orgs/<orgId>/state.json
 * (this file's concern) and data/orgs/<orgId>/portal.json (portalAuth.ts's
 * concern). Which organization loadState()/saveState() operate on is NOT a
 * parameter — it's resolved implicitly from the current request's
 * AsyncLocalStorage context (see orgContext.ts), set up by authMiddleware
 * once per request. This keeps every existing call site in server/index.ts
 * unchanged; only the underlying file path resolution became org-aware.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentOrgId, runWithOrg } from './orgContext.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const ORGS_DIR = path.join(DATA_DIR, 'orgs');
const ORGANIZATIONS_FILE = path.join(DATA_DIR, 'organizations.json');
const LEGACY_STATE_FILE = path.join(DATA_DIR, 'state.json');
const LEGACY_PORTAL_FILE = path.join(DATA_DIR, 'portal.json');
const LEGACY_BACKUPS_DIR = path.join(DATA_DIR, 'backups');

const DEFAULT_STATE = {
  employees: [] as any[],
  departments: [
    { id: 'dept-1', name: 'Abteilung A' },
    { id: 'dept-2', name: 'Abteilung B' },
    { id: 'dept-3', name: 'Abteilung C' },
  ],
  currentYear: new Date().getFullYear(),
  planningPeriods: [] as any[],
  customHolidays: [] as any[],
  labels: [] as any[],
  calendarLabels: [] as any[],
};

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureOrgsDir() {
  ensureDataDir();
  if (!fs.existsSync(ORGS_DIR)) fs.mkdirSync(ORGS_DIR, { recursive: true });
}

export function orgDataDir(orgId: string): string {
  return path.join(ORGS_DIR, orgId);
}

function ensureOrgDataDir(orgId: string) {
  ensureOrgsDir();
  const dir = orgDataDir(orgId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function stateFilePath(orgId: string): string {
  return path.join(orgDataDir(orgId), 'state.json');
}

/**
 * One-time migration: this app used to be single-tenant, storing everything
 * directly in data/state.json + data/portal.json. It now supports multiple
 * organizations, each with their own data/orgs/<id>/{state,portal}.json.
 * If no organizations.json exists yet but a legacy data/state.json does,
 * move the existing data into a first organization ("org-1") verbatim.
 * Idempotent — the presence of organizations.json is the completion marker,
 * so this runs at most once ever, and is safe to call on every boot.
 */
function migrateToOrganizations(): void {
  if (fs.existsSync(ORGANIZATIONS_FILE)) return;
  ensureOrgsDir();

  const org: Organization = {
    id: 'org-1',
    name: 'Organisation 1',
    slug: 'org-1',
    createdAt: new Date().toISOString(),
  };
  ensureOrgDataDir(org.id);

  if (fs.existsSync(LEGACY_STATE_FILE)) {
    fs.renameSync(LEGACY_STATE_FILE, stateFilePath(org.id));
  }
  if (fs.existsSync(LEGACY_PORTAL_FILE)) {
    fs.renameSync(LEGACY_PORTAL_FILE, path.join(orgDataDir(org.id), 'portal.json'));
  }
  if (fs.existsSync(LEGACY_BACKUPS_DIR)) {
    fs.renameSync(LEGACY_BACKUPS_DIR, path.join(orgDataDir(org.id), 'backups'));
  }

  // Write organizations.json LAST — its existence is what marks the
  // migration as done, so a crash mid-move is safely retried on next boot.
  fs.writeFileSync(ORGANIZATIONS_FILE, JSON.stringify({ organizations: [org] }, null, 2), 'utf-8');
}

migrateToOrganizations();

// ═══════════════════════════════════════════════════════════════════════
// Organization registry
// ═══════════════════════════════════════════════════════════════════════

function loadOrganizations(): Organization[] {
  ensureDataDir();
  if (!fs.existsSync(ORGANIZATIONS_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(ORGANIZATIONS_FILE, 'utf-8'));
    return raw.organizations || [];
  } catch (err) {
    console.error('Error loading organizations:', err);
    return [];
  }
}

function saveOrganizations(orgs: Organization[]): void {
  ensureDataDir();
  fs.writeFileSync(ORGANIZATIONS_FILE, JSON.stringify({ organizations: orgs }, null, 2), 'utf-8');
}

export function listOrganizations(): Organization[] {
  return loadOrganizations();
}

export function getOrganization(id: string): Organization | null {
  return loadOrganizations().find(o => o.id === id) || null;
}

function slugify(name: string): string {
  return name.toLowerCase().trim()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'organisation';
}

/** Create a new organization and bootstrap its (empty) data files. */
export function createOrganization(name: string): Organization {
  const orgs = loadOrganizations();
  const baseSlug = slugify(name);
  let slug = baseSlug;
  let i = 2;
  while (orgs.some(o => o.slug === slug)) { slug = `${baseSlug}-${i}`; i++; }

  const org: Organization = {
    id: `org-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name,
    slug,
    createdAt: new Date().toISOString(),
  };
  orgs.push(org);
  saveOrganizations(orgs);
  ensureOrgDataDir(org.id);
  runWithOrg(org.id, () => saveState(structuredClone(DEFAULT_STATE)));
  return org;
}

export function renameOrganization(id: string, name: string): Organization | null {
  const orgs = loadOrganizations();
  const org = orgs.find(o => o.id === id);
  if (!org) return null;
  org.name = name;
  saveOrganizations(orgs);
  return org;
}

/**
 * One-time migration: the app used to support exactly one global shift plan
 * (`state.shiftPlan`) with global `planReleased`/`employeesLocked` flags.
 * It now supports any number of independent "Planungsperioden"
 * (`state.planningPeriods`), each carrying its own release/lock status.
 * If a legacy shape is detected (no `planningPeriods` array yet), convert
 * the existing single plan into the first planning period and drop the
 * legacy fields. Idempotent — runs at most once per state file.
 */
function migrateToPlanningPeriods(state: any): { state: any; migrated: boolean } {
  if (Array.isArray(state.planningPeriods)) return { state, migrated: false }; // already migrated

  const periods: any[] = [];
  if (state.shiftPlan && Array.isArray(state.shiftPlan.assignments)) {
    periods.push({
      id: `period-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: undefined,
      year: state.shiftPlan.year,
      startMonth: state.shiftPlan.startMonth ?? 0,
      months: state.shiftPlan.months ?? 12,
      schedulerConfig: state.shiftPlan.schedulerConfig,
      violations: state.shiftPlan.violations ?? [],
      assignments: state.shiftPlan.assignments ?? [],
      algorithm: state.shiftPlan.algorithm,
      released: !!state.planReleased,
      employeesLocked: !!state.employeesLocked,
      createdAt: new Date().toISOString(),
    });
  }

  state.planningPeriods = periods;
  delete state.shiftPlan;
  delete state.planReleased;
  delete state.employeesLocked;
  return { state, migrated: true };
}

// ═══════════════════════════════════════════════════════════════════════
// Per-organization state — orgId is resolved implicitly from the current
// request's AsyncLocalStorage context (see orgContext.ts).
// ═══════════════════════════════════════════════════════════════════════

export function loadState(): any {
  const orgId = currentOrgId();
  ensureOrgDataDir(orgId);
  const file = stateFilePath(orgId);
  if (!fs.existsSync(file)) {
    return structuredClone(DEFAULT_STATE);
  }
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    const { state, migrated } = migrateToPlanningPeriods(parsed);
    // Persist immediately so the generated period id (and dropped legacy
    // fields) are stable across subsequent loads — otherwise every
    // read-only GET would mint a fresh id, breaking period selection.
    if (migrated) saveState(state);
    return state;
  } catch (err) {
    console.error(`Error loading state for organization ${orgId}:`, err);
    return structuredClone(DEFAULT_STATE);
  }
}

export function saveState(state: any): void {
  const orgId = currentOrgId();
  ensureOrgDataDir(orgId);
  fs.writeFileSync(stateFilePath(orgId), JSON.stringify(state, null, 2), 'utf-8');
}
