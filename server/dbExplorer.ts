/**
 * Data-browser backend for the "Datenbank" tab on orga.schichtapp.de — lets
 * a platform account inspect every collection the app persists (across
 * data/*.json and each organization's data/orgs/<orgId>/*.json), along with
 * the foreign-key-style relationships between them, and delete individual
 * rows, without needing direct shell/file access to the host.
 *
 * This module never exposes secrets: password hashes, salts, pending-reset
 * tokens and portal session tokens are always stripped before a row leaves
 * this file — callers get derived booleans (mustChangePassword /
 * hasPendingReset) instead.
 *
 * Collections are grouped into two scopes:
 *   - 'platform': one global table, independent of any organization.
 *   - 'org':      one table per organization, read from its own data dir.
 *
 * Row deletion is intentionally a raw, single-row operation — it does NOT
 * cascade to rows in other collections that reference it (e.g. deleting an
 * employee leaves their calendar-label/swap-offer/portal-credential rows in
 * place). That mirrors what a generic database browser does (phpMyAdmin,
 * Prisma Studio, ...): it deletes exactly the row you asked for, nothing
 * more, and referential cleanup is left to whoever knows the business rules
 * for that specific collection. `organizations` and `orgSettings` are
 * excluded from deletion entirely — an organization has no safe cascading
 * delete anywhere in this codebase, and `orgSettings` is a singleton
 * configuration record, not a list of independent rows.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { loadState, saveState, orgDataDir, listOrganizations } from './db.js';
import { runWithOrg } from './orgContext.js';
import { deleteAdminUser } from './adminAuth.js';
import { deleteVacation } from './adminVacations.js';
import { deletePlatformUser } from './platformAuth.js';
import { attachmentFilePath } from './boards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

function readJson(file: string): any {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export type DbFieldType = 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object' | 'id';

export interface DbRelation {
  /** Field on this collection holding the foreign value (may hold an array of ids). */
  field: string;
  /** Target collection id. */
  target: string;
}

export interface DbCollectionMeta {
  id: string;
  label: string;
  scope: 'platform' | 'org';
  /** Where the data physically lives — shown in the UI so it's traceable back to a real file. */
  source: string;
  description: string;
  relations: DbRelation[];
  /** Whether individual rows can be deleted from this collection through the UI. False for `organizations` (no safe cascading delete exists) and `orgSettings` (a singleton config record, not a list of rows). */
  deletable: boolean;
}

