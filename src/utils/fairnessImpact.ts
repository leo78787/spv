/**
 * Fairness Impact Factors
 *
 * For each rule toggle and shift-count input, compute how the three fairness
 * scores (overall, nacht, früh/WE) change when that setting is modified.
 *
 * Uses a short (2-month) preview horizon so computation stays fast.
 */

import { Employee, ShiftAssignment, ShiftType } from '../types';
import { SchedulerConfig, generateAutomaticShiftPlan, getEmployeeActiveWeight, MIN_ACTIVE_WEIGHT } from './scheduler';

// ─── fairness score helpers ───────────────────────────────────────────────────

/** Coefficient-of-variation based fairness: 100 = perfectly equal, 0 = totally unequal */
function cvFairness(counts: number[]): number {
  if (counts.length === 0) return 100;
  const avg = counts.reduce((s, c) => s + c, 0) / counts.length;
  if (avg === 0) return 100;
  const variance = counts.reduce((s, c) => s + (c - avg) ** 2, 0) / counts.length;
  const stdDev = Math.sqrt(variance);
  return Math.max(0, 100 - (stdDev / avg) * 100);
}

export interface FairnessScores {
  overall: number;
  verschieben: number;
  nacht: number;
  frueh: number;
}

/**
 * Computes fairness scores from a set of assignments.
 * Uses allowedShiftTypes to determine eligibility per shift type.
 *
 * When `periodRange` is given, each employee's shift counts are normalized by
 * their active-tenure weight within that range (see getEmployeeActiveWeight),
 * so partial-tenure employees are judged against their proportional fair
 * share rather than the same absolute count as full-period employees.
 * Employees with zero active weight in the range (not employed at all during
 * it) are excluded entirely, since they can't be fairly judged.
 */
export function computeFairnessScores(
  employees: Employee[],
  assignments: ShiftAssignment[],
  periodRange?: { start: Date; end: Date }
): FairnessScores {
  const weightOf = (e: Employee) => periodRange ? getEmployeeActiveWeight(e, periodRange.start, periodRange.end) : 1;
  const judgeable = employees
    .filter(e => !e.excludeFromPlanning)
    .filter(e => !periodRange || weightOf(e) > 0);

  const allIds = judgeable.map(e => e.id);
  const nachtFruehIds = judgeable
    .filter(e => {
      const allowed = e.allowedShiftTypes ?? ['fruehschicht', 'verschieben', 'nachtbereitschaft'];
      return allowed.includes('nachtbereitschaft') || allowed.includes('fruehschicht');
    })
    .map(e => e.id);

  const empById = new Map(judgeable.map(e => [e.id, e]));
  const countFor = (ids: string[], type: ShiftType | null) =>
    ids.map(id => {
      const raw = assignments.filter(a => a.employees.includes(id) && (type ? a.shiftType === type : true)).length;
      if (!periodRange) return raw;
      const emp = empById.get(id)!;
      const weight = Math.max(MIN_ACTIVE_WEIGHT, weightOf(emp));
      return raw / weight;
    });

  return {
    overall:     cvFairness(countFor(allIds, null)),
    verschieben: cvFairness(countFor(allIds, 'verschieben')),
    nacht:       cvFairness(countFor(nachtFruehIds, 'nachtbereitschaft')),
    frueh:       cvFairness(countFor(nachtFruehIds, 'fruehschicht')),
  };
}


// ─── delta ────────────────────────────────────────────────────────────────────

export interface ImpactDelta {
  overall:     number;
  verschieben: number;
  nacht:       number;
  frueh:       number;
}

/** For count inputs: impact when count goes up (+1) or down (-1) */
export interface CountImpact {
  plus:  ImpactDelta;
  minus: ImpactDelta;
}

function delta(baseline: FairnessScores, changed: FairnessScores): ImpactDelta {
  const d = (a: number, b: number) => +((b - a).toFixed(1));
  return {
    overall:     d(baseline.overall,     changed.overall),
    verschieben: d(baseline.verschieben, changed.verschieben),
    nacht:       d(baseline.nacht,       changed.nacht),
    frueh:       d(baseline.frueh,       changed.frueh),
  };
}

// ─── main export ──────────────────────────────────────────────────────────────

export interface ImpactFactors {
  baseline: FairnessScores;
  /** Delta per rule when that rule is toggled from its current state — keyed by SchedulerRules key for system rules, or CustomRule.id for custom rules. */
  rules: Record<string, ImpactDelta>;
  /** Delta per count input for +1 and -1 change */
  counts: {
    verschieben:       CountImpact;
    nachtbereitschaft: CountImpact;
    fruehschicht:      CountImpact;
    over55VerschiebenSlots: CountImpact;
  };
}

