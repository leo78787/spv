/**
 * Compute Web Worker — runs all heavy scheduler/optimizer computation
 * off the main thread so the UI never freezes.
 *
 * Handles:
 *  - generate          → generateAutomaticShiftPlan
 *  - equality          → runEqualityOptimiser
 *  - totalBalance      → runTotalBalanceOptimiser
 *  - computeImpact     → computeImpactFactors
 *  - calibrate         → 3 trial runs to measure ms/iteration
 *  - optimise          → Monte-Carlo fairness optimiser (chunked, cancellable)
 *  - cancelOptimise    → abort running optimisation
 */

import {
  generateAutomaticShiftPlan,
  runEqualityOptimiser,
  runTotalBalanceOptimiser,
} from '../utils/scheduler';
import {
  computeImpactFactors,
  computeFairnessScores,
} from '../utils/fairnessImpact';
import type { FairnessScores } from '../utils/fairnessImpact';
import type { Employee, ShiftAssignment, ShiftType } from '../types';
import type { OptimiserTargets, OptimiserProgress, OptimiserResult } from '../utils/optimizer';

// ── cancel flag for optimisation ────────────────────────────────────────────
let cancelOptimise = false;

// ── message handler ─────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    // ── Plan generation ──────────────────────────────────────────────────
    case 'generate': {
      try {
        const result = generateAutomaticShiftPlan(
          msg.employees, msg.year, msg.startMonth, msg.months,
          msg.config, msg.departments,
        );
        self.postMessage({ type: 'generate', id: msg.id, result });
      } catch (err: any) {
        self.postMessage({ type: 'generate', id: msg.id, error: String(err) });
      }
      break;
    }

    // ── Equality optimiser ───────────────────────────────────────────────
    case 'equality': {
      try {
        const result = runEqualityOptimiser(
          msg.employees, msg.assignments, msg.config, msg.maxIter,
        );
        self.postMessage({ type: 'equality', id: msg.id, result });
      } catch (err: any) {
        self.postMessage({ type: 'equality', id: msg.id, error: String(err) });
      }
      break;
    }

    // ── Total-balance optimiser ──────────────────────────────────────────
    case 'totalBalance': {
      try {
        const result = runTotalBalanceOptimiser(
          msg.employees, msg.assignments, msg.config, msg.maxIter,
        );
        self.postMessage({ type: 'totalBalance', id: msg.id, result });
      } catch (err: any) {
        self.postMessage({ type: 'totalBalance', id: msg.id, error: String(err) });
      }
      break;
    }

    // ── Fairness impact factors ──────────────────────────────────────────
    case 'computeImpact': {
      try {
        const result = computeImpactFactors(
          msg.employees, msg.config, msg.year, msg.startMonth,
        );
        self.postMessage({
          type: 'computeImpact', id: msg.id,
          result, snapshot: msg.snapshot,
        });
      } catch (err: any) {
        self.postMessage({
          type: 'computeImpact', id: msg.id,
          error: String(err), snapshot: msg.snapshot,
        });
      }
      break;
    }

    // ── Calibration (measure ms per iteration) ───────────────────────────
    case 'calibrate': {
      try {
        const CALIBRATION_ITERS = 3;
        const t0 = performance.now();
        for (let i = 0; i < CALIBRATION_ITERS; i++) {
          generateAutomaticShiftPlan(
            msg.employees, msg.year, msg.startMonth, 12,
            msg.config, msg.departments,
          );
        }
        const elapsed = performance.now() - t0;
        self.postMessage({
          type: 'calibrate', id: msg.id,
          msPerIteration: elapsed / CALIBRATION_ITERS,
        });
      } catch (err: any) {
        self.postMessage({ type: 'calibrate', id: msg.id, error: String(err) });
      }
      break;
    }

    // ── Monte-Carlo optimisation (chunked, cancellable) ──────────────────
    case 'optimise': {
      cancelOptimise = false;
      runOptimiseChunked(msg);
      break;
    }

    case 'cancelOptimise': {
      cancelOptimise = true;
      break;
    }
  }
};

// ── Optimiser helpers (duplicated here to avoid import issues) ───────────

const SHIFT_TYPES: ShiftType[] = ['verschieben', 'nachtbereitschaft', 'fruehschicht'];

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function compositeScore(scores: FairnessScores, t: OptimiserTargets): number {
  let sum = 0, count = 0;
  if (t.overall)     { sum += scores.overall;     count++; }
  if (t.verschieben) { sum += scores.verschieben; count++; }
  if (t.nacht)       { sum += scores.nacht;       count++; }
  if (t.frueh)       { sum += scores.frueh;       count++; }
  return count === 0 ? 0 : sum / count;
}

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

