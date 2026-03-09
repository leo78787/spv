/**
 * Module-level singleton that manages the optimiser client-side.
 *
 * All computation runs directly in the browser — no server required.
 */

import type { OptimiserTargets, OptimiserProgress, OptimiserResult } from '../utils/optimizer';
import type { Employee } from '../types';
import type { SchedulerConfig } from '../utils/scheduler';
import { generateAutomaticShiftPlan } from '../utils/scheduler';
import { computeFairnessScores } from '../utils/fairnessImpact';
import { useStore } from '../store';

// ── Public state shape ──────────────────────────────────────────────────────

export interface OptimiserManagerState {
  isOptimising: boolean;
  progress: OptimiserProgress | null;
  result: OptimiserResult | null;
  maxIterations: number;
  targets: OptimiserTargets;
  msPerIteration: number | null;
  generationMessage: { success: boolean; message: string; assignmentCount: number } | null;
}

type Listener = (state: OptimiserManagerState) => void;

// ── Module-level singleton state ────────────────────────────────────────────

let cancelFlag = false;

let applyContext: {
  year: number;
  startMonth: number;
  months: number;
  schedulerConfig: SchedulerConfig;
} | null = null;

const state: OptimiserManagerState = {
  isOptimising: false,
  progress: null,
  result: null,
  maxIterations: 5000,
  targets: { overall: true, verschieben: true, nacht: true, frueh: true },
  msPerIteration: null,
  generationMessage: null,
};

const listeners = new Set<Listener>();

function snapshot(): OptimiserManagerState {
  return { ...state };
}

