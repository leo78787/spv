/**
 * Fairness Optimizer — Monte Carlo Random Plan Search
 *
 * Generates completely new random valid shift plans each iteration by
 * shuffling the employee pool before feeding it to the greedy scheduler.
 * Since the scheduler's tie-breaking and selection order depend on the
 * input order, each shuffle produces a genuinely different valid plan.
 *
 * Key properties:
 * - Every generated plan respects ALL hard rules (the greedy scheduler
 *   enforces them) — no separate legality checks needed.
 * - With infinite iterations, theoretically explores all possible valid plans.
 * - Keeps track of the best plan found so far.
 * - Always runs all user-specified iterations (no early convergence).
 * - Emits progress callbacks with elapsed / estimated time so the UI can
 *   show a progress bar and ETA.
 */

import {
  Employee,
  ShiftAssignment,
  ShiftType,
  SchedulerConfig,
  Department,
} from '../types';
import {
  generateAutomaticShiftPlan,
  getEmployeeActiveWeight,
  MIN_ACTIVE_WEIGHT,
} from './scheduler';
import { computeFairnessScores, FairnessScores } from './fairnessImpact';

// ── public types ────────────────────────────────────────────────────────────

export interface OptimiserTargets {
  overall: boolean;
  verschieben: boolean;
  nacht: boolean;
  frueh: boolean;
}

export interface OptimiserConfig {
  maxIterations: number;
  targets: OptimiserTargets;
}

export const DEFAULT_OPTIMISER_CONFIG: OptimiserConfig = {
  maxIterations: 5000,
  targets: { overall: true, verschieben: true, nacht: true, frueh: true },
};

export interface OptimiserProgress {
  iteration: number;
  maxIterations: number;
  bestScore: number;
  currentScores: FairnessScores;
  /** Milliseconds elapsed since optimisation start. */
  elapsedMs: number;
  /** Estimated total runtime in milliseconds (extrapolated from current pace). */
  estimatedTotalMs: number;
  done: boolean;
}