export const DB_SCHEMA: DbCollectionMeta[] = [
  // ── Plattformweit ──────────────────────────────────────────────────
  {
    id: 'organizations',
    label: 'Organisationen',
    scope: 'platform',
    source: 'data/organizations.json',
    description: 'Jede Organisation (Mandant), die auf orga.schichtapp.de verwaltet wird.',
    relations: [],
    deletable: false,
  },
  {
    id: 'platformUsers',
    label: 'Plattform-Zugänge',
    scope: 'platform',
    source: 'data/platformUsers.json',
    description: 'Personen mit Zugriff auf orga.schichtapp.de selbst (nicht auf eine einzelne Organisation).',
    relations: [],
    deletable: true,
  },
  // ── Pro Organisation ───────────────────────────────────────────────
  {
    id: 'adminUsers',
    label: 'Admin-Zugänge',
    scope: 'org',
    source: 'data/adminUsers.json (gefiltert nach Organisation)',
    description: 'Zugänge zum Admin-Bereich der Organisation (Rollen: Admin / Leitung / Betrachter).',
    relations: [{ field: 'organizationId', target: 'organizations' }],
    deletable: true,
  },
  {
    id: 'adminVacations',
    label: 'Admin-Abwesenheiten',
    scope: 'org',
    source: 'data/adminVacations.json (gefiltert nach Organisation)',
    description: 'Abwesenheits-/Urlaubseinträge der Admin-Zugänge, inkl. Vertretung.',
    relations: [
      { field: 'organizationId', target: 'organizations' },
      { field: 'adminUserId', target: 'adminUsers' },
      { field: 'substituteAdminUserId', target: 'adminUsers' },
    ],
    deletable: true,
  },
  {
    id: 'employees',
    label: 'Mitarbeiter',
    scope: 'org',
    source: 'data/orgs/<org>/state.json → employees',
    description: 'Mitarbeiterstammdaten inkl. Urlaub, Präferenzen und Portal-Status.',
    relations: [
      { field: 'department', target: 'departments' },
      { field: 'portalSelectedPeriodId', target: 'planningPeriods' },
    ],
    deletable: true,
  },
  {
    id: 'departments',
    label: 'Abteilungen',
    scope: 'org',
    source: 'data/orgs/<org>/state.json → departments',
    description: 'Abteilungen der Organisation.',
    relations: [],
    deletable: true,
  },
  {
    id: 'planningPeriods',
    label: 'Planungsperioden',
    scope: 'org',
    source: 'data/orgs/<org>/state.json → planningPeriods',
    description: 'Zeiträume mit eigenem Schichtplan, Freigabe-Status und Regel-Konfiguration. Zuweisungen selbst stehen in der Tabelle „Zuweisungen“.',
    relations: [],
    deletable: true,
  },
  {
    id: 'assignments',
    label: 'Zuweisungen',
    scope: 'org',
    source: 'data/orgs/<org>/state.json → planningPeriods[].assignments',
    description: 'Einzelne Schicht-Zuweisungen, aus allen Planungsperioden zusammengeführt.',
    relations: [
      { field: 'periodId', target: 'planningPeriods' },
      { field: 'employees', target: 'employees' },
    ],
    deletable: true,
  },
  {
    id: 'customHolidays',
    label: 'Feiertage (individuell)',
    scope: 'org',
    source: 'data/orgs/<org>/state.json → customHolidays',
    description: 'Zusätzlich zu gesetzlichen Feiertagen erfasste freie Tage.',
    relations: [],
    deletable: true,
  },
  {
    id: 'labels',
    label: 'Labels',
    scope: 'org',
    source: 'data/orgs/<org>/state.json → labels',
    description: 'Definierte Kalender-Label (Kürzel/Farbe), die Mitarbeitern zugewiesen werden können.',
    relations: [],
    deletable: true,
  },
  {
    id: 'calendarLabels',
    label: 'Kalender-Label-Zuweisungen',
    scope: 'org',
    source: 'data/orgs/<org>/state.json → calendarLabels',
    description: 'Zuordnung eines Labels zu einem Mitarbeiter an einem bestimmten Tag.',
    relations: [
      { field: 'employeeId', target: 'employees' },
      { field: 'labelId', target: 'labels' },
    ],
    deletable: true,
  },
  {
    id: 'swapOffers',
    label: 'Tauschangebote',
    scope: 'org',
    source: 'data/orgs/<org>/state.json → swapOffers',
    description: 'Von Mitarbeitern angebotene Schichten zum Tausch/zur Übernahme.',
    relations: [
      { field: 'employeeId', target: 'employees' },
      { field: 'assignmentId', target: 'assignments' },
    ],
    deletable: true,
  },
  {
    id: 'swapMatches',
    label: 'Tausch-Matches',
    scope: 'org',
    source: 'data/orgs/<org>/state.json → swapMatches',
    description: 'Zusammengeführte Tauschangebote (bzw. Übernahmen).',
    relations: [
      { field: 'offerA', target: 'swapOffers' },
      { field: 'offerB', target: 'swapOffers' },
    ],
    deletable: true,
  },
  {
    id: 'portalCredentials',
    label: 'Mitarbeiter-Portal-Zugänge',
    scope: 'org',
    source: 'data/orgs/<org>/portal.json → credentials',
    description: 'Login-Zugänge zum Mitarbeiter-Portal. Passwort-Hashes werden nie ausgeliefert.',
    relations: [{ field: 'employeeId', target: 'employees' }],
    deletable: true,
  },
  {
    id: 'portalSessions',
    label: 'Mitarbeiter-Portal-Sitzungen',
    scope: 'org',
    source: 'data/orgs/<org>/portal.json → sessions',
    description: 'Aktive angemeldete Sitzungen im Mitarbeiter-Portal. Die Sitzungs-Tokens selbst werden nie ausgeliefert.',
    relations: [{ field: 'employeeId', target: 'employees' }],
    deletable: true,
  },
  {
    id: 'boards',
    label: 'Boards',
    scope: 'org',
    source: 'data/orgs/<org>/boards.json → boards',
    description: 'Aufgaben-Boards (Kanban). Aufgaben selbst stehen in der Tabelle „Board-Aufgaben“.',
    relations: [
      { field: 'organizationId', target: 'organizations' },
      { field: 'ownerId', target: 'adminUsers' },
      { field: 'visibleToUserIds', target: 'adminUsers' },
    ],
    deletable: true,
  },
  {
    id: 'boardTasks',
    label: 'Board-Aufgaben',
    scope: 'org',
    source: 'data/orgs/<org>/boards.json → boards[].sections[].tasks',
    description: 'Einzelne Aufgaben aus allen Boards und Abschnitten, zusammengeführt.',
    relations: [
      { field: 'boardId', target: 'boards' },
      { field: 'assigneeIds', target: 'adminUsers' },
    ],
    deletable: true,
  },
  {
    id: 'boardAttachments',
    label: 'Board-Anhänge',
    scope: 'org',
    source: 'data/orgs/<org>/boards.json → attachments',
    description: 'Dateianhänge an Board-Kommentaren (nur Metadaten, keine Dateiinhalte).',
    relations: [],
    deletable: true,
  },
  {
    id: 'orgSettings',
    label: 'Organisations-Einstellungen',
    scope: 'org',
    source: 'data/orgs/<org>/state.json → swapSettings / tabVisibility / defaultSchedulerConfig / backupSettings',
    description: 'Konfigurations-Objekte der Organisation, als ein einzelner Datensatz.',
    relations: [{ field: 'id', target: 'organizations' }],
    deletable: false,
  },
];

