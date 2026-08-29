import {
  Employee,
  ShiftType,
  ShiftAssignment,
  SchedulerConfig,
  DEFAULT_SCHEDULER_CONFIG,
  SchedulerViolation,
  Department,
} from '../types';
import { evaluateConditionNode } from './customRuleEngine';

// Re-export so existing callers (ShiftPlanning, tests) only need one import
export type { SchedulerConfig, SchedulerRules } from '../types';
export type { SchedulerViolation } from '../types';
export { DEFAULT_SCHEDULER_CONFIG } from '../types';

import { 
  startOfWeek, 
  addWeeks, 
  isWithinInterval,
  startOfYear,
  endOfYear,
  addDays,
  subDays,
  isWeekend,
  isSameDay,
  startOfDay,
  endOfDay
} from 'date-fns';

/**
 * Whether an employee's employment window ([hireDate, terminationDate], both
 * optional/open-ended) fully covers a given shift date range. Used to exclude
 * not-yet-hired / already-left employees from scheduling.
 */
export function isEmployeeActiveDuring(employee: Employee, shiftStart: Date, shiftEnd: Date): boolean {
  const hire = employee.hireDate ? startOfDay(new Date(employee.hireDate)) : null;
  const termination = employee.terminationDate ? startOfDay(new Date(employee.terminationDate)) : null;
  if (hire && startOfDay(shiftStart) < hire) return false;
  if (termination && startOfDay(shiftEnd) > termination) return false;
  return true;
}

/**
 * Fraction (0..1) of days within [rangeStart, rangeEnd] during which the
 * employee is employed, based on hireDate/terminationDate. Used to give
 * partial-tenure employees a proportionally fair (not equal) share of shifts:
 * an employee active for e.g. half of a planning period should end up with
 * roughly half the shifts of a full-period employee, not the same amount.
 */
export function getEmployeeActiveWeight(employee: Employee, rangeStart: Date, rangeEnd: Date): number {
  const rStart = startOfDay(rangeStart);
  const rEnd = startOfDay(rangeEnd);
  const totalDays = Math.round((rEnd.getTime() - rStart.getTime()) / 86400000) + 1;
  if (totalDays <= 0) return 1;

  const hire = employee.hireDate ? startOfDay(new Date(employee.hireDate)) : null;
  const termination = employee.terminationDate ? startOfDay(new Date(employee.terminationDate)) : null;

  const activeStart = hire && hire > rStart ? hire : rStart;
  const activeEnd = termination && termination < rEnd ? termination : rEnd;
  const activeDays = Math.round((activeEnd.getTime() - activeStart.getTime()) / 86400000) + 1;
  return Math.max(0, Math.min(1, activeDays / totalDays));
}

/** Floor applied to active weight when used as a division denominator, to avoid inflating counts to infinity. */
export const MIN_ACTIVE_WEIGHT = 0.02;

/**
 * Check if employee can work on a specific date considering vacation boundaries
 * Rule: No weekend work before or after vacation
 */
export function canWorkOnDate(employee: Employee, date: Date, respectVacationWeekend = true): boolean {
  // helper: check single-day + ranges using normalized day boundaries
  const d = startOfDay(date);

  const hasVacationOn = (day: Date) => {
    const dayStart = startOfDay(day);
    // single-day entries
    const single = (employee.vacationDays || []).some(vacDay => startOfDay(new Date(vacDay)).getTime() === dayStart.getTime());
    if (single) return true;
    // ranges
    const ranges = (employee.vacationRanges || []).some(r => {
      const s = startOfDay(new Date(r.startDate));
      const e = endOfDay(new Date(r.endDate));
      return isWithinInterval(dayStart, { start: s, end: e });
    });
    return ranges;
  };

  // Check if on vacation (single day or inside a range)
  if (hasVacationOn(d)) return false;

  // Check if weekend work is allowed (considering vacation boundaries)
  if (respectVacationWeekend && isWeekend(date)) {
    // Check day before vacation
    const nextDay = addDays(date, 1);
    const dayAfterNext = addDays(date, 2);

    const hasVacationAfter = hasVacationOn(nextDay) || hasVacationOn(dayAfterNext);
    if (hasVacationAfter) return false;

    // Check day after vacation
    const prevDay = subDays(date, 1);
    const dayBeforePrev = subDays(date, 2);

    const hasVacationBefore = hasVacationOn(prevDay) || hasVacationOn(dayBeforePrev);
    if (hasVacationBefore) return false;
  }

  return true;
}

/**
 * Check if employee wants to avoid this shift type
 */
export function hasAvoidancePreference(employee: Employee, shiftType: ShiftType, date: Date): boolean {
  return employee.preferences.some(pref => 
    pref.shiftType === shiftType &&
    pref.preferred === false &&
    isWithinInterval(date, { start: pref.startDate, end: pref.endDate })
  );
}

/**
 * Count how many times an employee has worked a specific shift type
 */
function countShiftTypeForEmployee(
  employeeId: string, 
  shiftType: ShiftType, 
  assignments: ShiftAssignment[]
): number {
  return assignments.filter(a => 
    a.shiftType === shiftType && a.employees.includes(employeeId)
  ).length;
}

/**
 * Block Frühschicht (weekend early shift) when adjacency rules apply:
 * - No Frühschicht on the weekend directly before/after a 'verschieben' week
 * - No Frühschicht on the weekend directly after a 'nachtbereitschaft' week
 */
