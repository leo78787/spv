// server/fairnessWorker.ts
import { workerData, parentPort } from "worker_threads";

// src/types.ts
var DEFAULT_SCHEDULER_CONFIG = {
  shiftCounts: {
    verschieben: 5,
    nachtbereitschaft: 2,
    fruehschicht: 3
  },
  over55VerschiebenSlots: 2,
  rules: {
    noWeekendAroundVacation: true,
    noFruehschichtAdjacentToVerschieben: true,
    noNachtAfterVerschieben: true,
    noVerschiebenAfterNacht: true,
    noConsecutiveVerschieben: true,
    noConsecutiveNacht: true,
    noConsecutiveFruehschicht: true,
    noNachtBeforeVacation: true,
    respectEmployeeShiftTypes: true,
    respectAvoidancePreferences: true,
    departmentDiversity: true
  }
};

// node_modules/date-fns/toDate.mjs
function toDate(argument) {
  const argStr = Object.prototype.toString.call(argument);
  if (argument instanceof Date || typeof argument === "object" && argStr === "[object Date]") {
    return new argument.constructor(+argument);
  } else if (typeof argument === "number" || argStr === "[object Number]" || typeof argument === "string" || argStr === "[object String]") {
    return new Date(argument);
  } else {
    return /* @__PURE__ */ new Date(NaN);
  }
}

// node_modules/date-fns/constructFrom.mjs
function constructFrom(date, value) {
  if (date instanceof Date) {
    return new date.constructor(value);
  } else {
    return new Date(value);
  }
}

// node_modules/date-fns/addDays.mjs
function addDays(date, amount) {
  const _date = toDate(date);
  if (isNaN(amount)) return constructFrom(date, NaN);
  if (!amount) {
    return _date;
  }
  _date.setDate(_date.getDate() + amount);
  return _date;
}

// node_modules/date-fns/isWeekend.mjs
function isWeekend(date) {
  const day = toDate(date).getDay();
  return day === 0 || day === 6;
}

// node_modules/date-fns/_lib/defaultOptions.mjs
var defaultOptions = {};
function getDefaultOptions() {
  return defaultOptions;
}

// node_modules/date-fns/startOfWeek.mjs
function startOfWeek(date, options) {
  const defaultOptions2 = getDefaultOptions();
  const weekStartsOn = options?.weekStartsOn ?? options?.locale?.options?.weekStartsOn ?? defaultOptions2.weekStartsOn ?? defaultOptions2.locale?.options?.weekStartsOn ?? 0;
  const _date = toDate(date);
  const day = _date.getDay();
  const diff = (day < weekStartsOn ? 7 : 0) + day - weekStartsOn;
  _date.setDate(_date.getDate() - diff);
  _date.setHours(0, 0, 0, 0);
  return _date;
}

// node_modules/date-fns/startOfDay.mjs
function startOfDay(date) {
  const _date = toDate(date);
  _date.setHours(0, 0, 0, 0);
  return _date;
}

// node_modules/date-fns/addWeeks.mjs
function addWeeks(date, amount) {
  const days = amount * 7;
  return addDays(date, days);
}

// node_modules/date-fns/isSameDay.mjs
function isSameDay(dateLeft, dateRight) {
  const dateLeftStartOfDay = startOfDay(dateLeft);
  const dateRightStartOfDay = startOfDay(dateRight);
  return +dateLeftStartOfDay === +dateRightStartOfDay;
}

// node_modules/date-fns/endOfDay.mjs
function endOfDay(date) {
  const _date = toDate(date);
  _date.setHours(23, 59, 59, 999);
  return _date;
}

// node_modules/date-fns/isWithinInterval.mjs
function isWithinInterval(date, interval) {
  const time = +toDate(date);
  const [startTime, endTime] = [
    +toDate(interval.start),
    +toDate(interval.end)
  ].sort((a, b) => a - b);
  return time >= startTime && time <= endTime;
}

// node_modules/date-fns/subDays.mjs
function subDays(date, amount) {
  return addDays(date, -amount);
}