export function getCollectionMeta(id: string): DbCollectionMeta | null {
  return DB_SCHEMA.find(c => c.id === id) || null;
}

// ─── Platform-scoped readers ──────────────────────────────────────────

function rowsOrganizations(): any[] {
  return listOrganizations();
}

function rowsPlatformUsers(): any[] {
  const data = readJson(path.join(DATA_DIR, 'platformUsers.json'));
  const users = data?.users || [];
  const creds = data?.credentials || {};
  return users.map((u: any) => ({
    ...u,
    mustChangePassword: !!creds[u.id]?.mustChangePassword,
    hasPendingReset: !!(creds[u.id]?.reset && creds[u.id].reset.expiresAt > Date.now()),
  }));
}

// ─── Org-scoped readers (all take a resolved orgId) ──────────────────

function rowsAdminUsers(orgId: string): any[] {
  const data = readJson(path.join(DATA_DIR, 'adminUsers.json'));
  const users = (data?.users || []).filter((u: any) => u.organizationId === orgId);
  const creds = data?.credentials || {};
  return users.map((u: any) => ({
    ...u,
    mustChangePassword: !!creds[u.id]?.mustChangePassword,
    hasPendingReset: !!(creds[u.id]?.reset && creds[u.id].reset.expiresAt > Date.now()),
  }));
}

function rowsAdminVacations(orgId: string): any[] {
  const data = readJson(path.join(DATA_DIR, 'adminVacations.json'));
  return (data?.entries || []).filter((e: any) => e.organizationId === orgId);
}

function withState<T>(orgId: string, pick: (state: any) => T): T {
  return runWithOrg(orgId, () => pick(loadState()));
}

function rowsEmployees(orgId: string): any[] {
  return withState(orgId, s => s.employees || []);
}

function rowsDepartments(orgId: string): any[] {
  return withState(orgId, s => s.departments || []);
}

function rowsPlanningPeriods(orgId: string): any[] {
  return withState(orgId, s => (s.planningPeriods || []).map((p: any) => ({
    ...p,
    assignmentsCount: (p.assignments || []).length,
    violationsCount: (p.violations || []).length,
    assignments: undefined,
    violations: undefined,
  })));
}