export function isBlockedFromFruehschichtDueToAdjacency(
  employee: Employee,
  date: Date,
  assignments: ShiftAssignment[]
): boolean {
  const day = date.getDay();
  const isWeekendDay = day === 6 || day === 0; // Saturday=6, Sunday=0
  if (!isWeekendDay) return false;

  // Check verschobene adjacency (week Monday–Friday)
  const hasAdjacentVerschieben = assignments.some(a => {
    if (!a.employees.includes(employee.id) || a.shiftType !== 'verschieben') return false;
    const start = new Date(a.startDate); // Monday
    const end = new Date(a.endDate);     // Friday
    const beforeSat = subDays(start, 2); // Saturday before the week
    const beforeSun = subDays(start, 1); // Sunday before the week
    const afterSat = addDays(end, 1);    // Saturday after the week
    const afterSun = addDays(end, 2);    // Sunday after the week
    return isSameDay(date, beforeSat) || isSameDay(date, beforeSun) || isSameDay(date, afterSat) || isSameDay(date, afterSun);
  });

  if (hasAdjacentVerschieben) return true;

  // Check nachtbereitschaft adjacency — block the Frühschicht weekend directly after nacht ends.
  // Nacht typically ends on Saturday; the next Frühschicht slot is Sat+7 (daysDiff=7) and Sun+8 (daysDiff=8).
  // Use a daysDiff range (consistent with all other adjacency helpers) so the full following weekend is covered.
  const hasRecentNightWeek = assignments.some(a => {
    if (!a.employees.includes(employee.id) || a.shiftType !== 'nachtbereitschaft') return false;
    const end = new Date(a.endDate); // typically a Saturday
    const daysDiff = Math.round((date.getTime() - end.getTime()) / (1000 * 60 * 60 * 24));
    // daysDiff 0 = same Sat as nacht end (already blocked by conflicting-shift check)
    // daysDiff 1 = Sun right after nacht
    // daysDiff 7 = following Sat (first available Frühschicht weekend)
    // daysDiff 8 = following Sun
    return daysDiff >= 0 && daysDiff <= 8;
  });

  if (hasRecentNightWeek) return true;

  return false;
}

/**
 * Symmetric to isBlockedFromFruehschichtDueToAdjacency:
 * When planning Verschieben (Mon–Fri), block if the employee already has a
 * Frühschicht on the directly adjacent weekend (Sat/Sun before Monday, or
 * Sat/Sun after Friday).
 */
export function isBlockedFromVerschiebenDueToAdjacentFruehschicht(
  employee: Employee,
  verschiebenStartDate: Date, // Monday
  verschiebenEndDate: Date,   // Friday
  assignments: ShiftAssignment[]
): boolean {
  return assignments.some(a => {
    if (a.shiftType !== 'fruehschicht') return false;
    if (!a.employees.includes(employee.id)) return false;
    const fStart = new Date(a.startDate); // Saturday
    const fEnd   = new Date(a.endDate);   // Sunday
    // Weekend directly before the verschieben week (Sat & Sun before Monday)
    const beforeSat = subDays(verschiebenStartDate, 2);
    const beforeSun = subDays(verschiebenStartDate, 1);
    // Weekend directly after the verschieben week (Sat & Sun after Friday)
    const afterSat  = addDays(verschiebenEndDate, 1);
    const afterSun  = addDays(verschiebenEndDate, 2);
    return (
      isSameDay(fStart, beforeSat) || isSameDay(fStart, beforeSun) ||
      isSameDay(fStart, afterSat)  || isSameDay(fStart, afterSun)  ||
      isSameDay(fEnd,   beforeSat) || isSameDay(fEnd,   beforeSun) ||
      isSameDay(fEnd,   afterSat)  || isSameDay(fEnd,   afterSun)
    );
  });
}

/**
 * Block consecutive Verschieben weeks for the same employee.
 * If an employee's last verschieben ended within 7 days before the new verschieben
 * start (i.e. back-to-back weeks), they are blocked.
 */
export function isBlockedFromConsecutiveVerschieben(
  employee: Employee,
  verschiebenStartDate: Date,
  assignments: ShiftAssignment[]
): boolean {
  return assignments.some(a => {
    if (a.shiftType !== 'verschieben') return false;
    if (!a.employees.includes(employee.id)) return false;
    const vEnd = new Date(a.endDate);
    const daysDiff = Math.round(
      (verschiebenStartDate.getTime() - vEnd.getTime()) / (1000 * 60 * 60 * 24)
    );
    // Verschieben ends Fri, next starts Mon → daysDiff = 3 → blocked
    return daysDiff >= 1 && daysDiff <= 7;
  });
}

/**
 * Block consecutive Nachtbereitschaft weeks for the same employee.
 * Nacht runs Sat→Fri (7 days). The next available Nacht slot starts the
 * following Saturday = daysDiff of 8 after endDate (Fri+8 = next Sat).
 * Using <= 8 so the full immediately-following week is blocked.
 */
export function isBlockedFromConsecutiveNacht(
  employee: Employee,
  nachtStartDate: Date,
  assignments: ShiftAssignment[]
): boolean {
  return assignments.some(a => {
    if (a.shiftType !== 'nachtbereitschaft') return false;
    if (!a.employees.includes(employee.id)) return false;
    const nEnd = new Date(a.endDate);
    const daysDiff = Math.round(
      (nachtStartDate.getTime() - nEnd.getTime()) / (1000 * 60 * 60 * 24)
    );
    // Nacht ends Fri, next nacht starts following Sat → daysDiff = 8 → blocked
    return daysDiff >= 1 && daysDiff <= 8;
  });
}

/**
 * Block consecutive Frühschicht (weekend early shift) for the same employee.
 * If an employee had a Frühschicht ending within 7 days before the new Frühschicht
 * start date, they are blocked.
 */
export function isBlockedFromConsecutiveFruehschicht(
  employee: Employee,
  fruehStartDate: Date,
  assignments: ShiftAssignment[]
): boolean {
  return assignments.some(a => {
    if (a.shiftType !== 'fruehschicht') return false;
    if (!a.employees.includes(employee.id)) return false;
    const fEnd = new Date(a.endDate);
    const daysDiff = Math.round(
      (fruehStartDate.getTime() - fEnd.getTime()) / (1000 * 60 * 60 * 24)
    );
    // Früh ends Sun, next starts Sat → daysDiff = 6 → blocked
    return daysDiff >= 1 && daysDiff <= 7;
  });
}