// src/utils/scheduler.ts
function isEmployeeActiveDuring(employee, shiftStart, shiftEnd) {
  const hire = employee.hireDate ? startOfDay(new Date(employee.hireDate)) : null;
  const termination = employee.terminationDate ? startOfDay(new Date(employee.terminationDate)) : null;
  if (hire && startOfDay(shiftStart) < hire) return false;
  if (termination && startOfDay(shiftEnd) > termination) return false;
  return true;
}
function getEmployeeActiveWeight(employee, rangeStart, rangeEnd) {
  const rStart = startOfDay(rangeStart);
  const rEnd = startOfDay(rangeEnd);
  const totalDays = Math.round((rEnd.getTime() - rStart.getTime()) / 864e5) + 1;
  if (totalDays <= 0) return 1;
  const hire = employee.hireDate ? startOfDay(new Date(employee.hireDate)) : null;
  const termination = employee.terminationDate ? startOfDay(new Date(employee.terminationDate)) : null;
  const activeStart = hire && hire > rStart ? hire : rStart;
  const activeEnd = termination && termination < rEnd ? termination : rEnd;
  const activeDays = Math.round((activeEnd.getTime() - activeStart.getTime()) / 864e5) + 1;
  return Math.max(0, Math.min(1, activeDays / totalDays));
}
var MIN_ACTIVE_WEIGHT = 0.02;
function canWorkOnDate(employee, date, respectVacationWeekend = true) {
  const d = startOfDay(date);
  const hasVacationOn = (day) => {
    const dayStart = startOfDay(day);
    const single = (employee.vacationDays || []).some((vacDay) => startOfDay(new Date(vacDay)).getTime() === dayStart.getTime());
    if (single) return true;
    const ranges = (employee.vacationRanges || []).some((r) => {
      const s = startOfDay(new Date(r.startDate));
      const e = endOfDay(new Date(r.endDate));
      return isWithinInterval(dayStart, { start: s, end: e });
    });
    return ranges;
  };
  if (hasVacationOn(d)) return false;
  if (respectVacationWeekend && isWeekend(date)) {
    const nextDay = addDays(date, 1);
    const dayAfterNext = addDays(date, 2);
    const hasVacationAfter = hasVacationOn(nextDay) || hasVacationOn(dayAfterNext);
    if (hasVacationAfter) return false;
    const prevDay = subDays(date, 1);
    const dayBeforePrev = subDays(date, 2);
    const hasVacationBefore = hasVacationOn(prevDay) || hasVacationOn(dayBeforePrev);
    if (hasVacationBefore) return false;
  }
  return true;
}
function hasAvoidancePreference(employee, shiftType, date) {
  return employee.preferences.some(
    (pref) => pref.shiftType === shiftType && pref.preferred === false && isWithinInterval(date, { start: pref.startDate, end: pref.endDate })
  );
}
function countShiftTypeForEmployee(employeeId, shiftType, assignments) {
  return assignments.filter(
    (a) => a.shiftType === shiftType && a.employees.includes(employeeId)
  ).length;
}
function isBlockedFromFruehschichtDueToAdjacency(employee, date, assignments) {
  const day = date.getDay();
  const isWeekendDay = day === 6 || day === 0;
  if (!isWeekendDay) return false;
  const hasAdjacentVerschieben = assignments.some((a) => {
    if (!a.employees.includes(employee.id) || a.shiftType !== "verschieben") return false;
    const start = new Date(a.startDate);
    const end = new Date(a.endDate);
    const beforeSat = subDays(start, 2);
    const beforeSun = subDays(start, 1);
    const afterSat = addDays(end, 1);
    const afterSun = addDays(end, 2);
    return isSameDay(date, beforeSat) || isSameDay(date, beforeSun) || isSameDay(date, afterSat) || isSameDay(date, afterSun);
  });
  if (hasAdjacentVerschieben) return true;
  const hasRecentNightWeek = assignments.some((a) => {
    if (!a.employees.includes(employee.id) || a.shiftType !== "nachtbereitschaft") return false;
    const end = new Date(a.endDate);
    const daysDiff = Math.round((date.getTime() - end.getTime()) / (1e3 * 60 * 60 * 24));
    return daysDiff >= 0 && daysDiff <= 8;
  });
  if (hasRecentNightWeek) return true;
  return false;
}
function isBlockedFromVerschiebenDueToAdjacentFruehschicht(employee, verschiebenStartDate, verschiebenEndDate, assignments) {
  return assignments.some((a) => {
    if (a.shiftType !== "fruehschicht") return false;
    if (!a.employees.includes(employee.id)) return false;
    const fStart = new Date(a.startDate);
    const fEnd = new Date(a.endDate);
    const beforeSat = subDays(verschiebenStartDate, 2);
    const beforeSun = subDays(verschiebenStartDate, 1);
    const afterSat = addDays(verschiebenEndDate, 1);
    const afterSun = addDays(verschiebenEndDate, 2);
    return isSameDay(fStart, beforeSat) || isSameDay(fStart, beforeSun) || isSameDay(fStart, afterSat) || isSameDay(fStart, afterSun) || isSameDay(fEnd, beforeSat) || isSameDay(fEnd, beforeSun) || isSameDay(fEnd, afterSat) || isSameDay(fEnd, afterSun);
  });
}
function isBlockedFromConsecutiveVerschieben(employee, verschiebenStartDate, assignments) {
  return assignments.some((a) => {
    if (a.shiftType !== "verschieben") return false;
    if (!a.employees.includes(employee.id)) return false;
    const vEnd = new Date(a.endDate);
    const daysDiff = Math.round(
      (verschiebenStartDate.getTime() - vEnd.getTime()) / (1e3 * 60 * 60 * 24)
    );
    return daysDiff >= 1 && daysDiff <= 7;
  });
}
function isBlockedFromConsecutiveNacht(employee, nachtStartDate, assignments) {
  return assignments.some((a) => {
    if (a.shiftType !== "nachtbereitschaft") return false;
    if (!a.employees.includes(employee.id)) return false;
    const nEnd = new Date(a.endDate);
    const daysDiff = Math.round(
      (nachtStartDate.getTime() - nEnd.getTime()) / (1e3 * 60 * 60 * 24)
    );
    return daysDiff >= 1 && daysDiff <= 8;
  });
}
function isBlockedFromConsecutiveFruehschicht(employee, fruehStartDate, assignments) {
  return assignments.some((a) => {
    if (a.shiftType !== "fruehschicht") return false;
    if (!a.employees.includes(employee.id)) return false;
    const fEnd = new Date(a.endDate);
    const daysDiff = Math.round(
      (fruehStartDate.getTime() - fEnd.getTime()) / (1e3 * 60 * 60 * 24)
    );
    return daysDiff >= 1 && daysDiff <= 7;
  });
}
function isBlockedFromVerschiebenAfterNacht(employee, verschiebenStartDate, assignments) {
  return assignments.some((a) => {
    if (a.shiftType !== "nachtbereitschaft") return false;
    if (!a.employees.includes(employee.id)) return false;
    const nEnd = new Date(a.endDate);
    const daysDiff = Math.round(
      (verschiebenStartDate.getTime() - nEnd.getTime()) / (1e3 * 60 * 60 * 24)
    );
    return daysDiff >= 1 && daysDiff <= 7;
  });
}
function isBlockedFromNachtAfterVerschieben(employee, nachtStartDate, assignments) {
  return assignments.some((a) => {
    if (a.shiftType !== "verschieben") return false;
    if (!a.employees.includes(employee.id)) return false;
    const vEnd = new Date(a.endDate);
    const daysDiff = Math.round(
      (nachtStartDate.getTime() - vEnd.getTime()) / (1e3 * 60 * 60 * 24)
    );
    return daysDiff >= 1 && daysDiff <= 7;
  });
}
function isBlockedFromNachtBeforeVacation(employee, nachtEndDate) {
  const checkDay = (day) => {
    const dayStart = startOfDay(day);
    const single = (employee.vacationDays || []).some(
      (vacDay) => startOfDay(new Date(vacDay)).getTime() === dayStart.getTime()
    );
    if (single) return true;
    return (employee.vacationRanges || []).some((r) => {
      const s = startOfDay(new Date(r.startDate));
      const e = endOfDay(new Date(r.endDate));
      return isWithinInterval(dayStart, { start: s, end: e });
    });
  };
  for (let d = 1; d <= 7; d++) {
    if (checkDay(addDays(nachtEndDate, d))) return true;
  }
  return false;
}
function getAvailableEmployeesSorted(employees2, shiftType, startDate, endDate, existingAssignments, config2 = DEFAULT_SCHEDULER_CONFIG, _departments, planRange) {
  const { rules } = config2;
  const available = employees2.filter((emp) => {
    if (!isEmployeeActiveDuring(emp, startDate, endDate)) return false;
    if (rules.respectEmployeeShiftTypes) {
      const allowed = emp.allowedShiftTypes ?? ["fruehschicht", "verschieben", "nachtbereitschaft"];
      if (!allowed.includes(shiftType)) return false;
    }
    const days = [];
    for (let d = new Date(startDate); d <= endDate; d = addDays(d, 1)) {
      days.push(new Date(d));
    }
    const canWorkAllDays = days.every((day) => canWorkOnDate(emp, day, rules.noWeekendAroundVacation));
    if (!canWorkAllDays) return false;
    if (rules.respectAvoidancePreferences) {
      const wantsToAvoid = days.some((day) => hasAvoidancePreference(emp, shiftType, day));
      if (wantsToAvoid) return false;
    }
    const hasConflictingShift = existingAssignments.some((assignment) => {
      if (!assignment.employees.includes(emp.id)) return false;
      const assignStart = new Date(assignment.startDate);
      const assignEnd = new Date(assignment.endDate);
      return days.some((day) => day >= assignStart && day <= assignEnd);
    });
    if (hasConflictingShift) return false;
    if (rules.noFruehschichtAdjacentToVerschieben && shiftType === "fruehschicht") {
      const blockedByAdjacency = days.some((day) => isBlockedFromFruehschichtDueToAdjacency(emp, day, existingAssignments));
      if (blockedByAdjacency) return false;
    }
    if (rules.noFruehschichtAdjacentToVerschieben && shiftType === "verschieben") {
      if (isBlockedFromVerschiebenDueToAdjacentFruehschicht(emp, startDate, endDate, existingAssignments)) return false;
    }
    if (rules.noNachtAfterVerschieben && shiftType === "nachtbereitschaft") {
      const blockedByVerschieben = isBlockedFromNachtAfterVerschieben(emp, startDate, existingAssignments);
      if (blockedByVerschieben) return false;
    }
    if (rules.noVerschiebenAfterNacht && shiftType === "verschieben") {
      const blockedByNacht = isBlockedFromVerschiebenAfterNacht(emp, startDate, existingAssignments);
      if (blockedByNacht) return false;
    }
    if (rules.noConsecutiveVerschieben && shiftType === "verschieben") {
      if (isBlockedFromConsecutiveVerschieben(emp, startDate, existingAssignments)) return false;
    }
    if (rules.noConsecutiveNacht && shiftType === "nachtbereitschaft") {
      if (isBlockedFromConsecutiveNacht(emp, startDate, existingAssignments)) return false;
    }
    if (rules.noConsecutiveFruehschicht && shiftType === "fruehschicht") {
      if (isBlockedFromConsecutiveFruehschicht(emp, startDate, existingAssignments)) return false;
    }
    if (rules.noNachtBeforeVacation && shiftType === "nachtbereitschaft") {
      if (isBlockedFromNachtBeforeVacation(emp, endDate)) return false;
    }
    const daysDiffFromEnd = (a) => Math.round((new Date(a.startDate).getTime() - endDate.getTime()) / (1e3 * 60 * 60 * 24));
    if (rules.noVerschiebenAfterNacht && shiftType === "nachtbereitschaft") {
      const blocked = existingAssignments.some((a) => {
        if (a.shiftType !== "verschieben" || !a.employees.includes(emp.id)) return false;
        const d = daysDiffFromEnd(a);
        return d >= 1 && d <= 8;
      });
      if (blocked) return false;
    }
    if (rules.noNachtAfterVerschieben && shiftType === "verschieben") {
      const blocked = existingAssignments.some((a) => {
        if (a.shiftType !== "nachtbereitschaft" || !a.employees.includes(emp.id)) return false;
        const d = daysDiffFromEnd(a);
        return d >= 1 && d <= 8;
      });
      if (blocked) return false;
    }
    if (rules.noFruehschichtAdjacentToVerschieben && shiftType === "nachtbereitschaft") {
      const blocked = existingAssignments.some((a) => {
        if (a.shiftType !== "fruehschicht" || !a.employees.includes(emp.id)) return false;
        const d = daysDiffFromEnd(a);
        return d >= 0 && d <= 8;
      });
      if (blocked) return false;
    }
    if (rules.noConsecutiveNacht && shiftType === "nachtbereitschaft") {
      const blocked = existingAssignments.some((a) => {
        if (a.shiftType !== "nachtbereitschaft" || !a.employees.includes(emp.id)) return false;
        const d = daysDiffFromEnd(a);
        return d >= 1 && d <= 8;
      });
      if (blocked) return false;
    }
    if (rules.noConsecutiveVerschieben && shiftType === "verschieben") {
      const blocked = existingAssignments.some((a) => {
        if (a.shiftType !== "verschieben" || !a.employees.includes(emp.id)) return false;
        const d = daysDiffFromEnd(a);
        return d >= 1 && d <= 7;
      });
      if (blocked) return false;
    }
    if (rules.noConsecutiveFruehschicht && shiftType === "fruehschicht") {
      const blocked = existingAssignments.some((a) => {
        if (a.shiftType !== "fruehschicht" || !a.employees.includes(emp.id)) return false;
        const d = daysDiffFromEnd(a);
        return d >= 1 && d <= 7;
      });
      if (blocked) return false;
    }
    return true;
  });
  return available.sort((a, b) => {
    const aCount = countShiftTypeForEmployee(a.id, shiftType, existingAssignments);
    const bCount = countShiftTypeForEmployee(b.id, shiftType, existingAssignments);
    if (!planRange) return aCount - bCount;
    const aWeight = Math.max(MIN_ACTIVE_WEIGHT, getEmployeeActiveWeight(a, planRange.start, planRange.end));
    const bWeight = Math.max(MIN_ACTIVE_WEIGHT, getEmployeeActiveWeight(b, planRange.start, planRange.end));
    return aCount / aWeight - bCount / bWeight;
  });
}
function selectEmployeesWithDepartmentDiversity(employees2, requiredCount, useDiversity = true) {
  if (!useDiversity) {
    return employees2.slice(0, requiredCount);
  }
  const selected = [];
  const usedDepartments = /* @__PURE__ */ new Set();
  for (const emp of employees2) {
    if (selected.length >= requiredCount) break;
    if (!usedDepartments.has(emp.department)) {
      selected.push(emp);
      usedDepartments.add(emp.department);
    }
  }
  for (const emp of employees2) {
    if (selected.length >= requiredCount) break;
    if (!selected.includes(emp)) {
      selected.push(emp);
    }
  }
  return selected;
}
function generateShiftPeriodsForRange(startDate, months) {
  const periods = /* @__PURE__ */ new Map();
  const rangeStart = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const rangeEnd = addDays(new Date(rangeStart.getFullYear(), rangeStart.getMonth() + months, 1), -1);
  const nightShifts = [];
  let currentDate = startOfWeek(rangeStart, { weekStartsOn: 6 });
  while (currentDate <= rangeEnd) {
    const shiftEnd = addDays(currentDate, 6);
    if (shiftEnd >= rangeStart && currentDate <= rangeEnd) {
      nightShifts.push({ startDate: new Date(currentDate), endDate: shiftEnd });
    }
    currentDate = addDays(currentDate, 7);
  }
  periods.set("nachtbereitschaft", nightShifts);
  const lateShifts = [];
  currentDate = startOfWeek(rangeStart, { weekStartsOn: 1 });
  while (currentDate <= rangeEnd) {
    const shiftEnd = addDays(currentDate, 4);
    if (shiftEnd >= rangeStart && currentDate <= rangeEnd) {
      lateShifts.push({ startDate: new Date(currentDate), endDate: shiftEnd });
    }
    currentDate = addWeeks(currentDate, 1);
  }
  periods.set("verschieben", lateShifts);
  const earlyShifts = [];
  currentDate = startOfWeek(rangeStart, { weekStartsOn: 6 });
  while (currentDate <= rangeEnd) {
    const shiftEnd = addDays(currentDate, 1);
    if (shiftEnd >= rangeStart && currentDate <= rangeEnd) {
      earlyShifts.push({ startDate: new Date(currentDate), endDate: shiftEnd });
    }
    currentDate = addWeeks(currentDate, 1);
  }
  periods.set("fruehschicht", earlyShifts);
  return periods;
}
function generateAutomaticShiftPlan(employees2, startYear, startMonth2 = 0, months = 12, config2 = DEFAULT_SCHEDULER_CONFIG, departments) {
  const assignments = [];
  const violations = [];
  const startDate = new Date(startYear, startMonth2, 1);
  const planRange = { start: startDate, end: new Date(startYear, startMonth2 + months, 0) };
  const periods = generateShiftPeriodsForRange(startDate, months);
  const { shiftCounts, rules } = config2;
  const typeOrder = {
    verschieben: 0,
    fruehschicht: 1,
    nachtbereitschaft: 2
  };
  const requiredCounts = {
    verschieben: shiftCounts.verschieben,
    nachtbereitschaft: shiftCounts.nachtbereitschaft,
    fruehschicht: shiftCounts.fruehschicht
  };
  const allPeriods = [];
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
  const ruleLabels = {
    noNachtAfterVerschieben: "Keine Nacht nach Versetzt-Woche",
    noVerschiebenAfterNacht: "Kein Versetzt nach Nacht-Woche",
    noConsecutiveVerschieben: "Keine zwei Versetzt-Wochen hintereinander",
    noConsecutiveNacht: "Keine zwei Nachtschichten hintereinander",
    noConsecutiveFruehschicht: "Keine zwei Fr\xFChschichten hintereinander",
    noNachtBeforeVacation: "Keine Nacht in der Woche vor Urlaub",
    respectEmployeeShiftTypes: "Erlaubte Schichttypen pro MA",
    noWeekendAroundVacation: "Kein WE um Urlaub",
    noFruehschichtAdjacentToVerschieben: "Keine Fr\xFChschicht angrenzend an Versetzt",
    respectAvoidancePreferences: "Vermeidungspr\xE4ferenzen",
    departmentDiversity: "Abteilungsvielfalt"
  };
  for (const period of allPeriods) {
    const { shiftType } = period;
    const requiredCount = requiredCounts[shiftType];
    const available = getAvailableEmployeesSorted(
      employees2,
      shiftType,
      period.startDate,
      period.endDate,
      assignments,
      config2,
      departments,
      planRange
    );
    const useDiversity = rules.departmentDiversity;
    let selected;
    if (shiftType === "verschieben" && config2.over55VerschiebenSlots > 0) {
      const over55Available = available.filter((e) => e.isOver55);
      const minOver55 = Math.min(config2.over55VerschiebenSlots, requiredCount);
      const over55Selected = selectEmployeesWithDepartmentDiversity(over55Available, minOver55, useDiversity);
      const remainingCount = requiredCount - over55Selected.length;
      const selectedIds = new Set(over55Selected.map((e) => e.id));
      const remainingPool = available.filter((e) => !selectedIds.has(e.id));
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
        employees: selected.map((emp) => emp.id),
        confirmed: true
      });
    } else {
      const blockedRules = [];
      const activatedRuleKeys = Object.keys(rules).filter((k) => rules[k]);
      for (const ruleKey of activatedRuleKeys) {
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
        assignedEmployeeIds: selected.map((e) => e.id),
        blockedRules
      });
      if (selected.length > 0) {
        assignments.push({
          id: `${shiftType}-${period.startDate.toISOString()}`,
          shiftType,
          startDate: period.startDate,
          endDate: period.endDate,
          employees: selected.map((emp) => emp.id),
          confirmed: true
        });
      }
    }
  }
  return { assignments, violations };
}