/**
 * How many months to simulate per trial.
 * Longer = more assignments = less relative noise.
 */
const PREVIEW_MONTHS = 12;

/**
 * How many independent trials to average per config point.
 * The scheduler is stochastic (uses Math.random), so a single run
 * can differ from another run with the same config just by chance.
 * Averaging multiple trials cancels that noise out.
 */
const TRIAL_COUNT = 3;

/** Average multiple random runs to get a stable score estimate. */
function run(employees: Employee[], config: SchedulerConfig, year: number, startMonth: number): FairnessScores {
  const scores: FairnessScores[] = [];
  const periodRange = { start: new Date(year, startMonth, 1), end: new Date(year, startMonth + PREVIEW_MONTHS, 0) };
  for (let i = 0; i < TRIAL_COUNT; i++) {
    const { assignments } = generateAutomaticShiftPlan(employees, year, startMonth, PREVIEW_MONTHS, config);
    scores.push(computeFairnessScores(employees, assignments, periodRange));
  }
  const avg = (key: keyof FairnessScores) =>
    +( scores.reduce((s, sc) => s + sc[key], 0) / TRIAL_COUNT ).toFixed(1);
  return {
    overall:     avg('overall'),
    verschieben: avg('verschieben'),
    nacht:       avg('nacht'),
    frueh:       avg('frueh'),
  };
}

/**
 * Compute impact factors for every rule and count input.
 * Call from a web worker or in a setTimeout to avoid blocking the UI.
 */
export function computeImpactFactors(
  employees: Employee[],
  config: SchedulerConfig,
  year: number,
  startMonth: number
): ImpactFactors {
  const baseline = run(employees, config, year, startMonth);

  // ── rules ──
  const rules: ImpactFactors['rules'] = {};
  for (const key of Object.keys(config.rules) as Array<keyof SchedulerConfig['rules']>) {
    const cfg: SchedulerConfig = { ...config, rules: { ...config.rules, [key]: !config.rules[key] } };
    rules[key] = delta(baseline, run(employees, cfg, year, startMonth));
  }
  for (const customRule of config.customRules || []) {
    const cfg: SchedulerConfig = {
      ...config,
      customRules: config.customRules.map(r => r.id === customRule.id ? { ...r, enabled: !r.enabled } : r),
    };
    rules[customRule.id] = delta(baseline, run(employees, cfg, year, startMonth));
  }

  // ── shift counts (+1 / -1) ──
  const countImpact = (
    patchPlus:  Partial<SchedulerConfig['shiftCounts']>,
    patchMinus: Partial<SchedulerConfig['shiftCounts']>
  ): CountImpact => {
    const cfgP: SchedulerConfig = { ...config, shiftCounts: { ...config.shiftCounts, ...patchPlus } };
    const cfgM: SchedulerConfig = { ...config, shiftCounts: { ...config.shiftCounts, ...patchMinus } };
    return {
      plus:  delta(baseline, run(employees, cfgP, year, startMonth)),
      minus: delta(baseline, run(employees, cfgM, year, startMonth)),
    };
  };

  const counts: ImpactFactors['counts'] = {
    verschieben: countImpact(
      { verschieben: Math.min(20, config.shiftCounts.verschieben + 1) },
      { verschieben: Math.max(1,  config.shiftCounts.verschieben - 1) }
    ),
    nachtbereitschaft: countImpact(
      { nachtbereitschaft: Math.min(20, config.shiftCounts.nachtbereitschaft + 1) },
      { nachtbereitschaft: Math.max(1,  config.shiftCounts.nachtbereitschaft - 1) }
    ),
    fruehschicht: countImpact(
      { fruehschicht: Math.min(20, config.shiftCounts.fruehschicht + 1) },
      { fruehschicht: Math.max(1,  config.shiftCounts.fruehschicht - 1) }
    ),
    over55VerschiebenSlots: (() => {
      const cfgP: SchedulerConfig = { ...config, over55VerschiebenSlots: Math.min(config.shiftCounts.verschieben, config.over55VerschiebenSlots + 1) };
      const cfgM: SchedulerConfig = { ...config, over55VerschiebenSlots: Math.max(0, config.over55VerschiebenSlots - 1) };
      return {
        plus:  delta(baseline, run(employees, cfgP, year, startMonth)),
        minus: delta(baseline, run(employees, cfgM, year, startMonth)),
      };
    })(),
  };

  return { baseline, rules, counts };
}
