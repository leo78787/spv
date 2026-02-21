import { 
  Employee, 
  ShiftType, 
  ShiftAssignment,
  SchedulerConfig,
  DEFAULT_SCHEDULER_CONFIG,
  SchedulerViolation,
} from '../types';

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

  // Check nachtbereitschaft adjacency — block weekend directly after night-week (endDate and following Sunday)
  const hasRecentNightWeek = assignments.some(a => {
    if (!a.employees.includes(employee.id) || a.shiftType !== 'nachtbereitschaft') return false;
    const end = new Date(a.endDate); // typically a Saturday
    const afterEndSun = addDays(end, 1); // Sunday following end
    return isSameDay(date, end) || isSameDay(date, afterEndSun);
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
 * If an employee had a nacht shift ending within 7 days before the new nacht
 * start date, they are blocked.
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
    // Nacht ends Sat, next starts Sat → daysDiff = 7 → blocked
    return daysDiff >= 1 && daysDiff <= 7;
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
    // Block if the nacht starts on the day directly after verschieben ends
    // OR within the 7 calendar days that follow (= the entire next week)
    const daysDiff = Math.round(
      (nachtStartDate.getTime() - vEnd.getTime()) / (1000 * 60 * 60 * 24)
    );
    return daysDiff >= 1 && daysDiff <= 7;
  });
}

/**
 * Get available employees for a shift, sorted by workload for that shift type
 */
