/**
 * Module-level singleton that manages the optimiser via the server API.
 *
 * Replaces the old Web Worker approach: the optimiser now runs on the
 * server and streams progress via SSE.  The manager state and subscribe /
 * notify pattern remain identical so the UI code is mostly unchanged.
 *
 * When the optimiser finishes, it applies the result directly to the
 * Zustand store — even if the ShiftPlanning component is not mounted.
 */

import type { OptimiserTargets, OptimiserProgress, OptimiserResult } from '../utils/optimizer';
import type { Employee } from '../types';
import type { SchedulerConfig } from '../utils/scheduler';
import { useStore, getAuthToken } from '../store';

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

/** AbortController for cancelling the running fetch / SSE stream. */
let abortController: AbortController | null = null;

/** Parameters captured at start-time so the result can be applied later. */
let applyContext: {
  year: number;
  startMonth: number;
  months: number;
  schedulerConfig: SchedulerConfig;
} | null = null;

/** Whether a resume-check has already been done this page load. */
let resumeChecked = false;

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

// ── Date revival helper ─────────────────────────────────────────────────────

function reviveDates(obj: any): any {
  if (typeof obj === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(obj)) {
    return new Date(obj);
  }
  if (Array.isArray(obj)) return obj.map(reviveDates);
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const key of Object.keys(obj)) out[key] = reviveDates(obj[key]);
    return out;
  }
  return obj;
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
  return () => { listeners.delete(listener); };
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

/**
 * Run a tiny calibration (3 iterations) on the server to measure ms-per-
 * iteration for the current dataset.  Lets the UI show a time estimate
 * *before* the user starts the full optimisation.
 */
export async function calibrate(
  employees: Employee[],
  schedulerConfig: SchedulerConfig,
  year: number,
  startMonth: number,
) {
  if (state.isOptimising) return;
  const token = getAuthToken();
  if (!token) return;
  try {
    const resp = await fetch('/api/calibrate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ employees, schedulerConfig, year, startMonth, targets: state.targets }),
    });
    if (resp.ok) {
      const data = await resp.json();
      state.msPerIteration = data.msPerIteration;
      notify();
    }
  } catch (err) {
    console.error('[calibrate]', err);
  }
}

