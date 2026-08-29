/**
 * Structural diff between two versions of an organization's state.json,
 * used for two purposes at once (PUT /api/state is the one generic
 * endpoint almost every admin mutation — employees, departments, holidays,
 * labels, calendar labels, swap/tab settings, and manual calendar edits
 * like updateShiftAssignment — ultimately funnels through):
 *
 *  1. Permission enforcement — which AdminPermissionArea(s) a given save
 *     touches, so a `leitung` session can be rejected if it touches an
 *     area they don't have.
 *  2. The changelog — a human-readable list of what changed, one entry
 *     per changed/added/removed item.
 */

import type { AdminPermissionArea } from './adminAuth.js';

// `area` is a superset of AdminPermissionArea — it also covers changelog-only
// areas that aren't delegatable permissions (e.g. 'settings_tabs', which is
// always Admin-only now), so it's typed as a plain string rather than
// AdminPermissionArea. The permission check in index.ts (PUT /api/state)
// naturally rejects a Leitung touching a non-grantable area, since it can
// never appear in their granted permissions set.
export interface DiffItem {
  area: string;
  summary: string;
}

export interface DiffResult {
  items: DiffItem[];
  touchedAreas: Set<string>;
}

function safeEqual(a: any, b: any): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
}

/** Generic field-level diff for a single object, producing short human-readable change fragments. */
function diffFields(before: any, after: any, labels: Record<string, string>): string[] {
  const changed: string[] = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    if (key === 'id') continue;
    const bv = before?.[key];
    const av = after?.[key];
    if (safeEqual(bv, av)) continue;
    const label = labels[key] || key;
    if (Array.isArray(bv) || Array.isArray(av)) {
      changed.push(`${label} (${(bv || []).length}→${(av || []).length})`);
    } else if (bv && typeof bv === 'object') {
      changed.push(label);
    } else if (av && typeof av === 'object') {
      changed.push(label);
    } else {
      const fmt = (v: any) => (v === undefined || v === null || v === '' ? '–' : String(v));
      changed.push(`${label}: ${fmt(bv)} → ${fmt(av)}`);
    }
  }
  return changed;
}

/** Diff two arrays of id-keyed records: adds, removes, and field-level changes. */
function diffCollection<T extends { id: string }>(
  before: T[] | undefined,
  after: T[] | undefined,
  area: AdminPermissionArea,
  label: string,
  nameOf: (item: T) => string,
  fieldLabels: Record<string, string>,
): DiffItem[] {
  const items: DiffItem[] = [];
  const beforeMap = new Map((before || []).map(x => [x.id, x]));
  const afterMap = new Map((after || []).map(x => [x.id, x]));

  for (const [id, b] of afterMap) {
    if (!beforeMap.has(id)) items.push({ area, summary: `${label} hinzugefügt: ${nameOf(b)}` });
  }
  for (const [id, a] of beforeMap) {
    if (!afterMap.has(id)) items.push({ area, summary: `${label} entfernt: ${nameOf(a)}` });
  }
  for (const [id, b] of afterMap) {
    const a = beforeMap.get(id);
    if (!a) continue;
    const changedFields = diffFields(a, b, fieldLabels);
    if (changedFields.length > 0) {
      items.push({ area, summary: `${label} geändert (${nameOf(b)}): ${changedFields.join(', ')}` });
    }
  }
  return items;
}

const EMPLOYEE_FIELD_LABELS: Record<string, string> = {
  name: 'Name', email: 'E-Mail', department: 'Abteilung', isOver55: 'Ü55', hasL2: 'L2',
  allowedShiftTypes: 'Erlaubte Schichttypen', vacationDays: 'Urlaubstage', vacationRanges: 'Urlaubszeiträume',
  preferences: 'Präferenzen', hireDate: 'Eintrittsdatum', terminationDate: 'Austrittsdatum',
  portalStatus: 'Portal-Status', notificationPreferences: 'Benachrichtigungen', portalSelectedPeriodId: 'Portal-Periode',
};

const DEPARTMENT_FIELD_LABELS: Record<string, string> = { name: 'Name', managerId: 'Manager' };

const HOLIDAY_FIELD_LABELS: Record<string, string> = { date: 'Datum', name: 'Name', disabled: 'Deaktiviert' };

const LABEL_FIELD_LABELS: Record<string, string> = { name: 'Name', letter: 'Buchstabe', color: 'Farbe', text: 'Text', visibleToEmployee: 'Für Mitarbeitende sichtbar' };