export function getAvailableEmployeesSorted(
  employees: Employee[],
  shiftType: ShiftType,
  startDate: Date,
  endDate: Date,
  existingAssignments: ShiftAssignment[],
  config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG
): Employee[] {
  const { rules } = config;
  // Filter available employees
  const available = employees.filter(emp => {
    // Check all days in the shift period
    const days: Date[] = [];
    for (let d = new Date(startDate); d <= endDate; d = addDays(d, 1)) {
      days.push(new Date(d));
    }
    
    // Must be available on all days (vacation check; weekend-around-vacation toggleable)
    const canWorkAllDays = days.every(day => canWorkOnDate(emp, day, rules.noWeekendAroundVacation));
    if (!canWorkAllDays) return false;
    
    // Must not have avoidance preference (toggleable)
    if (rules.respectAvoidancePreferences) {
      const wantsToAvoid = days.some(day => hasAvoidancePreference(emp, shiftType, day));
      if (wantsToAvoid) return false;
    }

    // Qualification / age rule: Mitarbeiter Ü55 und Mitarbeiter ohne L2 dürfen
    // ausschließlich 'verschieben' (Mo–Fr) zugewiesen werden (toggleable).
    if (rules.over55AndNoL2OnlyVerschieben) {
      if ((emp.isOver55 || !emp.hasL2) && shiftType !== 'verschieben') return false;
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

    // Use shared adjacency checker for Frühschicht (weekend early shift) (toggleable)
    if (rules.noFruehschichtAdjacentToVerschieben && shiftType === 'fruehschicht') {
      const blockedByAdjacency = days.some(day => isBlockedFromFruehschichtDueToAdjacency(emp, day, existingAssignments));
      if (blockedByAdjacency) return false;
    }

    // Verschieben: forbid if adjacent weekend already has a Frühschicht for this employee (toggleable)
    if (rules.noFruehschichtAdjacentToVerschieben && shiftType === 'verschieben') {
      if (isBlockedFromVerschiebenDueToAdjacentFruehschicht(emp, startDate, endDate, existingAssignments)) return false;
    }

    // Nachtbereitschaft: forbid if employee had a verschobene Woche that ends the day before nacht start (toggleable)
    if (rules.noNachtAfterVerschieben && shiftType === 'nachtbereitschaft') {
      const blockedByVerschieben = isBlockedFromNachtAfterVerschieben(emp, startDate, existingAssignments);
      if (blockedByVerschieben) return false;
    }

    // Verschieben: forbid if employee just finished a Nacht week (toggleable)
    if (rules.noVerschiebenAfterNacht && shiftType === 'verschieben') {
      const blockedByNacht = isBlockedFromVerschiebenAfterNacht(emp, startDate, existingAssignments);
      if (blockedByNacht) return false;
    }

    // Verschieben: forbid two consecutive verschieben weeks for the same employee (toggleable)
    if (rules.noConsecutiveVerschieben && shiftType === 'verschieben') {
      if (isBlockedFromConsecutiveVerschieben(emp, startDate, existingAssignments)) return false;
    }

    // Nachtbereitschaft: forbid two consecutive nacht weeks for the same employee (toggleable)
    if (rules.noConsecutiveNacht && shiftType === 'nachtbereitschaft') {
      if (isBlockedFromConsecutiveNacht(emp, startDate, existingAssignments)) return false;
    }

    // Frühschicht: forbid two consecutive weekend early shifts for the same employee (toggleable)
    if (rules.noConsecutiveFruehschicht && shiftType === 'fruehschicht') {
      if (isBlockedFromConsecutiveFruehschicht(emp, startDate, existingAssignments)) return false;
    }

    return true;
  });
  
  // Sort by number of shifts of this type (ascending - fewest first)
  return available.sort((a, b) => {
    const aCount = countShiftTypeForEmployee(a.id, shiftType, existingAssignments);
    const bCount = countShiftTypeForEmployee(b.id, shiftType, existingAssignments);
    return aCount - bCount;
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

/**
 * Select employees for 'verschieben' weeks, ensuring exactly `requiredOver55Count`
 * slots are filled by ü55 employees (best-effort: uses as many ü55 as available).
 * Department diversity is enforced across both sub-pools combined.
 */
function selectVerschiebenEmployees(
  availableEmployees: Employee[],
  requiredCount: number,
  requiredOver55Count: number,
  useDiversity = true
): Employee[] {
  const over55Pool = availableEmployees.filter(e => e.isOver55);
  const othersPool  = availableEmployees.filter(e => !e.isOver55);

  // --- Select Ü55 slots with diversity ---
  const selectedOver55: Employee[] = [];
  const usedDepartments = new Set<string>();

  if (useDiversity) {
    // First pass: one per department
    for (const emp of over55Pool) {
      if (selectedOver55.length >= requiredOver55Count) break;
      if (!usedDepartments.has(emp.department)) {
        selectedOver55.push(emp);
        usedDepartments.add(emp.department);
      }
    }
    // Second pass: fill remaining
    for (const emp of over55Pool) {
      if (selectedOver55.length >= requiredOver55Count) break;
      if (!selectedOver55.includes(emp)) selectedOver55.push(emp);
    }
  } else {
    selectedOver55.push(...over55Pool.slice(0, requiredOver55Count));
  }

  // --- Select remaining slots from non-Ü55 pool, respecting already-used departments ---
  const remainingCount = requiredCount - selectedOver55.length;
  const selectedOthers: Employee[] = [];

  if (useDiversity) {
    // First pass: prefer departments not yet represented
    for (const emp of othersPool) {
      if (selectedOthers.length >= remainingCount) break;
      if (!usedDepartments.has(emp.department)) {
        selectedOthers.push(emp);
        usedDepartments.add(emp.department);
      }
    }
    // Second pass: fill remaining ignoring department
    for (const emp of othersPool) {
      if (selectedOthers.length >= remainingCount) break;
      if (!selectedOthers.includes(emp)) selectedOthers.push(emp);
    }
  } else {
    selectedOthers.push(...othersPool.slice(0, remainingCount));
  }

  return [...selectedOver55, ...selectedOthers];
}

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
  employees: Employee[],
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
    noNachtAfterVerschieben: 'Keine Nacht nach Versetzt-Woche',
    noVerschiebenAfterNacht: 'Kein Versetzt nach Nacht-Woche',
    noConsecutiveVerschieben: 'Keine zwei Versetzt-Wochen hintereinander',
    noConsecutiveNacht: 'Keine zwei Nachtschichten hintereinander',
    noConsecutiveFruehschicht: 'Keine zwei Frühschichten hintereinander',
    over55AndNoL2OnlyVerschieben: 'Ü55 / kein L2 nur versetzt',
    noWeekendAroundVacation: 'Kein WE um Urlaub',
    noFruehschichtAdjacentToVerschieben: 'Keine Frühschicht angrenzend an Versetzt',
    respectAvoidancePreferences: 'Vermeidungspräferenzen',
    departmentDiversity: 'Abteilungsvielfalt',
    reserveOver55SlotsForVerschieben: 'Ü55-Slot-Reservierung',
  };

  for (const [shiftType, periodList] of periods.entries()) {
    for (const period of periodList) {
      const required = requiredCounts[shiftType];

      // Find matching assignment by shift type and date range
      const matchingAssignment = assignments.find(a =>
        a.shiftType === shiftType &&
        new Date(a.startDate).getTime() === period.startDate.getTime() &&
        new Date(a.endDate).getTime() === period.endDate.getTime()
      );

      const assigned = matchingAssignment ? matchingAssignment.employees.length : 0;

      if (assigned < required) {
        const activatedRuleKeys = (Object.keys(rules) as Array<keyof typeof rules>).filter(k => rules[k]);
        const blockedRules: string[] = [];
        for (const ruleKey of activatedRuleKeys) {
          const label = ruleLabels[ruleKey];
          if (label) blockedRules.push(label);
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
  config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG
): AutoScheduleResult {
  const assignments: ShiftAssignment[] = [];
  const violations: SchedulerViolation[] = [];
  const startDate = new Date(startYear, startMonth, 1);
  const periods = generateShiftPeriodsForRange(startDate, months);
  const { shiftCounts, over55VerschiebenSlots, rules } = config;

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
    noNachtAfterVerschieben: 'Keine Nacht nach Versetzt-Woche',
    noVerschiebenAfterNacht: 'Kein Versetzt nach Nacht-Woche',
    noConsecutiveVerschieben: 'Keine zwei Versetzt-Wochen hintereinander',
    noConsecutiveNacht: 'Keine zwei Nachtschichten hintereinander',
    noConsecutiveFruehschicht: 'Keine zwei Frühschichten hintereinander',
    over55AndNoL2OnlyVerschieben: 'Ü55 / kein L2 nur versetzt',
    noWeekendAroundVacation: 'Kein WE um Urlaub',
    noFruehschichtAdjacentToVerschieben: 'Keine Frühschicht angrenzend an Versetzt',
    respectAvoidancePreferences: 'Vermeidungspräferenzen',
    departmentDiversity: 'Abteilungsvielfalt',
    reserveOver55SlotsForVerschieben: 'Ü55-Slot-Reservierung',
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
        config
      );
      
      // Select employees
      const useDiversity = rules.departmentDiversity;
      const selected = (shiftType === 'verschieben' && rules.reserveOver55SlotsForVerschieben)
        ? selectVerschiebenEmployees(available, requiredCount, over55VerschiebenSlots, useDiversity)
        : selectEmployeesWithDepartmentDiversity(available, requiredCount, useDiversity);

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
        const allCandidates = employees.filter(emp => {
          // Vacation / conflict check only (always-on rules)
          const days: Date[] = [];
          for (let d = new Date(period.startDate); d <= period.endDate; d = addDays(d, 1)) days.push(new Date(d));
          if (!days.every(day => canWorkOnDate(emp, day, false))) return false;
          const hasConflictingShift = assignments.some(a => {
            if (!a.employees.includes(emp.id)) return false;
            const aS = new Date(a.startDate), aE = new Date(a.endDate);
            return days.some(day => day >= aS && day <= aE);
          });
          return !hasConflictingShift;
        });
        const shortage = requiredCount - selected.length;
        const blockedRules: string[] = [];
        const activatedRuleKeys = (Object.keys(rules) as Array<keyof typeof rules>).filter(k => rules[k]);
        for (const ruleKey of activatedRuleKeys) {
          // Count how many candidates are blocked by this specific rule
          const label = ruleLabels[ruleKey];
          if (label) blockedRules.push(label);
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

/**
 * Run the equality optimiser.
 *
 * Takes a baseline set of assignments and tries to reduce the "shift-count
 * range" (max − min assignments per employee) for each shift type by swapping
 * employees between assignments.
 *
 * For 'verschieben' with reserveOver55SlotsForVerschieben enabled, it balances
 * the Ü55 pool and the non-Ü55 pool separately.
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
): EqualityResult {
  // Deep-clone assignments so the baseline is not mutated
  let assignments = baselineAssignments.map(a => ({
    ...a,
    employees: [...a.employees],
  }));

  const { rules } = config;

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

  // For verschieben with Ü55-slots: separate pools
  function relevantPool(st: ShiftType): Employee[] {
    if (st === 'verschieben') return employees; // ranges computed on full pool first
    // nacht/früh: only eligible employees (not Ü55, has L2 — when rule active)
    if (rules.over55AndNoL2OnlyVerschieben) {
      return employees.filter(e => !e.isOver55 && e.hasL2);
    }
    return employees;
  }

  // For verschieben, optionally split into two sub-pools
  function verschiebenPools(): Employee[][] {
    if (rules.reserveOver55SlotsForVerschieben) {
      return [
        employees.filter(e => e.isOver55),
        employees.filter(e => !e.isOver55),
      ];
    }
    return [employees];
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