function rowsAssignments(orgId: string): any[] {
  return withState(orgId, s => {
    const out: any[] = [];
    for (const p of s.planningPeriods || []) {
      for (const a of p.assignments || []) out.push({ periodId: p.id, ...a });
    }
    return out;
  });
}

function rowsCustomHolidays(orgId: string): any[] {
  return withState(orgId, s => s.customHolidays || []);
}

function rowsLabels(orgId: string): any[] {
  return withState(orgId, s => s.labels || []);
}

function rowsCalendarLabels(orgId: string): any[] {
  return withState(orgId, s => s.calendarLabels || []);
}

function rowsSwapOffers(orgId: string): any[] {
  return withState(orgId, s => s.swapOffers || []);
}

function rowsSwapMatches(orgId: string): any[] {
  return withState(orgId, s => s.swapMatches || []);
}

function rowsOrgSettings(orgId: string): any[] {
  return withState(orgId, s => [{
    id: orgId,
    swapSettings: s.swapSettings ?? null,
    tabVisibility: s.tabVisibility ?? null,
    betrachterTabVisibility: s.betrachterTabVisibility ?? null,
    defaultSchedulerConfig: s.defaultSchedulerConfig ?? null,
    backupSettings: s.backupSettings ?? null,
  }]);
}

function readPortalFile(orgId: string): any {
  return readJson(path.join(orgDataDir(orgId), 'portal.json')) || { credentials: {}, sessions: {} };
}

function rowsPortalCredentials(orgId: string): any[] {
  const data = readPortalFile(orgId);
  return Object.entries(data.credentials || {}).map(([employeeId, c]: [string, any]) => ({
    id: employeeId,
    employeeId,
    username: c.username,
    mustChangePassword: !!c.mustChangePassword,
    createdAt: c.createdAt,
  }));
}

/** A stable, non-reversible stand-in for a session token — safe to show/use as a row id since the real token can never be recovered from it, yet it's deterministic so a delete request can re-find the same session. */
function sessionSurrogateId(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 20);
}

function rowsPortalSessions(orgId: string): any[] {
  const data = readPortalFile(orgId);
  return Object.entries(data.sessions || {}).map(([token, s]: [string, any]) => ({
    id: sessionSurrogateId(token),
    employeeId: s.employeeId,
    expiresAt: s.expiresAt,
  }));
}

function readBoardsFile(orgId: string): any {
  return readJson(path.join(orgDataDir(orgId), 'boards.json')) || { boards: [], attachments: {} };
}

function rowsBoards(orgId: string): any[] {
  const data = readBoardsFile(orgId);
  return (data.boards || []).map((b: any) => ({
    ...b,
    sectionsCount: (b.sections || []).length,
    tasksCount: (b.sections || []).reduce((n: number, sec: any) => n + (sec.tasks || []).length, 0),
    sections: undefined,
  }));
}

function rowsBoardTasks(orgId: string): any[] {
  const data = readBoardsFile(orgId);
  const out: any[] = [];
  for (const b of data.boards || []) {
    for (const sec of b.sections || []) {
      for (const t of sec.tasks || []) {
        out.push({
          boardId: b.id,
          sectionId: sec.id,
          ...t,
          subtasksCount: (t.subtasks || []).length,
          commentsCount: (t.comments || []).length,
          subtasks: undefined,
          comments: undefined,
        });
      }
    }
  }
  return out;
}

function rowsBoardAttachments(orgId: string): any[] {
  const data = readBoardsFile(orgId);
  return Object.entries(data.attachments || {}).map(([id, meta]: [string, any]) => ({ id, ...meta }));
}

// ─── Row deletion (one function per org-scoped collection that isn't ─────
// already covered by an existing business-logic delete function) ─────────

function deleteFromStateArray(orgId: string, arrayField: string, id: string): boolean {
  return runWithOrg(orgId, () => {
    const state = loadState();
    const arr = state[arrayField];
    if (!Array.isArray(arr)) return false;
    const idx = arr.findIndex((r: any) => r.id === id);
    if (idx === -1) return false;
    arr.splice(idx, 1);
    saveState(state);
    return true;
  });
}