function perTypeRanges(pool: Employee[], assignments: ShiftAssignment[]): Record<ShiftType, number> {
  const r = {} as Record<ShiftType, number>;
  for (const st of SHIFT_TYPES) {
    if (pool.length === 0) { r[st] = 0; continue; }
    const counts = pool.map(e =>
      assignments.filter(a => a.shiftType === st && a.employees.includes(e.id)).length,
    );
    r[st] = Math.max(...counts) - Math.min(...counts);
  }
  return r;
}

function worsensRanges(
  pools: { label: string; pool: Employee[] }[],
  baselineRangesPerPool: Map<string, Record<ShiftType, number>>,
  candidate: ShiftAssignment[],
): boolean {
  for (const { label, pool } of pools) {
    const baseR = baselineRangesPerPool.get(label)!;
    const newR = perTypeRanges(pool, candidate);
    if (SHIFT_TYPES.some(t => newR[t] > baseR[t])) return true;
  }
  return false;
}

// ── Chunked optimiser loop (yields to event loop for cancel messages) ────

function runOptimiseChunked(msg: any) {
  const {
    id, employees, config, year, startMonth,
    maxIterations, targets, baselineAssignments, baselineViolations,
    departments,
  } = msg;

  // Baseline
  const baselineResult = baselineAssignments && baselineAssignments.length > 0
    ? { assignments: baselineAssignments, violations: baselineViolations || [] }
    : generateAutomaticShiftPlan(employees, year, startMonth, 12, config, departments);

  const pools = buildPools(employees);
  const baselineRangesPerPool = new Map<string, Record<ShiftType, number>>();
  for (const { label, pool } of pools) {
    baselineRangesPerPool.set(label, perTypeRanges(pool, baselineResult.assignments));
  }

  let bestAssignments = baselineResult.assignments;
  let bestViolations = baselineResult.violations;
  let bestScores = computeFairnessScores(employees, bestAssignments);
  let bestComposite = compositeScore(bestScores, targets);

  const progressInterval = Math.max(1, Math.floor(maxIterations / 200));
  const CHUNK_SIZE = Math.max(1, Math.min(10, progressInterval));
  const t0 = performance.now();
  let iter = 0;

  function runChunk() {
    if (cancelOptimise) {
      self.postMessage({ type: 'optimiseCancelled', id });
      return;
    }

    try {
      const chunkEnd = Math.min(iter + CHUNK_SIZE, maxIterations);
      for (; iter < chunkEnd; iter++) {
        // Emit progress
        if (iter % progressInterval === 0) {
          const elapsedMs = performance.now() - t0;
          const frac = iter / maxIterations;
          const estimatedTotalMs = frac > 0 ? elapsedMs / frac : 0;
          self.postMessage({
            type: 'optimiseProgress', id,
            progress: {
              iteration: iter, maxIterations, bestScore: bestComposite,
              currentScores: { ...bestScores }, elapsedMs, estimatedTotalMs, done: false,
            } satisfies OptimiserProgress,
            msPerIteration: iter > 0 ? elapsedMs / iter : null,
          });
        }

        const shuffled = shuffle([...employees]);
        const { assignments: candidate, violations: candidateViolations } =
          generateAutomaticShiftPlan(shuffled, year, startMonth, 12, config, departments);

        if (worsensRanges(pools, baselineRangesPerPool, candidate)) continue;

        const candidateScores = computeFairnessScores(employees, candidate);
        const candidateComposite = compositeScore(candidateScores, targets);
        if (candidateComposite > bestComposite) {
          bestAssignments = candidate;
          bestViolations = candidateViolations;
          bestScores = { ...candidateScores };
          bestComposite = candidateComposite;
        }
      }

      if (iter >= maxIterations) {
        // Done
        const result: OptimiserResult = {
          assignments: bestAssignments,
          violations: bestViolations,
          scores: bestScores,
          iterations: maxIterations,
        };
        self.postMessage({ type: 'optimiseDone', id, result });
      } else {
        // Yield to event loop so cancel messages can be processed
        setTimeout(runChunk, 0);
      }
    } catch (err: any) {
      self.postMessage({ type: 'optimiseError', id, error: String(err) });
    }
  }

  // Kick off first chunk (setTimeout so incoming cancel can be received)
  setTimeout(runChunk, 0);
}
