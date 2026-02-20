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
 * - Converges early when no improvement found for a configurable plateau.
 * - Emits progress callbacks so the UI can show a progress bar.
 */

import {
  Employee,
  ShiftAssignment,
  SchedulerConfig,
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
  converged: boolean;
  done: boolean;
}

export interface OptimiserResult {
  assignments: ShiftAssignment[];
  scores: FairnessScores;
  iterations: number;
  converged: boolean;
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
  onProgress?: (p: OptimiserProgress) => void
): OptimiserResult {
  const { maxIterations, targets } = optimiserConfig;

  // ── Step 1: baseline with original order ──────────────────────────────
  const { assignments: baseline } = generateAutomaticShiftPlan(
    employees, year, startMonth, months, schedulerConfig
  );
  let bestAssignments = baseline;
  let bestScores = computeFairnessScores(employees, baseline);
  let bestComposite = compositeScore(bestScores, targets);

  // Convergence: abort after this many iterations w/o improvement
  const PLATEAU_LIMIT = Math.max(500, Math.floor(maxIterations * 0.15));
  let plateauCount = 0;

  const progressInterval = Math.max(1, Math.floor(maxIterations / 200));

  for (let iter = 0; iter < maxIterations; iter++) {
    // ── emit progress at intervals ───────────────────────────────────
    if (iter % progressInterval === 0 && onProgress) {
      onProgress({
        iteration: iter,
        maxIterations,
        bestScore: bestComposite,
        currentScores: { ...bestScores },
        converged: false,
        done: false,
      });
    }

    // ── generate a new random valid plan ─────────────────────────────
    const shuffled = shuffle([...employees]);
    const { assignments: candidate } = generateAutomaticShiftPlan(
      shuffled, year, startMonth, months, schedulerConfig
    );

    const candidateScores = computeFairnessScores(employees, candidate);
    const candidateComposite = compositeScore(candidateScores, targets);

    if (candidateComposite > bestComposite) {
      bestAssignments = candidate;
      bestScores = { ...candidateScores };
      bestComposite = candidateComposite;
      plateauCount = 0;
    } else {
      plateauCount++;
    }

    // ── convergence check ────────────────────────────────────────────
    if (plateauCount >= PLATEAU_LIMIT) {
      if (onProgress) {
        onProgress({
          iteration: iter,
          maxIterations,
          bestScore: bestComposite,
          currentScores: { ...bestScores },
          converged: true,
          done: true,
        });
      }
      return {
        assignments: bestAssignments,
        scores: bestScores,
        iterations: iter + 1,
        converged: true,
      };
    }
  }

  // Reached max iterations
  if (onProgress) {
    onProgress({
      iteration: maxIterations,
      maxIterations,
      bestScore: bestComposite,
      currentScores: { ...bestScores },
      converged: false,
      done: true,
    });
  }
  return {
    assignments: bestAssignments,
    scores: bestScores,
    iterations: maxIterations,
    converged: false,
  };
}
