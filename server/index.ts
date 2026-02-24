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
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { loadState, saveState } from './db.js';
import { generateAutomaticShiftPlan, runEqualityOptimiser, runTotalBalanceOptimiser, detectViolations, getAvailableEmployeesSorted } from '../src/utils/scheduler.js';
import { computeFairnessScores } from '../src/utils/fairnessImpact.js';
import { runOptimiser } from '../src/utils/optimizer.js';
import {
  createOrResetCredentials,
  authenticateEmployee,
  validatePortalToken,
  changePassword,
  getAllCredentialInfo,
} from './portalAuth.js';
import { sendInvitationEmail, sendPlanNotificationEmail, sendSwapMatchEmail, sendRingSwapMatchEmail } from './mailer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAIRNESS_WORKER_PATH = path.join(__dirname, 'fairnessWorker.mjs');

const app = express();
const PORT = 3002;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ═══════════════════════════════════════════════════════════════════════
// PERSISTENT BACKGROUND OPTIMISATION JOB
// ═══════════════════════════════════════════════════════════════════════

interface OptimJob {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  startedAt: number;
  iter: number;
  maxIterations: number;
  bestScore: number;
  currentScores: Record<string, number>;
  elapsedMs: number;
  estimatedTotalMs: number;
  year: number;
  startMonth: number;
  months: number;
  schedulerConfig: any;
  targets: any;
  result?: { assignments: any[]; scores: any; iterations: number };
  error?: string;
}

let currentJob: OptimJob | null = null;

/** All SSE responses that are currently subscribed to job progress. */
const sseOptimClients = new Set<any>();

function broadcastOptimSSE(payload: any) {
  if (sseOptimClients.size === 0) return;
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseOptimClients) {
    try { res.write(line); } catch { /* client gone, will be removed on close */ }
  }
}

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
  // Preserve server-managed flags that the admin frontend doesn't send
  const existing = loadState();
  // If the new state has no shift plan, clear plan-related flags
  const hasShiftPlan = !!(req.body.shiftPlan && req.body.shiftPlan.assignments && req.body.shiftPlan.assignments.length > 0);
  const merged = {
    ...req.body,
    employeesLocked: hasShiftPlan ? (existing.employeesLocked ?? false) : false,
    planReleased: hasShiftPlan ? (existing.planReleased ?? false) : false,
    swapOffers: hasShiftPlan ? (existing.swapOffers ?? []) : [],
    swapMatches: hasShiftPlan ? (existing.swapMatches ?? []) : [],
  };
  saveState(merged);
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
    const state = loadState();
    const departments = state.departments || [];
    const result = generateAutomaticShiftPlan(
      employees,
      year,
      startMonth,
      months,
      schedulerConfig,
      departments,
    );

    // Clear swap offers and matches when a new plan is generated
    // (old assignments no longer exist in the new plan)
    state.swapOffers = [];
    state.swapMatches = [];
    saveState(state);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Equality optimiser (synchronous — fast) ─────────────────────────