/**
 * Start the optimisation via the server.  Reads progress from an SSE
 * stream.  When the server replies with a 'result' event, the result is
 * applied to the Zustand store — even if the component is unmounted.
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

  abortController = new AbortController();

  const token = getAuthToken();

  fetch('/api/optimize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      employees,
      schedulerConfig,
      optimiserConfig: { maxIterations: state.maxIterations, targets: state.targets },
      year,
      startMonth,
      months: 12,
      ...(baselineAssignments ? { baselineAssignments } : {}),
      ...(baselineViolations ? { baselineViolations } : {}),
    }),
    signal: abortController.signal,
  })
    .then(async (response) => {
      if (response.status === 409) {
        // Already running on server — subscribe instead
        _connectSubscribeStream(token!);
        return;
      }
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let data: any;
          try { data = JSON.parse(line.slice(6)); } catch { continue; }
          _handleSSEMessage(data);
        }
      }

      if (state.isOptimising) {
        state.isOptimising = false;
        state.progress = null;
        notify();
      }
    })
    .catch((err) => {
      if (err.name === 'AbortError') return;
      console.error('[optimiser fetch]', err);
      state.isOptimising = false;
      state.progress = null;
      notify();
    });
}

/** Cancel a running optimisation (aborts the fetch / SSE stream + server-side job). */
export function cancelOptimisation() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  state.isOptimising = false;
  state.progress = null;
  notify();

  // Also cancel the server-side job so it stops consuming CPU
  const token = getAuthToken();
  if (token) {
    fetch('/api/optimize/cancel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
}

/**
 * Check whether the server has a running or recently-finished optimisation
 * job and restore state accordingly.  Call once on page load.
 */
export async function checkAndResumeOptimisation(): Promise<void> {
  if (resumeChecked) return;
  resumeChecked = true;

  const token = getAuthToken();
  if (!token) return;

  let job: any;
  try {
    const resp = await fetch('/api/optimize/status', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return;
    job = await resp.json();
  } catch {
    return;
  }

  if (!job || job.status === 'idle') return;

  if (job.status === 'running') {
    // Restore running state from server
    state.isOptimising = true;
    state.maxIterations = job.maxIterations;
    state.targets = job.targets;
    state.progress = {
      iteration: job.iter,
      maxIterations: job.maxIterations,
      bestScore: job.bestScore,
      currentScores: job.currentScores,
      elapsedMs: job.elapsedMs,
      estimatedTotalMs: job.estimatedTotalMs,
      done: false,
    };
    applyContext = { year: job.year, startMonth: job.startMonth, months: job.months, schedulerConfig: job.schedulerConfig };
    notify();

    // Subscribe to live SSE stream
    _connectSubscribeStream(token);
  } else if (job.status === 'done' && job.hasResult) {
    // Server finished while we were away — fetch the result via subscribe endpoint
    // which sends the cached result immediately
    applyContext = { year: job.year, startMonth: job.startMonth, months: job.months, schedulerConfig: job.schedulerConfig };
    state.isOptimising = true; // will be cleared when result event arrives
    state.maxIterations = job.maxIterations;
    state.progress = {
      iteration: job.iter, maxIterations: job.maxIterations,
      bestScore: job.bestScore, currentScores: job.currentScores,
      elapsedMs: job.elapsedMs, estimatedTotalMs: job.elapsedMs, done: true,
    };
    notify();
    _connectSubscribeStream(token);
  } else if (job.status === 'cancelled' || job.status === 'error') {
    // Nothing to restore — clear any stale UI state
    state.isOptimising = false;
    state.progress = null;
    notify();
  }
}

function _connectSubscribeStream(token: string) {
  if (abortController) abortController.abort();
  abortController = new AbortController();

  fetch('/api/optimize/subscribe', {
    headers: { Authorization: `Bearer ${token}` },
    signal: abortController.signal,
  })
    .then(async (response) => {
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let data: any;
          try { data = JSON.parse(line.slice(6)); } catch { continue; }
          _handleSSEMessage(data);
        }
      }

      if (state.isOptimising) {
        state.isOptimising = false;
        state.progress = null;
        notify();
      }
    })
    .catch((err) => {
      if (err.name === 'AbortError') return;
      console.error('[optimiser subscribe]', err);
      state.isOptimising = false;
      state.progress = null;
      notify();
    });
}

function _handleSSEMessage(data: any) {
  if (data.type === 'progress' && data.progress) {
    state.progress = data.progress;
    if (data.progress.iteration > 0 && data.progress.elapsedMs > 0) {
      state.msPerIteration = data.progress.elapsedMs / data.progress.iteration;
    }
    notify();
  } else if (data.type === 'result' && data.result) {
    const result = reviveDates(data.result) as OptimiserResult;
    state.result = result;
    state.progress = null;
    state.isOptimising = false;

    // The server already auto-saved — but we still update the Zustand store
    // so the UI reflects the new plan without waiting for the next poll.
    const ctx = applyContext;
    if (ctx) {
      const store = useStore.getState();
      const revivedAssignments = result.assignments.map((a: any) => ({
        ...a,
        startDate: new Date(a.startDate),
        endDate: new Date(a.endDate),
      }));
      const revivedViolations = (result.violations || []).map((v: any) => ({
        ...v,
        startDate: new Date(v.startDate),
        endDate: new Date(v.endDate),
      }));
      store.setShiftPlan({
        year: ctx.year,
        startMonth: ctx.startMonth,
        months: ctx.months,
        schedulerConfig: ctx.schedulerConfig,
        violations: revivedViolations,
        assignments: revivedAssignments,
        algorithm: 'fairness-optimiert',
      });
    }

    state.generationMessage = {
      success: true,
      message: `Optimierter Schichtplan – ${result.iterations.toLocaleString()} Iterationen`,
      assignmentCount: result.assignments.length,
    };

    // Clear the server-side job record now that we've applied the result.
    const token = getAuthToken();
    if (token) {
      fetch('/api/optimize', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    }

    notify();
  } else if (data.type === 'error') {
    console.error('[optimiser server]', data.error);
    state.isOptimising = false;
    state.progress = null;
    notify();
  } else if (data.type === 'cancelled' || data.type === 'idle') {
    state.isOptimising = false;
    state.progress = null;
    notify();
  }
}