export interface OptimiserResult {
  assignments: ShiftAssignment[];
  scores: FairnessScores;
  iterations: number;
  violations?: any[];
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Fisher–Yates shuffle (in-place, returns same array). */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Composite score — weighted average of enabled dimensions (higher = better). */
function compositeScore(scores: FairnessScores, targets: OptimiserTargets): number {
  let sum = 0;
  let count = 0;
  if (targets.overall)     { sum += scores.overall;     count++; }
  if (targets.verschieben) { sum += scores.verschieben; count++; }
  if (targets.nacht)       { sum += scores.nacht;       count++; }
  if (targets.frueh)       { sum += scores.frueh;       count++; }
  return count === 0 ? 0 : sum / count;
}

// ── per-pool per-type range helpers ─────────────────────────────────────────

const SHIFT_TYPES: ShiftType[] = ['verschieben', 'nachtbereitschaft', 'fruehschicht'];

function groupKey(e: Employee): string {
  const allowed = [...(e.allowedShiftTypes ?? ['fruehschicht', 'verschieben', 'nachtbereitschaft'])].sort().join(',');
  return `${allowed}|${e.isOver55 ? '55+' : '<55'}`;
}

function buildPools(employees: Employee[]): { label: string; pool: Employee[] }[] {
  const poolMap = new Map<string, Employee[]>();
  for (const emp of employees) {
    const key = groupKey(emp);
    if (!poolMap.has(key)) poolMap.set(key, []);
    poolMap.get(key)!.push(emp);
  }
  return Array.from(poolMap.entries()).map(([key, pool]) => ({ label: key, pool }));
}

function perTypeRanges(pool: Employee[], assignments: ShiftAssignment[], periodRange?: { start: Date; end: Date }): Record<ShiftType, number> {
  const r = {} as Record<ShiftType, number>;
  // Only judge employees who were actually active (even partially) during
  // the period — an employee with zero active weight has no fair count to
  // compare and would otherwise show up as a spurious "0" pulling the range down.
  const judgeablePool = periodRange ? pool.filter(e => getEmployeeActiveWeight(e, periodRange.start, periodRange.end) > 0) : pool;
  for (const st of SHIFT_TYPES) {
    if (judgeablePool.length === 0) { r[st] = 0; continue; }
    const counts = judgeablePool.map(e => {
      const raw = assignments.filter(a => a.shiftType === st && a.employees.includes(e.id)).length;
      if (!periodRange) return raw;
      const weight = Math.max(MIN_ACTIVE_WEIGHT, getEmployeeActiveWeight(e, periodRange.start, periodRange.end));
      return raw / weight;
    });
    r[st] = Math.max(...counts) - Math.min(...counts);
  }
  return r;
}

/** Returns true if any pool's per-type range in `candidate` is worse than in `baseline`. */
function worsensRanges(
  pools: { label: string; pool: Employee[] }[],
  baselineRangesPerPool: Map<string, Record<ShiftType, number>>,
  candidate: ShiftAssignment[],
  periodRange?: { start: Date; end: Date },
): boolean {
  for (const { label, pool } of pools) {
    const baseR = baselineRangesPerPool.get(label)!;
    const newR = perTypeRanges(pool, candidate, periodRange);
    if (SHIFT_TYPES.some(t => newR[t] > baseR[t] + 1e-9)) return true;
  }
  return false;
}

// ── main optimiser ──────────────────────────────────────────────────────────

/**
 * Run the fairness optimiser.
 *
 * Strategy: Monte Carlo random plan search.
 * Each iteration shuffles the employee list and generates a complete new
 * valid plan via the greedy scheduler.  The greedy scheduler's selection
 * depends on input order (for tie-breaking, diversity picks, etc.), so
 * each shuffle yields a genuinely different valid schedule.
 *
 * With enough iterations, this systematically explores the space of all
 * valid plans and keeps the one with the best fairness scores.
 */
export function runOptimiser(
  employees: Employee[],
  year: number,
  startMonth: number,
  months: number,
  schedulerConfig: SchedulerConfig,
  optimiserConfig: OptimiserConfig = DEFAULT_OPTIMISER_CONFIG,
  onProgress?: (p: OptimiserProgress) => void,
  departments?: Department[]
): OptimiserResult {
  const { maxIterations, targets } = optimiserConfig;
  const periodRange = { start: new Date(year, startMonth, 1), end: new Date(year, startMonth + months, 0) };

  // ── Build per-pool baseline ranges (must never be worsened) ───────────
  const pools = buildPools(employees);
  const baselineRangesPerPool = new Map<string, Record<ShiftType, number>>();

  // ── Step 1: baseline with original order ──────────────────────────────
  const { assignments: baseline } = generateAutomaticShiftPlan(
    employees, year, startMonth, months, schedulerConfig, departments
  );

  // Record baseline per-type ranges per pool
  for (const { label, pool } of pools) {
    baselineRangesPerPool.set(label, perTypeRanges(pool, baseline, periodRange));
  }

  let bestAssignments = baseline;
  let bestScores = computeFairnessScores(employees, baseline, periodRange);
  let bestComposite = compositeScore(bestScores, targets);

  const progressInterval = Math.max(1, Math.floor(maxIterations / 200));
  const t0 = Date.now();

  for (let iter = 0; iter < maxIterations; iter++) {
    // ── emit progress at intervals ───────────────────────────────────
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
        done: false,
      });
    }

    // ── generate a new random valid plan ─────────────────────────────
    const shuffled = shuffle([...employees]);
    const { assignments: candidate } = generateAutomaticShiftPlan(
      shuffled, year, startMonth, months, schedulerConfig, departments
    );

    // Skip candidate if it worsens per-pool per-type ranges
    if (worsensRanges(pools, baselineRangesPerPool, candidate, periodRange)) continue;

    const candidateScores = computeFairnessScores(employees, candidate, periodRange);
    const candidateComposite = compositeScore(candidateScores, targets);

    if (candidateComposite > bestComposite) {
      bestAssignments = candidate;
      bestScores = { ...candidateScores };
      bestComposite = candidateComposite;
    }
  }

  // All iterations completed
  const totalElapsed = Date.now() - t0;
  if (onProgress) {
    onProgress({
      iteration: maxIterations,
      maxIterations,
      bestScore: bestComposite,
      currentScores: { ...bestScores },
      elapsedMs: totalElapsed,
      estimatedTotalMs: totalElapsed,
      done: true,
    });
  }
  return {
    assignments: bestAssignments,
    scores: bestScores,
    iterations: maxIterations,
  };
}