// src/utils/fairnessImpact.ts
function cvFairness(counts) {
  if (counts.length === 0) return 100;
  const avg = counts.reduce((s, c) => s + c, 0) / counts.length;
  if (avg === 0) return 100;
  const variance = counts.reduce((s, c) => s + (c - avg) ** 2, 0) / counts.length;
  const stdDev = Math.sqrt(variance);
  return Math.max(0, 100 - stdDev / avg * 100);
}
function computeFairnessScores(employees2, assignments, periodRange) {
  const weightOf = (e) => periodRange ? getEmployeeActiveWeight(e, periodRange.start, periodRange.end) : 1;
  const judgeable = periodRange ? employees2.filter((e) => weightOf(e) > 0) : employees2;
  const allIds = judgeable.map((e) => e.id);
  const nachtFruehIds = judgeable.filter((e) => {
    const allowed = e.allowedShiftTypes ?? ["fruehschicht", "verschieben", "nachtbereitschaft"];
    return allowed.includes("nachtbereitschaft") || allowed.includes("fruehschicht");
  }).map((e) => e.id);
  const empById = new Map(judgeable.map((e) => [e.id, e]));
  const countFor = (ids, type) => ids.map((id) => {
    const raw = assignments.filter((a) => a.employees.includes(id) && (type ? a.shiftType === type : true)).length;
    if (!periodRange) return raw;
    const emp = empById.get(id);
    const weight = Math.max(MIN_ACTIVE_WEIGHT, weightOf(emp));
    return raw / weight;
  });
  return {
    overall: cvFairness(countFor(allIds, null)),
    verschieben: cvFairness(countFor(allIds, "verschieben")),
    nacht: cvFairness(countFor(nachtFruehIds, "nachtbereitschaft")),
    frueh: cvFairness(countFor(nachtFruehIds, "fruehschicht"))
  };
}
function delta(baseline, changed) {
  const d = (a, b) => +(b - a).toFixed(1);
  return {
    overall: d(baseline.overall, changed.overall),
    verschieben: d(baseline.verschieben, changed.verschieben),
    nacht: d(baseline.nacht, changed.nacht),
    frueh: d(baseline.frueh, changed.frueh)
  };
}
var PREVIEW_MONTHS = 12;
var TRIAL_COUNT = 3;
function run(employees2, config2, year2, startMonth2) {
  const scores = [];
  const periodRange = { start: new Date(year2, startMonth2, 1), end: new Date(year2, startMonth2 + PREVIEW_MONTHS, 0) };
  for (let i = 0; i < TRIAL_COUNT; i++) {
    const { assignments } = generateAutomaticShiftPlan(employees2, year2, startMonth2, PREVIEW_MONTHS, config2);
    scores.push(computeFairnessScores(employees2, assignments, periodRange));
  }
  const avg = (key) => +(scores.reduce((s, sc) => s + sc[key], 0) / TRIAL_COUNT).toFixed(1);
  return {
    overall: avg("overall"),
    verschieben: avg("verschieben"),
    nacht: avg("nacht"),
    frueh: avg("frueh")
  };
}
function computeImpactFactors(employees2, config2, year2, startMonth2) {
  const baseline = run(employees2, config2, year2, startMonth2);
  const rules = {};
  for (const key of Object.keys(config2.rules)) {
    const cfg = { ...config2, rules: { ...config2.rules, [key]: !config2.rules[key] } };
    rules[key] = delta(baseline, run(employees2, cfg, year2, startMonth2));
  }
  const countImpact = (patchPlus, patchMinus) => {
    const cfgP = { ...config2, shiftCounts: { ...config2.shiftCounts, ...patchPlus } };
    const cfgM = { ...config2, shiftCounts: { ...config2.shiftCounts, ...patchMinus } };
    return {
      plus: delta(baseline, run(employees2, cfgP, year2, startMonth2)),
      minus: delta(baseline, run(employees2, cfgM, year2, startMonth2))
    };
  };
  const counts = {
    verschieben: countImpact(
      { verschieben: Math.min(20, config2.shiftCounts.verschieben + 1) },
      { verschieben: Math.max(1, config2.shiftCounts.verschieben - 1) }
    ),
    nachtbereitschaft: countImpact(
      { nachtbereitschaft: Math.min(20, config2.shiftCounts.nachtbereitschaft + 1) },
      { nachtbereitschaft: Math.max(1, config2.shiftCounts.nachtbereitschaft - 1) }
    ),
    fruehschicht: countImpact(
      { fruehschicht: Math.min(20, config2.shiftCounts.fruehschicht + 1) },
      { fruehschicht: Math.max(1, config2.shiftCounts.fruehschicht - 1) }
    ),
    over55VerschiebenSlots: (() => {
      const cfgP = { ...config2, over55VerschiebenSlots: Math.min(config2.shiftCounts.verschieben, config2.over55VerschiebenSlots + 1) };
      const cfgM = { ...config2, over55VerschiebenSlots: Math.max(0, config2.over55VerschiebenSlots - 1) };
      return {
        plus: delta(baseline, run(employees2, cfgP, year2, startMonth2)),
        minus: delta(baseline, run(employees2, cfgM, year2, startMonth2))
      };
    })()
  };
  return { baseline, rules, counts };
}

// server/fairnessWorker.ts
if (!parentPort) throw new Error("Must run as a worker thread");
var { employees, config, year, startMonth } = workerData;
try {
  const result = computeImpactFactors(employees, config, year, startMonth);
  parentPort.postMessage({ result });
} catch (err) {
  parentPort.postMessage({ error: String(err) });
}
