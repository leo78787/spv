/**
 * Express back-end for the Schichtplan Manager.
 *
 * Responsibilities:
 *  1. Persistent storage  — JSON file (data/state.json)
 *  2. Computation          — shift-plan generation, fairness optimisation,
 *                            fairness impact preview
 *  3. Authentication       — simple token-based auth
 *
 * Run with:  npx tsx server/index.ts
 */

import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { loadState, saveState } from './db.js';
import { generateAutomaticShiftPlan } from '../src/utils/scheduler.js';
import { computeImpactFactors } from '../src/utils/fairnessImpact.js';
import { runOptimiser } from '../src/utils/optimizer.js';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ═══════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════

const validTokens = new Set<string>();

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || !validTokens.has(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (username === 'spm2026' && password === 'schichtplan2026!') {
    const token = crypto.randomUUID();
    validTokens.add(token);
    res.json({ success: true, token });
  } else {
    res.status(401).json({
      success: false,
      message: 'Ungültiger Benutzername oder Passwort.',
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// STATE CRUD (full-state sync, mirrors the old localStorage approach)
// ═══════════════════════════════════════════════════════════════════════

app.get('/api/state', authMiddleware, (_req, res) => {
  res.json(loadState());
});

app.put('/api/state', authMiddleware, (req, res) => {
  saveState(req.body);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

/** Recursively convert ISO date strings back to Date objects. */
function reviveDates(obj: any): any {
  if (
    typeof obj === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(obj)
  ) {
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

// ═══════════════════════════════════════════════════════════════════════
// SERVER-SIDE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════

// ── Generate shift plan ─────────────────────────────────────────────

app.post('/api/generate', authMiddleware, (req, res) => {
  try {
    const { employees, year, startMonth, months, schedulerConfig } =
      reviveDates(req.body);
    const result = generateAutomaticShiftPlan(
      employees,
      year,
      startMonth,
      months,
      schedulerConfig,
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Optimise (SSE stream via worker_threads) ────────────────────────

app.post('/api/optimize', authMiddleware, (req, res) => {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let closed = false;
  req.on('close', () => {
    closed = true;
    worker.terminate();
  });

  // Try worker_threads first — if tsx doesn't support it in the worker,
  // fall back to running the optimiser synchronously in the main thread.
  let worker: Worker;
  try {
    worker = new Worker(new URL('./optimizerWorker.ts', import.meta.url), {
      workerData: req.body,
    });
  } catch {
    // Fallback: synchronous execution
    try {
      const data = reviveDates(req.body);
      const result = runOptimiser(
        data.employees,
        data.year,
        data.startMonth,
        data.months,
        data.schedulerConfig,
        data.optimiserConfig,
        (progress) => {
          if (!closed)
            res.write(`data: ${JSON.stringify({ type: 'progress', progress })}\n\n`);
        },
      );
      if (!closed) {
        res.write(`data: ${JSON.stringify({ type: 'result', result })}\n\n`);
      }
    } catch (err) {
      if (!closed) {
        res.write(
          `data: ${JSON.stringify({ type: 'error', error: String(err) })}\n\n`,
        );
      }
    }
    res.end();
    return;
  }

  worker.on('message', (msg: any) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(msg)}\n\n`);
    if (msg.type === 'result') {
      res.end();
    }
  });

  worker.on('error', (err: Error) => {
    if (closed) return;
    res.write(
      `data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`,
    );
    res.end();
  });

  worker.on('exit', (code) => {
    if (!closed && code !== 0) {
      res.write(
        `data: ${JSON.stringify({ type: 'error', error: `Worker exited with code ${code}` })}\n\n`,
      );
      res.end();
    }
  });
});

// ── Fairness impact preview ─────────────────────────────────────────

app.post('/api/fairness', authMiddleware, (req, res) => {
  try {
    const { employees, config, year, startMonth } = reviveDates(req.body);
    const result = computeImpactFactors(employees, config, year, startMonth);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Calibrate (tiny 3-iteration run to measure performance) ─────────

app.post('/api/calibrate', authMiddleware, (req, res) => {
  try {
    const { employees, schedulerConfig, year, startMonth, targets } =
      reviveDates(req.body);
    const CALIBRATION_ITERS = 3;
    const t0 = Date.now();
    runOptimiser(employees, year, startMonth, 12, schedulerConfig, {
      maxIterations: CALIBRATION_ITERS,
      targets,
    });
    const elapsed = Date.now() - t0;
    res.json({ msPerIteration: elapsed / CALIBRATION_ITERS });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`✔ Schichtplan server running on http://localhost:${PORT}`);
});