const ASSIGNMENT_FIELD_LABELS: Record<string, string> = { employees: 'Mitarbeitende', shiftType: 'Schichttyp', startDate: 'Start', endDate: 'Ende', confirmed: 'Bestätigt' };

/** Diff a single planning period's assignments/violations (area: calendar) and its own top-level fields (area: planning). */
function diffPeriod(before: any, after: any): DiffItem[] {
  const items: DiffItem[] = [];
  const periodLabel = after?.name || before?.name || `${after?.year ?? before?.year}`;

  items.push(...diffCollection(
    before?.assignments, after?.assignments, 'calendar', 'Schicht-Zuweisung',
    (a: any) => `${a.shiftType} ${a.startDate?.slice?.(0, 10) ?? ''}`.trim(),
    ASSIGNMENT_FIELD_LABELS,
  ));

  const beforeViolationIds = new Set((before?.violations || []).map((v: any) => v.id));
  const afterViolationIds = new Set((after?.violations || []).map((v: any) => v.id));
  const resolvedCount = [...beforeViolationIds].filter(id => !afterViolationIds.has(id)).length;
  if (resolvedCount > 0) {
    items.push({ area: 'calendar', summary: `Regelverstoß bestätigt/gelöst (${periodLabel}): ${resolvedCount}` });
  }

  const periodFieldChanges = diffFields(
    { released: before?.released, employeesLocked: before?.employeesLocked, name: before?.name },
    { released: after?.released, employeesLocked: after?.employeesLocked, name: after?.name },
    { released: 'Freigegeben', employeesLocked: 'Gesperrt', name: 'Name' },
  );
  if (periodFieldChanges.length > 0) {
    items.push({ area: 'planning', summary: `Planungsperiode geändert (${periodLabel}): ${periodFieldChanges.join(', ')}` });
  }

  return items;
}

function diffPlanningPeriods(before: any[] | undefined, after: any[] | undefined): DiffItem[] {
  const items: DiffItem[] = [];
  const beforeMap = new Map((before || []).map((p: any) => [p.id, p]));
  const afterMap = new Map((after || []).map((p: any) => [p.id, p]));
  for (const [id, p] of afterMap) {
    if (!beforeMap.has(id)) continue; // creation goes through the dedicated /api/periods endpoint, logged there
    items.push(...diffPeriod(beforeMap.get(id), p));
  }
  return items;
}

/** Compare two full organization states and produce a changelog-ready diff. */
export function diffState(before: any, after: any): DiffResult {
  const items: DiffItem[] = [];

  items.push(...diffCollection(before?.employees, after?.employees, 'employees', 'Mitarbeiter', (e: any) => e.name, EMPLOYEE_FIELD_LABELS));
  items.push(...diffCollection(before?.departments, after?.departments, 'departments', 'Abteilung', (d: any) => d.name, DEPARTMENT_FIELD_LABELS));
  items.push(...diffCollection(before?.customHolidays, after?.customHolidays, 'settings_holidays', 'Feiertag', (h: any) => h.name || h.date, HOLIDAY_FIELD_LABELS));
  items.push(...diffCollection(before?.labels, after?.labels, 'calendar', 'Label', (l: any) => l.name, LABEL_FIELD_LABELS));
  items.push(...diffCollection(before?.calendarLabels, after?.calendarLabels, 'calendar', 'Kalender-Label-Zuweisung', (cl: any) => cl.date, {}));
  items.push(...diffPlanningPeriods(before?.planningPeriods, after?.planningPeriods));

  if (!safeEqual(before?.swapSettings, after?.swapSettings)) {
    items.push({ area: 'settings_swapconfig', summary: 'Tausch-Einstellungen geändert' });
  }
  if (!safeEqual(before?.tabVisibility, after?.tabVisibility)) {
    items.push({ area: 'settings_tabs', summary: 'Reiter-Sichtbarkeit geändert' });
  }
  if (!safeEqual(before?.betrachterTabVisibility, after?.betrachterTabVisibility)) {
    items.push({ area: 'settings_tabs', summary: 'Reiter-Sichtbarkeit (Betrachter) geändert' });
  }
  if (!safeEqual(before?.defaultSchedulerConfig, after?.defaultSchedulerConfig)) {
    items.push({ area: 'planning', summary: 'Standard-Planungsregeln geändert' });
  }

  const touchedAreas = new Set(items.map(i => i.area));
  return { items, touchedAreas };
}