function deleteAssignmentRow(orgId: string, id: string): boolean {
  return runWithOrg(orgId, () => {
    const state = loadState();
    for (const p of state.planningPeriods || []) {
      const idx = (p.assignments || []).findIndex((a: any) => a.id === id);
      if (idx !== -1) {
        p.assignments.splice(idx, 1);
        saveState(state);
        return true;
      }
    }
    return false;
  });
}

function writePortalFile(orgId: string, data: any): void {
  fs.writeFileSync(path.join(orgDataDir(orgId), 'portal.json'), JSON.stringify(data, null, 2), 'utf-8');
}

function deletePortalCredentialRow(orgId: string, employeeId: string): boolean {
  const data = readPortalFile(orgId);
  if (!data.credentials || !(employeeId in data.credentials)) return false;
  delete data.credentials[employeeId];
  writePortalFile(orgId, data);
  return true;
}

function deletePortalSessionRow(orgId: string, surrogateId: string): boolean {
  const data = readPortalFile(orgId);
  const token = Object.keys(data.sessions || {}).find(t => sessionSurrogateId(t) === surrogateId);
  if (!token) return false;
  delete data.sessions[token];
  writePortalFile(orgId, data);
  return true;
}

function writeBoardsFile(orgId: string, data: any): void {
  fs.writeFileSync(path.join(orgDataDir(orgId), 'boards.json'), JSON.stringify(data, null, 2), 'utf-8');
}

function deleteBoardRow(orgId: string, id: string): boolean {
  const data = readBoardsFile(orgId);
  const idx = (data.boards || []).findIndex((b: any) => b.id === id);
  if (idx === -1) return false;
  data.boards.splice(idx, 1);
  writeBoardsFile(orgId, data);
  return true;
}

function deleteBoardTaskRow(orgId: string, id: string): boolean {
  const data = readBoardsFile(orgId);
  for (const b of data.boards || []) {
    for (const sec of b.sections || []) {
      const idx = (sec.tasks || []).findIndex((t: any) => t.id === id);
      if (idx !== -1) {
        sec.tasks.splice(idx, 1);
        writeBoardsFile(orgId, data);
        return true;
      }
    }
  }
  return false;
}

function deleteBoardAttachmentRow(orgId: string, id: string): boolean {
  const data = readBoardsFile(orgId);
  const meta = data.attachments?.[id];
  if (!meta) return false;
  try {
    const filePath = attachmentFilePath(orgId, id, meta);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Metadata deletion below still proceeds even if the file is already gone or unreadable.
  }
  delete data.attachments[id];
  writeBoardsFile(orgId, data);
  return true;
}

const ORG_DELETERS: Record<string, (orgId: string, id: string) => boolean> = {
  adminUsers: (_orgId, id) => deleteAdminUser(id),
  adminVacations: (_orgId, id) => deleteVacation(id),
  employees: (orgId, id) => deleteFromStateArray(orgId, 'employees', id),
  departments: (orgId, id) => deleteFromStateArray(orgId, 'departments', id),
  planningPeriods: (orgId, id) => deleteFromStateArray(orgId, 'planningPeriods', id),
  assignments: deleteAssignmentRow,
  customHolidays: (orgId, id) => deleteFromStateArray(orgId, 'customHolidays', id),
  labels: (orgId, id) => deleteFromStateArray(orgId, 'labels', id),
  calendarLabels: (orgId, id) => deleteFromStateArray(orgId, 'calendarLabels', id),
  swapOffers: (orgId, id) => deleteFromStateArray(orgId, 'swapOffers', id),
  swapMatches: (orgId, id) => deleteFromStateArray(orgId, 'swapMatches', id),
  portalCredentials: deletePortalCredentialRow,
  portalSessions: deletePortalSessionRow,
  boards: deleteBoardRow,
  boardTasks: deleteBoardTaskRow,
  boardAttachments: deleteBoardAttachmentRow,
};

/**
 * Delete a single row from a collection. Read-then-write, not atomic across
 * concurrent requests — acceptable here since this is an occasional manual
 * admin action, not a high-concurrency write path.
 */
