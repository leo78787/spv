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
import { generateAutomaticShiftPlan, runEqualityOptimiser, detectViolations } from '../src/utils/scheduler.js';
import { computeFairnessScores } from '../src/utils/fairnessImpact.js';
import { runOptimiser } from '../src/utils/optimizer.js';
import {
  createOrResetCredentials,
  authenticateEmployee,
  validatePortalToken,
  changePassword,
  getAllCredentialInfo,
} from './portalAuth.js';
import { sendInvitationEmail, sendPlanNotificationEmail } from './mailer.js';

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
  const merged = {
    ...req.body,
    employeesLocked: existing.employeesLocked ?? false,
    planReleased: existing.planReleased ?? false,
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

// ── Equality optimiser (synchronous — fast) ─────────────────────────

app.post('/api/optimize-equality', authMiddleware, (req, res) => {
  try {
    const data = reviveDates(req.body);
    const { employees, schedulerConfig, baselineAssignments } = data;
    const maxIterations = data.maxIterations ?? 500;
    const year = data.year ?? new Date().getFullYear();
    const startMonth = data.startMonth ?? 0;
    const months = data.months ?? 12;

    const result = runEqualityOptimiser(
      employees,
      baselineAssignments,
      schedulerConfig,
      maxIterations,
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

  // Baseline — use supplied baseline if available (from equality optimizer), otherwise generate fresh
  const baselineResult = suppliedBaseline && suppliedBaseline.length > 0
    ? { assignments: suppliedBaseline, violations: suppliedBaselineViolations || [] as any[] }
    : generateAutomaticShiftPlan(employees, year, startMonth, months, schedulerConfig);
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
        const { assignments: candidate, violations: candidateViolations } = generateAutomaticShiftPlan(shuffled, year, startMonth, months, schedulerConfig);
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
// EMPLOYEE PORTAL API
// ═══════════════════════════════════════════════════════════════════════

/** Admin endpoint: get credential info for all employees */
app.get('/api/portal/credentials', authMiddleware, (_req, res) => {
  res.json(getAllCredentialInfo());
});

/** Admin endpoint: invite employee (create/reset credentials + send email) */
app.post('/api/portal/invite', authMiddleware, async (req, res) => {
  try {
    const { employeeId } = req.body;
    const state = loadState();
    const emp = (state.employees || []).find((e: any) => e.id === employeeId);
    if (!emp) { res.status(404).json({ error: 'Mitarbeiter nicht gefunden' }); return; }
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