/**
 * Block Verschieben when the employee just finished a Nachtbereitschaft week.
 * Symmetric to isBlockedFromNachtAfterVerschieben:
 * if an employee had a nacht shift ending at date N, they may NOT start a
 * verschieben week within 7 calendar days after N.
 */
export function isBlockedFromVerschiebenAfterNacht(
  employee: Employee,
  verschiebenStartDate: Date,
  assignments: ShiftAssignment[]
): boolean {
  return assignments.some(a => {
    if (a.shiftType !== 'nachtbereitschaft') return false;
    if (!a.employees.includes(employee.id)) return false;
    const nEnd = new Date(a.endDate);
    const daysDiff = Math.round(
      (verschiebenStartDate.getTime() - nEnd.getTime()) / (1000 * 60 * 60 * 24)
    );
    // Block: nacht ends Sat, verschieben starts Mon (daysDiff=2) → blocked
    return daysDiff >= 1 && daysDiff <= 7;
  });
}

/**
 * Block Nachtbereitschaft when a 'verschieben' week ends immediately before the night-week.
 * Rule: if an employee had a 'verschieben' shift in week W they may NOT be assigned to any
 * Nachtbereitschaft whose period starts within 7 days after the verschieben end date.
 * (Covers the "no Nacht in the next week after a shifted week" requirement.)
 */
export function isBlockedFromNachtAfterVerschieben(
  employee: Employee,
  nachtStartDate: Date,
  assignments: ShiftAssignment[]
): boolean {
  return assignments.some(a => {
    if (a.shiftType !== 'verschieben') return false;
    if (!a.employees.includes(employee.id)) return false;
    const vEnd = new Date(a.endDate);
    // Block nacht for 7 days after verschieben ends (one full rest week).
    const daysDiff = Math.round(
      (nachtStartDate.getTime() - vEnd.getTime()) / (1000 * 60 * 60 * 24)
    );
    return daysDiff >= 1 && daysDiff <= 7;
  });
}

/**
 * Block Nachtbereitschaft when the employee has vacation starting within 7 days
 * after the nacht period ends.  "No night shift in the week before vacation."
 */
export function isBlockedFromNachtBeforeVacation(
  employee: Employee,
  nachtEndDate: Date,
): boolean {
  const checkDay = (day: Date) => {
    const dayStart = startOfDay(day);
    const single = (employee.vacationDays || []).some(
      vacDay => startOfDay(new Date(vacDay)).getTime() === dayStart.getTime()
    );
    if (single) return true;
    return (employee.vacationRanges || []).some(r => {
      const s = startOfDay(new Date(r.startDate));
      const e = endOfDay(new Date(r.endDate));
      return isWithinInterval(dayStart, { start: s, end: e });
    });
  };

  // Check the 7 days following the nacht end date for vacation
  for (let d = 1; d <= 7; d++) {
    if (checkDay(addDays(nachtEndDate, d))) return true;
  }
  return false;
}

/**
 * Get available employees for a shift, sorted by workload for that shift type.
 * Optionally filters by department's allowed shift types.
 */
export function getAvailableEmployeesSorted(
  employees: Employee[],
  shiftType: ShiftType,
  startDate: Date,
  endDate: Date,
  existingAssignments: ShiftAssignment[],
  config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG,
  _departments?: Department[],
  /** Overall planning-period date range, used to weight fairness sorting proportionally to each employee's active tenure. Falls back to raw counts when omitted. */
  planRange?: { start: Date; end: Date }
): Employee[] {
  const { rules } = config;

  // Filter available employees
  const available = employees.filter(emp => {
    // Opted out of automatic planning entirely (still shown in the calendar roster elsewhere)
    if (emp.excludeFromPlanning) return false;

    // Employment window: exclude employees not yet hired / already left for this shift's dates
    if (!isEmployeeActiveDuring(emp, startDate, endDate)) return false;

    // Per-employee shift-type restriction
    if (rules.respectEmployeeShiftTypes) {
      const allowed = emp.allowedShiftTypes ?? ['fruehschicht', 'verschieben', 'nachtbereitschaft'];
      if (!allowed.includes(shiftType)) return false;
    }
    // Check all days in the shift period
    const days: Date[] = [];
    for (let d = new Date(startDate); d <= endDate; d = addDays(d, 1)) {
      days.push(new Date(d));
    }
    
    // Hard vacation-day-off check (unconditional, not a toggleable rule) —
    // weekend-around-vacation is handled separately below, generically, via
    // the 'weekendNearVacation' builtin rule.
    const canWorkAllDays = days.every(day => canWorkOnDate(emp, day, false));
    if (!canWorkAllDays) return false;

    // Must not have avoidance preference (toggleable)
    if (rules.respectAvoidancePreferences) {
      const wantsToAvoid = days.some(day => hasAvoidancePreference(emp, shiftType, day));
      if (wantsToAvoid) return false;
    }

    // CRITICAL: Must not already have a shift on any of these days (always enforced)
    const hasConflictingShift = existingAssignments.some(assignment => {
      if (!assignment.employees.includes(emp.id)) return false;

      const assignStart = new Date(assignment.startDate);
      const assignEnd = new Date(assignment.endDate);

      // Check if any day in this shift overlaps with existing assignment
      return days.some(day => day >= assignStart && day <= assignEnd);
    });

    if (hasConflictingShift) return false;

    // Planning rules — the 8 formerly-hardcoded temporal rules are now
    // pre-built block-based CustomRule entries (see BUILTIN_RULES in
    // types.ts), enforced by the exact same generic mechanism as any
    // user-added rule. See customRuleEngine.ts.
    //
    // Two checks are needed since generation is a single chronological
    // forward pass and a rule can only "see" assignments already committed,
    // never ones not yet decided: a candidate is rejected if EITHER (a) it
    // violates a rule looking backward at what's already committed, OR (b)
    // committing it would retroactively make an *already committed*
    // assignment violate a rule that targets that assignment's shift type
    // (the reverse-direction half of the same constraint).
    const customRules = config.customRules || [];
    if (customRules.length > 0) {
      const selfViolation = customRules.some(rule =>
        rule.enabled &&
        rule.targetShiftTypes.includes(shiftType) &&
        evaluateConditionNode(rule.condition, { employee: emp, startDate, endDate, assignments: existingAssignments })
      );
      if (selfViolation) return false;

      const candidateAssignment: ShiftAssignment = { id: '__candidate__', shiftType, startDate, endDate, employees: [emp.id], confirmed: true };
      const hypotheticalAssignments = [...existingAssignments, candidateAssignment];
      const retroactiveViolation = customRules.some(rule =>
        rule.enabled &&
        existingAssignments.some(a =>
          rule.targetShiftTypes.includes(a.shiftType) &&
          a.employees.includes(emp.id) &&
          evaluateConditionNode(rule.condition, { employee: emp, startDate: new Date(a.startDate), endDate: new Date(a.endDate), assignments: hypotheticalAssignments })
        )
      );
      if (retroactiveViolation) return false;
    }

    return true;
  });
  
  // Sort by number of shifts of this type (ascending - fewest first).
  // When a planRange is given, normalize each employee's raw count by their
  // active-tenure weight within that range, so partial-tenure employees are
  // compared on a proportional (not absolute) basis — e.g. someone employed
  // for half the period with half as many shifts is treated as "on par",
  // not as "underworked" relative to a full-period employee.
  return available.sort((a, b) => {
    const aCount = countShiftTypeForEmployee(a.id, shiftType, existingAssignments);
    const bCount = countShiftTypeForEmployee(b.id, shiftType, existingAssignments);
    if (!planRange) return aCount - bCount;
    const aWeight = Math.max(MIN_ACTIVE_WEIGHT, getEmployeeActiveWeight(a, planRange.start, planRange.end));
    const bWeight = Math.max(MIN_ACTIVE_WEIGHT, getEmployeeActiveWeight(b, planRange.start, planRange.end));
    return (aCount / aWeight) - (bCount / bWeight);
  });
}

