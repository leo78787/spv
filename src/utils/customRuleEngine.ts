/**
 * Generic interpreter for planning rules (see ConditionNode/CustomRule in
 * types.ts) — both the 8 pre-built default rules (BUILTIN_RULES) and any
 * user-added ones. This is the scheduler's sole rule-enforcement mechanism
 * for these behaviors (see scheduler.ts's getAvailableEmployeesSorted),
 * evaluated against exactly the context already available at that call site.
 */

import { startOfDay, addDays } from 'date-fns';
import { ConditionNode, CustomRule, Employee, SchedulerConfig, ShiftAssignment, ShiftType, SHIFT_LABELS } from '../types';

export interface RuleEvalContext {
  employee: Employee;
  /** Start of the shift currently being considered for assignment. */
  startDate: Date;
  /** End of the shift currently being considered for assignment. */
  endDate: Date;
  /** All assignments already committed so far (same list the caller already has). */
  assignments: ShiftAssignment[];
}

function dayDiff(a: Date, b: Date): number {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / (1000 * 60 * 60 * 24));
}

function inRange(gap: number, minDays: number, maxDays: number): boolean {
  return gap >= minDays && gap <= maxDays;
}

/** Gap (in days) checks generalizing the "assignment adjacency" pattern used by most built-in rules. */
function matchesGapDirection(
  direction: 'before' | 'after' | 'either',
  minDays: number,
  maxDays: number,
  otherStart: Date,
  otherEnd: Date,
  shiftStart: Date,
  shiftEnd: Date,
): boolean {
  // "before": the other event ends before the shift being considered starts.
  const gapBefore = dayDiff(shiftStart, otherEnd);
  // "after": the other event starts after the shift being considered ends.
  const gapAfter = dayDiff(otherStart, shiftEnd);
  if (direction === 'before') return inRange(gapBefore, minDays, maxDays);
  if (direction === 'after') return inRange(gapAfter, minDays, maxDays);
  return inRange(gapBefore, minDays, maxDays) || inRange(gapAfter, minDays, maxDays);
}

interface DateRange { start: Date; end: Date }

function vacationRangesOf(employee: Employee): DateRange[] {
  const singleDay = (employee.vacationDays || []).map(d => ({ start: new Date(d), end: new Date(d) }));
  const multiDay = (employee.vacationRanges || []).map(r => ({ start: new Date(r.startDate), end: new Date(r.endDate) }));
  return [...singleDay, ...multiDay];
}

/** Whether a vacation range overlaps [windowStart, windowEnd] at all (inclusive, day-granularity). */
function rangesOverlap(a: DateRange, windowStart: Date, windowEnd: Date): boolean {
  return startOfDay(a.start).getTime() <= startOfDay(windowEnd).getTime() &&
    startOfDay(a.end).getTime() >= startOfDay(windowStart).getTime();
}

/** True if the employee has vacation overlapping the window [minDays, maxDays] before/after/either side of [shiftStart, shiftEnd]. */
function nearVacationMatch(
  employee: Employee,
  direction: 'before' | 'after' | 'either',
  minDays: number,
  maxDays: number,
  shiftStart: Date,
  shiftEnd: Date,
): boolean {
  const ranges = vacationRangesOf(employee);
  if (ranges.length === 0) return false;
  const beforeWindow: DateRange = { start: addDays(shiftStart, -maxDays), end: addDays(shiftStart, -minDays) };
  const afterWindow: DateRange = { start: addDays(shiftEnd, minDays), end: addDays(shiftEnd, maxDays) };
  return ranges.some(r => {
    if (direction === 'before') return rangesOverlap(r, beforeWindow.start, beforeWindow.end);
    if (direction === 'after') return rangesOverlap(r, afterWindow.start, afterWindow.end);
    return rangesOverlap(r, beforeWindow.start, beforeWindow.end) || rangesOverlap(r, afterWindow.start, afterWindow.end);
  });
}

export function evaluateConditionNode(node: ConditionNode, ctx: RuleEvalContext): boolean {
  switch (node.type) {
    case 'and':
      return node.children.every(c => evaluateConditionNode(c, ctx));
    case 'or':
      return node.children.some(c => evaluateConditionNode(c, ctx));
    case 'not':
      return !evaluateConditionNode(node.child, ctx);
    case 'isWeekend': {
      const day = ctx.startDate.getDay();
      return day === 0 || day === 6;
    }
    case 'employeeAttribute':
      if (node.attribute === 'isOver55') return !!ctx.employee.isOver55 === node.equals;
      return ctx.employee.department === node.equals;
    case 'assignmentGap':
      return ctx.assignments.some(a => {
        if (a.shiftType !== node.shiftType || !a.employees.includes(ctx.employee.id)) return false;
        return matchesGapDirection(
          node.direction, node.minDays, node.maxDays,
          new Date(a.startDate), new Date(a.endDate),
          ctx.startDate, ctx.endDate,
        );
      });
    case 'nearVacation':
      return nearVacationMatch(ctx.employee, node.direction, node.minDays, node.maxDays, ctx.startDate, ctx.endDate);
    case 'weekendNearVacation': {
      // Per-day check (not just shift start/end) — mirrors the classic
      // "no weekend work around vacation" rule, which must catch e.g. a
      // 7-day Nachtbereitschaft week whose Saturday/Sunday fall near vacation
      // even though the week's own start/end aren't the weekend days.
      for (let d = new Date(ctx.startDate); d <= ctx.endDate; d = addDays(d, 1)) {
        const day = d.getDay();
        if (day !== 0 && day !== 6) continue;
        if (nearVacationMatch(ctx.employee, 'either', node.minDays, node.maxDays, d, d)) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/** Which enabled rules (targeting this shift type) currently block this candidate — for UI "why is this blocked" explanations. Self-direction only (matches what's already committed), not the reciprocal check — good enough for display purposes. */
export function blockingCustomRules(config: SchedulerConfig, shiftType: ShiftType, ctx: RuleEvalContext): CustomRule[] {
  return (config.customRules || []).filter(rule =>
    rule.enabled && rule.targetShiftTypes.includes(shiftType) && evaluateConditionNode(rule.condition, ctx)
  );
}

const DIRECTION_LABELS: Record<'before' | 'after' | 'either', string> = {
  before: 'davor',
  after: 'danach',
  either: 'davor oder danach',
};

/** Human-readable (German) summary of a condition tree — used for node labels and violation reporting. */
export function describeConditionNode(node: ConditionNode): string {
  switch (node.type) {
    case 'and':
      return node.children.map(describeConditionNode).join(' UND ');
    case 'or':
      return node.children.map(describeConditionNode).join(' ODER ');
    case 'not':
      return `NICHT (${describeConditionNode(node.child)})`;
    case 'isWeekend':
      return 'liegt am Wochenende';
    case 'weekendNearVacation':
      return `liegt am Wochenende, ${node.minDays}–${node.maxDays} Tage vor/nach Urlaub`;
    case 'employeeAttribute':
      if (node.attribute === 'isOver55') return node.equals ? 'Mitarbeiter ist Ü55' : 'Mitarbeiter ist nicht Ü55';
      return `Abteilung ist "${node.equals}"`;
    case 'assignmentGap':
      return `${SHIFT_LABELS[node.shiftType]} innerhalb von ${node.minDays}–${node.maxDays} Tagen ${DIRECTION_LABELS[node.direction]}`;
    case 'nearVacation':
      return `Urlaub innerhalb von ${node.minDays}–${node.maxDays} Tagen ${DIRECTION_LABELS[node.direction]}`;
    default:
      return '';
  }
}
