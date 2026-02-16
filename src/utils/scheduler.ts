import { 
  Employee, 
  ShiftType, 
  ShiftAssignment 
} from '../types';
import { 
  startOfWeek, 
  addWeeks, 
  isWithinInterval,
  startOfYear,
  endOfYear,
  addDays,
  subDays,
  isWeekend,
  isSameDay
} from 'date-fns';

/**
 * Check if employee can work on a specific date considering vacation boundaries
 * Rule: No weekend work before or after vacation
 */
function canWorkOnDate(employee: Employee, date: Date): boolean {
  // Check if on vacation
  const isOnVacation = employee.vacationDays.some(vacDay => {
    const vac = new Date(vacDay);
    return vac.toDateString() === date.toDateString();
  });
  
  if (isOnVacation) return false;
  
  // Check if weekend work is allowed (considering vacation boundaries)
  if (isWeekend(date)) {
    // Check day before vacation
    const nextDay = addDays(date, 1);
    const dayAfterNext = addDays(date, 2);
    
    const hasVacationAfter = employee.vacationDays.some(vacDay => {
      const vac = new Date(vacDay);
      return vac.toDateString() === nextDay.toDateString() || 
             vac.toDateString() === dayAfterNext.toDateString();
    });
    
    if (hasVacationAfter) return false;
    
    // Check day after vacation
    const prevDay = subDays(date, 1);
    const dayBeforePrev = subDays(date, 2);
    
    const hasVacationBefore = employee.vacationDays.some(vacDay => {
      const vac = new Date(vacDay);
      return vac.toDateString() === prevDay.toDateString() || 
             vac.toDateString() === dayBeforePrev.toDateString();
    });
    
    if (hasVacationBefore) return false;
  }
  
  return true;
}

/**
 * Check if employee wants to avoid this shift type
 */
