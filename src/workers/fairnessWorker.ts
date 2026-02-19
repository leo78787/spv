/**
 * Web Worker: Fairness Impact Computation
 *
 * Runs computeImpactFactors off the main thread so the UI stays responsive
 * even with PREVIEW_MONTHS=12 and TRIAL_COUNT=3.
 *
 * Message protocol
 *   In  → { id: number; employees: Employee[]; config: SchedulerConfig; year: number; startMonth: number }
 *   Out → { id: number; result: ImpactFactors }
 *       | { id: number; error: string }
 */

import { computeImpactFactors } from '../utils/fairnessImpact';
import type { Employee } from '../types';
import type { SchedulerConfig } from '../utils/scheduler';
import type { ImpactFactors } from '../utils/fairnessImpact';

export interface WorkerRequest {
  id: number;
  employees: Employee[];
  config: SchedulerConfig;
  year: number;
  startMonth: number;
}

export interface WorkerResponse {
  id: number;
  result?: ImpactFactors;
  error?: string;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, employees, config, year, startMonth } = e.data;
  try {
    const result = computeImpactFactors(employees, config, year, startMonth);
    (self as unknown as Worker).postMessage({ id, result } satisfies WorkerResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) } satisfies WorkerResponse);
  }
};