app.post('/api/optimize-equality', authMiddleware, (req, res) => {
  try {
    const data = reviveDates(req.body);
    const { employees, schedulerConfig, baselineAssignments } = data;
    const maxIterations = data.maxIterations ?? 500;
    const year = data.year ?? new Date().getFullYear();
    const startMonth = data.startMonth ?? 0;
    const months = data.months ?? 12;
    const state = loadState();
    const departments = state.departments || [];

    const result = runEqualityOptimiser(
      employees,
      baselineAssignments,
      schedulerConfig,
      maxIterations,
      undefined,
      departments,
    );

    // Recompute violations for the optimised assignments
    const violations = detectViolations(
      employees,
      result.assignments,
      schedulerConfig,
      year,
      startMonth,
      months,
    );

    res.json({ ...result, violations });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Total-balance optimiser (Step 2b) ───────────────────────────────────

app.post('/api/optimize-total-balance', authMiddleware, (req, res) => {
  try {
    const data = reviveDates(req.body);
    const { employees, schedulerConfig, baselineAssignments } = data;
    const maxIterations = data.maxIterations ?? 500;
    const year = data.year ?? new Date().getFullYear();
    const startMonth = data.startMonth ?? 0;
    const months = data.months ?? 12;
    const state = loadState();
    const departments = state.departments || [];

    const result = runTotalBalanceOptimiser(
      employees,
      baselineAssignments,
      schedulerConfig,
      maxIterations,
      departments,
    );

    const violations = detectViolations(
      employees,
      result.assignments,
      schedulerConfig,
      year,
      startMonth,
      months,
    );

    res.json({ ...result, violations });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Optimise — starts/joins a persistent background job ─────────────────

app.post('/api/optimize', authMiddleware, (req, res) => {
  // If a job is already running, reject (client should subscribe instead)
  if (currentJob?.status === 'running') {
    res.status(409).json({ error: 'Optimierung läuft bereits', jobId: currentJob.id });
    return;
  }

  // Set SSE headers so the initiating response also gets the stream
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  sseOptimClients.add(res);
  res.on('close', () => sseOptimClients.delete(res));

  const data = reviveDates(req.body);
  const { employees, schedulerConfig, year, startMonth } = data;
  const months = data.months ?? 12;
  const optimiserConfig = data.optimiserConfig ?? { maxIterations: 5000, targets: { overall: true, verschieben: true, nacht: true, frueh: true } };
  const { maxIterations, targets } = optimiserConfig;
  // Optional: caller can supply a pre-optimised baseline (e.g. from the equality step)
  const suppliedBaseline: any[] | undefined = data.baselineAssignments;
  const suppliedBaselineViolations: any[] | undefined = data.baselineViolations;
  const stateForDepts = loadState();
  const departments = stateForDepts.departments || [];

  // Create the persistent job record
  const job: OptimJob = {
    id: Date.now().toString(),
    status: 'running',
    startedAt: Date.now(),
    iter: 0,
    maxIterations,
    bestScore: 0,
    currentScores: {},
    elapsedMs: 0,
    estimatedTotalMs: 0,
    year,
    startMonth,
    months,
    schedulerConfig,
    targets,
  };
  currentJob = job;

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

  // ── Per-pool per-type range helpers (prevent worsening) ──────────────
  const SHIFT_TYPES: string[] = ['verschieben', 'nachtbereitschaft', 'fruehschicht'];
  function sGroupKey(e: any): string {
    const allowed = [...(e.allowedShiftTypes ?? ['fruehschicht', 'verschieben', 'nachtbereitschaft'])].sort().join(',');
    return `${allowed}|${e.isOver55 ? '55+' : '<55'}`;
  }
  function sBuildPools(emps: any[]): { label: string; pool: any[] }[] {
    const pMap = new Map<string, any[]>();
    for (const emp of emps) {
      const key = sGroupKey(emp);
      if (!pMap.has(key)) pMap.set(key, []);
      pMap.get(key)!.push(emp);
    }
    return Array.from(pMap.entries()).map(([k, p]) => ({ label: k, pool: p }));
  }
  function sPerTypeRanges(pool: any[], assigns: any[]): Record<string, number> {
    const r: Record<string, number> = {};
    for (const st of SHIFT_TYPES) {
      if (pool.length === 0) { r[st] = 0; continue; }
      const counts = pool.map((e: any) => assigns.filter((a: any) => a.shiftType === st && a.employees.includes(e.id)).length);
      r[st] = Math.max(...counts) - Math.min(...counts);
    }
    return r;
  }
  function sWorsensRanges(pools: { label: string; pool: any[] }[], baseRanges: Map<string, Record<string, number>>, candidate: any[]): boolean {
    for (const { label, pool } of pools) {
      const baseR = baseRanges.get(label)!;
      const newR = sPerTypeRanges(pool, candidate);
      if (SHIFT_TYPES.some(t => newR[t] > baseR[t])) return true;
    }
    return false;
  }

  // Baseline — use supplied baseline if available (from equality optimizer), otherwise generate fresh
  const baselineResult = suppliedBaseline && suppliedBaseline.length > 0
    ? { assignments: suppliedBaseline, violations: suppliedBaselineViolations || [] as any[] }
    : generateAutomaticShiftPlan(employees, year, startMonth, months, schedulerConfig, departments);

  // Record baseline per-type ranges per pool (must never be worsened)
  const sPools = sBuildPools(employees);
  const sBaselineRangesPerPool = new Map<string, Record<string, number>>();
  for (const { label, pool } of sPools) {
    sBaselineRangesPerPool.set(label, sPerTypeRanges(pool, baselineResult.assignments));
  }

  let bestAssignments = baselineResult.assignments;
  let bestViolations = baselineResult.violations;
  let bestScores = computeFairnessScores(employees, bestAssignments);
  let bestComposite = compositeScore(bestScores, targets);
  job.bestScore = bestComposite;
  job.currentScores = { ...bestScores };

  const progressInterval = Math.max(1, Math.floor(maxIterations / 200));
  const CHUNK_SIZE = Math.max(1, Math.min(10, progressInterval));
  const t0 = Date.now();
  let iter = 0;

  function runChunk() {
    // Stop if job was cancelled or replaced
    if (job !== currentJob || job.status === 'cancelled') return;

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
          // Update persistent job state
          job.iter = iter;
          job.elapsedMs = elapsedMs;
          job.estimatedTotalMs = estimatedTotalMs;
          broadcastOptimSSE({ type: 'progress', progress });
        }

        const shuffled = shuffle([...employees]);
        const { assignments: candidate, violations: candidateViolations } = generateAutomaticShiftPlan(shuffled, year, startMonth, months, schedulerConfig, departments);

        // Skip candidate if it worsens per-pool per-type ranges
        if (sWorsensRanges(sPools, sBaselineRangesPerPool, candidate)) continue;

        const candidateScores = computeFairnessScores(employees, candidate);
        const candidateComposite = compositeScore(candidateScores, targets);
        if (candidateComposite > bestComposite) {
          bestAssignments = candidate;
          bestViolations = candidateViolations;
          bestScores = { ...candidateScores };
          bestComposite = candidateComposite;
          job.bestScore = bestComposite;
          job.currentScores = { ...bestScores };
        }
      }

      if (iter >= maxIterations) {
        // Done — update job
        const totalElapsed = Date.now() - t0;
        job.iter = maxIterations;
        job.elapsedMs = totalElapsed;
        job.estimatedTotalMs = totalElapsed;
        job.status = 'done';
        job.result = { assignments: bestAssignments, violations: bestViolations, scores: bestScores, iterations: maxIterations };

        const doneProgress = {
          iteration: maxIterations, maxIterations, bestScore: bestComposite,
          currentScores: { ...bestScores }, elapsedMs: totalElapsed, estimatedTotalMs: totalElapsed, done: true,
        };
        broadcastOptimSSE({ type: 'progress', progress: doneProgress });
        broadcastOptimSSE({ type: 'result', result: job.result });

        // ── Auto-save the optimised plan to state.json ───────────────────
        try {
          const st = loadState();
          st.shiftPlan = {
            year,
            startMonth,
            months,
            schedulerConfig,
            violations: bestViolations,
            assignments: bestAssignments,
            algorithm: 'fairness-optimiert',
          } as any;
          saveState(st);
        } catch (saveErr) {
          console.error('[optimize] auto-save failed:', saveErr);
        }

        // Close all subscriber streams
        for (const client of sseOptimClients) {
          try { client.end(); } catch {}
        }
        sseOptimClients.clear();
      } else {
        setImmediate(runChunk);
      }
    } catch (chunkErr) {
      job.status = 'error';
      job.error = String(chunkErr);
      broadcastOptimSSE({ type: 'error', error: String(chunkErr) });
      for (const client of sseOptimClients) {
        try { client.end(); } catch {}
      }
      sseOptimClients.clear();
    }
  }

  try {
    runChunk();
  } catch (err) {
    job.status = 'error';
    job.error = String(err);
    broadcastOptimSSE({ type: 'error', error: String(err) });
    res.end();
  }
});

// ── Get current optimisation job status (poll endpoint) ─────────────────────

app.get('/api/optimize/status', authMiddleware, (_req, res) => {
  if (!currentJob) {
    res.json({ status: 'idle' });
    return;
  }
  res.json({
    id: currentJob.id,
    status: currentJob.status,
    startedAt: currentJob.startedAt,
    iter: currentJob.iter,
    maxIterations: currentJob.maxIterations,
    bestScore: currentJob.bestScore,
    currentScores: currentJob.currentScores,
    elapsedMs: currentJob.elapsedMs,
    estimatedTotalMs: currentJob.estimatedTotalMs,
    year: currentJob.year,
    startMonth: currentJob.startMonth,
    months: currentJob.months,
    schedulerConfig: currentJob.schedulerConfig,
    targets: currentJob.targets,
    hasResult: !!currentJob.result,
    error: currentJob.error,
  });
});

// ── Subscribe to live optimisation progress (SSE reconnect) ─────────────────

app.get('/api/optimize/subscribe', authMiddleware, (req, res) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  if (!currentJob || currentJob.status !== 'running') {
    // Send current snapshot and close immediately if not running
    if (currentJob?.status === 'done' && currentJob.result) {
      const doneProgress = {
        iteration: currentJob.maxIterations, maxIterations: currentJob.maxIterations,
        bestScore: currentJob.bestScore, currentScores: currentJob.currentScores,
        elapsedMs: currentJob.elapsedMs, estimatedTotalMs: currentJob.elapsedMs, done: true,
      };
      res.write(`data: ${JSON.stringify({ type: 'progress', progress: doneProgress })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'result', result: currentJob.result })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ type: 'idle' })}\n\n`);
    }
    res.end();
    return;
  }

  // Send current progress immediately so UI restores state without a gap
  const currentProgress = {
    iteration: currentJob.iter, maxIterations: currentJob.maxIterations,
    bestScore: currentJob.bestScore, currentScores: currentJob.currentScores,
    elapsedMs: currentJob.elapsedMs, estimatedTotalMs: currentJob.estimatedTotalMs, done: false,
  };
  res.write(`data: ${JSON.stringify({ type: 'progress', progress: currentProgress })}\n\n`);

  sseOptimClients.add(res);
  res.on('close', () => sseOptimClients.delete(res));
});

// ── Cancel running optimisation ──────────────────────────────────────────────

app.post('/api/optimize/cancel', authMiddleware, (_req, res) => {
  if (currentJob?.status === 'running') {
    currentJob.status = 'cancelled';
    broadcastOptimSSE({ type: 'cancelled' });
    for (const client of sseOptimClients) {
      try { client.end(); } catch {}
    }
    sseOptimClients.clear();
  }
  res.json({ ok: true });
});

// ── Clear finished job record ────────────────────────────────────────────────

app.delete('/api/optimize', authMiddleware, (_req, res) => {
  if (currentJob?.status !== 'running') {
    currentJob = null;
  }
  res.json({ ok: true });
});

// ── Fairness impact preview (runs in worker thread to keep event loop free) ──

app.post('/api/fairness', authMiddleware, (req, res) => {
  const { employees, config, year, startMonth } = reviveDates(req.body);

  const worker = new Worker(FAIRNESS_WORKER_PATH, {
    workerData: { employees, config, year, startMonth },
  });

  let replied = false;

  worker.once('message', (msg: { result?: any; error?: string }) => {
    replied = true;
    if (msg.error) {
      res.status(500).json({ error: msg.error });
    } else {
      res.json(msg.result);
    }
  });

  worker.once('error', (err) => {
    replied = true;
    res.status(500).json({ error: String(err) });
  });

  // Only terminate worker if client disconnects before we've replied
  res.on('close', () => { if (!replied) worker.terminate(); });
});

// ── Calibrate (tiny 3-iteration run to measure performance) ─────────

app.post('/api/calibrate', authMiddleware, (req, res) => {
  try {
    const { employees, schedulerConfig, year, startMonth, targets } =
      reviveDates(req.body);
    const state = loadState();
    const departments = state.departments || [];
    const CALIBRATION_ITERS = 3;
    const t0 = Date.now();
    runOptimiser(employees, year, startMonth, 12, schedulerConfig, {
      maxIterations: CALIBRATION_ITERS,
      targets,
    }, undefined, departments);
    const elapsed = Date.now() - t0;
    res.json({ msPerIteration: elapsed / CALIBRATION_ITERS });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// EMPLOYEE PORTAL API
// ═══════════════════════════════════════════════════════════════════════

/** Admin endpoint: get credential info for all employees */
app.get('/api/portal/credentials', authMiddleware, (_req, res) => {
  res.json(getAllCredentialInfo());
});

/** Admin endpoint: invite employee (create/reset credentials + send email) */
app.post('/api/portal/invite', authMiddleware, async (req, res) => {
  try {
    const { employeeId, email: providedEmail } = req.body;
    const state = loadState();
    const emp = (state.employees || []).find((e: any) => e.id === employeeId);
    if (!emp) { res.status(404).json({ error: 'Mitarbeiter nicht gefunden' }); return; }
    // If an email was provided in the request, save it to the employee first
    if (providedEmail && typeof providedEmail === 'string' && providedEmail.trim()) {
      emp.email = providedEmail.trim();
      saveState(state);
    }
    if (!emp.email) { res.status(400).json({ error: 'Keine E-Mail-Adresse hinterlegt' }); return; }

    const { username, oneTimePassword } = createOrResetCredentials(employeeId, emp.name);

    // Update portalStatus
    emp.portalStatus = 'invited';
    saveState(state);

    await sendInvitationEmail(emp.email, emp.name, username, oneTimePassword);
    res.json({ success: true, username });
  } catch (err) {
    console.error('[portal/invite]', err);
    res.status(500).json({ error: String(err) });
  }
});

/** Admin endpoint: resend credentials (new OTP, same username) */
app.post('/api/portal/resend', authMiddleware, async (req, res) => {
  try {
    const { employeeId } = req.body;
    const state = loadState();
    const emp = (state.employees || []).find((e: any) => e.id === employeeId);
    if (!emp) { res.status(404).json({ error: 'Mitarbeiter nicht gefunden' }); return; }
    if (!emp.email) { res.status(400).json({ error: 'Keine E-Mail-Adresse hinterlegt' }); return; }

    const { username, oneTimePassword } = createOrResetCredentials(employeeId, emp.name);
    await sendInvitationEmail(emp.email, emp.name, username, oneTimePassword);
    res.json({ success: true, username });
  } catch (err) {
    console.error('[portal/resend]', err);
    res.status(500).json({ error: String(err) });
  }
});

/** Employee portal login */
app.post('/api/portal/login', (req, res) => {
  const { username, password } = req.body ?? {};
  const result = authenticateEmployee(username, password);
  if (!result) {
    res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    return;
  }
  res.json(result);
});

/** Portal auth middleware */
function portalAuthMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const employeeId = validatePortalToken(token);
  if (!employeeId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  (req as any).employeeId = employeeId;
  next();
}

/** Portal: change password */
app.post('/api/portal/change-password', portalAuthMiddleware, (req, res) => {
  const employeeId = (req as any).employeeId;
  const { newPassword } = req.body ?? {};
  if (!newPassword || newPassword.length < 6) {
    res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
    return;
  }
  changePassword(employeeId, newPassword);
  res.json({ success: true });
});

/** Portal: get own data (employee info, shifts, labels, vacation, preferences) */
app.get('/api/portal/my-data', portalAuthMiddleware, (req, res) => {
  const employeeId = (req as any).employeeId;
  const state = loadState();
  const emp = (state.employees || []).find((e: any) => e.id === employeeId);
  if (!emp) { res.status(404).json({ error: 'Mitarbeiter nicht gefunden' }); return; }

  const plan = state.shiftPlan;
  const released = !!state.planReleased;

  // Own shift assignments
  const myAssignments = plan?.assignments?.filter((a: any) =>
    (a.employees || []).includes(employeeId)
  ) || [];

  // Labels visible to employee (filtered by visibleToEmployee flag)
  const visibleLabels = (state.labels || []).filter((l: any) => l.visibleToEmployee !== false);
  const visibleLabelIds = new Set(visibleLabels.map((l: any) => l.id));
  const myCalendarLabels = (state.calendarLabels || []).filter(
    (cl: any) => cl.employeeId === employeeId && visibleLabelIds.has(cl.labelId)
  );

  // Department
  const dept = (state.departments || []).find((d: any) => d.id === emp.department);

  res.json({
    employee: {
      id: emp.id,
      name: emp.name,
      department: dept?.name || '',
      isOver55: emp.isOver55,
      hasL2: emp.hasL2,
      allowedShiftTypes: emp.allowedShiftTypes || ['fruehschicht', 'verschieben', 'nachtbereitschaft'],
      vacationDays: emp.vacationDays || [],
      vacationRanges: emp.vacationRanges || [],
      preferences: emp.preferences || [],
      portalStatus: emp.portalStatus || 'none',
    },
    planReleased: released,
    employeesLocked: !!state.employeesLocked,
    planYear: plan?.year,
    planStartMonth: plan?.startMonth ?? 0,
    planMonths: plan?.months ?? 12,
    assignments: released ? myAssignments : [],
    labels: released ? visibleLabels : [],
    calendarLabels: released ? myCalendarLabels : [],
    customHolidays: state.customHolidays || [],
    swapSettings: state.swapSettings || { enabled: false, onlyWithinDepartment: false, onlyWithinShiftType: false },
    departmentId: emp.department || null,
  });
});

/** Portal: save vacation + preferences (draft or submit) */
app.put('/api/portal/my-data', portalAuthMiddleware, (req, res) => {
  const employeeId = (req as any).employeeId;
  const state = loadState();

  // Check if plan is released → editing locked
  if (state.planReleased) {
    res.status(403).json({ error: 'Schichtplan ist freigegeben. Änderungen sind gesperrt.' });
    return;
  }

  // Check if admin locked employee changes
  if (state.employeesLocked) {
    res.status(403).json({ error: 'Änderungen wurden vom Administrator gesperrt.' });
    return;
  }

  const emp = (state.employees || []).find((e: any) => e.id === employeeId);
  if (!emp) { res.status(404).json({ error: 'Mitarbeiter nicht gefunden' }); return; }

  // If already submitted, don't allow re-submit
  if (emp.portalStatus === 'submitted') {
    res.status(403).json({ error: 'Ihre Daten wurden bereits eingereicht. Änderungen sind nicht mehr möglich.' });
    return;
  }

  const { vacationRanges, preferences, action } = reviveDates(req.body);

  emp.vacationRanges = vacationRanges ?? emp.vacationRanges;
  emp.preferences = preferences ?? emp.preferences;
  emp.portalStatus = action === 'submit' ? 'submitted' : 'draft';

  saveState(state);
  res.json({ success: true, portalStatus: emp.portalStatus });
});

/** Admin: reset an employee's portalStatus back to 'draft' */
app.post('/api/portal/reset-status', authMiddleware, (req, res) => {
  const { employeeId } = req.body ?? {};
  if (!employeeId) { res.status(400).json({ error: 'employeeId fehlt' }); return; }
  const state = loadState();
  const emp = (state.employees || []).find((e: any) => e.id === employeeId);
  if (!emp) { res.status(404).json({ error: 'Mitarbeiter nicht gefunden' }); return; }
  emp.portalStatus = 'draft';
  saveState(state);
  res.json({ success: true, portalStatus: 'draft' });
});

// ═══════════════════════════════════════════════════════════════════════
// EMPLOYEE LOCK
// ═══════════════════════════════════════════════════════════════════════

/** Admin: toggle employee changes lock */
app.post('/api/employees/lock', authMiddleware, (req, res) => {
  const { locked } = req.body;
  const state = loadState();
  state.employeesLocked = !!locked;
  saveState(state);
  res.json({ success: true, employeesLocked: state.employeesLocked });
});

app.get('/api/employees/lock', authMiddleware, (_req, res) => {
  const state = loadState();
  res.json({ employeesLocked: !!state.employeesLocked });
});

// ═══════════════════════════════════════════════════════════════════════
// STATE VERSION (for real-time polling)
// ═══════════════════════════════════════════════════════════════════════

/** Returns a hash/timestamp of current state for change detection */
app.get('/api/state/version', (_req, res) => {
  try {
    const statPath = path.join(__dirname, '..', 'data', 'state.json');
    const stat = fs.statSync(statPath);
    res.json({ version: stat.mtimeMs.toString() });
  } catch {
    res.json({ version: '0' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PLAN RELEASE
// ═══════════════════════════════════════════════════════════════════════

/** Admin: release or unrelease the shift plan */
app.post('/api/plan/release', authMiddleware, async (req, res) => {
  try {
    const { released } = req.body;
    const state = loadState();
    state.planReleased = !!released;
    saveState(state);

    // If releasing, send email to all employees with email addresses who are ACTIVE
    if (released) {
      const credInfo = getAllCredentialInfo();
      const employees = state.employees || [];
      for (const emp of employees) {
        if (emp.email) {
          // Only notify employees who have logged in at least once (mustChangePassword === false)
          const cred = credInfo[emp.id];
          if (!cred || cred.mustChangePassword) continue;
          try {
            await sendPlanNotificationEmail(
              emp.email,
              emp.name,
              'Ihr Schichtplan wurde freigegeben. Sie können ihn jetzt im Portal einsehen.'
            );
          } catch (mailErr) {
            console.error(`[plan/release] Failed to notify ${emp.name}:`, mailErr);
          }
        }
      }
    } else {
      // When un-releasing, automatically lock employee changes
      state.employeesLocked = true;
      saveState(state);
    }

    res.json({ success: true, planReleased: state.planReleased });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Admin: get plan release status */
app.get('/api/plan/release', authMiddleware, (_req, res) => {
  const state = loadState();
  res.json({ released: !!state.planReleased });
});

/** Admin: notify a single employee about changes */
app.post('/api/portal/notify', authMiddleware, async (req, res) => {
  try {
    const { employeeId, message } = req.body;
    const state = loadState();
    const emp = (state.employees || []).find((e: any) => e.id === employeeId);
    if (!emp?.email) { res.status(400).json({ error: 'Keine E-Mail' }); return; }
    await sendPlanNotificationEmail(emp.email, emp.name, message || 'Ihr Schichtplan wurde aktualisiert.');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// SHIFT SWAP API
// ═══════════════════════════════════════════════════════════════════════

/** Helper: load swap data from state (stored in state.swapOffers / state.swapMatches) */
function loadSwapOffers(): any[] { return loadState().swapOffers || []; }
function loadSwapMatches(): any[] { return loadState().swapMatches || []; }
function saveSwapOffers(offers: any[]) { const s = loadState(); s.swapOffers = offers; saveState(s); }
function saveSwapMatches(matches: any[]) { const s = loadState(); s.swapMatches = matches; saveState(s); }

/** Admin: get all swap offers and matches */
app.get('/api/swaps', authMiddleware, (_req, res) => {
  const state = loadState();
  res.json({
    offers: state.swapOffers || [],
    matches: state.swapMatches || [],
    settings: state.swapSettings || { enabled: false, onlyWithinDepartment: false, onlyWithinShiftType: false },
  });
});

/** Portal: create a swap offer (employee wants to trade a shift) */
app.post('/api/portal/swap-offer', portalAuthMiddleware, (req, res) => {
  try {
    const employeeId = (req as any).employeeId;
    const state = loadState();

    // Check swap is enabled
    const swapSettings = state.swapSettings || { enabled: false };
    if (!swapSettings.enabled) {
      res.status(403).json({ error: 'Schichttausch ist nicht aktiviert.' });
      return;
    }

    // Check plan is released
    if (!state.planReleased) {
      res.status(403).json({ error: 'Schichtplan ist noch nicht freigegeben.' });
      return;
    }

    const { assignmentId, willingRanges, willingShiftTypes } = req.body;

    // Find the assignment
    const plan = state.shiftPlan;
    if (!plan) { res.status(400).json({ error: 'Kein Schichtplan vorhanden.' }); return; }

    const assignment = (plan.assignments || []).find((a: any) => a.id === assignmentId);
    if (!assignment) { res.status(404).json({ error: 'Schicht nicht gefunden.' }); return; }
    if (!assignment.employees.includes(employeeId)) {
      res.status(403).json({ error: 'Sie sind dieser Schicht nicht zugewiesen.' });
      return;
    }

    // Check for existing open offer from this employee for this assignment
    const offers = state.swapOffers || [];
    const existing = offers.find((o: any) => o.employeeId === employeeId && o.assignmentId === assignmentId && o.status === 'open');
    if (existing) {
      res.status(409).json({ error: 'Sie haben diese Schicht bereits zum Tausch angeboten.' });
      return;
    }

    const offer = {
      id: `swap-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      employeeId,
      assignmentId,
      shiftType: assignment.shiftType,
      startDate: assignment.startDate,
      endDate: assignment.endDate,
      willingRanges: willingRanges || [],
      willingShiftTypes: willingShiftTypes || [assignment.shiftType],
      createdAt: new Date().toISOString(),
      status: 'open',
    };

    offers.push(offer);
    state.swapOffers = offers;
    saveState(state);

    // Try to find matches asynchronously
    findAndCreateMatches(state);

    res.json({ success: true, offer });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Portal: withdraw a swap offer */
app.post('/api/portal/swap-offer/withdraw', portalAuthMiddleware, (req, res) => {
  const employeeId = (req as any).employeeId;
  const { offerId } = req.body;

  const state = loadState();
  const offers = state.swapOffers || [];
  const offer = offers.find((o: any) => o.id === offerId);
  if (!offer) { res.status(404).json({ error: 'Angebot nicht gefunden.' }); return; }
  if (offer.employeeId !== employeeId) { res.status(403).json({ error: 'Nicht Ihr Angebot.' }); return; }
  if (offer.status !== 'open') { res.status(400).json({ error: 'Angebot ist nicht mehr aktiv.' }); return; }

  offer.status = 'withdrawn';

  // Invalidate any pending matches that reference this withdrawn offer
  const matches = state.swapMatches || [];
  for (const m of matches) {
    if (m.status !== 'pending') continue;
    const refsOffer = m.offerA === offerId || m.offerB === offerId ||
      (m.ringOffers && m.ringOffers.includes(offerId));
    if (refsOffer) {
      m.status = 'rejected';
      m.resolvedAt = new Date().toISOString();
    }
  }
  state.swapMatches = matches;

  state.swapOffers = offers;
  saveState(state);
  res.json({ success: true });
});

/** Portal: get own swap offers */
app.get('/api/portal/swap-offers', portalAuthMiddleware, (req, res) => {
  const employeeId = (req as any).employeeId;
  const state = loadState();
  const offers = (state.swapOffers || []).filter((o: any) => o.employeeId === employeeId);
  const matches = (state.swapMatches || []).filter((m: any) => {
    const offerIds = offers.map((o: any) => o.id);
    return offerIds.includes(m.offerA) || offerIds.includes(m.offerB);
  });
  res.json({
    offers,
    matches,
    swapSettings: state.swapSettings || { enabled: false, onlyWithinDepartment: false, onlyWithinShiftType: false },
  });
});

/** Admin: check rule violations for a swap match before approving */
app.post('/api/swaps/check-violations', authMiddleware, (req, res) => {
  try {
    const { matchId } = req.body;
    const state = loadState();
    const matches = state.swapMatches || [];
    const match = matches.find((m: any) => m.id === matchId);
    if (!match) { res.status(404).json({ error: 'Match nicht gefunden.' }); return; }

    const offers = state.swapOffers || [];
    const plan = state.shiftPlan;
    if (!plan) { res.status(400).json({ error: 'Kein Schichtplan.', violations: [] }); return; }

    const employees = state.employees || [];
    const config = plan.schedulerConfig || state.schedulerConfig;
    const departments = state.departments || [];

    const SHIFT_LABELS: Record<string, string> = {
      fruehschicht: 'Frühschicht (WE)',
      verschieben: 'Verschobene Schicht',
      nachtbereitschaft: 'Nachtbereitschaft',
    };

    const violationMessages: string[] = [];

    const isRing = match.ringOffers && match.ringOffers.length >= 3;

    // Build simulated assignments
    const tempAssignments = (plan.assignments || []).map((a: any) => ({
      ...a,
      employees: [...(a.employees || [])],
      startDate: new Date(a.startDate),
      endDate: new Date(a.endDate),
    }));
    const assignmentsWithoutSwap = (plan.assignments || []).map((a: any) => ({
      ...a,
      employees: [...(a.employees || [])],
      startDate: new Date(a.startDate),
      endDate: new Date(a.endDate),
    }));

    if (isRing) {
      // ── Ring swap simulation ──
      const ringOfferIds: string[] = match.ringOffers;
      const ringOffers = ringOfferIds.map((id: string) => offers.find((o: any) => o.id === id));
      if (ringOffers.some((o: any) => !o)) { res.status(400).json({ error: 'Angebote nicht gefunden.', violations: [] }); return; }

      const n = ringOffers.length;
      // Simulate ring swap on tempAssignments: assignment[i] gets emp[(i-1+n)%n]
      for (let i = 0; i < n; i++) {
        const t = tempAssignments.find((a: any) => a.id === ringOffers[i].assignmentId);
        if (t) {
          t.employees = t.employees.filter((id: string) => id !== ringOffers[i].employeeId);
          t.employees.push(ringOffers[(i - 1 + n) % n].employeeId);
        }
      }

      // Check each employee can take the new shift
      for (let i = 0; i < n; i++) {
        const emp = employees.find((e: any) => e.id === ringOffers[i].employeeId);
        // Employee i takes the shift of employee (i-1+n)%n (previous in ring)
        const targetOffer = ringOffers[(i - 1 + n) % n];
        const targetAssignment = (plan.assignments || []).find((a: any) => a.id === targetOffer.assignmentId);
        if (emp && targetAssignment) {
          const otherAssignments = assignmentsWithoutSwap
            .filter((a: any) => a.id !== targetAssignment.id)
            .map((a: any) => ({ ...a, employees: a.employees.filter((id: string) => id !== emp.id) }));
          const canTake = getAvailableEmployeesSorted(
            [emp], targetAssignment.shiftType,
            new Date(targetAssignment.startDate), new Date(targetAssignment.endDate),
            otherAssignments, config, departments,
          );
          if (canTake.length === 0) {
            const dt = new Date(targetAssignment.startDate).toLocaleDateString('de-DE');
            violationMessages.push(
              `${emp.name} kann ${SHIFT_LABELS[targetAssignment.shiftType] || targetAssignment.shiftType} ab ${dt} nicht übernehmen (Regelkonflikt)`
            );
          }
        }
      }
    } else {
      // ── Direct swap simulation ──
      const offerA = offers.find((o: any) => o.id === match.offerA);
      const offerB = offers.find((o: any) => o.id === match.offerB);
      if (!offerA || !offerB) { res.status(400).json({ error: 'Angebote nicht gefunden.', violations: [] }); return; }

      const assignmentA = (plan.assignments || []).find((a: any) => a.id === offerA.assignmentId);
      const assignmentB = (plan.assignments || []).find((a: any) => a.id === offerB.assignmentId);
      if (!assignmentA || !assignmentB) { res.status(400).json({ error: 'Schichten nicht gefunden.', violations: [] }); return; }

      const tA = tempAssignments.find((a: any) => a.id === offerA.assignmentId);
      const tB = tempAssignments.find((a: any) => a.id === offerB.assignmentId);
      if (tA && tB) {
        tA.employees = tA.employees.filter((id: string) => id !== offerA.employeeId);
        tA.employees.push(offerB.employeeId);
        tB.employees = tB.employees.filter((id: string) => id !== offerB.employeeId);
        tB.employees.push(offerA.employeeId);
      }

      const empA = employees.find((e: any) => e.id === offerA.employeeId);
      const empB = employees.find((e: any) => e.id === offerB.employeeId);

      if (empA && assignmentB) {
        const otherAssignments = assignmentsWithoutSwap
          .filter((a: any) => a.id !== assignmentB.id)
          .map((a: any) => ({ ...a, employees: a.employees.filter((id: string) => id !== offerA.employeeId) }));
        const canTake = getAvailableEmployeesSorted(
          [empA], assignmentB.shiftType,
          new Date(assignmentB.startDate), new Date(assignmentB.endDate),
          otherAssignments, config, departments,
        );
        if (canTake.length === 0) {
          const dt = new Date(assignmentB.startDate).toLocaleDateString('de-DE');
          violationMessages.push(
            `${empA.name} kann ${SHIFT_LABELS[assignmentB.shiftType] || assignmentB.shiftType} ab ${dt} nicht übernehmen (Regelkonflikt)`
          );
        }
      }

      if (empB && assignmentA) {
        const otherAssignments = assignmentsWithoutSwap
          .filter((a: any) => a.id !== assignmentA.id)
          .map((a: any) => ({ ...a, employees: a.employees.filter((id: string) => id !== offerB.employeeId) }));
        const canTake = getAvailableEmployeesSorted(
          [empB], assignmentA.shiftType,
          new Date(assignmentA.startDate), new Date(assignmentA.endDate),
          otherAssignments, config, departments,
        );
        if (canTake.length === 0) {
          const dt = new Date(assignmentA.startDate).toLocaleDateString('de-DE');
          violationMessages.push(
            `${empB.name} kann ${SHIFT_LABELS[assignmentA.shiftType] || assignmentA.shiftType} ab ${dt} nicht übernehmen (Regelkonflikt)`
          );
        }
      }
    }

    // Compare understaffing violations before vs after
    const beforeViolations = detectViolations(
      employees, assignmentsWithoutSwap, config,
      plan.year || new Date().getFullYear(),
      plan.startMonth ?? 0,
      plan.months ?? 12,
    );
    const afterViolations = detectViolations(
      employees, tempAssignments, config,
      plan.year || new Date().getFullYear(),
      plan.startMonth ?? 0,
      plan.months ?? 12,
    );
    const beforeIds = new Set(beforeViolations.map((v: any) => v.id));
    const newViolations = afterViolations.filter((v: any) => !beforeIds.has(v.id));
    for (const v of newViolations) {
      const dt = new Date(v.startDate).toLocaleDateString('de-DE');
      violationMessages.push(
        `${SHIFT_LABELS[v.shiftType] || v.shiftType} ab ${dt}: Unterbesetzung (${v.assigned}/${v.required})`
      );
    }

    res.json({ violations: violationMessages });
  } catch (err) {
    res.status(500).json({ error: 'Prüfung fehlgeschlagen.', violations: [] });
  }
});

/** Admin: approve or reject a swap match */
app.post('/api/swaps/resolve', authMiddleware, async (req, res) => {
  try {
    const { matchId, action } = req.body; // action = 'approve' | 'reject'
    const state = loadState();
    const matches = state.swapMatches || [];
    const match = matches.find((m: any) => m.id === matchId);
    if (!match) { res.status(404).json({ error: 'Match nicht gefunden.' }); return; }
    if (match.status !== 'pending') { res.status(400).json({ error: 'Match wurde bereits bearbeitet.' }); return; }

    if (action === 'reject') {
      match.status = 'rejected';
      match.resolvedAt = new Date().toISOString();
      state.swapMatches = matches;
      saveState(state);
      res.json({ success: true, match });
      return;
    }

    // Approve: execute the swap
    const offers = state.swapOffers || [];
    const plan = state.shiftPlan;
    if (!plan) { res.status(400).json({ error: 'Kein Schichtplan.' }); return; }

    const isRing = match.ringOffers && match.ringOffers.length >= 3;

    if (isRing) {
      // ── Ring swap: each offer[i]'s employee leaves their assignment,
      //    and the PREVIOUS person in the ring takes it (circular shift). ──
      const ringOfferIds: string[] = match.ringOffers;
      const ringOffers = ringOfferIds.map((id: string) => offers.find((o: any) => o.id === id));
      if (ringOffers.some((o: any) => !o)) { res.status(400).json({ error: 'Angebote nicht gefunden.' }); return; }

      const ringAssignments = ringOffers.map((o: any) =>
        (plan.assignments || []).find((a: any) => a.id === o.assignmentId)
      );
      if (ringAssignments.some((a: any) => !a)) { res.status(400).json({ error: 'Schichten nicht gefunden.' }); return; }

      // Execute ring: cycle [0→1→2→0] means emp[0] can take emp[1]'s shift, etc.
      // So emp[i] goes to assignment[(i+1)%n], meaning assignment[i] gets emp[(i-1+n)%n]
      const n = ringOffers.length;
      for (let i = 0; i < n; i++) {
        const assignment = ringAssignments[i];
        const currentEmpId = ringOffers[i].employeeId;
        const newEmpId = ringOffers[(i - 1 + n) % n].employeeId;
        assignment.employees = assignment.employees.filter((id: string) => id !== currentEmpId);
        assignment.employees.push(newEmpId);
      }

      // Mark all offers as matched
      for (const o of ringOffers) o.status = 'matched';
      match.status = 'approved';
      match.resolvedAt = new Date().toISOString();

      state.swapOffers = offers;
      state.swapMatches = matches;
      saveState(state);

      // Send emails to all ring participants
      const employees = state.employees || [];
      const allParticipantNames = ringOffers.map((o: any) => {
        const e = employees.find((emp: any) => emp.id === o.employeeId);
        return e?.name || 'Unbekannt';
      });
      for (let i = 0; i < n; i++) {
        const emp = employees.find((e: any) => e.id === ringOffers[i].employeeId);
        // Employee i gave away ringOffers[i] and received ringOffers[(i-1+n)%n]'s shift
        const receivedOffer = ringOffers[(i - 1 + n) % n];
        if (emp?.email) {
          try {
            await sendRingSwapMatchEmail(emp.email, emp.name, ringOffers[i], receivedOffer, allParticipantNames);
          } catch (e) { console.error('[ring-swap] mail failed:', e); }
        }
      }

      res.json({ success: true, match });
    } else {
      // ── Direct swap ──
      const offerA = offers.find((o: any) => o.id === match.offerA);
      const offerB = offers.find((o: any) => o.id === match.offerB);
      if (!offerA || !offerB) { res.status(400).json({ error: 'Angebote nicht gefunden.' }); return; }

      const assignmentA = (plan.assignments || []).find((a: any) => a.id === offerA.assignmentId);
      const assignmentB = (plan.assignments || []).find((a: any) => a.id === offerB.assignmentId);
      if (!assignmentA || !assignmentB) { res.status(400).json({ error: 'Schichten nicht gefunden.' }); return; }

      // Execute swap: remove each employee from their original, add to the other
      assignmentA.employees = assignmentA.employees.filter((id: string) => id !== offerA.employeeId);
      assignmentA.employees.push(offerB.employeeId);
      assignmentB.employees = assignmentB.employees.filter((id: string) => id !== offerB.employeeId);
      assignmentB.employees.push(offerA.employeeId);

      offerA.status = 'matched';
      offerB.status = 'matched';
      match.status = 'approved';
      match.resolvedAt = new Date().toISOString();

      state.swapOffers = offers;
      state.swapMatches = matches;
      saveState(state);

      // Send emails to both employees
      const employees = state.employees || [];
      const empA = employees.find((e: any) => e.id === offerA.employeeId);
      const empB = employees.find((e: any) => e.id === offerB.employeeId);

      if (empA?.email) {
        try {
          await sendSwapMatchEmail(empA.email, empA.name, empB?.name || 'Kollege/in', offerA, offerB);
        } catch (e) { console.error('[swap] mail to A failed:', e); }
      }
      if (empB?.email) {
        try {
          await sendSwapMatchEmail(empB.email, empB.name, empA?.name || 'Kollege/in', offerB, offerA);
        } catch (e) { console.error('[swap] mail to B failed:', e); }
      }

      res.json({ success: true, match });
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Admin: undo a resolved swap match */
app.post('/api/swaps/undo', authMiddleware, async (req, res) => {
  try {
    const { matchId } = req.body;
    const state = loadState();
    const matches = state.swapMatches || [];
    const match = matches.find((m: any) => m.id === matchId);
    if (!match) { res.status(404).json({ error: 'Match nicht gefunden.' }); return; }
    if (match.status === 'pending') { res.status(400).json({ error: 'Match ist noch ausstehend.' }); return; }

    const offers = state.swapOffers || [];
    const isRing = match.ringOffers && match.ringOffers.length >= 3;

    if (match.status === 'approved') {
      const plan = state.shiftPlan;

      if (isRing && plan) {
        // Reverse ring swap
        const ringOfferIds: string[] = match.ringOffers;
        const ringOffers = ringOfferIds.map((id: string) => offers.find((o: any) => o.id === id));
        const ringAssignments = ringOffers.map((o: any) =>
          o ? (plan.assignments || []).find((a: any) => a.id === o.assignmentId) : null
        );

        const n = ringOffers.length;
        for (let i = 0; i < n; i++) {
          if (!ringOffers[i] || !ringAssignments[i]) continue;
          const assignment = ringAssignments[i];
          const originalEmpId = ringOffers[i].employeeId;
          const swappedInEmpId = ringOffers[(i - 1 + n) % n].employeeId;
          // Remove the person who was swapped in, restore original
          assignment.employees = assignment.employees.filter((id: string) => id !== swappedInEmpId);
          if (!assignment.employees.includes(originalEmpId)) assignment.employees.push(originalEmpId);
        }

        // Only reset offers that are still 'matched' back to 'open'
        for (const o of ringOffers) { if (o && o.status === 'matched') o.status = 'open'; }
      } else {
        // Reverse direct swap
        const offerA = offers.find((o: any) => o.id === match.offerA);
        const offerB = offers.find((o: any) => o.id === match.offerB);

        if (offerA && offerB && plan) {
          const assignmentA = (plan.assignments || []).find((a: any) => a.id === offerA.assignmentId);
          const assignmentB = (plan.assignments || []).find((a: any) => a.id === offerB.assignmentId);
          if (assignmentA && assignmentB) {
            assignmentA.employees = assignmentA.employees.filter((id: string) => id !== offerB.employeeId);
            if (!assignmentA.employees.includes(offerA.employeeId)) assignmentA.employees.push(offerA.employeeId);
            assignmentB.employees = assignmentB.employees.filter((id: string) => id !== offerA.employeeId);
            if (!assignmentB.employees.includes(offerB.employeeId)) assignmentB.employees.push(offerB.employeeId);
          }
        }

        if (offerA && offerA.status === 'matched') offerA.status = 'open';
        if (offerB && offerB.status === 'matched') offerB.status = 'open';
      }
    }
    // For rejected matches: don't touch offer status at all

    // Check if all referenced offers are still open — if not, remove the match entirely
    const allOfferIds = isRing
      ? (match.ringOffers as string[])
      : [match.offerA, match.offerB];
    const allOpen = allOfferIds.every((id: string) => {
      const o = offers.find((x: any) => x.id === id);
      return o && o.status === 'open';
    });

    if (allOpen) {
      // All offers still active → set match back to pending
      match.status = 'pending';
      delete match.resolvedAt;
    } else {
      // At least one offer was withdrawn → remove the match
      const idx = matches.indexOf(match);
      if (idx !== -1) matches.splice(idx, 1);
    }

    state.swapOffers = offers;
    state.swapMatches = matches;
    saveState(state);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Match-finding logic: check if two open offers are compatible */
function findAndCreateMatches(state: any) {
  const offers: any[] = state.swapOffers || [];
  const matches: any[] = state.swapMatches || [];
  const swapSettings = state.swapSettings || { enabled: false, onlyWithinDepartment: false, onlyWithinShiftType: false, allowRingSwap: false };
  const employees = state.employees || [];

  // ── 0) Cleanup: invalidate pending matches that reference non-open offers ──
  for (const m of matches) {
    if (m.status !== 'pending') continue;
    const offerIds = (m.ringOffers && m.ringOffers.length > 0)
      ? m.ringOffers
      : [m.offerA, m.offerB];
    const hasInvalid = offerIds.some((id: string) => {
      const o = offers.find((x: any) => x.id === id);
      return !o || o.status !== 'open';
    });
    if (hasInvalid) {
      m.status = 'rejected';
      m.resolvedAt = new Date().toISOString();
    }
  }

  const openOffers = offers.filter((o: any) => o.status === 'open');

  // ── 1) Direct (pairwise) matches ─────────────────────────────────────
  for (let i = 0; i < openOffers.length; i++) {
    for (let j = i + 1; j < openOffers.length; j++) {
      const a = openOffers[i];
      const b = openOffers[j];

      // Don't match the same employee with themselves
      if (a.employeeId === b.employeeId) continue;

      // Check if already matched
      const alreadyMatched = matches.some((m: any) =>
        m.status === 'pending' &&
        ((m.offerA === a.id && m.offerB === b.id) || (m.offerA === b.id && m.offerB === a.id))
      );
      if (alreadyMatched) continue;

      // Department constraint
      if (swapSettings.onlyWithinDepartment) {
        const empA = employees.find((e: any) => e.id === a.employeeId);
        const empB = employees.find((e: any) => e.id === b.employeeId);
        if (empA?.department !== empB?.department) continue;
      }

      // Shift type constraint
      if (swapSettings.onlyWithinShiftType) {
        if (a.shiftType !== b.shiftType) continue;
      }

      // Check mutual compatibility:
      // A wants to get rid of their shift and is willing to work in B's timeframe (and vice versa)
      // A's willing ranges must overlap with B's shift dates
      // B's willing ranges must overlap with A's shift dates
      const aWillingForB = checkWillingMatch(a, b, swapSettings);
      const bWillingForA = checkWillingMatch(b, a, swapSettings);

      if (aWillingForB && bWillingForA) {
        const newMatch = {
          id: `match-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          offerA: a.id,
          offerB: b.id,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        matches.push(newMatch);
      }
    }
  }

  // ── 2) Ring swap matches (cycles of length 3+) ───────────────────────
  if (swapSettings.allowRingSwap && openOffers.length >= 3) {
    findRingMatches(openOffers, matches, swapSettings, employees);
  }

  state.swapMatches = matches;
  saveState(state);
}

/**
 * Find ring swaps: cycles A→B→C→…→A where each participant gives their
 * shift to the next person in the ring, and the last gives theirs to the first.
 *
 * Built as a directed graph where edge (offer_i → offer_j) means:
 *  - offer_i is willing to take offer_j's shift (type + time range match)
 *  - department constraints are satisfied
 *
 * Then we look for simple cycles of length 3..MAX_RING.
 */
function findRingMatches(
  openOffers: any[],
  matches: any[],
  swapSettings: any,
  employees: any[],
) {
  const MAX_RING = 5; // limit cycle length for performance

  // Build adjacency list: canTake[i] = indices j where offer[i] is willing to take offer[j]'s shift
  const n = openOffers.length;
  const canTake: number[][] = Array.from({ length: n }, () => []);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (openOffers[i].employeeId === openOffers[j].employeeId) continue;

      // Department constraint
      if (swapSettings.onlyWithinDepartment) {
        const empI = employees.find((e: any) => e.id === openOffers[i].employeeId);
        const empJ = employees.find((e: any) => e.id === openOffers[j].employeeId);
        if (empI?.department !== empJ?.department) continue;
      }

      // offer[i] is willing to accept offer[j]'s shift
      if (checkWillingMatch(openOffers[i], openOffers[j], swapSettings)) {
        canTake[i].push(j);
      }
    }
  }

  // DFS cycle detection: find all simple cycles of length 3..MAX_RING
  // Use a set of canonical keys to avoid duplicate cycles
  const foundCycleKeys = new Set<string>();

  // Only count offers in pending/approved matches as "already matched"
  const alreadyInMatch = new Set<string>();
  for (const m of matches) {
    if (m.status !== 'pending' && m.status !== 'approved') continue;
    if (m.ringOffers && m.ringOffers.length > 0) {
      for (const oid of m.ringOffers) alreadyInMatch.add(oid);
    } else {
      alreadyInMatch.add(m.offerA);
      alreadyInMatch.add(m.offerB);
    }
  }

  const newRingMatches: any[] = [];

  for (let startIdx = 0; startIdx < n; startIdx++) {
    // DFS from startIdx looking for cycles back to startIdx
    const path: number[] = [startIdx];
    const visited = new Set<number>([startIdx]);

    function dfs(current: number) {
      if (path.length > MAX_RING) return;

      for (const next of canTake[current]) {
        if (next === startIdx && path.length >= 3) {
          // Found a cycle! path = [startIdx, ..., current] → startIdx
          // Canonical key: rotate so smallest index is first, then join
          const cycle = [...path];
          const minIdx = cycle.indexOf(Math.min(...cycle));
          const rotated = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
          const key = rotated.join('-');

          if (foundCycleKeys.has(key)) continue;
          foundCycleKeys.add(key);

          // Check that none of the offers in this ring are already matched
          const ringOfferIds = cycle.map(idx => openOffers[idx].id);
          if (ringOfferIds.some(id => alreadyInMatch.has(id))) continue;

          // All employees in the ring must be distinct
          const empIds = cycle.map(idx => openOffers[idx].employeeId);
          if (new Set(empIds).size !== empIds.length) continue;

          // Create the ring match
          newRingMatches.push({
            id: `ring-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            offerA: ringOfferIds[0],
            offerB: ringOfferIds[1],
            ringOffers: ringOfferIds,
            status: 'pending',
            createdAt: new Date().toISOString(),
          });

          // Mark these offers as used so they don't appear in other rings
          for (const id of ringOfferIds) alreadyInMatch.add(id);
          return; // one ring per start is enough
        }

        if (visited.has(next)) continue;
        visited.add(next);
        path.push(next);
        dfs(next);
        path.pop();
        visited.delete(next);
      }
    }

    dfs(startIdx);
  }

  for (const rm of newRingMatches) matches.push(rm);
}

/** Check if offer A is willing to take offer B's shift */
function checkWillingMatch(offerA: any, offerB: any, swapSettings: any): boolean {
  // A must be willing to work the shift type of B
  if (swapSettings.onlyWithinShiftType) {
    // Already checked above, but double-check
    if (offerA.shiftType !== offerB.shiftType) return false;
  } else {
    // A must list B's shift type as acceptable
    const willingTypes = offerA.willingShiftTypes || [offerA.shiftType];
    if (!willingTypes.includes(offerB.shiftType)) return false;
  }

  // A's willing ranges must overlap with B's shift dates
  const bStart = offerB.startDate;
  const bEnd = offerB.endDate;

  if (!offerA.willingRanges || offerA.willingRanges.length === 0) return false;

  return offerA.willingRanges.some((range: any) => {
    const rStart = range.startDate;
    const rEnd = range.endDate;
    // B's shift must fall within A's willing range
    return rStart <= bStart && rEnd >= bEnd;
  });
}

/** Admin: trigger manual match scan */
app.post('/api/swaps/scan', authMiddleware, (_req, res) => {
  const state = loadState();
  findAndCreateMatches(state);
  res.json({
    offers: state.swapOffers || [],
    matches: state.swapMatches || [],
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SERVE PORTAL SPA (catch-all for /portal routes)
// ═══════════════════════════════════════════════════════════════════════

const PORTAL_DIR = path.join(__dirname, '..', 'dist', 'portal');

app.use('/portal', express.static(PORTAL_DIR));
app.use('/portal', (_req, res) => {
  const indexPath = path.join(PORTAL_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Portal not built yet');
  }
});

// ═══════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`✔ Schichtplan server running on http://localhost:${PORT}`);
});
