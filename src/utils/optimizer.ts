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
  SchedulerConfig,
  Department,
} from '../types';
import {
  generateAutomaticShiftPlan,
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

  // ── Step 1: baseline with original order ──────────────────────────────
  const { assignments: baseline } = generateAutomaticShiftPlan(
    employees, year, startMonth, months, schedulerConfig, departments
  );
  let bestAssignments = baseline;
  let bestScores = computeFairnessScores(employees, baseline);
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

    const candidateScores = computeFairnessScores(employees, candidate);
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
