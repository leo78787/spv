/**
 * Worker thread for running the fairness optimiser.
 *
 * Receives the optimiser parameters via `workerData` and posts progress
 * messages back to the parent thread so the Express SSE endpoint can
 * stream them to the browser.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { runOptimiser } from '../src/utils/optimizer.js';

// ── Date revival ────────────────────────────────────────────────────────

function reviveDates(obj: any): any {
  if (typeof obj === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(obj)) {
    return new Date(obj);
  }
  if (Array.isArray(obj)) return obj.map(reviveDates);
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const key of Object.keys(obj)) {
      result[key] = reviveDates(obj[key]);
    }
    return result;
  }
  return obj;
}

// ── Run ─────────────────────────────────────────────────────────────────

const data = reviveDates(workerData);
const { employees, schedulerConfig, optimiserConfig, year, startMonth, months } = data;

const result = runOptimiser(
  employees,
  year,
  startMonth,
  months,
  schedulerConfig,
  optimiserConfig,
  (progress) => {
    parentPort?.postMessage({ type: 'progress', progress });
  },
);

parentPort?.postMessage({ type: 'result', result });