/**
 * Select employees from different departments (diversity optional)
 */
function selectEmployeesWithDepartmentDiversity(
  employees: Employee[],
  requiredCount: number,
  useDiversity = true
): Employee[] {
  if (!useDiversity) {
    return employees.slice(0, requiredCount);
  }

  const selected: Employee[] = [];
  const usedDepartments = new Set<string>();
  
  // First pass: one from each department
  for (const emp of employees) {
    if (selected.length >= requiredCount) break;
    
    if (!usedDepartments.has(emp.department)) {
      selected.push(emp);
      usedDepartments.add(emp.department);
    }
  }
  
  // Second pass: fill remaining if needed
  for (const emp of employees) {
    if (selected.length >= requiredCount) break;
    
    if (!selected.includes(emp)) {
      selected.push(emp);
    }
  }
  
  return selected;
}

// selectVerschiebenEmployees removed – per-employee allowedShiftTypes replaces Ü55 pool logic

/**
 * Generate all shift periods for a year
 */
export function generateShiftPeriods(year: number): Map<ShiftType, { startDate: Date; endDate: Date }[]> {
  const periods = new Map<ShiftType, { startDate: Date; endDate: Date }[]>();
  
  const yearStart = startOfYear(new Date(year, 0, 1));
  const yearEnd = endOfYear(new Date(year, 11, 31));
  
  // Reuse range-based generator for a full calendar year
  const fullYearStart = yearStart;
  const fullYearEnd = yearEnd;

  // Nachtbereitschaft: Saturday to Saturday (weekly)
  const nightShifts: { startDate: Date; endDate: Date }[] = [];
  let currentDate = startOfWeek(fullYearStart, { weekStartsOn: 6 }); // Start on Saturday
  
  while (currentDate <= fullYearEnd) {
    const shiftEnd = addDays(currentDate, 6); // Saturday to Saturday (7 days)
    nightShifts.push({ startDate: new Date(currentDate), endDate: shiftEnd });
    currentDate = addDays(currentDate, 7);
  }
  periods.set('nachtbereitschaft', nightShifts);
  
  // Verschobene Schicht: Monday to Friday (weekly)
  const lateShifts: { startDate: Date; endDate: Date }[] = [];
  currentDate = startOfWeek(fullYearStart, { weekStartsOn: 1 }); // Start on Monday
  
  while (currentDate <= fullYearEnd) {
    const shiftEnd = addDays(currentDate, 4); // Monday to Friday
    lateShifts.push({ startDate: new Date(currentDate), endDate: shiftEnd });
    currentDate = addWeeks(currentDate, 1);
  }
  periods.set('verschieben', lateShifts);
  
  // Frühschicht (Weekend): Saturday to Sunday
  const earlyShifts: { startDate: Date; endDate: Date }[] = [];
  currentDate = startOfWeek(fullYearStart, { weekStartsOn: 6 }); // Start on Saturday
  
  while (currentDate <= fullYearEnd) {
    const shiftEnd = addDays(currentDate, 1); // Saturday to Sunday
    earlyShifts.push({ startDate: new Date(currentDate), endDate: shiftEnd });
    currentDate = addWeeks(currentDate, 1);
  }
  periods.set('fruehschicht', earlyShifts);
  
  return periods;
}

/**
 * Generate shift periods for an arbitrary start date and month range (e.g. 12 months)
 */
