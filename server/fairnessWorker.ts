/**
 * Worker thread for /api/fairness — runs computeImpactFactors off the main
 * event loop so that /api/generate requests are never blocked.
 *
 * Compiled to server/fairnessWorker.mjs via esbuild (see package.json build
 * script or the one-shot command in README).
 */
import { workerData, parentPort } from 'worker_threads';
import { computeImpactFactors } from '../src/utils/fairnessImpact.js';

if (!parentPort) throw new Error('Must run as a worker thread');

const { employees, config, year, startMonth } = workerData;

try {
  const result = computeImpactFactors(employees, config, year, startMonth);
  parentPort.postMessage({ result });
} catch (err) {
  parentPort.postMessage({ error: String(err) });
}
