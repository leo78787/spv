/**
 * Module-level singleton that manages the optimiser Web Worker.
 *
 * The worker reference and all optimiser state live at module scope so they
 * survive React component unmounts (e.g. when the user switches to another
 * tab inside the app).  When the ShiftPlanning component remounts it simply
 * subscribes to the manager and immediately receives the current state.
 *
 * When the optimiser finishes, it applies the result directly to the Zustand
 * store — even if the ShiftPlanning component is not mounted at that moment.
 */

import type { OptimiserWorkerRequest, OptimiserWorkerResponse } from '../workers/optimiserWorker';
import type { OptimiserTargets, OptimiserProgress, OptimiserResult } from '../utils/optimizer';
import type { Employee } from '../types';
import type { SchedulerConfig } from '../utils/scheduler';
import { useStore } from '../store';

// ── Public state shape ──────────────────────────────────────────────────────

export interface OptimiserManagerState {
  isOptimising: boolean;
  progress: OptimiserProgress | null;
  result: OptimiserResult | null;
  maxIterations: number;
  targets: OptimiserTargets;
  /** Measured ms per iteration from the last run (used for pre-start time estimates). */
  msPerIteration: number | null;
  /** Human-readable message set when the optimiser finishes. */
  generationMessage: { success: boolean; message: string; assignmentCount: number } | null;
}

type Listener = (state: OptimiserManagerState) => void;

// ── Module-level singleton state ────────────────────────────────────────────

let worker: Worker | null = null;

/** Parameters captured at start-time so the result can be applied later. */
let applyContext: {
  year: number;
  startMonth: number;
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

/** Get the current optimiser state (non-reactive, for initial reads). */
export function getOptimiserState(): OptimiserManagerState {
  return snapshot();
}

/**
 * Subscribe to optimiser state changes.
 * Returns an unsubscribe function.
 */
export function subscribeOptimiser(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Update max-iterations setting. */
export function setMaxIterations(v: number) {
  state.maxIterations = Math.max(100, v);
  notify();
}

/** Update which fairness dimensions are targeted. */
export function setTargets(targets: OptimiserTargets) {
  state.targets = { ...targets };
  notify();
}

let calibrationWorker: Worker | null = null;

/**
 * Run a tiny calibration (3 iterations) to measure ms-per-iteration for the
 * current dataset & machine.  This lets the UI show a time estimate *before*
 * the user starts the full optimisation.
 */
export function calibrate(
  employees: Employee[],
  schedulerConfig: SchedulerConfig,
  year: number,
  startMonth: number,
) {
  // Don't calibrate while a real run is in progress
  if (state.isOptimising) return;
  // Abort any previous calibration
  if (calibrationWorker) { calibrationWorker.terminate(); calibrationWorker = null; }

  calibrationWorker = new Worker(
    new URL('../workers/optimiserWorker.ts', import.meta.url),
    { type: 'module' },
  );

  calibrationWorker.onmessage = (e: MessageEvent<OptimiserWorkerResponse>) => {
    const msg = e.data;
    if (msg.type === 'result' && msg.result) {
      // result.iterations always = CALIBRATION_ITERS
      // elapsed time is in the last progress we received, but the worker
      // doesn't send it in the result.  However we timed it ourselves:
    }
    // We use our own timing below
  };

  const CALIBRATION_ITERS = 3;
  const t0 = performance.now();

  // We need to capture the finish event
  calibrationWorker.onmessage = (e: MessageEvent<OptimiserWorkerResponse>) => {
    const msg = e.data;
    if (msg.type === 'result') {
      const elapsed = performance.now() - t0;
      state.msPerIteration = elapsed / CALIBRATION_ITERS;
      notify();
      calibrationWorker?.terminate();
      calibrationWorker = null;
    } else if (msg.type === 'error') {
      calibrationWorker?.terminate();
      calibrationWorker = null;
    }
  };

  const req: OptimiserWorkerRequest = {
    id: Date.now(),
    employees,
    schedulerConfig,
    optimiserConfig: { maxIterations: CALIBRATION_ITERS, targets: state.targets },
    year,
    startMonth,
    months: 12,
  };
  calibrationWorker.postMessage(req);
}

/**
 * Start the optimisation.  Creates a new Web Worker and tracks its progress.
 * When the worker finishes, the result is applied directly to the Zustand
 * store so the shift plan is updated even if the UI component is unmounted.
 */
export function startOptimisation(
  employees: Employee[],
  schedulerConfig: SchedulerConfig,
  year: number,
  startMonth: number,
) {
  if (state.isOptimising) return;

  state.isOptimising = true;
  state.progress = null;
  state.result = null;
  state.generationMessage = null;
  notify();

  applyContext = { year, startMonth, schedulerConfig };

  worker = new Worker(
    new URL('../workers/optimiserWorker.ts', import.meta.url),
    { type: 'module' },
  );

  worker.onmessage = (e: MessageEvent<OptimiserWorkerResponse>) => {
    const msg = e.data;

    if (msg.type === 'progress' && msg.progress) {
      state.progress = msg.progress;
      // Update msPerIteration from live data for future estimates
      if (msg.progress.iteration > 0 && msg.progress.elapsedMs > 0) {
        state.msPerIteration = msg.progress.elapsedMs / msg.progress.iteration;
      }
      notify();
    } else if (msg.type === 'result' && msg.result) {
      const result = msg.result;

      state.result = result;
      state.progress = null;
      state.isOptimising = false;

      // Apply result to the Zustand store (works even while unmounted)
      const ctx = applyContext;
      if (ctx) {
        const store = useStore.getState();
        store.createShiftPlan(ctx.year, ctx.startMonth, 12, ctx.schedulerConfig, []);
        result.assignments.forEach((a: any) => {
          store.updateShiftAssignment({
            ...a,
            startDate: new Date(a.startDate),
            endDate: new Date(a.endDate),
          });
        });
      }

      state.generationMessage = {
        success: true,
        message: `Optimierter Schichtplan – ${result.iterations.toLocaleString()} Iterationen`,
        assignmentCount: result.assignments.length,
      };
      notify();

      worker?.terminate();
      worker = null;
    } else if (msg.type === 'error') {
      console.error('[optimiserWorker]', msg.error);
      state.isOptimising = false;
      state.progress = null;
      notify();
      worker?.terminate();
      worker = null;
    }
  };

  const req: OptimiserWorkerRequest = {
    id: Date.now(),
    employees,
    schedulerConfig,
    optimiserConfig: { maxIterations: state.maxIterations, targets: state.targets },
    year,
    startMonth,
    months: 12,
  };
  worker.postMessage(req);
}

/** Cancel a running optimisation (terminates the worker). */
export function cancelOptimisation() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  state.isOptimising = false;
  state.progress = null;
  notify();
}
