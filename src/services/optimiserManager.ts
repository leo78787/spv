/**
 * Module-level singleton that manages the optimiser client-side.
 *
 * All computation runs in a Web Worker — the main thread stays responsive.
 */

import type { OptimiserTargets, OptimiserProgress, OptimiserResult } from '../utils/optimizer';
import type { Employee } from '../types';
import type { SchedulerConfig } from '../utils/scheduler';
import { useStore } from '../store';
import {
  workerCalibrate,
  workerOptimise,
  workerCancelOptimise,
} from '../workers/workerApi';

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
 * Run a tiny calibration (3 iterations) in the worker to measure ms/iteration.
 */
export function calibrate(
  employees: Employee[],
  schedulerConfig: SchedulerConfig,
  year: number,
  startMonth: number,
) {
  if (state.isOptimising) return;

  const store = useStore.getState();
  const departments = store.departments || [];

  workerCalibrate(employees, schedulerConfig, year, startMonth, departments)
    .then(msPerIteration => {
      state.msPerIteration = msPerIteration;
      notify();
    })
    .catch(err => {
      console.error('[calibrate]', err);
    });
}

/**
 * Start the optimisation via the Web Worker.
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
  notify();

  applyContext = { year, startMonth, months: 12, schedulerConfig };

  const store = useStore.getState();
  const departments = store.departments || [];
  const maxIterations = state.maxIterations;
  const targets = { ...state.targets };

  workerOptimise(
    employees,
    schedulerConfig,
    year,
    startMonth,
    maxIterations,
    targets,
    {
      onProgress: (progress, msPerIter) => {
        state.progress = progress;
        if (msPerIter != null) state.msPerIteration = msPerIter;
        notify();
      },
      onDone: (result) => {
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
            violations: result.violations ?? [],
            assignments: result.assignments,
            algorithm: 'fairness-optimiert',
          });
        }

        state.generationMessage = {
          success: true,
          message: `Optimierter Schichtplan – ${maxIterations.toLocaleString()} Iterationen`,
          assignmentCount: result.assignments.length,
        };

        notify();
      },
      onCancelled: () => {
        state.isOptimising = false;
        state.progress = null;
        notify();
      },
      onError: (error) => {
        console.error('[optimiser]', error);
        state.isOptimising = false;
        state.progress = null;
        notify();
      },
    },
    baselineAssignments,
    baselineViolations,
    departments,
  );
}

export function cancelOptimisation() {
  workerCancelOptimise();
  state.isOptimising = false;
  state.progress = null;
  notify();
}

/** No-op in client-side mode (no server job to resume). */
export async function checkAndResumeOptimisation(): Promise<void> {
  // Nothing to do in local mode
}