export function generateShiftPeriodsForRange(startDate: Date, months: number): Map<ShiftType, { startDate: Date; endDate: Date }[]> {
  const periods = new Map<ShiftType, { startDate: Date; endDate: Date }[]>();
  const rangeStart = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const rangeEnd = addDays(new Date(rangeStart.getFullYear(), rangeStart.getMonth() + months, 1), -1);

  // Nachtbereitschaft: Saturday to Saturday
  const nightShifts: { startDate: Date; endDate: Date }[] = [];
  let currentDate = startOfWeek(rangeStart, { weekStartsOn: 6 }); // nearest Saturday on or before rangeStart
  while (currentDate <= rangeEnd) {
    const shiftEnd = addDays(currentDate, 6);
    // include if overlaps range
    if (shiftEnd >= rangeStart && currentDate <= rangeEnd) {
      nightShifts.push({ startDate: new Date(currentDate), endDate: shiftEnd });
    }
    currentDate = addDays(currentDate, 7);
  }
  periods.set('nachtbereitschaft', nightShifts);

  // Verschobene Schicht: Monday to Friday
  const lateShifts: { startDate: Date; endDate: Date }[] = [];
  currentDate = startOfWeek(rangeStart, { weekStartsOn: 1 }); // Monday on or before rangeStart
  while (currentDate <= rangeEnd) {
    const shiftEnd = addDays(currentDate, 4);
    if (shiftEnd >= rangeStart && currentDate <= rangeEnd) {
      lateShifts.push({ startDate: new Date(currentDate), endDate: shiftEnd });
    }
    currentDate = addWeeks(currentDate, 1);
  }
  periods.set('verschieben', lateShifts);

  // Frühschicht: Saturday to Sunday
  const earlyShifts: { startDate: Date; endDate: Date }[] = [];
  currentDate = startOfWeek(rangeStart, { weekStartsOn: 6 });
  while (currentDate <= rangeEnd) {
    const shiftEnd = addDays(currentDate, 1);
    if (shiftEnd >= rangeStart && currentDate <= rangeEnd) {
      earlyShifts.push({ startDate: new Date(currentDate), endDate: shiftEnd });
    }
    currentDate = addWeeks(currentDate, 1);
  }
  periods.set('fruehschicht', earlyShifts);

  return periods;
}

export interface AutoScheduleResult {
  assignments: ShiftAssignment[];
  violations: SchedulerViolation[];
}

/**
 * Detect violations (understaffing) for a given set of assignments.
 * Generates all expected shift periods, then checks each period against
 * the required staffing levels from the config.
 */
export function detectViolations(
  _employees: Employee[],
  assignments: ShiftAssignment[],
  config: SchedulerConfig,
  startYear: number,
  startMonth: number,
  months: number,
): SchedulerViolation[] {
  const violations: SchedulerViolation[] = [];
  const startDate = new Date(startYear, startMonth, 1);
  const periods = generateShiftPeriodsForRange(startDate, months);
  const { shiftCounts, rules } = config;

  const requiredCounts: Record<ShiftType, number> = {
    verschieben: shiftCounts.verschieben,
    nachtbereitschaft: shiftCounts.nachtbereitschaft,
    fruehschicht: shiftCounts.fruehschicht,
  };

  const ruleLabels: Partial<Record<keyof typeof rules, string>> = {
    respectEmployeeShiftTypes: 'Erlaubte Schichttypen pro MA',
    respectAvoidancePreferences: 'Vermeidungspräferenzen',
    departmentDiversity: 'Abteilungsvielfalt',
  };

  for (const [shiftType, periodList] of periods.entries()) {
    for (const period of periodList) {
      const required = requiredCounts[shiftType];

      // Find matching assignment by shift type and date range.
      // Compare only the date parts (year/month/day) because stored assignments may have
      // a different time component (T12:00:00Z vs T00:00:00Z) depending on the client timezone.
      const sameDay = (a: Date, b: Date) =>
        a.getUTCFullYear() === b.getUTCFullYear() &&
        a.getUTCMonth() === b.getUTCMonth() &&
        a.getUTCDate() === b.getUTCDate();
      const matchingAssignment = assignments.find(a =>
        a.shiftType === shiftType &&
        sameDay(new Date(a.startDate), period.startDate) &&
        sameDay(new Date(a.endDate), period.endDate)
      );

      const assigned = matchingAssignment ? matchingAssignment.employees.length : 0;

      if (assigned < required) {
        const activatedRuleKeys = (Object.keys(rules) as Array<keyof typeof rules>).filter(k => rules[k]);
        const blockedRules: string[] = [];
        for (const ruleKey of activatedRuleKeys) {
          const label = ruleLabels[ruleKey];
          if (label) blockedRules.push(label);
        }
        for (const rule of config.customRules || []) {
          if (rule.enabled && rule.targetShiftTypes.includes(shiftType)) blockedRules.push(rule.name);
        }

        violations.push({
          id: `violation-${shiftType}-${period.startDate.toISOString()}`,
          shiftType,
          startDate: period.startDate,
          endDate: period.endDate,
          required,
          assigned,
          assignedEmployeeIds: matchingAssignment ? matchingAssignment.employees : [],
          blockedRules,
        });
      }
    }
  }

  return violations;
}

/**
 * Automatically generate complete shift plan for the entire year
 * Order: 1. Night shifts, 2. Late shifts, 3. Early (weekend) shifts
 * Returns both the assignments and any periods that could not be fully staffed.
 */