function notify() {
  const s = snapshot();
  for (const l of listeners) l(s);
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getOptimiserState(): OptimiserManagerState {
  return snapshot();
}

export function subscribeOptimiser(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setMaxIterations(v: number) {
  state.maxIterations = Math.max(100, v);
  notify();
}

export function setTargets(targets: OptimiserTargets) {
  state.targets = { ...targets };
  notify();
}

/**
 * Run a tiny calibration (3 iterations) locally to measure ms-per-iteration.
 */
export function calibrate(
  employees: Employee[],
  schedulerConfig: SchedulerConfig,
  year: number,
  startMonth: number,
) {
  if (state.isOptimising) return;
  try {
    const store = useStore.getState();
    const departments = store.departments || [];
    const CALIBRATION_ITERS = 3;
    const t0 = performance.now();
    for (let i = 0; i < CALIBRATION_ITERS; i++) {
      generateAutomaticShiftPlan(employees, year, startMonth, 12, schedulerConfig, departments);
    }
    const elapsed = performance.now() - t0;
    state.msPerIteration = elapsed / CALIBRATION_ITERS;
    notify();
  } catch (err) {
    console.error('[calibrate]', err);
  }
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function compositeScore(scores: any, t: any): number {
  let sum = 0, count = 0;
  if (t.overall)     { sum += scores.overall;     count++; }
  if (t.verschieben) { sum += scores.verschieben; count++; }
  if (t.nacht)       { sum += scores.nacht;       count++; }
  if (t.frueh)       { sum += scores.frueh;       count++; }
  return count === 0 ? 0 : sum / count;
}

/**
 * Start the optimisation client-side using chunked setTimeout calls
 * to keep the UI responsive.
 */
export function startOptimisation(
  employees: Employee[],
  schedulerConfig: SchedulerConfig,
  year: number,
  startMonth: number,
  baselineAssignments?: any[],
  baselineViolations?: any[],
) {
  if (state.isOptimising) return;

  state.isOptimising = true;
  state.progress = null;
  state.result = null;
  state.generationMessage = null;
  cancelFlag = false;
  notify();

  applyContext = { year, startMonth, months: 12, schedulerConfig };

  const store = useStore.getState();
  const departments = store.departments || [];
  const maxIterations = state.maxIterations;
  const targets = { ...state.targets };

  // Per-pool per-type range helpers (prevent worsening)
  const SHIFT_TYPES: string[] = ['verschieben', 'nachtbereitschaft', 'fruehschicht'];
  function sGroupKey(e: any): string {
    const allowed = [...(e.allowedShiftTypes ?? ['fruehschicht', 'verschieben', 'nachtbereitschaft'])].sort().join(',');
    return `${allowed}|${e.isOver55 ? '55+' : '<55'}`;
  }
  function sBuildPools(emps: any[]): { label: string; pool: any[] }[] {
    const pMap = new Map<string, any[]>();
    for (const emp of emps) {
      const key = sGroupKey(emp);
      if (!pMap.has(key)) pMap.set(key, []);
      pMap.get(key)!.push(emp);
    }
    return Array.from(pMap.entries()).map(([k, p]) => ({ label: k, pool: p }));
  }
  function sPerTypeRanges(pool: any[], assigns: any[]): Record<string, number> {
    const r: Record<string, number> = {};
    for (const st of SHIFT_TYPES) {
      if (pool.length === 0) { r[st] = 0; continue; }
      const counts = pool.map((e: any) => assigns.filter((a: any) => a.shiftType === st && a.employees.includes(e.id)).length);
      r[st] = Math.max(...counts) - Math.min(...counts);
    }
    return r;
  }
  function sWorsensRanges(pools: { label: string; pool: any[] }[], baseRanges: Map<string, Record<string, number>>, candidate: any[]): boolean {
    for (const { label, pool } of pools) {
      const baseR = baseRanges.get(label)!;
      const newR = sPerTypeRanges(pool, candidate);
      if (SHIFT_TYPES.some(t => newR[t] > baseR[t])) return true;
    }
    return false;
  }

  // Baseline
  const baselineResult = baselineAssignments && baselineAssignments.length > 0
    ? { assignments: baselineAssignments, violations: baselineViolations || [] as any[] }
    : generateAutomaticShiftPlan(employees, year, startMonth, 12, schedulerConfig, departments);

  const sPools = sBuildPools(employees);
  const sBaselineRangesPerPool = new Map<string, Record<string, number>>();
  for (const { label, pool } of sPools) {
    sBaselineRangesPerPool.set(label, sPerTypeRanges(pool, baselineResult.assignments));
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
    if (cancelFlag) {
      state.isOptimising = false;
      state.progress = null;
      notify();
      return;
    }

    try {
      const chunkEnd = Math.min(iter + CHUNK_SIZE, maxIterations);
      for (; iter < chunkEnd; iter++) {
        if (iter % progressInterval === 0) {
          const elapsedMs = performance.now() - t0;
          const frac = iter / maxIterations;
          const estimatedTotalMs = frac > 0 ? elapsedMs / frac : 0;
          state.progress = {
            iteration: iter, maxIterations, bestScore: bestComposite,
            currentScores: { ...bestScores }, elapsedMs, estimatedTotalMs, done: false,
          };
          state.msPerIteration = iter > 0 ? elapsedMs / iter : state.msPerIteration;
          notify();
        }

        const shuffled = shuffle([...employees]);
        const { assignments: candidate, violations: candidateViolations } = generateAutomaticShiftPlan(shuffled, year, startMonth, 12, schedulerConfig, departments);

        if (sWorsensRanges(sPools, sBaselineRangesPerPool, candidate)) continue;

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
        state.result = result;
        state.progress = null;
        state.isOptimising = false;

        // Apply to store
        const ctx = applyContext;
        if (ctx) {
          useStore.getState().setShiftPlan({
            year: ctx.year,
            startMonth: ctx.startMonth,
            months: ctx.months,
            schedulerConfig: ctx.schedulerConfig,
            violations: bestViolations,
            assignments: bestAssignments,
            algorithm: 'fairness-optimiert',
          });
        }

        state.generationMessage = {
          success: true,
          message: `Optimierter Schichtplan – ${maxIterations.toLocaleString()} Iterationen`,
          assignmentCount: bestAssignments.length,
        };

        notify();
      } else {
        setTimeout(runChunk, 0);
      }
    } catch (chunkErr) {
      console.error('[optimiser]', chunkErr);
      state.isOptimising = false;
      state.progress = null;
      notify();
    }
  }

  // Start with setTimeout to not block UI
  setTimeout(runChunk, 0);
}

export function cancelOptimisation() {
  cancelFlag = true;
  state.isOptimising = false;
  state.progress = null;
  notify();
}

/** No-op in client-side mode (no server job to resume). */
export async function checkAndResumeOptimisation(): Promise<void> {
  // Nothing to do in local mode
}
