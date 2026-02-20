import { format, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'dd.MM.yyyy', { locale: de });
}

export function formatDateShort(date: Date | string): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return format(d, 'dd.MM', { locale: de });
}

export function formatDateRange(start: Date, end: Date): string {
  return `${formatDate(start)} - ${formatDate(end)}`;
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function getMonthName(monthIndex: number): string {
  const months = [
    'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
  ];
  return months[monthIndex];
}

// Parse a date string from an <input type="date"> (YYYY-MM-DD) into a local Date at midnight
export function parseDateInput(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Format a Date for <input type="date"> value (YYYY-MM-DD) using local date components
export function formatDateForInput(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Parse boolean-ish values commonly found in CSV/XLSX
export function parseBoolean(val: any): boolean {
  if (typeof val === 'boolean') return val;
  if (!val) return false;
  const s = String(val).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}

// Parse vacation ranges string like "2026-02-20:2026-02-24;2026-07-01:2026-07-03"
export function parseVacationRanges(val: any): { startDate: Date; endDate: Date }[] {
  if (!val) return [];
  const text = String(val).trim();
  if (!text) return [];
  return text.split(';').map(part => {
    const [start, end] = part.split(':').map((s: string) => s.trim());
    return { startDate: parseDateInput(start), endDate: parseDateInput(end || start) };
  }).filter(r => r.startDate && r.endDate);
}

// Given parsed preview rows and existing entities, resolve unique names and which departments must be created.
export function processImportPreview(parsedRows: Array<any>, existingEmployees: Array<{name: string}>, existingDepartments: Array<{name: string}>) {
  const existingNames = new Set(existingEmployees.map(e => e.name.toLowerCase().trim()));
  const existingDeptNames = new Set(existingDepartments.map(d => d.name.toLowerCase().trim()));

  const nameCountsInFile: Record<string, number> = {};
  parsedRows.forEach(r => {
    const n = (r.name || '').toLowerCase().trim();
    nameCountsInFile[n] = (nameCountsInFile[n] || 0) + 1;
  });

  const departmentsToCreate = new Set<string>();
  const employeesToAdd: Array<any> = [];

  const makeUnique = (base: string) => {
    const baseTrim = base.trim();
    const baseLower = baseTrim.toLowerCase();
    if (!existingNames.has(baseLower)) {
      existingNames.add(baseLower);
      return baseTrim;
    }
    let i = 2;
    while (existingNames.has(`${baseTrim} (${i})`.toLowerCase())) i++;
    const candidate = `${baseTrim} (${i})`;
    existingNames.add(candidate.toLowerCase());
    return candidate;
  };

  parsedRows.forEach((r: any) => {
    if (r.errors && r.errors.length > 0) return; // skip invalid rows
    const deptName = (r.departmentName || '').trim();

    // if the exact employee (same name and existing department) already exists, skip importing that row
    const nameLower = (r.name || '').toLowerCase().trim();
    if (existingNames.has(nameLower) && existingDeptNames.has(deptName.toLowerCase())) return;

    if (!existingDeptNames.has(deptName.toLowerCase())) departmentsToCreate.add(deptName);

    const uniqueName = makeUnique(r.name || '');
    employeesToAdd.push({
      originalName: r.name,
      name: uniqueName,
      departmentName: deptName,
      isOver55: !!r.isOver55,
      hasL2: !!r.hasL2,
      vacationRanges: r.vacationRanges || []
    });
  });

  return { departmentsToCreate: Array.from(departmentsToCreate), employeesToAdd };
}

// Revive dates in an imported plan JSON so store can consume it (strings -> Date)
export function reviveImportedPlan(data: any) {
  if (!data) return null;
  const { shiftPlan, employees, departments } = data as any;
  if (!shiftPlan || !employees || !departments) return null;

  // revive employees
  const revivedEmployees = employees.map((e: any) => ({
    ...e,
    vacationDays: (e.vacationDays || []).map((d: any) => d ? new Date(d) : d),
    vacationRanges: (e.vacationRanges || []).map((r: any) => ({ startDate: new Date(r.startDate), endDate: new Date(r.endDate) })),
    preferences: (e.preferences || []).map((p: any) => ({ ...p, startDate: new Date(p.startDate), endDate: new Date(p.endDate) }))
  }));

  // revive assignments
  const revivedAssignments = (shiftPlan.assignments || []).map((a: any) => ({
    ...a,
    startDate: new Date(a.startDate),
    endDate: new Date(a.endDate)
  }));

  const revivedPlan = {
    ...shiftPlan,
    assignments: revivedAssignments,
  };

  // Mark imported plans so UI can display the source algorithm if missing
  if (!revivedPlan.algorithm) {
    revivedPlan.algorithm = 'importiert';
  }

  return { shiftPlan: revivedPlan, employees: revivedEmployees, departments };
}

// Return a map of ISO-date (yyyy-MM-dd) => holiday name for Berlin (Bundesland: BE)
export function getBerlinHolidays(year: number): Record<string, string> {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  // compute Easter Sunday (Meeus/Jones algorithm)
  const easterSunday = (Y: number) => {
    const a = Y % 19;
    const b = Math.floor(Y / 100);
    const c = Y % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=March, 4=April
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Y, month - 1, day);
  };

  const map: Record<string, string> = {};
  const easter = easterSunday(year);

  const add = (d: Date, name: string) => { map[fmt(d)] = name; };

  // fixed-date holidays
  add(new Date(year, 0, 1), 'Neujahr'); // Jan 1
  add(new Date(year, 2, 8), 'Internationaler Frauentag'); // Mar 8 (Berlin)
  add(new Date(year, 4, 1), 'Tag der Arbeit'); // May 1
  add(new Date(year, 9, 3), 'Tag der Deutschen Einheit'); // Oct 3
  add(new Date(year, 11, 25), '1. Weihnachtstag'); // Dec 25
  add(new Date(year, 11, 26), '2. Weihnachtstag'); // Dec 26

  // Easter related
  const day = (d: Date, offset: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
  add(day(easter, -2), 'Karfreitag'); // Good Friday
  add(day(easter, 1), 'Ostermontag'); // Easter Monday
  add(day(easter, 39), 'Christi Himmelfahrt'); // Ascension (39 days after Easter Sunday)
  add(day(easter, 50), 'Pfingstmontag'); // Pentecost Monday

  return map;
}