export function generateAutomaticShiftPlan(
  employees: Employee[],
  startYear: number,
  startMonth = 0, // 0 = Januar
  months = 12,
  config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG,
  departments?: Department[]
): AutoScheduleResult {
  const assignments: ShiftAssignment[] = [];
  const violations: SchedulerViolation[] = [];
  const startDate = new Date(startYear, startMonth, 1);
  const planRange = { start: startDate, end: new Date(startYear, startMonth + months, 0) };
  const periods = generateShiftPeriodsForRange(startDate, months);
  const { shiftCounts, rules } = config;

  // Build a flat list of all periods with their requirements, then sort
  // chronologically by start date, so each nacht week is already committed to the
  // assignment list when the *following* verschieben week is evaluated.
  // Tiebreaker within the same start date: verschieben(0) < fruehschicht(1) < nacht(2)
  const typeOrder: Record<ShiftType, number> = {
    verschieben: 0,
    fruehschicht: 1,
    nachtbereitschaft: 2,
  };
  const requiredCounts: Record<ShiftType, number> = {
    verschieben: shiftCounts.verschieben,
    nachtbereitschaft: shiftCounts.nachtbereitschaft,
    fruehschicht: shiftCounts.fruehschicht,
  };
  const allPeriods: { shiftType: ShiftType; startDate: Date; endDate: Date }[] = [];
  for (const [shiftType, periodList] of periods.entries()) {
    for (const p of periodList) {
      allPeriods.push({ shiftType, startDate: p.startDate, endDate: p.endDate });
    }
  }
  allPeriods.sort((a, b) => {
    const dateDiff = a.startDate.getTime() - b.startDate.getTime();
    if (dateDiff !== 0) return dateDiff;
    return typeOrder[a.shiftType] - typeOrder[b.shiftType];
  });

  // Human-readable rule labels (for violation messages)
  const ruleLabels: Partial<Record<keyof typeof rules, string>> = {
    respectEmployeeShiftTypes: 'Erlaubte Schichttypen pro MA',
    respectAvoidancePreferences: 'Vermeidungspräferenzen',
    departmentDiversity: 'Abteilungsvielfalt',
  };

  for (const period of allPeriods) {
    const { shiftType } = period;
    const requiredCount = requiredCounts[shiftType];

    // Get available employees sorted by workload (fewest first)
      const available = getAvailableEmployeesSorted(
        employees,
        shiftType,
        period.startDate,
        period.endDate,
        assignments,
        config,
        departments,
        planRange
      );
      
      // Select employees — with Ü55 slot reservation for verschieben
      const useDiversity = rules.departmentDiversity;
      let selected: Employee[];

      if (shiftType === 'verschieben' && config.over55VerschiebenSlots > 0) {
        // Ensure at least N Ü55 employees per verschieben week (minimum, not exact)
        const over55Available = available.filter(e => e.isOver55);
        const minOver55 = Math.min(config.over55VerschiebenSlots, requiredCount);

        // First fill the minimum Ü55 slots
        const over55Selected = selectEmployeesWithDepartmentDiversity(over55Available, minOver55, useDiversity);
        // Then fill remaining slots from ALL remaining available employees (preserving workload order)
        const remainingCount = requiredCount - over55Selected.length;
        const selectedIds = new Set(over55Selected.map(e => e.id));
        const remainingPool = available.filter(e => !selectedIds.has(e.id));
        const restSelected = selectEmployeesWithDepartmentDiversity(remainingPool, remainingCount, useDiversity);
        selected = [...over55Selected, ...restSelected];
      } else {
        selected = selectEmployeesWithDepartmentDiversity(available, requiredCount, useDiversity);
      }

      if (selected.length >= requiredCount) {
        assignments.push({
          id: `${shiftType}-${period.startDate.toISOString()}`,
          shiftType,
          startDate: period.startDate,
          endDate: period.endDate,
          employees: selected.map(emp => emp.id),
          confirmed: true
        });
      } else {
        // Determine which active rules are causing the shortage
        const blockedRules: string[] = [];
        const activatedRuleKeys = (Object.keys(rules) as Array<keyof typeof rules>).filter(k => rules[k]);
        for (const ruleKey of activatedRuleKeys) {
          // Count how many candidates are blocked by this specific rule
          const label = ruleLabels[ruleKey];
          if (label) blockedRules.push(label);
        }
        for (const rule of config.customRules || []) {
          if (rule.enabled && rule.targetShiftTypes.includes(shiftType)) blockedRules.push(rule.name);
        }
        violations.push({
          id: `violation-${shiftType}-${period.startDate.toISOString()}`,
          shiftType,
          startDate: period.startDate,
          endDate: period.endDate,
          required: requiredCount,
          assigned: selected.length,
          assignedEmployeeIds: selected.map(e => e.id),
          blockedRules,
        });
        // Still create a partial assignment if at least 1 employee was found
        if (selected.length > 0) {
          assignments.push({
            id: `${shiftType}-${period.startDate.toISOString()}`,
            shiftType,
            startDate: period.startDate,
            endDate: period.endDate,
            employees: selected.map(emp => emp.id),
            confirmed: true
          });
        }
      }
  }
  
  return { assignments, violations };
}

// ═══════════════════════════════════════════════════════════════════════════
// EQUALITY OPTIMISER — minimise the range (max - min) of shift counts
// ═══════════════════════════════════════════════════════════════════════════

export interface EqualityProgress {
  iteration: number;
  maxIterations: number;
  improvements: number;
  ranges: Record<ShiftType, number>;
  done: boolean;
}

export interface EqualityResult {
  assignments: ShiftAssignment[];
  iterations: number;
  improvements: number;
  ranges: Record<ShiftType, number>;
}

export interface TotalBalanceResult {
  assignments: ShiftAssignment[];
  iterations: number;
  improvements: number;
  ranges: Record<string, number>;       // per pool & shift-type, e.g. "L2:verschieben"
  totalRange: Record<string, number>;   // per employee-type group
}

/**
 * Run the total-balance optimiser.
 *
 * Takes the equality-optimised baseline and tries to reduce the **total-shift
 * range** (max − min of total assignments across ALL shift types) per employee
 * type group.
 *
 * Constraint: the per-shift-type range **per employee-type pool** may NEVER
 * increase compared to the input baseline — only the total range across
 * types is reduced.
 *
 * Works by finding donors (most total shifts) and receivers (fewest total
 * shifts) within each employee-type pool, then attempting to move a single
 * assignment slot from donor to receiver (any shift type) while respecting
 * all active scheduler rules.
 */