export function deleteRow(collectionId: string, orgId: string | undefined, id: string): { success: true } | { error: string } {
  const meta = getCollectionMeta(collectionId);
  if (!meta) return { error: 'Unbekannte Tabelle.' };
  if (!meta.deletable) return { error: 'Diese Tabelle unterstützt kein Löschen einzelner Datensätze.' };
  if (!id) return { error: 'Datensatz-ID erforderlich.' };

  if (meta.scope === 'platform') {
    if (collectionId === 'platformUsers') {
      const result = deletePlatformUser(id);
      return 'error' in result ? result : { success: true };
    }
    return { error: 'Löschen für diese Tabelle ist nicht verfügbar.' };
  }

  if (!orgId) return { error: 'Organisation erforderlich.' };
  if (!listOrganizations().some(o => o.id === orgId)) return { error: 'Organisation nicht gefunden.' };

  const deleter = ORG_DELETERS[collectionId];
  if (!deleter) return { error: 'Löschen für diese Tabelle ist nicht verfügbar.' };
  const ok = deleter(orgId, id);
  return ok ? { success: true } : { error: 'Datensatz nicht gefunden.' };
}

const ORG_READERS: Record<string, (orgId: string) => any[]> = {
  adminUsers: rowsAdminUsers,
  adminVacations: rowsAdminVacations,
  employees: rowsEmployees,
  departments: rowsDepartments,
  planningPeriods: rowsPlanningPeriods,
  assignments: rowsAssignments,
  customHolidays: rowsCustomHolidays,
  labels: rowsLabels,
  calendarLabels: rowsCalendarLabels,
  swapOffers: rowsSwapOffers,
  swapMatches: rowsSwapMatches,
  portalCredentials: rowsPortalCredentials,
  portalSessions: rowsPortalSessions,
  boards: rowsBoards,
  boardTasks: rowsBoardTasks,
  boardAttachments: rowsBoardAttachments,
  orgSettings: rowsOrgSettings,
};

const PLATFORM_READERS: Record<string, () => any[]> = {
  organizations: rowsOrganizations,
  platformUsers: rowsPlatformUsers,
};

/** A hard cap so a pathological/future-large collection can never blow up the response — the UI shows a "gekürzt" notice when this is hit. */
const MAX_ROWS = 5000;

export interface CollectionRowsResult {
  rows: any[];
  total: number;
  truncated: boolean;
}

/**
 * Row data for one collection. `orgId` is required for scope === 'org'
 * collections (a 400-shaped error object is returned instead if missing or
 * unknown) and ignored for scope === 'platform' ones.
 */
export function getCollectionRows(collectionId: string, orgId?: string): CollectionRowsResult | { error: string } {
  const meta = getCollectionMeta(collectionId);
  if (!meta) return { error: 'Unbekannte Tabelle.' };

  let rows: any[];
  if (meta.scope === 'platform') {
    rows = PLATFORM_READERS[collectionId]();
  } else {
    if (!orgId) return { error: 'Organisation erforderlich.' };
    if (!listOrganizations().some(o => o.id === orgId)) return { error: 'Organisation nicht gefunden.' };
    rows = ORG_READERS[collectionId](orgId);
  }

  const total = rows.length;
  const truncated = total > MAX_ROWS;
  return { rows: truncated ? rows.slice(0, MAX_ROWS) : rows, total, truncated };
}

export interface CollectionCount {
  id: string;
  count: number | null; // null when scope === 'org' and no orgId was given
}

/** Row counts for every collection — platform ones always resolved, org ones resolved for `orgId` when given, else null (UI shows "—" until an organization is selected). */
export function getAllCounts(orgId?: string): CollectionCount[] {
  return DB_SCHEMA.map(meta => {
    if (meta.scope === 'platform') {
      return { id: meta.id, count: PLATFORM_READERS[meta.id]().length };
    }
    if (!orgId) return { id: meta.id, count: null };
    try {
      return { id: meta.id, count: ORG_READERS[meta.id](orgId).length };
    } catch {
      return { id: meta.id, count: null };
    }
  });
}
