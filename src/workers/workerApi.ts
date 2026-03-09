/**
 * Worker API bridge — main-thread interface to the compute Web Worker.
 *
 * All heavy computation (plan generation, optimisation, fairness impact)
 * runs in a Web Worker so the UI stays responsive.
 *
 * Uses Vite's `?worker&inline` import which embeds the worker code as a
 * base64 blob — compatible with vite-plugin-singlefile (no external files).
 */

// Vite inline-worker import (bundled + base64-encoded at build time)
import ComputeWorker from './computeWorker?worker&inline';

import type { SchedulerConfig } from '../utils/scheduler';
import type { ImpactFactors } from '../utils/fairnessImpact';
import type { Employee, ShiftAssignment, Department, SchedulerViolation } from '../types';
import type { OptimiserTargets, OptimiserProgress, OptimiserResult } from '../utils/optimizer';

// ── Singleton worker instance ───────────────────────────────────────────────

let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new ComputeWorker();
  }
  return worker!;
}

// ── Request ID counter ──────────────────────────────────────────────────────

let nextId = 0;

// ── Pending request resolvers ────────────────────────────────────────────────

type PendingResolver = {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
};

const pending = new Map<number, PendingResolver>();

// ── Callback registries for streaming messages ──────────────────────────────

type OptimiseProgressCallback = (progress: OptimiserProgress, msPerIteration: number | null) => void;
type OptimiseDoneCallback = (result: OptimiserResult) => void;
type OptimiseCancelledCallback = () => void;
type OptimiseErrorCallback = (error: string) => void;

let onOptimiseProgress: OptimiseProgressCallback | null = null;
let onOptimiseDone: OptimiseDoneCallback | null = null;
let onOptimiseCancelled: OptimiseCancelledCallback | null = null;
let onOptimiseError: OptimiseErrorCallback | null = null;

// ── Worker message handler ──────────────────────────────────────────────────

function ensureMessageHandler() {
  const w = getWorker();
  // Only set once
  if ((w as any).__bridgeHandlerSet) return;
  (w as any).__bridgeHandlerSet = true;

  w.onmessage = (e: MessageEvent) => {
    const msg = e.data;

    switch (msg.type) {
      case 'generate':
      case 'equality':
      case 'totalBalance':
      case 'computeImpact':
      case 'calibrate': {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error));
        } else {
          p.resolve(msg);
        }
        break;
      }

      case 'optimiseProgress': {
        onOptimiseProgress?.(msg.progress, msg.msPerIteration);
        break;
      }

      case 'optimiseDone': {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        onOptimiseDone?.(msg.result);
        p?.resolve(msg.result);
        break;
      }

      case 'optimiseCancelled': {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        onOptimiseCancelled?.();
        p?.resolve(null);
        break;
      }

      case 'optimiseError': {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        onOptimiseError?.(msg.error);
        p?.reject(new Error(msg.error));
        break;
      }
    }
  };
}

// ── Helper to post & await a response ────────────────────────────────────────

function postAndAwait<T>(message: any): Promise<T> {
  ensureMessageHandler();
  const id = ++nextId;
  message.id = id;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage(message);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/** Generate a shift plan in the worker. */
export async function workerGenerate(
  employees: Employee[],
  year: number,
  startMonth: number,
  months: number,
  config: SchedulerConfig,
  departments?: Department[],
): Promise<{ assignments: ShiftAssignment[]; violations: SchedulerViolation[] }> {
  const resp = await postAndAwait<any>({
    type: 'generate', employees, year, startMonth, months, config, departments,
  });
  return resp.result;
}

/** Run equality optimiser in the worker. */
export async function workerEquality(
  employees: Employee[],
  assignments: ShiftAssignment[],
  config: SchedulerConfig,
  maxIter: number,
): Promise<{ assignments: ShiftAssignment[]; improvements: number; iterations: number; ranges: Record<string, number> }> {
  const resp = await postAndAwait<any>({
    type: 'equality', employees, assignments, config, maxIter,
  });
  return resp.result;
}

/** Run total-balance optimiser in the worker. */
export async function workerTotalBalance(
  employees: Employee[],
  assignments: ShiftAssignment[],
  config: SchedulerConfig,
  maxIter: number,
): Promise<{ assignments: ShiftAssignment[]; improvements: number; iterations: number; ranges: Record<string, number>; totalRange: Record<string, number> }> {
  const resp = await postAndAwait<any>({
    type: 'totalBalance', employees, assignments, config, maxIter,
  });
  return resp.result;
}

/** Compute fairness impact factors in the worker. */
export async function workerComputeImpact(
  employees: Employee[],
  config: SchedulerConfig,
  year: number,
  startMonth: number,
  snapshot: string,
): Promise<{ result: ImpactFactors; snapshot: string }> {
  const resp = await postAndAwait<any>({
    type: 'computeImpact', employees, config, year, startMonth, snapshot,
  });
  return { result: resp.result, snapshot: resp.snapshot };
}

/** Run calibration (3 iterations) in the worker. */
export async function workerCalibrate(
  employees: Employee[],
  config: SchedulerConfig,
  year: number,
  startMonth: number,
  departments?: Department[],
): Promise<number> {
  const resp = await postAndAwait<any>({
    type: 'calibrate', employees, config, year, startMonth, departments,
  });
  return resp.msPerIteration;
}

/**
 * Start Monte-Carlo optimisation in the worker.
 * Returns a promise that resolves when the optimisation finishes or is cancelled.
 * Use the callbacks to receive progress updates.
 */
export function workerOptimise(
  employees: Employee[],
  config: SchedulerConfig,
  year: number,
  startMonth: number,
  maxIterations: number,
  targets: OptimiserTargets,
  callbacks: {
    onProgress?: OptimiseProgressCallback;
    onDone?: OptimiseDoneCallback;
    onCancelled?: OptimiseCancelledCallback;
    onError?: OptimiseErrorCallback;
  },
  baselineAssignments?: ShiftAssignment[],
  baselineViolations?: SchedulerViolation[],
  departments?: Department[],
): Promise<OptimiserResult | null> {
  ensureMessageHandler();

  // Set callbacks
  onOptimiseProgress = callbacks.onProgress ?? null;
  onOptimiseDone = callbacks.onDone ?? null;
  onOptimiseCancelled = callbacks.onCancelled ?? null;
  onOptimiseError = callbacks.onError ?? null;

  const id = ++nextId;
  return new Promise<OptimiserResult | null>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({
      type: 'optimise', id,
      employees, config, year, startMonth,
      maxIterations, targets,
      baselineAssignments, baselineViolations,
      departments,
    });
  });
}

/** Cancel a running optimisation. */
export function workerCancelOptimise() {
  getWorker().postMessage({ type: 'cancelOptimise' });
}