export function runTotalBalanceOptimiser(
  employees: Employee[],
  baselineAssignments: ShiftAssignment[],
  config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG,
  maxIterations = 500,
  departments?: Department[],
): TotalBalanceResult {
  // Deep-clone
  let assignments = baselineAssignments.map(a => ({
    ...a,
    employees: [...a.employees],
  }));

  const { rules: _rules } = config;
  const shiftTypes: ShiftType[] = ['verschieben', 'nachtbereitschaft', 'fruehschicht'];

  // ── helpers ──────────────────────────────────────────────────────────────

  const countFor = (empId: string, st: ShiftType, a: ShiftAssignment[]) =>
    a.filter(x => x.shiftType === st && x.employees.includes(empId)).length;

  const totalCountFor = (empId: string, a: ShiftAssignment[]) =>
    a.filter(x => x.employees.includes(empId)).length;

  function perTypeRange(pool: Employee[], a: ShiftAssignment[]): Record<ShiftType, number> {
    const r: Record<string, number> = {};
    for (const st of shiftTypes) {
      if (pool.length === 0) { r[st] = 0; continue; }
      const counts = pool.map(e => countFor(e.id, st, a));
      r[st] = Math.max(...counts) - Math.min(...counts);
    }
    return r as Record<ShiftType, number>;
  }

  function computeTotalRange(pool: Employee[], a: ShiftAssignment[]): number {
    if (pool.length === 0) return 0;
    const counts = pool.map(e => totalCountFor(e.id, a));
    return Math.max(...counts) - Math.min(...counts);
  }

  function canTakeSlot(emp: Employee, assignment: ShiftAssignment, assgn: ShiftAssignment[]): boolean {
    if (assignment.employees.includes(emp.id)) return false;
    const otherAssignments = assgn.filter(a => a.id !== assignment.id);
    const available = getAvailableEmployeesSorted(
      [emp], assignment.shiftType,
      new Date(assignment.startDate), new Date(assignment.endDate),
      otherAssignments, config, departments,
    );
    return available.length > 0;
  }

  // ── employee-type pools ──────────────────────────────────────────────────
  // Group employees by their attribute signature (allowedShiftTypes + isOver55)
  // so each pool is balanced independently.

  const groupKey = (e: Employee): string => {
    const allowed = [...(e.allowedShiftTypes ?? ['fruehschicht', 'verschieben', 'nachtbereitschaft'])].sort().join(',');
    return `${allowed}|${e.isOver55 ? '55+' : '<55'}`;
  };

  const poolMap = new Map<string, Employee[]>();
  for (const emp of employees) {
    const key = groupKey(emp);
    if (!poolMap.has(key)) poolMap.set(key, []);
    poolMap.get(key)!.push(emp);
  }

  const pools: { label: string; pool: Employee[] }[] = Array.from(poolMap.entries()).map(
    ([key, pool]) => ({ label: key, pool })
  );

  // Record baseline per-type ranges PER POOL (must never be worsened)
  const baselineRangesPerPool: Map<string, Record<ShiftType, number>> = new Map();
  for (const { label, pool } of pools) {
    baselineRangesPerPool.set(label, perTypeRange(pool, assignments));
  }

  let improvements = 0;
  let iter = 0;

  for (iter = 0; iter < maxIterations; iter++) {
    let madeProgress = false;

    for (const { pool } of pools) {
      if (pool.length < 2) continue;

      // Compute total counts for this pool
      const counted = pool.map(e => ({ emp: e, total: totalCountFor(e.id, assignments) }));
      counted.sort((a, b) => a.total - b.total);

      const minTotal = counted[0].total;
      const maxTotal = counted[counted.length - 1].total;
      if (maxTotal - minTotal <= 1) continue;

      const donors = counted.filter(c => c.total === maxTotal);
      const receivers = counted.filter(c => c.total === minTotal);

      // Shuffle for non-determinism
      for (let i = donors.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [donors[i], donors[j]] = [donors[j], donors[i]];
      }

      let swapped = false;
      for (const donor of donors) {
        if (swapped) break;

        // Try every shift type the donor has assignments for
        for (const st of shiftTypes) {
          if (swapped) break;

          const donorAssigs = assignments.filter(
            a => a.shiftType === st && a.employees.includes(donor.emp.id)
          );

          for (const assignment of donorAssigs) {
            if (swapped) break;
            const shuffledReceivers = [...receivers];
            for (let i = shuffledReceivers.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [shuffledReceivers[i], shuffledReceivers[j]] = [shuffledReceivers[j], shuffledReceivers[i]];
            }

            for (const receiver of shuffledReceivers) {
              if (receiver.emp.id === donor.emp.id) continue;
              if (assignment.employees.includes(receiver.emp.id)) continue;

              // Build temp assignments with donor removed
              const tempAssignments = assignments.map(a => {
                if (a.id !== assignment.id) return a;
                return { ...a, employees: a.employees.filter(id => id !== donor.emp.id) };
              });

              if (!canTakeSlot(receiver.emp, assignment, tempAssignments)) continue;

              // Tentatively apply swap and check per-type ranges
              const tentative = tempAssignments.map(a => {
                if (a.id !== assignment.id) return a;
                return { ...a, employees: [...a.employees, receiver.emp.id] };
              });

              // CONSTRAINT: no per-type range PER POOL may increase
              let worsens = false;
              for (const { label: pLabel, pool: pPool } of pools) {
                const baseR = baselineRangesPerPool.get(pLabel)!;
                const newR = perTypeRange(pPool, tentative);
                if (shiftTypes.some(t => newR[t] > baseR[t])) { worsens = true; break; }
              }
              if (worsens) continue;

              // Accept: execute swap on real assignments
              const target = assignments.find(a => a.id === assignment.id)!;
              target.employees = target.employees.filter(id => id !== donor.emp.id);
              target.employees.push(receiver.emp.id);
              improvements++;
              swapped = true;
              madeProgress = true;
              break;
            }
          }
        }
      }
    }

    if (!madeProgress) { iter++; break; }
  }

  // Compute final total ranges per pool
  const totalRangeMap: Record<string, number> = {};
  for (const { label, pool } of pools) {
    totalRangeMap[label] = computeTotalRange(pool, assignments);
  }

  return {
    assignments,
    iterations: iter,
    improvements,
    ranges: Object.fromEntries(
      pools.flatMap(({ label, pool }) =>
        shiftTypes.map(t => [`${label}:${t}`, perTypeRange(pool, assignments)[t]])
      )
    ) as any,
    totalRange: totalRangeMap,
  };
}

