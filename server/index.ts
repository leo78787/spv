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
import { loadState, saveState } from './db.js';
import { generateAutomaticShiftPlan } from '../src/utils/scheduler.js';
import { computeImpactFactors, computeFairnessScores } from '../src/utils/fairnessImpact.js';
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
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  let closed = false;
  res.on('close', () => { closed = true; });

  // Run the optimiser in async chunks to keep the event loop responsive
  // and allow SSE progress events to be flushed to the client.
  const data = reviveDates(req.body);
  const { employees, schedulerConfig, year, startMonth, months } = data;
  const optimiserConfig = data.optimiserConfig ?? { maxIterations: 5000, targets: { overall: true, verschieben: true, nacht: true, frueh: true } };
  const { maxIterations, targets } = optimiserConfig;

  // Run optimiser logic inline with async yielding
  const genPlan = generateAutomaticShiftPlan;

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

  // Baseline
  const { assignments: baseline } = genPlan(employees, year, startMonth, months, schedulerConfig);
  let bestAssignments = baseline;
  let bestScores = computeFairnessScores(employees, baseline);
  let bestComposite = compositeScore(bestScores, targets);

  const progressInterval = Math.max(1, Math.floor(maxIterations / 200));
  const CHUNK_SIZE = Math.max(1, Math.min(10, progressInterval));
  const t0 = Date.now();
  let iter = 0;

  function runChunk() {
    if (closed) return;

    try {
      const chunkEnd = Math.min(iter + CHUNK_SIZE, maxIterations);
      for (; iter < chunkEnd; iter++) {
        if (iter % progressInterval === 0) {
          const elapsedMs = Date.now() - t0;
          const frac = iter / maxIterations;
          const estimatedTotalMs = frac > 0 ? elapsedMs / frac : 0;
          const progress = {
            iteration: iter, maxIterations, bestScore: bestComposite,
            currentScores: { ...bestScores }, elapsedMs, estimatedTotalMs, done: false,
          };
          if (!closed) res.write(`data: ${JSON.stringify({ type: 'progress', progress })}\n\n`);
        }

        const shuffled = shuffle([...employees]);
        const { assignments: candidate } = genPlan(shuffled, year, startMonth, months, schedulerConfig);
        const candidateScores = computeFairnessScores(employees, candidate);
        const candidateComposite = compositeScore(candidateScores, targets);
        if (candidateComposite > bestComposite) {
          bestAssignments = candidate;
          bestScores = { ...candidateScores };
          bestComposite = candidateComposite;
        }
      }

      if (iter >= maxIterations) {
        // Done
        const totalElapsed = Date.now() - t0;
        const doneProgress = {
          iteration: maxIterations, maxIterations, bestScore: bestComposite,
          currentScores: { ...bestScores }, elapsedMs: totalElapsed, estimatedTotalMs: totalElapsed, done: true,
        };
        if (!closed) {
          res.write(`data: ${JSON.stringify({ type: 'progress', progress: doneProgress })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'result', result: { assignments: bestAssignments, scores: bestScores, iterations: maxIterations } })}\n\n`);
        }
        res.end();
      } else {
        // Yield to the event loop, then continue
        setImmediate(runChunk);
      }
    } catch (chunkErr) {
      if (!closed) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: String(chunkErr) })}\n\n`);
      }
      res.end();
    }
  }

  try {
    runChunk();
  } catch (err) {
    if (!closed) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: String(err) })}\n\n`);
    }
    res.end();
  }
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
