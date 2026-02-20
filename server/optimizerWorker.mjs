// server/optimizerWorker.ts
import { parentPort, workerData } from "node:worker_threads";

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
    over55AndNoL2OnlyVerschieben: true,
    reserveOver55SlotsForVerschieben: true,
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
    const afterEndSun = addDays(end, 1);
    return isSameDay(date, end) || isSameDay(date, afterEndSun);
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
function getAvailableEmployeesSorted(employees2, shiftType, startDate, endDate, existingAssignments, config = DEFAULT_SCHEDULER_CONFIG) {
  const { rules } = config;
  const available = employees2.filter((emp) => {
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
    if (rules.over55AndNoL2OnlyVerschieben) {
      if ((emp.isOver55 || !emp.hasL2) && shiftType !== "verschieben") return false;
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
    return true;
  });
  return available.sort((a, b) => {
    const aCount = countShiftTypeForEmployee(a.id, shiftType, existingAssignments);
    const bCount = countShiftTypeForEmployee(b.id, shiftType, existingAssignments);
    return aCount - bCount;
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
function selectVerschiebenEmployees(availableEmployees, requiredCount, requiredOver55Count, useDiversity = true) {
  const over55Pool = availableEmployees.filter((e) => e.isOver55);
  const othersPool = availableEmployees.filter((e) => !e.isOver55);
  const selectedOver55 = [];
  const usedDepartments = /* @__PURE__ */ new Set();
  if (useDiversity) {
    for (const emp of over55Pool) {
      if (selectedOver55.length >= requiredOver55Count) break;
      if (!usedDepartments.has(emp.department)) {
        selectedOver55.push(emp);
        usedDepartments.add(emp.department);
      }
    }
    for (const emp of over55Pool) {
      if (selectedOver55.length >= requiredOver55Count) break;
      if (!selectedOver55.includes(emp)) selectedOver55.push(emp);
    }
  } else {
    selectedOver55.push(...over55Pool.slice(0, requiredOver55Count));
  }
  const remainingCount = requiredCount - selectedOver55.length;
  const selectedOthers = [];
  if (useDiversity) {
    for (const emp of othersPool) {
      if (selectedOthers.length >= remainingCount) break;
      if (!usedDepartments.has(emp.department)) {
        selectedOthers.push(emp);
        usedDepartments.add(emp.department);
      }
    }
    for (const emp of othersPool) {
      if (selectedOthers.length >= remainingCount) break;
      if (!selectedOthers.includes(emp)) selectedOthers.push(emp);
    }
  } else {
    selectedOthers.push(...othersPool.slice(0, remainingCount));
  }
  return [...selectedOver55, ...selectedOthers];
}
function generateShiftPeriodsForRange(startDate, months2) {
  const periods = /* @__PURE__ */ new Map();
  const rangeStart = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const rangeEnd = addDays(new Date(rangeStart.getFullYear(), rangeStart.getMonth() + months2, 1), -1);
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
function generateAutomaticShiftPlan(employees2, startYear, startMonth2 = 0, months2 = 12, config = DEFAULT_SCHEDULER_CONFIG) {
  const assignments = [];
  const violations = [];
  const startDate = new Date(startYear, startMonth2, 1);
  const periods = generateShiftPeriodsForRange(startDate, months2);
  const { shiftCounts, over55VerschiebenSlots, rules } = config;
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
    over55AndNoL2OnlyVerschieben: "\xDC55 / kein L2 nur versetzt",
    noWeekendAroundVacation: "Kein WE um Urlaub",
    noFruehschichtAdjacentToVerschieben: "Keine Fr\xFChschicht angrenzend an Versetzt",
    respectAvoidancePreferences: "Vermeidungspr\xE4ferenzen",
    departmentDiversity: "Abteilungsvielfalt",
    reserveOver55SlotsForVerschieben: "\xDC55-Slot-Reservierung"
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
      config
    );
    const useDiversity = rules.departmentDiversity;
    const selected = shiftType === "verschieben" && rules.reserveOver55SlotsForVerschieben ? selectVerschiebenEmployees(available, requiredCount, over55VerschiebenSlots, useDiversity) : selectEmployeesWithDepartmentDiversity(available, requiredCount, useDiversity);
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
      const allCandidates = employees2.filter((emp) => {
        const days = [];
        for (let d = new Date(period.startDate); d <= period.endDate; d = addDays(d, 1)) days.push(new Date(d));
        if (!days.every((day) => canWorkOnDate(emp, day, false))) return false;
        const hasConflictingShift = assignments.some((a) => {
          if (!a.employees.includes(emp.id)) return false;
          const aS = new Date(a.startDate), aE = new Date(a.endDate);
          return days.some((day) => day >= aS && day <= aE);
        });
        return !hasConflictingShift;
      });
      const shortage = requiredCount - selected.length;
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
function computeFairnessScores(employees2, assignments) {
  const allIds = employees2.map((e) => e.id);
  const nachtFruehIds = employees2.filter((e) => !e.isOver55 && e.hasL2).map((e) => e.id);
  const countFor = (ids, type) => ids.map(
    (id) => assignments.filter((a) => a.employees.includes(id) && (type ? a.shiftType === type : true)).length
  );
  return {
    overall: cvFairness(countFor(allIds, null)),
    verschieben: cvFairness(countFor(allIds, "verschieben")),
    nacht: cvFairness(countFor(nachtFruehIds, "nachtbereitschaft")),
    frueh: cvFairness(countFor(nachtFruehIds, "fruehschicht"))
  };
}

// src/utils/optimizer.ts
var DEFAULT_OPTIMISER_CONFIG = {
  maxIterations: 5e3,
  targets: { overall: true, verschieben: true, nacht: true, frueh: true }
};
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function compositeScore(scores, targets) {
  let sum = 0;
  let count = 0;
  if (targets.overall) {
    sum += scores.overall;
    count++;
  }
  if (targets.verschieben) {
    sum += scores.verschieben;
    count++;
  }
  if (targets.nacht) {
    sum += scores.nacht;
    count++;
  }
  if (targets.frueh) {
    sum += scores.frueh;
    count++;
  }
  return count === 0 ? 0 : sum / count;
}
function runOptimiser(employees2, year2, startMonth2, months2, schedulerConfig2, optimiserConfig2 = DEFAULT_OPTIMISER_CONFIG, onProgress) {
  const { maxIterations, targets } = optimiserConfig2;
  const { assignments: baseline } = generateAutomaticShiftPlan(
    employees2,
    year2,
    startMonth2,
    months2,
    schedulerConfig2
  );
  let bestAssignments = baseline;
  let bestScores = computeFairnessScores(employees2, baseline);
  let bestComposite = compositeScore(bestScores, targets);
  const progressInterval = Math.max(1, Math.floor(maxIterations / 200));
  const t0 = Date.now();
  for (let iter = 0; iter < maxIterations; iter++) {
    if (iter % progressInterval === 0 && onProgress) {
      const elapsedMs = Date.now() - t0;
      const frac = iter / maxIterations;
      const estimatedTotalMs = frac > 0 ? elapsedMs / frac : 0;
      onProgress({
        iteration: iter,
        maxIterations,
        bestScore: bestComposite,
        currentScores: { ...bestScores },
        elapsedMs,
        estimatedTotalMs,
        done: false
      });
    }
    const shuffled = shuffle([...employees2]);
    const { assignments: candidate } = generateAutomaticShiftPlan(
      shuffled,
      year2,
      startMonth2,
      months2,
      schedulerConfig2
    );
    const candidateScores = computeFairnessScores(employees2, candidate);
    const candidateComposite = compositeScore(candidateScores, targets);
    if (candidateComposite > bestComposite) {
      bestAssignments = candidate;
      bestScores = { ...candidateScores };
      bestComposite = candidateComposite;
    }
  }
  const totalElapsed = Date.now() - t0;
  if (onProgress) {
    onProgress({
      iteration: maxIterations,
      maxIterations,
      bestScore: bestComposite,
      currentScores: { ...bestScores },
      elapsedMs: totalElapsed,
      estimatedTotalMs: totalElapsed,
      done: true
    });
  }
  return {
    assignments: bestAssignments,
    scores: bestScores,
    iterations: maxIterations
  };
}

// server/optimizerWorker.ts
function reviveDates(obj) {
  if (typeof obj === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(obj)) {
    return new Date(obj);
  }
  if (Array.isArray(obj)) return obj.map(reviveDates);
  if (obj && typeof obj === "object") {
    const result2 = {};
    for (const key of Object.keys(obj)) {
      result2[key] = reviveDates(obj[key]);
    }
    return result2;
  }
  return obj;
}
var data = reviveDates(workerData);
var { employees, schedulerConfig, optimiserConfig, year, startMonth, months } = data;
var result = runOptimiser(
  employees,
  year,
  startMonth,
  months,
  schedulerConfig,
  optimiserConfig,
  (progress) => {
    parentPort?.postMessage({ type: "progress", progress });
  }
);
parentPort?.postMessage({ type: "result", result });