function hasAvoidancePreference(employee: Employee, shiftType: ShiftType, date: Date): boolean {
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
 * Block Nachtbereitschaft when a 'verschieben' week ends immediately before the night-week
 * Rule: if employee has a 'verschieben' assignment that ends on the Friday directly
 * before the Nachtbereitschaft start (Saturday), they must not be assigned to that Nachtwoche.
 */
export function isBlockedFromNachtAfterVerschieben(
  employee: Employee,
  nachtStartDate: Date,
  assignments: ShiftAssignment[]
): boolean {
  // Find any verschieben assignment whose endDate + 1 day === nachtStartDate
  return assignments.some(a => {
    if (a.shiftType !== 'verschieben') return false;
    if (!a.employees.includes(employee.id)) return false;
    const vEnd = new Date(a.endDate);
    return isSameDay(addDays(vEnd, 1), nachtStartDate);
  });
}

/**
 * Get available employees for a shift, sorted by workload for that shift type
 */
function getAvailableEmployeesSorted(
  employees: Employee[],
  shiftType: ShiftType,
  startDate: Date,
  endDate: Date,
  existingAssignments: ShiftAssignment[]
): Employee[] {
  // Filter available employees
  const available = employees.filter(emp => {
    // Check all days in the shift period
    const days: Date[] = [];
    for (let d = new Date(startDate); d <= endDate; d = addDays(d, 1)) {
      days.push(new Date(d));
    }
    
    // Must be available on all days
    const canWorkAllDays = days.every(day => canWorkOnDate(emp, day));
    if (!canWorkAllDays) return false;
    
    // Must not have avoidance preference
    const wantsToAvoid = days.some(day => hasAvoidancePreference(emp, shiftType, day));
    if (wantsToAvoid) return false;

    // Qualification / age rule: Mitarbeiter Ü55 und Mitarbeiter ohne L2 dürfen
    // ausschließlich 'verschieben' (Mo–Fr) zugewiesen werden.
    if ((emp.isOver55 || !emp.hasL2) && shiftType !== 'verschieben') return false;
    
    // CRITICAL: Must not already have a shift on any of these days
    const hasConflictingShift = existingAssignments.some(assignment => {
      if (!assignment.employees.includes(emp.id)) return false;
      
      const assignStart = new Date(assignment.startDate);
      const assignEnd = new Date(assignment.endDate);
      
      // Check if any day in this shift overlaps with existing assignment
      return days.some(day => day >= assignStart && day <= assignEnd);
    });
    
    if (hasConflictingShift) return false;

    // Use shared adjacency checker for Frühschicht (weekend early shift)
    if (shiftType === 'fruehschicht') {
      const blockedByAdjacency = days.some(day => isBlockedFromFruehschichtDueToAdjacency(emp, day, existingAssignments));
      if (blockedByAdjacency) return false;
    }

    // Nachtbereitschaft: forbid if employee had a verschobene Woche that ends the day before nacht start
    if (shiftType === 'nachtbereitschaft') {
      const blockedByVerschieben = isBlockedFromNachtAfterVerschieben(emp, startDate, existingAssignments);
      if (blockedByVerschieben) return false;
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
 * Select employees from different departments
 */
function selectEmployeesWithDepartmentDiversity(
  employees: Employee[],
  requiredCount: number
): Employee[] {
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
 * Generate all shift periods for a year
 */
export function generateShiftPeriods(year: number): Map<ShiftType, { startDate: Date; endDate: Date }[]> {
  const periods = new Map<ShiftType, { startDate: Date; endDate: Date }[]>();
  
  const yearStart = startOfYear(new Date(year, 0, 1));
  const yearEnd = endOfYear(new Date(year, 11, 31));
  
  // Nachtbereitschaft: Saturday to Saturday (weekly)
  const nightShifts: { startDate: Date; endDate: Date }[] = [];
  let currentDate = startOfWeek(yearStart, { weekStartsOn: 6 }); // Start on Saturday
  
  while (currentDate <= yearEnd) {
    const shiftEnd = addDays(currentDate, 6); // Saturday to Saturday (7 days)
    nightShifts.push({ startDate: new Date(currentDate), endDate: shiftEnd });
    currentDate = addDays(currentDate, 7);
  }
  periods.set('nachtbereitschaft', nightShifts);
  
  // Verschobene Schicht: Monday to Friday (weekly)
  const lateShifts: { startDate: Date; endDate: Date }[] = [];
  currentDate = startOfWeek(yearStart, { weekStartsOn: 1 }); // Start on Monday
  
  while (currentDate <= yearEnd) {
    const shiftEnd = addDays(currentDate, 4); // Monday to Friday
    lateShifts.push({ startDate: new Date(currentDate), endDate: shiftEnd });
    currentDate = addWeeks(currentDate, 1);
  }
  periods.set('verschieben', lateShifts);
  
  // Frühschicht (Weekend): Saturday to Sunday
  const earlyShifts: { startDate: Date; endDate: Date }[] = [];
  currentDate = startOfWeek(yearStart, { weekStartsOn: 6 }); // Start on Saturday
  
  while (currentDate <= yearEnd) {
    const shiftEnd = addDays(currentDate, 1); // Saturday to Sunday
    earlyShifts.push({ startDate: new Date(currentDate), endDate: shiftEnd });
    currentDate = addWeeks(currentDate, 1);
  }
  periods.set('fruehschicht', earlyShifts);
  
  return periods;
}

/**
 * Automatically generate complete shift plan for the entire year
 * Order: 1. Night shifts, 2. Late shifts, 3. Early (weekend) shifts
 */
export function generateAutomaticShiftPlan(
  employees: Employee[],
  year: number
): ShiftAssignment[] {
  const assignments: ShiftAssignment[] = [];
  const periods = generateShiftPeriods(year);
  
  // Priority order adjusted so `verschieben` is assigned before `nachtbereitschaft`
  // (prevents Nacht immediately after a Verschobene Woche)
  const shiftOrder: [ShiftType, number][] = [
    ['verschieben', 4],        // First: Late shifts (exactly 4 people)
    ['nachtbereitschaft', 2],  // Second: Night shifts (exactly 2 people)
    ['fruehschicht', 3]        // Third: Weekend shifts (exactly 3 people)
  ];
  
  for (const [shiftType, requiredCount] of shiftOrder) {
    const shiftsForType = periods.get(shiftType) || [];
    
    for (const period of shiftsForType) {
      // Get available employees sorted by workload (fewest first)
      const available = getAvailableEmployeesSorted(
        employees,
        shiftType,
        period.startDate,
        period.endDate,
        assignments
      );
      
      // Select employees with department diversity
      const selected = selectEmployeesWithDepartmentDiversity(
        available,
        requiredCount
      );
      
      // Create assignment only if we have enough employees
      if (selected.length === requiredCount) {
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
  
  return assignments;
}