/**
 * Run the equality optimiser.
 *
 * Takes a baseline set of assignments and tries to reduce the "shift-count
 * range" (max − min assignments per employee) for each shift type by swapping
 * employees between assignments.
 *
 * For 'verschieben' it balances all employees together.
 *
 * All active scheduler rules are respected: a swap is only accepted if the
 * receiving employee passes getAvailableEmployeesSorted for that period.
 */
export function runEqualityOptimiser(
  employees: Employee[],
  baselineAssignments: ShiftAssignment[],
  config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG,
  maxIterations = 500,
  onProgress?: (p: EqualityProgress) => void,
  departments?: Department[],
): EqualityResult {
  // Deep-clone assignments so the baseline is not mutated
  let assignments = baselineAssignments.map(a => ({
    ...a,
    employees: [...a.employees],
  }));

  const { rules: _rules } = config;

  const shiftTypes: ShiftType[] = ['verschieben', 'nachtbereitschaft', 'fruehschicht'];

  // Helper: count assignments of a given type for an employee
  const countFor = (empId: string, st: ShiftType, assgn: ShiftAssignment[]) =>
    assgn.filter(a => a.shiftType === st && a.employees.includes(empId)).length;

  // Helper: compute range per shift type
  function computeRanges(assgn: ShiftAssignment[]): Record<ShiftType, number> {
    const result: Record<string, number> = {};
    for (const st of shiftTypes) {
      const pool = relevantPool(st);
      if (pool.length === 0) { result[st] = 0; continue; }
      const counts = pool.map(e => countFor(e.id, st, assgn));
      result[st] = Math.max(...counts) - Math.min(...counts);
    }
    return result as Record<ShiftType, number>;
  }

  // All employees that can work a given shift type
  function relevantPool(st: ShiftType): Employee[] {
    return employees.filter(e => {
      const allowed = e.allowedShiftTypes || ['fruehschicht', 'verschieben', 'nachtbereitschaft'];
      return allowed.includes(st);
    });
  }

  // Pools for verschieben balancing — only employees allowed for verschieben
  function verschiebenPools(): Employee[][] {
    const pool = relevantPool('verschieben');
    return pool.length > 0 ? [pool] : [];
  }

  // Check if an employee can be added to a specific assignment without
  // violating any active rule.  Uses getAvailableEmployeesSorted which
  // applies all toggleable rules.
  function canTakeSlot(emp: Employee, assignment: ShiftAssignment, assgn: ShiftAssignment[]): boolean {
    // Already assigned here?
    if (assignment.employees.includes(emp.id)) return false;
    // Build a temporary assignment list WITHOUT this assignment (to avoid self-conflict)
    const otherAssignments = assgn.filter(a => a.id !== assignment.id);
    const available = getAvailableEmployeesSorted(
      [emp],
      assignment.shiftType,
      new Date(assignment.startDate),
      new Date(assignment.endDate),
      otherAssignments,
      config,
      departments,
    );
    return available.length > 0;
  }

  let improvements = 0;
  let iter = 0;
  const progressInterval = Math.max(1, Math.floor(maxIterations / 100));

  for (iter = 0; iter < maxIterations; iter++) {
    if (iter % progressInterval === 0 && onProgress) {
      onProgress({
        iteration: iter,
        maxIterations,
        improvements,
        ranges: computeRanges(assignments),
        done: false,
      });
    }

    let madeProgress = false;

    for (const st of shiftTypes) {
      // Determine pools to balance
      const pools = st === 'verschieben' ? verschiebenPools() : [relevantPool(st)];

      for (const pool of pools) {
        if (pool.length < 2) continue;

        // Compute counts
        const counted = pool.map(e => ({ emp: e, count: countFor(e.id, st, assignments) }));
        counted.sort((a, b) => a.count - b.count);

        const minCount = counted[0].count;
        const maxCount = counted[counted.length - 1].count;

        if (maxCount - minCount <= 1) continue; // already balanced

        // Find an employee with the most shifts ("donor") and one with the
        // least ("receiver").  Try to swap one assignment.
        const donors = counted.filter(c => c.count === maxCount);
        const receivers = counted.filter(c => c.count === minCount);

        // Shuffle to avoid deterministic lock-in
        for (let i = donors.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [donors[i], donors[j]] = [donors[j], donors[i]];
        }

        let swapped = false;
        for (const donor of donors) {
          if (swapped) break;
          // Find assignments that include this donor
          const donorAssignments = assignments.filter(
            a => a.shiftType === st && a.employees.includes(donor.emp.id)
          );
          for (const assignment of donorAssignments) {
            if (swapped) break;
            // Shuffle receivers too
            const shuffledReceivers = [...receivers];
            for (let i = shuffledReceivers.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [shuffledReceivers[i], shuffledReceivers[j]] = [shuffledReceivers[j], shuffledReceivers[i]];
            }
            for (const receiver of shuffledReceivers) {
              if (receiver.emp.id === donor.emp.id) continue;
              if (assignment.employees.includes(receiver.emp.id)) continue;

              // Check if receiver can take this slot
              // Build temp assignments with donor removed from this assignment
              const tempAssignments = assignments.map(a => {
                if (a.id !== assignment.id) return a;
                return { ...a, employees: a.employees.filter(id => id !== donor.emp.id) };
              });

              if (canTakeSlot(receiver.emp, assignment, tempAssignments)) {
                // Execute the swap: remove donor, add receiver
                const target = assignments.find(a => a.id === assignment.id)!;
                target.employees = target.employees.filter(id => id !== donor.emp.id);
                target.employees.push(receiver.emp.id);
                improvements++;
                swapped = true;
                madeProgress = true;
                break;
              }
            }
          }
        }
      }
    }

    // If no shift type made progress this iteration, we've converged
    if (!madeProgress) {
      iter++;
      break;
    }
  }

  if (onProgress) {
    onProgress({
      iteration: iter,
      maxIterations,
      improvements,
      ranges: computeRanges(assignments),
      done: true,
    });
  }

  return {
    assignments,
    iterations: iter,
    improvements,
    ranges: computeRanges(assignments),
  };
}
