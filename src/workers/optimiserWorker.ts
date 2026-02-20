/**
 * Web Worker that runs the fairness optimizer in the background.
 *
 * Messages IN  → OptimiserWorkerRequest
 * Messages OUT → OptimiserWorkerResponse (progress or final result)
 */

import { Employee, SchedulerConfig } from '../types';
import {
  runOptimiser,
  OptimiserConfig,
  OptimiserProgress,
  OptimiserResult,
} from '../utils/optimizer';

export interface OptimiserWorkerRequest {
  id: number;
  employees: Employee[];
  schedulerConfig: SchedulerConfig;
  optimiserConfig: OptimiserConfig;
  year: number;
  startMonth: number;
  months: number;
}

export interface OptimiserWorkerResponse {
  id: number;
  type: 'progress' | 'result' | 'error';
  progress?: OptimiserProgress;
  result?: OptimiserResult;
  error?: string;
}

self.onmessage = (e: MessageEvent<OptimiserWorkerRequest>) => {
  const { id, employees, schedulerConfig, optimiserConfig, year, startMonth, months } = e.data;

  try {
    // Revive Date objects (JSON serialisation turns them into strings)
    const revived = employees.map(emp => ({
      ...emp,
      vacationDays: (emp.vacationDays || []).map(d => new Date(d)),
      vacationRanges: (emp.vacationRanges || []).map(r => ({
        startDate: new Date(r.startDate),
        endDate: new Date(r.endDate),
      })),
      preferences: (emp.preferences || []).map(p => ({
        ...p,
        startDate: new Date(p.startDate),
        endDate: new Date(p.endDate),
      })),
    }));

    const result = runOptimiser(
      revived,
      year,
      startMonth,
      months,
      schedulerConfig,
      optimiserConfig,
      (progress) => {
        // Send progress updates back to the main thread
        const msg: OptimiserWorkerResponse = { id, type: 'progress', progress };
        self.postMessage(msg);
      }
    );

    const resp: OptimiserWorkerResponse = { id, type: 'result', result };
    self.postMessage(resp);
  } catch (err: any) {
    const resp: OptimiserWorkerResponse = {
      id,
      type: 'error',
      error: err?.message || String(err),
    };
    self.postMessage(resp);
  }
};
