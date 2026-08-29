/**
 * Vacation/absence entries for admin-dashboard accounts (Admin/Leitung/
 * Betrachter) — separate from the employee-level `vacationRanges` used by
 * the shift scheduler (see `types.ts`'s `Employee.vacationRanges`). This is
 * a self-service coverage calendar: each admin-dashboard account can record
 * when they're away and who (from among the other accounts of the same
 * organization) is covering for them, and everyone with dashboard access to
 * that organization can see everyone else's entries.
 *
 * One directory shared across all organizations (data/adminVacations.json),
 * filtered by organizationId — same convention as adminUsers.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'adminVacations.json');

export interface AdminVacationEntry {
  id: string;
  organizationId: string;
  adminUserId: string;
  /** ISO date (YYYY-MM-DD), inclusive. */
  startDate: string;
  /** ISO date (YYYY-MM-DD), inclusive. */
  endDate: string;
  substituteAdminUserId?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

interface AdminVacationsData {
  entries: AdminVacationEntry[];
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load(): AdminVacationsData {
  ensureDataDir();
  if (!fs.existsSync(FILE)) return { entries: [] };
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    if (!Array.isArray(data.entries)) return { entries: [] };
    return data;
  } catch {
    return { entries: [] };
  }
}

function save(data: AdminVacationsData): void {
  ensureDataDir();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf-8');
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateDates(startDate: string, endDate: string): string | null {
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) return 'Ungültiges Datum.';
  if (startDate > endDate) return 'Das Enddatum muss nach dem Startdatum liegen.';
  return null;
}

export function listVacations(organizationId: string): AdminVacationEntry[] {
  return load().entries.filter(e => e.organizationId === organizationId);
}

export function getVacation(id: string): AdminVacationEntry | null {
  return load().entries.find(e => e.id === id) || null;
}

export function createVacation(
  organizationId: string,
  adminUserId: string,
  input: { startDate: string; endDate: string; substituteAdminUserId?: string; note?: string },
): AdminVacationEntry | { error: string } {
  const startDate = String(input.startDate ?? '');
  const endDate = String(input.endDate ?? '');
  const dateError = validateDates(startDate, endDate);
  if (dateError) return { error: dateError };
  if (input.substituteAdminUserId && input.substituteAdminUserId === adminUserId) {
    return { error: 'Man kann sich nicht selbst als Vertretung eintragen.' };
  }

  const data = load();
  const entry: AdminVacationEntry = {
    id: `avac-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    organizationId,
    adminUserId,
    startDate,
    endDate,
    substituteAdminUserId: input.substituteAdminUserId || undefined,
    note: input.note?.trim() || undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.entries.push(entry);
  save(data);
  return entry;
}

export function updateVacation(
  id: string,
  input: { startDate: string; endDate: string; substituteAdminUserId?: string; note?: string },
): AdminVacationEntry | { error: string } | null {
  const data = load();
  const entry = data.entries.find(e => e.id === id);
  if (!entry) return null;

  const startDate = String(input.startDate ?? '');
  const endDate = String(input.endDate ?? '');
  const dateError = validateDates(startDate, endDate);
  if (dateError) return { error: dateError };
  if (input.substituteAdminUserId && input.substituteAdminUserId === entry.adminUserId) {
    return { error: 'Man kann sich nicht selbst als Vertretung eintragen.' };
  }

  entry.startDate = startDate;
  entry.endDate = endDate;
  entry.substituteAdminUserId = input.substituteAdminUserId || undefined;
  entry.note = input.note?.trim() || undefined;
  entry.updatedAt = new Date().toISOString();
  save(data);
  return entry;
}

export function deleteVacation(id: string): boolean {
  const data = load();
  const idx = data.entries.findIndex(e => e.id === id);
  if (idx === -1) return false;
  data.entries.splice(idx, 1);
  save(data);
  return true;
}
