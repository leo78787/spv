/**
 * Simple JSON-file persistence for the application state.
 *
 * Stores everything in `data/state.json` (one level above the server/ dir).
 * On first run, creates the file with sensible defaults.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

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

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
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

export function loadState(): any {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    return structuredClone(DEFAULT_STATE);
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const { state, migrated } = migrateToPlanningPeriods(parsed);
    // Persist immediately so the generated period id (and dropped legacy
    // fields) are stable across subsequent loads — otherwise every
    // read-only GET would mint a fresh id, breaking period selection.
    if (migrated) saveState(state);
    return state;
  } catch (err) {
    console.error('Error loading state:', err);
    return structuredClone(DEFAULT_STATE);
  }
}

export function saveState(state: any): void {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}
