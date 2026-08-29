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
import { loadState, saveState, listOrganizations, getOrganization, createOrganization, renameOrganization, orgDataDir } from './db.js';
import { runWithOrg } from './orgContext.js';
import { generateAutomaticShiftPlan, runEqualityOptimiser, runTotalBalanceOptimiser, detectViolations, getAvailableEmployeesSorted, getEmployeeActiveWeight, MIN_ACTIVE_WEIGHT } from '../src/utils/scheduler.js';
import { computeFairnessScores } from '../src/utils/fairnessImpact.js';
import { runOptimiser } from '../src/utils/optimizer.js';
import {
  createOrResetCredentials,
  authenticateEmployee,
  validatePortalToken,
  changePassword,
  getAllCredentialInfo,
  clearAllCredentials,
} from './portalAuth.js';
import {
  listAdminUsers,
  getAdminUser,
  inviteAdminUser,
  resetAdminPassword,
  updateAdminUserRole,
  updatePersonalTabVisibility,
  deleteAdminUser,
  authenticateAdmin,
  changeAdminPassword,
  verifyAdminPassword,
  ADMIN_PERMISSION_AREAS,
  type AdminRole,
  type AdminPermissionArea,
} from './adminAuth.js';
import {
  initPlatformOwner,
  authenticatePlatform,
  listPlatformUsers,
  getPlatformUser,
  invitePlatformUser,
  resetPlatformUserPassword,
  deletePlatformUser,
  changePlatformUserPassword,
} from './platformAuth.js';
import { sendInvitationEmail, sendPlanNotificationEmail, sendSwapMatchEmail, sendRingSwapMatchEmail, sendTakeoverMatchEmail, sendAdminInviteEmail } from './mailer.js';
import { initBackupSchedule, updateBackupSettings, disableBackupSettings, restoreFromBackup } from './backup.js';
import { diffState } from './stateDiff.js';
import { logChange, logChanges, queryChangeLog } from './auditLog.js';
import { DEFAULT_TAB_VISIBILITY, type TabVisibility } from '../src/types.js';

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
  periodId: string;
  result?: { assignments: any[]; violations?: any[]; scores: any; iterations: number };
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

/**
 * Admin session: which organization the caller operates in, their role, and
 * (for real invited accounts) their admin-user id. The legacy shared login
 * (spm2026) maps to a synthetic full-access "admin" session on the first
 * organization with no adminUserId — kept working indefinitely as an
 * explicit fallback. Sessions are in-memory only (as they already were),
 * lost on restart — unchanged behavior from before this change.
 */
interface AdminSession {
  organizationId: string;
  role: AdminRole;
  adminUserId?: string;
}
const adminTokens = new Map<string, AdminSession>();

/** Human-readable actor description for the audit log, derived from an admin session. */
function actorFromAdminSession(session: AdminSession): { actorType: 'admin' | 'legacy'; actorName: string; actorEmail?: string } {
  if (!session.adminUserId) return { actorType: 'legacy', actorName: 'Gemeinsamer Admin-Zugang' };
  const user = getAdminUser(session.adminUserId);
  return { actorType: 'admin', actorName: user?.name ?? 'Unbekannt', actorEmail: user?.email };
}

/** Convenience: log a changelog entry attributed to the current admin request's session/org. */
function logAdminChange(req: express.Request, area: string, summary: string): void {
  const session: AdminSession | undefined = (req as any).adminSession;
  if (!session) return;
  const org = getOrganization(session.organizationId);
  logChange({ organizationId: session.organizationId, organizationName: org?.name ?? null, ...actorFromAdminSession(session), area, summary });
}

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const session = token ? adminTokens.get(token) : undefined;
  if (!session) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  // Re-derive the role live from the current account record on every
  // request (rather than trusting the role cached in the token at login
  // time) so a role/permission change made elsewhere (Team tab, orga
  // portal) takes effect on the very next request — no logout/login needed.
  let effectiveSession: AdminSession = session;
  if (session.adminUserId) {
    const user = getAdminUser(session.adminUserId);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    effectiveSession = { ...session, role: user.role };
  }
  // Betrachter is read-only everywhere — blocked generically here so every
  // existing and future mutating endpoint is covered without individual checks.
  if (effectiveSession.role === 'betrachter' && req.method !== 'GET') {
    res.status(403).json({ error: 'Betrachter können keine Änderungen vornehmen.' });
    return;
  }
  (req as any).adminSession = effectiveSession;
  runWithOrg(effectiveSession.organizationId, next);
}

/** Requires the caller to be Admin (full access) — use after authMiddleware. Team management and full data reset are always admin-only, never delegatable. */
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const session: AdminSession | undefined = (req as any).adminSession;
  if (session?.role !== 'admin') {
    res.status(403).json({ error: 'Nur Admins können diese Aktion ausführen.' });
    return;
  }
  next();
}

/** Requires the caller to be Admin, or a Leitung with the given permission area granted — use after authMiddleware. */
function requirePermission(area: AdminPermissionArea) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const session: AdminSession | undefined = (req as any).adminSession;
    if (session?.role === 'admin') { next(); return; }
    if (session?.role === 'leitung' && session.adminUserId) {
      const user = getAdminUser(session.adminUserId);
      if (user?.permissions?.includes(area)) { next(); return; }
    }
    res.status(403).json({ error: 'Dafür haben Sie keine Berechtigung.' });
  };
}

/**
 * Legacy shared admin login by username. Authenticates against the same
 * adminUsers.json records as the personal email login below — the
 * "spm2026" account is seeded once as a real, ordinary AdminUser (see
 * migrateLegacyAccount() in adminAuth.ts), so it's editable/deletable
 * through the normal Team UI just like any invited account, and this
 * route just resolves it by its username instead of an email address.
 */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body ?? {};
  const result = authenticateAdmin(String(username ?? ''), String(password ?? ''));
  if (!result) {
    res.status(401).json({
      success: false,
      message: 'Ungültiger Benutzername oder Passwort.',
    });
    return;
  }
  const token = crypto.randomUUID();
  adminTokens.set(token, { organizationId: result.user.organizationId, role: result.user.role, adminUserId: result.user.id });
  res.json({ success: true, token, role: result.user.role, mustChangePassword: result.mustChangePassword });
});

/** Personal admin login (Admin/Leitung/Betrachter accounts invited within an organization). */
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body ?? {};
  const result = authenticateAdmin(String(email ?? ''), String(password ?? ''));
  if (!result) {
    res.status(401).json({ error: 'Ungültige Anmeldedaten.' });
    return;
  }
  const token = crypto.randomUUID();
  adminTokens.set(token, { organizationId: result.user.organizationId, role: result.user.role, adminUserId: result.user.id });
  res.json({
    success: true,
    token,
    role: result.user.role,
    mustChangePassword: result.mustChangePassword,
    name: result.user.name,
  });
});

/** Admin: change own password (invited accounts only — the legacy shared login has no changeable password here). */
app.post('/api/admin/change-password', authMiddleware, (req, res) => {
  const session: AdminSession = (req as any).adminSession;
  if (!session.adminUserId) {
    res.status(400).json({ error: 'Für den gemeinsamen Admin-Zugang kann hier kein Passwort geändert werden.' });
    return;
  }
  const { newPassword } = req.body ?? {};
  if (!newPassword || String(newPassword).length < 6) {
    res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben.' });
    return;
  }
  changeAdminPassword(session.adminUserId, String(newPassword));
  res.json({ success: true });
});

/**
 * Re-check the password of whoever is currently logged in — used to replace
 * the old hardcoded "2026" confirmation on sensitive actions (release/lock/
 * delete planning periods, settings-tab unlocks). Works the same for an
 * Admin or a permitted Leitung session; each confirms with their own
 * password. The legacy shared session confirms with its own fixed password.
 */
app.post('/api/admin/verify-password', authMiddleware, (req, res) => {
  const session: AdminSession = (req as any).adminSession;
  const { password } = req.body ?? {};
  const ok = session.adminUserId
    ? verifyAdminPassword(session.adminUserId, String(password ?? ''))
    : String(password ?? '') === 'schichtplan2026!';
  res.json({ valid: ok });
});

/** Admin: who am I — role, organization, permissions (for Leitung), and (if assigned) the department to pre-select in Mitarbeiter/Kalender. */
app.get('/api/admin/me', authMiddleware, (req, res) => {
  const session: AdminSession = (req as any).adminSession;
  const org = getOrganization(session.organizationId);
  const state = loadState();
  const departments: any[] = state.departments || [];
  const myDepartment = session.adminUserId
    ? departments.find((d: any) => d.managerId === session.adminUserId)
    : undefined;
  const user = session.adminUserId ? getAdminUser(session.adminUserId) : null;
  const permissions = session.role === 'admin'
    ? [...ADMIN_PERMISSION_AREAS]
    : session.role === 'leitung'
      ? (user?.permissions ?? [])
      : [];

  // Org-wide max (Admin-controlled): which tabs exist at all for this role.
  const orgTabVisibility: TabVisibility = (session.role === 'betrachter'
    ? state.betrachterTabVisibility
    : state.tabVisibility) ?? DEFAULT_TAB_VISIBILITY;
  // Personal preference (Leitung/Betrachter self-service): further hide tabs
  // within what the Admin allows. Always intersected — a personal "true"
  // can never re-show a tab the Admin has org-wide disabled.
  const personalRaw: Record<string, boolean> = user?.personalTabVisibility ?? {};
  const effectiveTabVisibility: TabVisibility = { ...orgTabVisibility };
  (Object.keys(orgTabVisibility) as (keyof TabVisibility)[]).forEach(key => {
    effectiveTabVisibility[key] = orgTabVisibility[key] !== false && personalRaw[key] !== false;
  });

  res.json({
    role: session.role,
    organizationId: session.organizationId,
    organizationName: org?.name ?? null,
    defaultDepartmentId: myDepartment?.id ?? null,
    permissions,
    tabVisibility: state.tabVisibility ?? null,
    betrachterTabVisibility: state.betrachterTabVisibility ?? null,
    orgTabVisibility,
    personalTabVisibility: personalRaw,
    effectiveTabVisibility,
  });
});

/** Self-service: a Leitung/Betrachter shows/hides tabs for themselves, within whatever the Admin has org-wide allowed. Always clamped server-side so a tab the Admin disallowed can never be re-enabled this way. */
app.put('/api/admin/my-tab-visibility', authMiddleware, (req, res) => {
  const session: AdminSession = (req as any).adminSession;
  if (!session.adminUserId) { res.status(400).json({ error: 'Nicht verfügbar für diesen Zugang.' }); return; }
  const state = loadState();
  const orgTabVisibility: TabVisibility = (session.role === 'betrachter'
    ? state.betrachterTabVisibility
    : state.tabVisibility) ?? DEFAULT_TAB_VISIBILITY;
  const incoming: Record<string, boolean> = req.body?.personalTabVisibility ?? {};
  const clamped: Record<string, boolean> = {};
  (Object.keys(orgTabVisibility) as (keyof TabVisibility)[]).forEach(key => {
    clamped[key] = orgTabVisibility[key] !== false && incoming[key] !== false;
  });
  const updated = updatePersonalTabVisibility(session.adminUserId, clamped);
  if (!updated) { res.status(404).json({ error: 'Nicht gefunden.' }); return; }
  res.json({ success: true, personalTabVisibility: clamped });
});

// ═══════════════════════════════════════════════════════════════════════
// ADMIN ORG USERS — Admin invites/manages Admin/Leitung/Betrachter accounts
// within their own organization.
// ═══════════════════════════════════════════════════════════════════════

app.get('/api/admin/org/users', authMiddleware, (req, res) => {
  const session: AdminSession = (req as any).adminSession;
  res.json(listAdminUsers(session.organizationId));
});

app.post('/api/admin/org/users', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const session: AdminSession = (req as any).adminSession;
    const { name, email, role, permissions } = req.body ?? {};
    if (!name || !email || (role !== 'admin' && role !== 'leitung' && role !== 'betrachter')) {
      res.status(400).json({ error: 'Name, E-Mail und Rolle (admin/leitung/betrachter) erforderlich.' });
      return;
    }
    const result = inviteAdminUser(session.organizationId, String(name), String(email), role, Array.isArray(permissions) ? permissions : undefined);
    if ('error' in result) { res.status(400).json({ error: result.error }); return; }

    const org = getOrganization(session.organizationId);
    try {
      await sendAdminInviteEmail(result.user.email, result.user.name, org?.name ?? 'Schichtplan Manager', result.user.role, result.oneTimePassword);
    } catch (mailErr) {
      console.error('[admin/org/users] invite email failed:', mailErr);
    }
    logChange({ organizationId: session.organizationId, organizationName: org?.name ?? null, ...actorFromAdminSession(session), area: 'team', summary: `Zugang eingeladen: ${result.user.name} (${result.user.email}), Rolle: ${result.user.role}` });
    res.json({ success: true, user: result.user });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/admin/org/users/:id/resend', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const session: AdminSession = (req as any).adminSession;
    const user = getAdminUser(String(req.params.id));
    if (!user || user.organizationId !== session.organizationId) { res.status(404).json({ error: 'Nicht gefunden.' }); return; }
    const result = resetAdminPassword(user.id);
    if (!result) { res.status(404).json({ error: 'Nicht gefunden.' }); return; }
    const org = getOrganization(session.organizationId);
    await sendAdminInviteEmail(user.email, user.name, org?.name ?? 'Schichtplan Manager', user.role, result.oneTimePassword);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.put('/api/admin/org/users/:id', authMiddleware, requireAdmin, (req, res) => {
  const session: AdminSession = (req as any).adminSession;
  const user = getAdminUser(String(req.params.id));
  if (!user || user.organizationId !== session.organizationId) { res.status(404).json({ error: 'Nicht gefunden.' }); return; }
  const { role, permissions } = req.body ?? {};
  if (role !== 'admin' && role !== 'leitung' && role !== 'betrachter') { res.status(400).json({ error: 'Ungültige Rolle.' }); return; }
  const updated = updateAdminUserRole(user.id, role, Array.isArray(permissions) ? permissions : undefined);
  const org = getOrganization(session.organizationId);
  logChange({ organizationId: session.organizationId, organizationName: org?.name ?? null, ...actorFromAdminSession(session), area: 'team', summary: `Rolle geändert: ${user.name} (${user.email}) → ${role}${role === 'leitung' ? ` [${(permissions || []).join(', ')}]` : ''}` });
  res.json({ success: true, user: updated });
});

app.delete('/api/admin/org/users/:id', authMiddleware, requireAdmin, (req, res) => {
  const session: AdminSession = (req as any).adminSession;
  const user = getAdminUser(String(req.params.id));
  if (!user || user.organizationId !== session.organizationId) { res.status(404).json({ error: 'Nicht gefunden.' }); return; }
  deleteAdminUser(user.id);
  const org = getOrganization(session.organizationId);
  logChange({ organizationId: session.organizationId, organizationName: org?.name ?? null, ...actorFromAdminSession(session), area: 'team', summary: `Zugang entfernt: ${user.name} (${user.email})` });
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════
// PLATFORM (orga.schichtapp.de) — organization registry + platform users
// ═══════════════════════════════════════════════════════════════════════

type PlatformSession = { userId: string; name: string; email: string };
const platformTokens = new Map<string, PlatformSession>();

function platformAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const session = token ? platformTokens.get(token) : undefined;
  if (!session) { res.status(401).json({ error: 'Unauthorized' }); return; }
  (req as any).platformSession = session;
  next();
}

function actorFromPlatformSession(session: PlatformSession): { actorType: 'platform'; actorName: string; actorEmail?: string } {
  return { actorType: 'platform', actorName: session.name, actorEmail: session.email };
}

app.post('/api/platform/login', (req, res) => {
  const { username, email, password } = req.body ?? {};
  const identifier = String(email ?? username ?? '');
  const result = authenticatePlatform(identifier, String(password ?? ''));
  if (!result) {
    res.status(401).json({ error: 'Ungültige Anmeldedaten.' });
    return;
  }
  const token = crypto.randomUUID();
  platformTokens.set(token, { userId: result.user.id, name: result.user.name, email: result.user.email });
  res.json({ success: true, token, mustChangePassword: result.mustChangePassword, name: result.user.name });
});

/**
 * Set a new password for the current platform session — only ever reachable
 * right after logging in with a one-time password (mustChangePassword was
 * true), not a general "change my password whenever" action. There is no
 * self-service change-anytime endpoint; the only way to get a new password
 * is "Passwort zurücksetzen" in Einstellungen, which emails a fresh one-time
 * password and forces this same first-use flow again.
 */
app.post('/api/platform/change-password', platformAuthMiddleware, (req, res) => {
  const session: PlatformSession = (req as any).platformSession;
  const { newPassword } = req.body ?? {};
  if (!newPassword || String(newPassword).length < 6) {
    res.status(400).json({ error: 'Neues Passwort muss mindestens 6 Zeichen haben.' });
    return;
  }
  changePlatformUserPassword(session.userId, String(newPassword));
  res.json({ success: true });
});

app.get('/api/platform/organizations', platformAuthMiddleware, (_req, res) => {
  res.json(listOrganizations());
});

app.post('/api/platform/organizations', platformAuthMiddleware, async (req, res) => {
  try {
    const session: PlatformSession = (req as any).platformSession;
    const { name, leitungName, leitungEmail } = req.body ?? {};
    if (!name || !String(name).trim()) { res.status(400).json({ error: 'Name der Organisation erforderlich.' }); return; }
    const org = createOrganization(String(name).trim());
    logChange({ organizationId: org.id, organizationName: org.name, ...actorFromPlatformSession(session), area: 'organization', summary: `Organisation angelegt: ${org.name}` });

    let invitedAdmin: any = null;
    if (leitungName && leitungEmail) {
      const result = inviteAdminUser(org.id, String(leitungName), String(leitungEmail), 'admin');
      if ('error' in result) {
        res.json({ success: true, organization: org, leitungError: result.error });
        return;
      }
      try {
        await sendAdminInviteEmail(result.user.email, result.user.name, org.name, 'admin', result.oneTimePassword);
      } catch (mailErr) {
        console.error('[platform/organizations] invite email failed:', mailErr);
      }
      logChange({ organizationId: org.id, organizationName: org.name, ...actorFromPlatformSession(session), area: 'team', summary: `Erster Admin eingeladen: ${result.user.name} (${result.user.email})` });
      invitedAdmin = result.user;
    }
    res.json({ success: true, organization: org, leitung: invitedAdmin });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.put('/api/platform/organizations/:id', platformAuthMiddleware, (req, res) => {
  const session: PlatformSession = (req as any).platformSession;
  const { name } = req.body ?? {};
  if (!name || !String(name).trim()) { res.status(400).json({ error: 'Name erforderlich.' }); return; }
  const before = getOrganization(String(req.params.id));
  const org = renameOrganization(String(req.params.id), String(name).trim());
  if (!org) { res.status(404).json({ error: 'Organisation nicht gefunden.' }); return; }
  logChange({ organizationId: org.id, organizationName: org.name, ...actorFromPlatformSession(session), area: 'organization', summary: `Organisation umbenannt: ${before?.name ?? ''} → ${org.name}` });
  res.json({ success: true, organization: org });
});

app.get('/api/platform/organizations/:id/users', platformAuthMiddleware, (req, res) => {
  res.json(listAdminUsers(String(req.params.id)));
});

app.post('/api/platform/organizations/:id/invite-leitung', platformAuthMiddleware, async (req, res) => {
  try {
    const session: PlatformSession = (req as any).platformSession;
    const orgId = String(req.params.id);
    const org = getOrganization(orgId);
    if (!org) { res.status(404).json({ error: 'Organisation nicht gefunden.' }); return; }
    const { name, email, role, permissions } = req.body ?? {};
    if (!name || !email) { res.status(400).json({ error: 'Name und E-Mail erforderlich.' }); return; }
    const resolvedRole: AdminRole = role === 'leitung' || role === 'betrachter' ? role : 'admin';
    const result = inviteAdminUser(orgId, String(name), String(email), resolvedRole, Array.isArray(permissions) ? permissions : undefined);
    if ('error' in result) { res.status(400).json({ error: result.error }); return; }
    await sendAdminInviteEmail(result.user.email, result.user.name, org.name, resolvedRole, result.oneTimePassword);
    logChange({ organizationId: org.id, organizationName: org.name, ...actorFromPlatformSession(session), area: 'team', summary: `Zugang eingeladen: ${result.user.name} (${result.user.email}), Rolle: ${resolvedRole}` });
    res.json({ success: true, user: result.user });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.put('/api/platform/organizations/:id/users/:userId', platformAuthMiddleware, (req, res) => {
  const session: PlatformSession = (req as any).platformSession;
  const orgId = String(req.params.id);
  const user = getAdminUser(String(req.params.userId));
  if (!user || user.organizationId !== orgId) { res.status(404).json({ error: 'Nicht gefunden.' }); return; }
  const { role, permissions } = req.body ?? {};
  if (role !== 'admin' && role !== 'leitung' && role !== 'betrachter') { res.status(400).json({ error: 'Ungültige Rolle.' }); return; }
  const updated = updateAdminUserRole(user.id, role, Array.isArray(permissions) ? permissions : undefined);
  const org = getOrganization(orgId);
  logChange({ organizationId: orgId, organizationName: org?.name ?? null, ...actorFromPlatformSession(session), area: 'team', summary: `Rolle geändert: ${user.name} (${user.email}) → ${role}${role === 'leitung' ? ` [${(permissions || []).join(', ')}]` : ''}` });
  res.json({ success: true, user: updated });
});

app.delete('/api/platform/organizations/:id/users/:userId', platformAuthMiddleware, (req, res) => {
  const session: PlatformSession = (req as any).platformSession;
  const orgId = String(req.params.id);
  const user = getAdminUser(String(req.params.userId));
  if (!user || user.organizationId !== orgId) { res.status(404).json({ error: 'Nicht gefunden.' }); return; }
  deleteAdminUser(user.id);
  const org = getOrganization(orgId);
  logChange({ organizationId: orgId, organizationName: org?.name ?? null, ...actorFromPlatformSession(session), area: 'team', summary: `Zugang entfernt: ${user.name} (${user.email})` });
  res.json({ success: true });
});

app.post('/api/platform/organizations/:id/users/:userId/resend', platformAuthMiddleware, async (req, res) => {
  try {
    const orgId = String(req.params.id);
    const user = getAdminUser(String(req.params.userId));
    if (!user || user.organizationId !== orgId) { res.status(404).json({ error: 'Nicht gefunden.' }); return; }
    const result = resetAdminPassword(user.id);
    if (!result) { res.status(404).json({ error: 'Nicht gefunden.' }); return; }
    const org = getOrganization(orgId);
    await sendAdminInviteEmail(user.email, user.name, org?.name ?? 'Schichtplan Manager', user.role, result.oneTimePassword);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Platform users (who can access orga.schichtapp.de) ──────────────────

app.get('/api/platform/users', platformAuthMiddleware, (_req, res) => {
  res.json(listPlatformUsers());
});

app.post('/api/platform/users', platformAuthMiddleware, async (req, res) => {
  try {
    const session: PlatformSession = (req as any).platformSession;
    const { name, email } = req.body ?? {};
    if (!name || !email) { res.status(400).json({ error: 'Name und E-Mail erforderlich.' }); return; }
    const result = invitePlatformUser(String(name), String(email));
    if ('error' in result) { res.status(400).json({ error: result.error }); return; }
    try {
      await sendAdminInviteEmail(result.user.email, result.user.name, 'Schichtplan Manager – Organisationsverwaltung', 'admin', result.oneTimePassword);
    } catch (mailErr) {
      console.error('[platform/users] invite email failed:', mailErr);
    }
    logChange({ organizationId: null, organizationName: null, ...actorFromPlatformSession(session), area: 'platform', summary: `Plattform-Zugang eingeladen: ${result.user.name} (${result.user.email})` });
    res.json({ success: true, user: result.user });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/platform/users/:id/reset-password', platformAuthMiddleware, async (req, res) => {
  try {
    const session: PlatformSession = (req as any).platformSession;
    const user = getPlatformUser(String(req.params.id));
    if (!user) { res.status(404).json({ error: 'Nicht gefunden.' }); return; }
    const result = resetPlatformUserPassword(user.id);
    if (!result) { res.status(404).json({ error: 'Nicht gefunden.' }); return; }
    await sendAdminInviteEmail(user.email, user.name, 'Schichtplan Manager – Organisationsverwaltung', 'admin', result.oneTimePassword);
    logChange({ organizationId: null, organizationName: null, ...actorFromPlatformSession(session), area: 'platform', summary: `Passwort zurückgesetzt für: ${user.name} (${user.email})` });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.delete('/api/platform/users/:id', platformAuthMiddleware, (req, res) => {
  const session: PlatformSession = (req as any).platformSession;
  const user = getPlatformUser(String(req.params.id));
  if (!user) { res.status(404).json({ error: 'Nicht gefunden.' }); return; }
  const result = deletePlatformUser(user.id);
  if ('error' in result) { res.status(400).json({ error: result.error }); return; }
  logChange({ organizationId: null, organizationName: null, ...actorFromPlatformSession(session), area: 'platform', summary: `Plattform-Zugang entfernt: ${user.name} (${user.email})` });
  res.json({ success: true });
});

// ─── Changelog ────────────────────────────────────────────────────────

app.get('/api/platform/changelog', platformAuthMiddleware, (req, res) => {
  const { organizationId, from, to } = req.query;
  const entries = queryChangeLog({
    organizationId: typeof organizationId === 'string' && organizationId ? organizationId : undefined,
    from: typeof from === 'string' && from ? from : undefined,
    to: typeof to === 'string' && to ? to : undefined,
  });
  res.json(entries);
});

// ═══════════════════════════════════════════════════════════════════════
// STATE CRUD (full-state sync, mirrors the old localStorage approach)
// ═══════════════════════════════════════════════════════════════════════

app.get('/api/state', authMiddleware, (_req, res) => {
  res.json(loadState());
});

app.put('/api/state', authMiddleware, (req, res) => {
  // Preserve server-managed flags that the admin frontend doesn't send.
  // planningPeriods.released / .employeesLocked / .createdAt are exclusively
  // managed by the dedicated /api/periods/:id/release and /api/periods/:id/lock
  // endpoints below — never trust client-supplied values for those here.
  const session: AdminSession = (req as any).adminSession;
  const existing = loadState();
  const existingPeriodsById = new Map<string, any>((existing.planningPeriods || []).map((p: any) => [p.id, p]));
  const incomingPeriods: any[] = Array.isArray(req.body.planningPeriods) ? req.body.planningPeriods : [];
  const mergedPeriods = incomingPeriods.map((p: any) => {
    const prev = existingPeriodsById.get(p.id);
    return {
      ...p,
      released: prev?.released ?? false,
      employeesLocked: prev?.employeesLocked ?? false,
      createdAt: prev?.createdAt ?? new Date().toISOString(),
    };
  });
  const hasAnyAssignments = mergedPeriods.some((p: any) => Array.isArray(p.assignments) && p.assignments.length > 0);

  const merged = {
    ...req.body,
    planningPeriods: mergedPeriods,
    swapOffers: hasAnyAssignments ? (existing.swapOffers ?? []) : [],
    swapMatches: hasAnyAssignments ? (existing.swapMatches ?? []) : [],
    // backupSettings is exclusively managed via the dedicated /api/backup/* endpoints
    // below — the admin frontend never sends it, so it must be carried over explicitly.
    backupSettings: existing.backupSettings,
  };
  delete merged.shiftPlan;
  delete merged.planReleased;
  delete merged.employeesLocked;

  // Diff before saving: this single generic endpoint is where almost every
  // admin mutation ultimately lands (employees, departments, holidays,
  // labels, calendar labels, swap/tab settings, manual calendar edits), so
  // one diff serves both permission enforcement (Leitung must hold every
  // touched area) and the changelog (one entry per changed item).
  const diff = diffState(existing, merged);
  if (session.role === 'leitung') {
    const user = session.adminUserId ? getAdminUser(session.adminUserId) : null;
    const granted = new Set<string>(user?.permissions ?? []);
    const missing = [...diff.touchedAreas].filter(a => !granted.has(a));
    if (missing.length > 0) {
      res.status(403).json({ error: `Dafür haben Sie keine Berechtigung (${missing.join(', ')}).` });
      return;
    }
  }

  saveState(merged);

  if (diff.items.length > 0) {
    const org = getOrganization(session.organizationId);
    const actor = actorFromAdminSession(session);
    logChanges(diff.items.map(item => ({
      organizationId: session.organizationId,
      organizationName: org?.name ?? null,
      ...actor,
      area: item.area,
      summary: item.summary,
    })));
  }

  // For each released period, detect per-employee schedule changes (shift
  // assignments or visible calendar labels) and debounce a notification.
  const releasedBefore = getReleasedAssignments(existing);
  const releasedAfter = getReleasedAssignments(merged);
  if (releasedBefore.length > 0 || releasedAfter.length > 0) {
    const employees: any[] = merged.employees || existing.employees || [];
    for (const emp of employees) {
      const before = getEmployeeScheduleSignature(emp.id, releasedBefore, existing.labels, existing.calendarLabels);
      const after = getEmployeeScheduleSignature(emp.id, releasedAfter, merged.labels, merged.calendarLabels);
      if (before !== after) scheduleChangeNotification(emp.id);
    }
  }

  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════
// PLANNING PERIODS — CRUD, release, employee-lock
// ═══════════════════════════════════════════════════════════════════════

/** Admin: create a new planning period. Warns (does not block) on date-range overlap with existing periods. */
app.post('/api/periods', authMiddleware, requirePermission('planning'), (req, res) => {
  try {
    const { name, year, startMonth, months, schedulerConfig } = req.body ?? {};
    if (typeof year !== 'number' || typeof startMonth !== 'number' || typeof months !== 'number' || months < 1) {
      res.status(400).json({ error: 'Ungültiger Zeitraum.' });
      return;
    }
    const state = loadState();
    const candidate = { id: '', name, year, startMonth, months };
    const overlapping = findOverlappingPeriods(state, candidate);

    const period = {
      id: `period-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: name || undefined,
      year,
      startMonth,
      months,
      schedulerConfig,
      violations: [],
      assignments: [],
      algorithm: undefined,
      released: false,
      employeesLocked: false,
      createdAt: new Date().toISOString(),
    };
    state.planningPeriods = [...(state.planningPeriods || []), period];
    saveState(state);
    logAdminChange(req, 'planning', `Planungsperiode angelegt: ${periodLabel(period)}`);
    res.json({
      success: true,
      period,
      overlapWarning: overlapping.length > 0
        ? `Diese Planungsperiode überschneidet sich mit: ${overlapping.map(periodLabel).join(', ')}`
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Admin: update a planning period's date range / name / scheduler config. Warns on overlap. */
app.put('/api/periods/:id', authMiddleware, requirePermission('planning'), (req, res) => {
  try {
    const id = String(req.params.id);
    const state = loadState();
    const periods: any[] = state.planningPeriods || [];
    const period = periods.find(p => p.id === id);
    if (!period) { res.status(404).json({ error: 'Planungsperiode nicht gefunden.' }); return; }

    const { name, year, startMonth, months, schedulerConfig } = req.body ?? {};
    if (name !== undefined) period.name = name || undefined;
    if (typeof year === 'number') period.year = year;
    if (typeof startMonth === 'number') period.startMonth = startMonth;
    if (typeof months === 'number' && months >= 1) period.months = months;
    if (schedulerConfig !== undefined) period.schedulerConfig = schedulerConfig;
    period.updatedAt = new Date().toISOString();

    const overlapping = findOverlappingPeriods(state, period, id);
    state.planningPeriods = periods;
    saveState(state);
    logAdminChange(req, 'planning', `Planungsperiode bearbeitet: ${periodLabel(period)}`);
    res.json({
      success: true,
      period,
      overlapWarning: overlapping.length > 0
        ? `Diese Planungsperiode überschneidet sich mit: ${overlapping.map(periodLabel).join(', ')}`
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Admin: delete a planning period entirely (including its generated assignments). */
app.delete('/api/periods/:id', authMiddleware, requirePermission('planning'), (req, res) => {
  try {
    const id = String(req.params.id);
    const state = loadState();
    const periods: any[] = state.planningPeriods || [];
    const period = periods.find(p => p.id === id);
    if (!period) { res.status(404).json({ error: 'Planungsperiode nicht gefunden.' }); return; }
    const deletedLabel = periodLabel(period);

    const assignmentIds = new Set((period.assignments || []).map((a: any) => a.id));
    state.planningPeriods = periods.filter(p => p.id !== id);

    // Clean up swap offers/matches referencing assignments that no longer exist.
    const offers: any[] = (state.swapOffers || []).filter((o: any) => !assignmentIds.has(o.assignmentId));
    const removedOfferIds = new Set((state.swapOffers || []).filter((o: any) => assignmentIds.has(o.assignmentId)).map((o: any) => o.id));
    const matches: any[] = (state.swapMatches || []).filter((m: any) => {
      const refs = m.ringOffers && m.ringOffers.length > 0 ? m.ringOffers : [m.offerA, m.offerB].filter(Boolean);
      return !refs.some((rid: string) => removedOfferIds.has(rid));
    });
    state.swapOffers = offers;
    state.swapMatches = matches;

    saveState(state);
    logAdminChange(req, 'planning', `Planungsperiode gelöscht: ${deletedLabel}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Admin: release or unrelease a specific planning period. */
app.post('/api/periods/:id/release', authMiddleware, requirePermission('planning'), async (req, res) => {
  try {
    const id = String(req.params.id);
    const { released } = req.body ?? {};
    const state = loadState();
    const period = (state.planningPeriods || []).find((p: any) => p.id === id);
    if (!period) { res.status(404).json({ error: 'Planungsperiode nicht gefunden.' }); return; }

    const wasReleased = !!period.released;
    period.released = !!released;
    // Releasing a period implies the plan is final — auto-lock employee
    // self-service (vacation/preferences) for it too, unless already locked.
    if (period.released && !wasReleased && !period.employeesLocked) {
      period.employeesLocked = true;
    }
    saveState(state);
    logAdminChange(req, 'planning', `Planungsperiode ${period.released ? 'freigegeben' : 'Freigabe zurückgezogen'}: ${periodLabel(period)}`);

    // If newly releasing (was not released before), notify eligible employees who have assignments in THIS period.
    if (period.released && !wasReleased) {
      const credInfo = getAllCredentialInfo();
      const employees = state.employees || [];
      const employeeIdsInPeriod = new Set((period.assignments || []).flatMap((a: any) => a.employees || []));
      for (const emp of employees) {
        if (!emp.email) continue;
        if (!employeeIdsInPeriod.has(emp.id)) continue;
        if (!hasActivatedPortal(emp.id, credInfo)) continue;
        if (!getNotificationPreferences(emp).planRelease) continue;
        try {
          await sendPlanNotificationEmail(
            emp.email,
            emp.name,
            `Ihr Schichtplan für ${periodLabel(period)} wurde freigegeben. Sie können ihn jetzt im Portal einsehen.`
          );
        } catch (mailErr) {
          console.error(`[period/release] Failed to notify ${emp.name}:`, mailErr);
        }
      }
    }

    res.json({ success: true, period });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Admin: lock or unlock employee self-service (vacation/preferences) for a specific planning period. */
app.post('/api/periods/:id/lock', authMiddleware, requirePermission('planning'), (req, res) => {
  try {
    const id = String(req.params.id);
    const { locked } = req.body ?? {};
    const state = loadState();
    const period = (state.planningPeriods || []).find((p: any) => p.id === id);
    if (!period) { res.status(404).json({ error: 'Planungsperiode nicht gefunden.' }); return; }
    // Once released, the lock status is fixed (auto-locked on release) — un-/re-locking
    // a released period would let employees edit vacation/preferences after the plan is final.
    if (period.released) {
      res.status(403).json({ error: 'Freigegebene Planungsperioden können nicht mehr entsperrt/gesperrt werden.' });
      return;
    }
    period.employeesLocked = !!locked;
    saveState(state);
    logAdminChange(req, 'planning', `Planungsperiode ${period.employeesLocked ? 'gesperrt' : 'entsperrt'}: ${periodLabel(period)}`);
    res.json({ success: true, period });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
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

/** Default email notification preferences for employees that never set their own. */
const DEFAULT_NOTIFICATION_PREFERENCES = {
  planRelease: true,
  scheduleChanges: true,
  swapMatches: true,
};

/** Read an employee's notification preferences, falling back to defaults for missing fields. */
function getNotificationPreferences(emp: any): { planRelease: boolean; scheduleChanges: boolean; swapMatches: boolean } {
  return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...(emp?.notificationPreferences || {}) };
}

/** Whether an employee has activated their portal account (logged in at least once). */
function hasActivatedPortal(employeeId: string, credInfo: Record<string, { mustChangePassword: boolean }>): boolean {
  const cred = credInfo[employeeId];
  return !!cred && !cred.mustChangePassword;
}

// ═══════════════════════════════════════════════════════════════════════
// PLANNING PERIODS — helpers
// ═══════════════════════════════════════════════════════════════════════
//
// The app used to support exactly one global shift plan/year. It now
// supports any number of independent "Planungsperioden" — each with its
// own date range, generated assignments, and release/employee-lock status.
// state.planningPeriods: PlanningPeriod[] (see src/types.ts)

/** [start, end] inclusive Date range for a period. */
function periodDateRange(period: any): { start: Date; end: Date } {
  const startMonth = period.startMonth ?? 0;
  const months = period.months ?? 12;
  return {
    start: new Date(period.year, startMonth, 1),
    end: new Date(period.year, startMonth + months, 0),
  };
}

/** Whether two periods' date ranges overlap (inclusive). */
function periodsOverlap(a: any, b: any): boolean {
  const ra = periodDateRange(a);
  const rb = periodDateRange(b);
  return ra.start <= rb.end && rb.start <= ra.end;
}

/** All OTHER periods (by id) whose date range overlaps the given candidate period. */
function findOverlappingPeriods(state: any, candidate: any, excludeId?: string): any[] {
  const periods: any[] = state.planningPeriods || [];
  return periods.filter(p => p.id !== excludeId && p.id !== candidate.id && periodsOverlap(p, candidate));
}

/** Human-readable label for a period, e.g. its custom name or a date-range description. */
function periodLabel(period: any): string {
  if (period.name) return period.name;
  const { start, end } = periodDateRange(period);
  const fmt = (d: Date) => d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
}

/**
 * Resolve which planning period an employee's portal session should show:
 * their own persisted selection (if it still exists), otherwise the period
 * covering today, otherwise the most recently created one. Returns null if
 * no planning periods exist at all.
 */
function resolvePortalPeriod(state: any, emp: any): any | null {
  const periods: any[] = state.planningPeriods || [];
  if (periods.length === 0) return null;

  if (emp.portalSelectedPeriodId) {
    const found = periods.find((p: any) => p.id === emp.portalSelectedPeriodId);
    if (found) return found;
  }

  const today = new Date();
  const covering = periods.find((p: any) => {
    const { start, end } = periodDateRange(p);
    return today >= start && today <= end;
  });
  if (covering) return covering;

  return [...periods].sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
}

/** Whether a {startDate,endDate} entry (vacation range or shift preference) overlaps a planning period's date range. */
function entryOverlapsPeriod(entry: { startDate: any; endDate: any }, period: any): boolean {
  if (!period) return false;
  const { start, end } = periodDateRange(period);
  const s = new Date(entry.startDate);
  const e = new Date(entry.endDate);
  return s <= end && e >= start;
}

/** Find the planning period containing a given assignment id. Returns null if not found. */
function findPeriodByAssignmentId(state: any, assignmentId: string): any | null {
  const periods: any[] = state.planningPeriods || [];
  return periods.find(p => (p.assignments || []).some((a: any) => a.id === assignmentId)) || null;
}

/**
 * Find an assignment by id across all planning periods. Returns the actual
 * assignment object reference (safe to mutate in place — the caller must
 * still call saveState afterwards) along with its containing period.
 */
function findAssignmentAcrossPeriods(state: any, assignmentId: string): { period: any; assignment: any } | null {
  const periods: any[] = state.planningPeriods || [];
  for (const period of periods) {
    const assignment = (period.assignments || []).find((a: any) => a.id === assignmentId);
    if (assignment) return { period, assignment };
  }
  return null;
}

/** Whether at least one planning period is currently released. */
function isAnyPeriodReleased(state: any): boolean {
  return (state.planningPeriods || []).some((p: any) => p.released);
}

/** Whether at least one planning period currently has employee self-service locked. */
function isAnyPeriodLocked(state: any): boolean {
  return (state.planningPeriods || []).some((p: any) => p.employeesLocked);
}

/** All assignments from currently-released periods (used for the employee portal / calendar-status consumers). */
function getReleasedAssignments(state: any): any[] {
  return (state.planningPeriods || []).filter((p: any) => p.released).flatMap((p: any) => p.assignments || []);
}

/** All assignments across every planning period, regardless of release status (used for conflict/eligibility checks that must span periods). */
function getAllAssignmentsFlat(state: any): any[] {
  return (state.planningPeriods || []).flatMap((p: any) => p.assignments || []);
}

// ── Post-release schedule-change notifications ───────────────────────
//
// The admin frontend auto-saves the full state on nearly every edit, so we
// can't email employees on every single PUT (that would spam them while the
// admin is mid-edit). Instead, whenever an already-released employee's
// visible schedule (their shift assignments or the calendar labels visible
// to them) changes, we (re)start a short per-employee debounce timer. Only
// once no further change happens for that employee within the debounce
// window do we actually send a single "your schedule was updated" email.

const SCHEDULE_CHANGE_DEBOUNCE_MS = 20_000;
const scheduleChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Build a comparable signature of everything a given employee can see across all released periods. */
function getEmployeeScheduleSignature(employeeId: string, releasedAssignments: any[], labels: any[], calendarLabels: any[]): string {
  const assignments = (releasedAssignments || [])
    .filter((a: any) => (a.employees || []).includes(employeeId))
    .map((a: any) => `${a.id}:${a.shiftType}:${a.startDate}:${a.endDate}`)
    .sort();
  const visibleLabelIds = new Set((labels || []).filter((l: any) => l.visibleToEmployee !== false).map((l: any) => l.id));
  const empLabels = (calendarLabels || [])
    .filter((cl: any) => cl.employeeId === employeeId && visibleLabelIds.has(cl.labelId))
    .map((cl: any) => `${cl.date}:${cl.labelId}`)
    .sort();
  return JSON.stringify({ assignments, empLabels });
}

/** (Re)start the debounce timer for an employee whose visible schedule just changed. */
function scheduleChangeNotification(employeeId: string): void {
  const existingTimer = scheduleChangeTimers.get(employeeId);
  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(async () => {
    scheduleChangeTimers.delete(employeeId);
    try {
      const state = loadState();
      const emp = (state.employees || []).find((e: any) => e.id === employeeId);
      if (!emp?.email) return;
      if (!isAnyPeriodReleased(state)) return; // no period released anymore in the meantime
      const credInfo = getAllCredentialInfo();
      if (!hasActivatedPortal(employeeId, credInfo)) return;
      if (!getNotificationPreferences(emp).scheduleChanges) return;
      await sendPlanNotificationEmail(
        emp.email,
        emp.name,
        'Ihr Schichtplan wurde aktualisiert. Bitte prüfen Sie Ihre Schichten und Termine im Portal.'
      );
    } catch (err) {
      console.error('[schedule-change-notify] failed:', err);
    }
  }, SCHEDULE_CHANGE_DEBOUNCE_MS);

  scheduleChangeTimers.set(employeeId, timer);
}

// ═══════════════════════════════════════════════════════════════════════
// SERVER-SIDE COMPUTATION
// ═══════════════════════════════════════════════════════════════════════

// ── Generate shift plan ─────────────────────────────────────────────

app.post('/api/generate', authMiddleware, requirePermission('planning'), (req, res) => {
  try {
    const { employees, periodId, schedulerConfig } = reviveDates(req.body);
    const state = loadState();
    const periods: any[] = state.planningPeriods || [];
    const period = periods.find(p => p.id === periodId);
    if (!period) { res.status(404).json({ error: 'Planungsperiode nicht gefunden.' }); return; }

    const departments = state.departments || [];
    const result = generateAutomaticShiftPlan(
      employees,
      period.year,
      period.startMonth ?? 0,
      period.months ?? 12,
      schedulerConfig,
      departments,
    );

    // Clear swap offers/matches referencing this period's OLD assignments —
    // they're about to be replaced, so any outstanding offers on them are stale.
    // Other periods' swap offers/matches are left untouched.
    const oldAssignmentIds = new Set((period.assignments || []).map((a: any) => a.id));
    if (oldAssignmentIds.size > 0) {
      const staleOfferIds = new Set(
        (state.swapOffers || []).filter((o: any) => oldAssignmentIds.has(o.assignmentId)).map((o: any) => o.id)
      );
      state.swapOffers = (state.swapOffers || []).filter((o: any) => !staleOfferIds.has(o.id));
      state.swapMatches = (state.swapMatches || []).filter((m: any) => {
        const refs = m.ringOffers && m.ringOffers.length > 0 ? m.ringOffers : [m.offerA, m.offerB, m.takeoverEmployeeId ? m.offerA : null].filter(Boolean);
        return !refs.some((rid: string) => staleOfferIds.has(rid));
      });
    }

    period.assignments = result.assignments;
    period.violations = result.violations;
    period.schedulerConfig = schedulerConfig;
    period.algorithm = 'automatisch generiert';
    period.updatedAt = new Date().toISOString();
    saveState(state);
    logAdminChange(req, 'planning', `Schichtplan generiert: ${periodLabel(period)} (${result.assignments.length} Zuweisungen)`);

    res.json({ ...result, period });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Equality optimiser (synchronous — fast) ─────────────────────────

app.post('/api/optimize-equality', authMiddleware, requirePermission('planning'), (req, res) => {
  try {
    const data = reviveDates(req.body);
    const { employees, schedulerConfig, baselineAssignments, periodId } = data;
    const maxIterations = data.maxIterations ?? 500;
    const state = loadState();
    const period = (state.planningPeriods || []).find((p: any) => p.id === periodId);
    if (!period) { res.status(404).json({ error: 'Planungsperiode nicht gefunden.' }); return; }
    const year = period.year;
    const startMonth = period.startMonth ?? 0;
    const months = period.months ?? 12;
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

    period.assignments = result.assignments;
    period.violations = violations;
    period.schedulerConfig = schedulerConfig;
    period.algorithm = 'gleichheits-optimiert';
    period.updatedAt = new Date().toISOString();
    saveState(state);
    logAdminChange(req, 'planning', `Gleichheits-Optimierung angewendet: ${periodLabel(period)}`);

    res.json({ ...result, violations, period });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Total-balance optimiser (Step 2b) ───────────────────────────────────

app.post('/api/optimize-total-balance', authMiddleware, requirePermission('planning'), (req, res) => {
  try {
    const data = reviveDates(req.body);
    const { employees, schedulerConfig, baselineAssignments, periodId } = data;
    const maxIterations = data.maxIterations ?? 500;
    const state = loadState();
    const period = (state.planningPeriods || []).find((p: any) => p.id === periodId);
    if (!period) { res.status(404).json({ error: 'Planungsperiode nicht gefunden.' }); return; }
    const year = period.year;
    const startMonth = period.startMonth ?? 0;
    const months = period.months ?? 12;
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

    period.assignments = result.assignments;
    period.violations = violations;
    period.schedulerConfig = schedulerConfig;
    period.algorithm = 'gesamt-balanciert';
    period.updatedAt = new Date().toISOString();
    saveState(state);
    logAdminChange(req, 'planning', `Gesamt-Balance-Optimierung angewendet: ${periodLabel(period)}`);

    res.json({ ...result, violations, period });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Optimise — starts/joins a persistent background job ─────────────────

app.post('/api/optimize', authMiddleware, requirePermission('planning'), (req, res) => {
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
  const { employees, schedulerConfig, periodId } = data;
  const stateForPeriod = loadState();
  const targetPeriod = (stateForPeriod.planningPeriods || []).find((p: any) => p.id === periodId);
  if (!targetPeriod) {
    broadcastOptimSSE({ type: 'error', error: 'Planungsperiode nicht gefunden.' });
    sseOptimClients.delete(res);
    res.end();
    return;
  }
  const year = targetPeriod.year;
  const startMonth = targetPeriod.startMonth ?? 0;
  const months = targetPeriod.months ?? 12;
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
    periodId,
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
  const periodRangeForJob = { start: new Date(year, startMonth, 1), end: new Date(year, startMonth + months, 0) };
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
    const judgeablePool = pool.filter((e: any) => getEmployeeActiveWeight(e, periodRangeForJob.start, periodRangeForJob.end) > 0);
    for (const st of SHIFT_TYPES) {
      if (judgeablePool.length === 0) { r[st] = 0; continue; }
      const counts = judgeablePool.map((e: any) => {
        const raw = assigns.filter((a: any) => a.shiftType === st && a.employees.includes(e.id)).length;
        const weight = Math.max(MIN_ACTIVE_WEIGHT, getEmployeeActiveWeight(e, periodRangeForJob.start, periodRangeForJob.end));
        return raw / weight;
      });
      r[st] = Math.max(...counts) - Math.min(...counts);
    }
    return r;
  }
  function sWorsensRanges(pools: { label: string; pool: any[] }[], baseRanges: Map<string, Record<string, number>>, candidate: any[]): boolean {
    for (const { label, pool } of pools) {
      const baseR = baseRanges.get(label)!;
      const newR = sPerTypeRanges(pool, candidate);
      if (SHIFT_TYPES.some(t => newR[t] > baseR[t] + 1e-9)) return true;
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
  let bestScores = computeFairnessScores(employees, bestAssignments, periodRangeForJob);
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

        const candidateScores = computeFairnessScores(employees, candidate, periodRangeForJob);
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

        // ── Auto-save the optimised plan into its planning period ────────
        try {
          const st = loadState();
          const period = (st.planningPeriods || []).find((p: any) => p.id === job.periodId);
          if (period) {
            period.assignments = bestAssignments;
            period.violations = bestViolations;
            period.schedulerConfig = schedulerConfig;
            period.algorithm = 'fairness-optimiert';
            period.updatedAt = new Date().toISOString();
            saveState(st);
            logAdminChange(req, 'planning', `Fairness-Optimierung angewendet: ${periodLabel(period)}`);
          } else {
            console.error('[optimize] auto-save skipped: period no longer exists', job.periodId);
          }
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
    periodId: currentJob.periodId,
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

app.post('/api/optimize/cancel', authMiddleware, requirePermission('planning'), (_req, res) => {
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

app.delete('/api/optimize', authMiddleware, requirePermission('planning'), (_req, res) => {
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
    const { employees, schedulerConfig, periodId, targets } =
      reviveDates(req.body);
    const state = loadState();
    const period = (state.planningPeriods || []).find((p: any) => p.id === periodId);
    const year = period?.year ?? new Date().getFullYear();
    const startMonth = period?.startMonth ?? 0;
    const months = period?.months ?? 12;
    const departments = state.departments || [];
    const CALIBRATION_ITERS = 3;
    const t0 = Date.now();
    runOptimiser(employees, year, startMonth, months, schedulerConfig, {
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

/** Admin endpoint: wipe ALL portal credentials and sessions (used on full app reset) */
app.post('/api/portal/reset', authMiddleware, (_req, res) => {
  clearAllCredentials();
  res.json({ success: true });
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
  const session = validatePortalToken(token);
  if (!session) { res.status(401).json({ error: 'Unauthorized' }); return; }
  (req as any).employeeId = session.employeeId;
  runWithOrg(session.organizationId, next);
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

  const periods: any[] = state.planningPeriods || [];
  const selectedPeriod = resolvePortalPeriod(state, emp);
  const released = !!selectedPeriod?.released;
  const periodAssignments: any[] = selectedPeriod?.assignments || [];

  // Own shift assignments within the currently selected planning period
  const myAssignments = periodAssignments.filter((a: any) =>
    (a.employees || []).includes(employeeId)
  );

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
      email: emp.email || '',
      department: dept?.name || '',
      isOver55: emp.isOver55,
      hasL2: emp.hasL2,
      allowedShiftTypes: emp.allowedShiftTypes || ['fruehschicht', 'verschieben', 'nachtbereitschaft'],
      vacationDays: emp.vacationDays || [],
      // Vacation ranges / preferences are scoped to the currently selected planning
      // period — entries belonging to other periods still exist but aren't shown
      // (and therefore can't be edited away) while a different period is active.
      vacationRanges: (emp.vacationRanges || []).filter((r: any) => entryOverlapsPeriod(r, selectedPeriod)),
      preferences: (emp.preferences || []).filter((p: any) => entryOverlapsPeriod(p, selectedPeriod)),
      portalStatus: emp.portalStatus || 'none',
    },
    selectedPeriod: selectedPeriod ? {
      id: selectedPeriod.id,
      name: selectedPeriod.name,
      year: selectedPeriod.year,
      startMonth: selectedPeriod.startMonth ?? 0,
      months: selectedPeriod.months ?? 12,
      released: !!selectedPeriod.released,
      employeesLocked: !!selectedPeriod.employeesLocked,
    } : null,
    availablePeriods: periods
      .map((p: any) => ({
        id: p.id,
        name: p.name,
        year: p.year,
        startMonth: p.startMonth ?? 0,
        months: p.months ?? 12,
        released: !!p.released,
        employeesLocked: !!p.employeesLocked,
      }))
      .sort((a: any, b: any) => (a.year * 12 + a.startMonth) - (b.year * 12 + b.startMonth)),
    planReleased: released,
    employeesLocked: !!selectedPeriod?.employeesLocked,
    assignments: released ? myAssignments : [],
    labels: released ? visibleLabels : [],
    calendarLabels: released ? myCalendarLabels : [],
    customHolidays: state.customHolidays || [],
    swapSettings: state.swapSettings || { enabled: false, onlyWithinDepartment: false, onlyWithinShiftType: false },
    departmentId: emp.department || null,
    notificationPreferences: getNotificationPreferences(emp),
  });
});

/** Portal: persist which planning period the employee is currently viewing/editing */
app.post('/api/portal/select-period', portalAuthMiddleware, (req, res) => {
  const employeeId = (req as any).employeeId;
  const { periodId } = req.body ?? {};
  const state = loadState();
  const emp = (state.employees || []).find((e: any) => e.id === employeeId);
  if (!emp) { res.status(404).json({ error: 'Mitarbeiter nicht gefunden' }); return; }
  const period = (state.planningPeriods || []).find((p: any) => p.id === periodId);
  if (!period) { res.status(404).json({ error: 'Planungsperiode nicht gefunden' }); return; }
  emp.portalSelectedPeriodId = periodId;
  saveState(state);
  res.json({ success: true });
});

/** Portal: save vacation + preferences (draft or submit) */
app.put('/api/portal/my-data', portalAuthMiddleware, (req, res) => {
  const employeeId = (req as any).employeeId;
  const state = loadState();

  const emp = (state.employees || []).find((e: any) => e.id === employeeId);
  if (!emp) { res.status(404).json({ error: 'Mitarbeiter nicht gefunden' }); return; }

  const selectedPeriod = resolvePortalPeriod(state, emp);

  // Check if the currently selected period is released → editing locked (a
  // released plan already reflects the current vacation/preference data;
  // changing it afterwards wouldn't be reflected without regenerating)
  if (selectedPeriod?.released) {
    res.status(403).json({ error: 'Schichtplan ist freigegeben. Änderungen sind gesperrt.' });
    return;
  }

  // Check if the admin locked employee self-service for the selected period
  if (selectedPeriod?.employeesLocked) {
    res.status(403).json({ error: 'Änderungen wurden vom Administrator gesperrt.' });
    return;
  }

  // If already submitted, don't allow re-submit
  if (emp.portalStatus === 'submitted') {
    res.status(403).json({ error: 'Ihre Daten wurden bereits eingereicht. Änderungen sind nicht mehr möglich.' });
    return;
  }

  const { vacationRanges, preferences, action } = reviveDates(req.body);

  // Vacation ranges / preferences are edited per planning period: only entries
  // overlapping the currently selected period are replaced. Entries belonging
  // to other periods (or to no period at all) are left untouched — a wholesale
  // replace here would silently delete other periods' data, since the client
  // only ever sends the subset it can see (see GET /api/portal/my-data above).
  if (selectedPeriod) {
    const keptVacationRanges = (emp.vacationRanges || []).filter((r: any) => !entryOverlapsPeriod(r, selectedPeriod));
    const keptPreferences = (emp.preferences || []).filter((p: any) => !entryOverlapsPeriod(p, selectedPeriod));
    const newVacationRanges = (vacationRanges ?? []).filter((r: any) => entryOverlapsPeriod(r, selectedPeriod));
    const newPreferences = (preferences ?? []).filter((p: any) => entryOverlapsPeriod(p, selectedPeriod));
    emp.vacationRanges = [...keptVacationRanges, ...newVacationRanges];
    emp.preferences = [...keptPreferences, ...newPreferences];
  }
  // else: no planning period exists to scope new entries to — GET already
  // returns an empty list in that case, so there is nothing meaningful the
  // client could have edited; leave emp.vacationRanges/preferences untouched
  // rather than risk wholesale-replacing them with an incomplete client view.
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

/** Portal: get/update the employee's own email notification preferences (always editable, independent of plan lock) */
app.put('/api/portal/notification-preferences', portalAuthMiddleware, (req, res) => {
  const employeeId = (req as any).employeeId;
  const state = loadState();
  const emp = (state.employees || []).find((e: any) => e.id === employeeId);
  if (!emp) { res.status(404).json({ error: 'Mitarbeiter nicht gefunden' }); return; }

  const current = getNotificationPreferences(emp);
  const { planRelease, scheduleChanges, swapMatches } = req.body ?? {};
  emp.notificationPreferences = {
    planRelease: typeof planRelease === 'boolean' ? planRelease : current.planRelease,
    scheduleChanges: typeof scheduleChanges === 'boolean' ? scheduleChanges : current.scheduleChanges,
    swapMatches: typeof swapMatches === 'boolean' ? swapMatches : current.swapMatches,
  };
  saveState(state);
  res.json({ success: true, notificationPreferences: emp.notificationPreferences });
});

// ═══════════════════════════════════════════════════════════════════════
// STATE VERSION (for real-time polling)
// ═══════════════════════════════════════════════════════════════════════

/** Returns a hash/timestamp of current state for change detection */
/**
 * Lightweight polling endpoint (admin app + employee portal both call this
 * every few seconds to detect changes without refetching the full state).
 * Multi-tenant: accepts either an admin token or a portal token, resolves
 * the caller's organization from it, and reports that org's state.json
 * mtime. A 401 here (bad/expired token — e.g. the in-memory admin/portal
 * session was lost on a server restart) is the signal the frontend uses to
 * automatically drop back to the login screen instead of silently getting
 * stuck on stale data.
 */
app.get('/api/state/version', (req, res) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const adminSession = adminTokens.get(token);
  const portalSession = adminSession ? null : validatePortalToken(token);
  const organizationId = adminSession?.organizationId ?? portalSession?.organizationId;
  if (!organizationId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  try {
    const statPath = path.join(orgDataDir(organizationId), 'state.json');
    const stat = fs.statSync(statPath);
    res.json({ version: stat.mtimeMs.toString() });
  } catch {
    res.json({ version: '0' });
  }
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

    const { assignmentId, willingRanges, willingShiftTypes } = req.body;

    // Find the assignment (must belong to a released period)
    const found = findAssignmentAcrossPeriods(state, assignmentId);
    if (!found) { res.status(404).json({ error: 'Schicht nicht gefunden.' }); return; }
    const { period, assignment } = found;
    if (!period.released) {
      res.status(403).json({ error: 'Schichtplan ist noch nicht freigegeben.' });
      return;
    }
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

/** Portal: request to directly take over a colleague's offered shift (no counter-offer) */
app.post('/api/portal/swap-offer/request-takeover', portalAuthMiddleware, (req, res) => {
  try {
    const employeeId = (req as any).employeeId;
    const { offerId } = req.body;
    const state = loadState();

    const swapSettings = state.swapSettings || { enabled: false, allowDirectTakeover: false };
    if (!swapSettings.enabled || !swapSettings.allowDirectTakeover) {
      res.status(403).json({ error: 'Direktübernahme ist nicht aktiviert.' });
      return;
    }

    const offers = state.swapOffers || [];
    const offer = offers.find((o: any) => o.id === offerId);
    if (!offer) { res.status(404).json({ error: 'Angebot nicht gefunden.' }); return; }
    if (offer.status !== 'open') { res.status(400).json({ error: 'Angebot ist nicht mehr verfügbar.' }); return; }
    if (offer.employeeId === employeeId) { res.status(400).json({ error: 'Sie können Ihre eigene Schicht nicht übernehmen.' }); return; }

    const foundOfferAssignment = findAssignmentAcrossPeriods(state, offer.assignmentId);
    if (!foundOfferAssignment || !foundOfferAssignment.period.released) {
      res.status(403).json({ error: 'Schichtplan ist noch nicht freigegeben.' });
      return;
    }

    if (swapSettings.onlyWithinDepartment) {
      const employees = state.employees || [];
      const owner = employees.find((e: any) => e.id === offer.employeeId);
      const requester = employees.find((e: any) => e.id === employeeId);
      if (!owner || !requester || owner.department !== requester.department) {
        res.status(403).json({ error: 'Übernahme ist nur innerhalb der eigenen Abteilung erlaubt.' });
        return;
      }
    }

    const matches = state.swapMatches || [];
    const existing = matches.find((m: any) =>
      m.offerA === offerId && m.takeoverEmployeeId === employeeId && m.status === 'pending'
    );
    if (existing) { res.status(409).json({ error: 'Sie haben diese Schicht bereits angefragt.' }); return; }

    const match = {
      id: `match-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      offerA: offerId,
      takeoverEmployeeId: employeeId,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    matches.push(match);
    state.swapMatches = matches;
    saveState(state);
    res.json({ success: true, match });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Portal: withdraw a pending direct-takeover request */
app.post('/api/portal/swap-offer/withdraw-takeover-request', portalAuthMiddleware, (req, res) => {
  const employeeId = (req as any).employeeId;
  const { matchId } = req.body;

  const state = loadState();
  const matches = state.swapMatches || [];
  const match = matches.find((m: any) => m.id === matchId);
  if (!match) { res.status(404).json({ error: 'Anfrage nicht gefunden.' }); return; }
  if (match.takeoverEmployeeId !== employeeId) { res.status(403).json({ error: 'Nicht Ihre Anfrage.' }); return; }
  if (match.status !== 'pending') { res.status(400).json({ error: 'Anfrage wurde bereits bearbeitet.' }); return; }

  const idx = matches.indexOf(match);
  matches.splice(idx, 1);
  state.swapMatches = matches;
  saveState(state);
  res.json({ success: true });
});

/** Portal: get own swap offers, own takeover requests, and colleagues' offers available for takeover */
app.get('/api/portal/swap-offers', portalAuthMiddleware, (req, res) => {
  const employeeId = (req as any).employeeId;
  const state = loadState();
  const emp = (state.employees || []).find((e: any) => e.id === employeeId);
  const selectedPeriod = emp ? resolvePortalPeriod(state, emp) : null;
  /** Whether an assignment (by id) belongs to the currently selected planning period. */
  const inSelectedPeriod = (assignmentId: string | undefined): boolean => {
    if (!selectedPeriod || !assignmentId) return false;
    const p = findPeriodByAssignmentId(state, assignmentId);
    return !!p && p.id === selectedPeriod.id;
  };

  const allOffersUnfiltered = state.swapOffers || [];
  const allMatchesUnfiltered = state.swapMatches || [];
  const employees = state.employees || [];
  const departments = state.departments || [];

  // Scope everything to the employee's currently selected planning period —
  // shifts (and therefore swaps) from other periods aren't relevant to this view.
  const allOffers = allOffersUnfiltered.filter((o: any) => inSelectedPeriod(o.assignmentId));
  const allMatches = allMatchesUnfiltered.filter((m: any) => {
    if (m.ringOffers && m.ringOffers.length > 0) {
      return (m.ringOffers as string[]).every((oid: string) => {
        const o = allOffersUnfiltered.find((x: any) => x.id === oid);
        return o && inSelectedPeriod(o.assignmentId);
      });
    }
    const offerA = allOffersUnfiltered.find((o: any) => o.id === m.offerA);
    return !!offerA && inSelectedPeriod(offerA.assignmentId);
  });

  const swapSettings = state.swapSettings || {
    enabled: false, onlyWithinDepartment: false, onlyWithinShiftType: false, allowRingSwap: false, allowDirectTakeover: false,
  };

  const offers = allOffers.filter((o: any) => o.employeeId === employeeId);
  const offerIds = offers.map((o: any) => o.id);

  const matches = allMatches
    .filter((m: any) => offerIds.includes(m.offerA) || offerIds.includes(m.offerB) || m.takeoverEmployeeId === employeeId)
    .map((m: any) => {
      // Enrich takeover matches with shift + counterpart info from the viewer's perspective
      if (m.takeoverEmployeeId) {
        const offerA = allOffers.find((o: any) => o.id === m.offerA);
        if (offerA) {
          const owner = employees.find((e: any) => e.id === offerA.employeeId);
          const taker = employees.find((e: any) => e.id === m.takeoverEmployeeId);
          const counterpartName = m.takeoverEmployeeId === employeeId ? (owner?.name || 'Unbekannt') : (taker?.name || 'Unbekannt');
          return {
            ...m,
            swapInfo: {
              shiftType: offerA.shiftType,
              startDate: offerA.startDate,
              endDate: offerA.endDate,
              counterpartName,
            },
          };
        }
      }
      return m;
    });

  let availableOffers: any[] = [];
  if (swapSettings.enabled && swapSettings.allowDirectTakeover) {
    const me = employees.find((e: any) => e.id === employeeId);
    const pendingRequestedOfferIds = new Set(
      allMatches
        .filter((m: any) => m.takeoverEmployeeId === employeeId && m.status === 'pending')
        .map((m: any) => m.offerA)
    );
    availableOffers = allOffers
      .filter((o: any) => o.status === 'open' && o.employeeId !== employeeId)
      .filter((o: any) => {
        if (!swapSettings.onlyWithinDepartment) return true;
        const owner = employees.find((e: any) => e.id === o.employeeId);
        return !!me && !!owner && me.department === owner.department;
      })
      .map((o: any) => {
        const owner = employees.find((e: any) => e.id === o.employeeId);
        const dept = owner ? departments.find((d: any) => d.id === owner.department) : null;
        return {
          ...o,
          employeeName: owner?.name || 'Unbekannt',
          departmentName: dept?.name || '',
          alreadyRequested: pendingRequestedOfferIds.has(o.id),
        };
      });
  }

  res.json({ offers, matches, availableOffers, swapSettings });
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
    const period = findPeriodByAssignmentId(state, match.offerA ? (offers.find((o: any) => o.id === match.offerA)?.assignmentId) : undefined);
    if (!period) { res.status(400).json({ error: 'Kein Schichtplan.', violations: [] }); return; }
    const plan = period;

    const employees = state.employees || [];
    const config = plan.schedulerConfig || state.schedulerConfig;
    const departments = state.departments || [];
    const allAssignmentsFlat = getAllAssignmentsFlat(state);

    /** Ensure an assignment belongs to the same period as offerA's — cross-period swaps aren't supported. */
    const assertSamePeriod = (assignmentId: string): boolean => {
      const p = findPeriodByAssignmentId(state, assignmentId);
      return !!p && p.id === plan.id;
    };

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
      if (ringOffers.some((o: any) => !assertSamePeriod(o.assignmentId))) {
        res.status(400).json({ error: 'Ringtausch über mehrere Planungsperioden hinweg wird nicht unterstützt.', violations: [] });
        return;
      }

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
          const otherAssignments = allAssignmentsFlat
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
    } else if (match.takeoverEmployeeId) {
      // ── Direct takeover simulation (no counter-offer) ──
      const offerA = offers.find((o: any) => o.id === match.offerA);
      if (!offerA) { res.status(400).json({ error: 'Angebot nicht gefunden.', violations: [] }); return; }

      const assignmentA = (plan.assignments || []).find((a: any) => a.id === offerA.assignmentId);
      if (!assignmentA) { res.status(400).json({ error: 'Schicht nicht gefunden.', violations: [] }); return; }

      const tA = tempAssignments.find((a: any) => a.id === offerA.assignmentId);
      if (tA) {
        tA.employees = tA.employees.filter((id: string) => id !== offerA.employeeId);
        tA.employees.push(match.takeoverEmployeeId);
      }

      const takeoverEmp = employees.find((e: any) => e.id === match.takeoverEmployeeId);
      if (takeoverEmp) {
        const otherAssignments = allAssignmentsFlat
          .filter((a: any) => a.id !== assignmentA.id)
          .map((a: any) => ({ ...a, employees: a.employees.filter((id: string) => id !== takeoverEmp.id) }));
        const canTake = getAvailableEmployeesSorted(
          [takeoverEmp], assignmentA.shiftType,
          new Date(assignmentA.startDate), new Date(assignmentA.endDate),
          otherAssignments, config, departments,
        );
        if (canTake.length === 0) {
          const dt = new Date(assignmentA.startDate).toLocaleDateString('de-DE');
          violationMessages.push(
            `${takeoverEmp.name} kann ${SHIFT_LABELS[assignmentA.shiftType] || assignmentA.shiftType} ab ${dt} nicht übernehmen (Regelkonflikt)`
          );
        }
      }
    } else {
      // ── Direct swap simulation ──
      const offerA = offers.find((o: any) => o.id === match.offerA);
      const offerB = offers.find((o: any) => o.id === match.offerB);
      if (!offerA || !offerB) { res.status(400).json({ error: 'Angebote nicht gefunden.', violations: [] }); return; }
      if (!assertSamePeriod(offerB.assignmentId)) {
        res.status(400).json({ error: 'Tausch über mehrere Planungsperioden hinweg wird nicht unterstützt.', violations: [] });
        return;
      }

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
        const otherAssignments = allAssignmentsFlat
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
        const otherAssignments = allAssignmentsFlat
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
app.post('/api/swaps/resolve', authMiddleware, requirePermission('swaps'), async (req, res) => {
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
      logAdminChange(req, 'swaps', 'Tauschangebot abgelehnt');
      res.json({ success: true, match });
      return;
    }

    // Approve: execute the swap
    const offers = state.swapOffers || [];
    const period = findPeriodByAssignmentId(state, match.offerA ? (offers.find((o: any) => o.id === match.offerA)?.assignmentId) : undefined);
    if (!period) { res.status(400).json({ error: 'Kein Schichtplan.' }); return; }
    const plan = period;
    const assertSamePeriodResolve = (assignmentId: string): boolean => {
      const p = findPeriodByAssignmentId(state, assignmentId);
      return !!p && p.id === plan.id;
    };

    const isRing = match.ringOffers && match.ringOffers.length >= 3;

    if (isRing) {
      // ── Ring swap: each offer[i]'s employee leaves their assignment,
      //    and the PREVIOUS person in the ring takes it (circular shift). ──
      const ringOfferIds: string[] = match.ringOffers;
      const ringOffers = ringOfferIds.map((id: string) => offers.find((o: any) => o.id === id));
      if (ringOffers.some((o: any) => !o)) { res.status(400).json({ error: 'Angebote nicht gefunden.' }); return; }
      if (ringOffers.some((o: any) => !assertSamePeriodResolve(o.assignmentId))) {
        res.status(400).json({ error: 'Ringtausch über mehrere Planungsperioden hinweg wird nicht unterstützt.' });
        return;
      }

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
      plan.updatedAt = new Date().toISOString();

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
        if (emp?.email && getNotificationPreferences(emp).swapMatches) {
          try {
            await sendRingSwapMatchEmail(emp.email, emp.name, ringOffers[i], receivedOffer, allParticipantNames);
          } catch (e) { console.error('[ring-swap] mail failed:', e); }
        }
      }

      logAdminChange(req, 'swaps', 'Ringtausch genehmigt');
      res.json({ success: true, match });
    } else if (match.takeoverEmployeeId) {
      // ── Direct takeover: giver loses the shift, requester takes it over (no counter-offer) ──
      const offerA = offers.find((o: any) => o.id === match.offerA);
      if (!offerA) { res.status(400).json({ error: 'Angebot nicht gefunden.' }); return; }

      const assignmentA = (plan.assignments || []).find((a: any) => a.id === offerA.assignmentId);
      if (!assignmentA) { res.status(400).json({ error: 'Schicht nicht gefunden.' }); return; }

      assignmentA.employees = assignmentA.employees.filter((id: string) => id !== offerA.employeeId);
      if (!assignmentA.employees.includes(match.takeoverEmployeeId)) assignmentA.employees.push(match.takeoverEmployeeId);

      offerA.status = 'matched';
      match.status = 'approved';
      match.resolvedAt = new Date().toISOString();
      plan.updatedAt = new Date().toISOString();

      // Any other pending request (takeover or normal swap/ring) referencing this
      // now-consumed offer is no longer valid — reject it immediately.
      for (const m of matches) {
        if (m.id === match.id || m.status !== 'pending') continue;
        const refsOfferA = m.offerA === offerA.id || m.offerB === offerA.id ||
          (m.ringOffers && m.ringOffers.includes(offerA.id));
        if (refsOfferA) { m.status = 'rejected'; m.resolvedAt = new Date().toISOString(); }
      }

      state.swapOffers = offers;
      state.swapMatches = matches;
      saveState(state);

      const employees = state.employees || [];
      const giver = employees.find((e: any) => e.id === offerA.employeeId);
      const taker = employees.find((e: any) => e.id === match.takeoverEmployeeId);

      if (giver?.email && getNotificationPreferences(giver).swapMatches) {
        try {
          await sendTakeoverMatchEmail(giver.email, giver.name, taker?.name || 'Kollege/in', offerA, 'giver');
        } catch (e) { console.error('[takeover] mail to giver failed:', e); }
      }
      if (taker?.email && getNotificationPreferences(taker).swapMatches) {
        try {
          await sendTakeoverMatchEmail(taker.email, taker.name, giver?.name || 'Kollege/in', offerA, 'taker');
        } catch (e) { console.error('[takeover] mail to taker failed:', e); }
      }

      logAdminChange(req, 'swaps', 'Schichtübernahme genehmigt');
      res.json({ success: true, match });
    } else {
      // ── Direct swap ──
      const offerA = offers.find((o: any) => o.id === match.offerA);
      const offerB = offers.find((o: any) => o.id === match.offerB);
      if (!offerA || !offerB) { res.status(400).json({ error: 'Angebote nicht gefunden.' }); return; }
      if (!assertSamePeriodResolve(offerB.assignmentId)) {
        res.status(400).json({ error: 'Tausch über mehrere Planungsperioden hinweg wird nicht unterstützt.' });
        return;
      }

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
      plan.updatedAt = new Date().toISOString();

      state.swapOffers = offers;
      state.swapMatches = matches;
      saveState(state);

      // Send emails to both employees
      const employees = state.employees || [];
      const empA = employees.find((e: any) => e.id === offerA.employeeId);
      const empB = employees.find((e: any) => e.id === offerB.employeeId);

      if (empA?.email && getNotificationPreferences(empA).swapMatches) {
        try {
          await sendSwapMatchEmail(empA.email, empA.name, empB?.name || 'Kollege/in', offerA, offerB);
        } catch (e) { console.error('[swap] mail to A failed:', e); }
      }
      if (empB?.email && getNotificationPreferences(empB).swapMatches) {
        try {
          await sendSwapMatchEmail(empB.email, empB.name, empA?.name || 'Kollege/in', offerB, offerA);
        } catch (e) { console.error('[swap] mail to B failed:', e); }
      }

      logAdminChange(req, 'swaps', 'Tausch genehmigt');
      res.json({ success: true, match });
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Admin: undo a resolved swap match */
app.post('/api/swaps/undo', authMiddleware, requirePermission('swaps'), async (req, res) => {
  try {
    const { matchId } = req.body;
    const state = loadState();
    const matches = state.swapMatches || [];
    const match = matches.find((m: any) => m.id === matchId);
    if (!match) { res.status(404).json({ error: 'Match nicht gefunden.' }); return; }
    if (match.status === 'pending') { res.status(400).json({ error: 'Match ist noch ausstehend.' }); return; }

    const offers = state.swapOffers || [];
    const isRing = match.ringOffers && match.ringOffers.length >= 3;
    const touchedPeriods = new Set<any>();

    if (match.status === 'approved') {
      if (isRing) {
        // Reverse ring swap
        const ringOfferIds: string[] = match.ringOffers;
        const ringOffers = ringOfferIds.map((id: string) => offers.find((o: any) => o.id === id));
        const ringAssignments = ringOffers.map((o: any) =>
          o ? findAssignmentAcrossPeriods(state, o.assignmentId) : null
        );

        const n = ringOffers.length;
        for (let i = 0; i < n; i++) {
          if (!ringOffers[i] || !ringAssignments[i]) continue;
          const { period, assignment } = ringAssignments[i]!;
          touchedPeriods.add(period);
          const originalEmpId = ringOffers[i].employeeId;
          const swappedInEmpId = ringOffers[(i - 1 + n) % n].employeeId;
          // Remove the person who was swapped in, restore original
          assignment.employees = assignment.employees.filter((id: string) => id !== swappedInEmpId);
          if (!assignment.employees.includes(originalEmpId)) assignment.employees.push(originalEmpId);
        }

        // Only reset offers that are still 'matched' back to 'open'
        for (const o of ringOffers) { if (o && o.status === 'matched') o.status = 'open'; }
      } else if (match.takeoverEmployeeId) {
        // Reverse direct takeover
        const offerA = offers.find((o: any) => o.id === match.offerA);
        const foundA = offerA ? findAssignmentAcrossPeriods(state, offerA.assignmentId) : null;
        if (offerA && foundA) {
          touchedPeriods.add(foundA.period);
          const assignmentA = foundA.assignment;
          assignmentA.employees = assignmentA.employees.filter((id: string) => id !== match.takeoverEmployeeId);
          if (!assignmentA.employees.includes(offerA.employeeId)) assignmentA.employees.push(offerA.employeeId);
        }
        if (offerA && offerA.status === 'matched') offerA.status = 'open';
      } else {
        // Reverse direct swap
        const offerA = offers.find((o: any) => o.id === match.offerA);
        const offerB = offers.find((o: any) => o.id === match.offerB);
        const foundA = offerA ? findAssignmentAcrossPeriods(state, offerA.assignmentId) : null;
        const foundB = offerB ? findAssignmentAcrossPeriods(state, offerB.assignmentId) : null;

        if (offerA && offerB && foundA && foundB) {
          touchedPeriods.add(foundA.period);
          touchedPeriods.add(foundB.period);
          const assignmentA = foundA.assignment;
          const assignmentB = foundB.assignment;
          assignmentA.employees = assignmentA.employees.filter((id: string) => id !== offerB.employeeId);
          if (!assignmentA.employees.includes(offerA.employeeId)) assignmentA.employees.push(offerA.employeeId);
          assignmentB.employees = assignmentB.employees.filter((id: string) => id !== offerA.employeeId);
          if (!assignmentB.employees.includes(offerB.employeeId)) assignmentB.employees.push(offerB.employeeId);
        }

        if (offerA && offerA.status === 'matched') offerA.status = 'open';
        if (offerB && offerB.status === 'matched') offerB.status = 'open';
      }

      for (const period of touchedPeriods) {
        (period as any).updatedAt = new Date().toISOString();
      }
    }
    // For rejected matches: don't touch offer status at all

    // Check if all referenced offers are still open — if not, remove the match entirely
    const allOfferIds = isRing
      ? (match.ringOffers as string[])
      : match.takeoverEmployeeId
        ? [match.offerA]
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
    logAdminChange(req, 'swaps', 'Tausch rückgängig gemacht');
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
      : m.takeoverEmployeeId
        ? [m.offerA]
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

      // Check if already matched — a rejected match for this exact pair must
      // also block re-creation, otherwise re-scanning resurrects the same
      // offer combination as a "new" match right after it was declined.
      const alreadyMatched = matches.some((m: any) =>
        (m.status === 'pending' || m.status === 'rejected') &&
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

      // Cross-period swaps are not supported — both assignments must belong to the same planning period
      const periodA = findPeriodByAssignmentId(state, a.assignmentId);
      const periodB = findPeriodByAssignmentId(state, b.assignmentId);
      if (!periodA || !periodB || periodA.id !== periodB.id) continue;

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
    findRingMatches(openOffers, matches, swapSettings, employees, state);
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
  state: any,
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

      // Cross-period rings are not supported — both assignments must belong to the same planning period
      const periodI = findPeriodByAssignmentId(state, openOffers[i].assignmentId);
      const periodJ = findPeriodByAssignmentId(state, openOffers[j].assignmentId);
      if (!periodI || !periodJ || periodI.id !== periodJ.id) continue;

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

  // A rejected ring must not be resurrected as a "new" match on re-scan —
  // track the exact offer combinations that were already rejected so an
  // identical cycle found again is skipped (unlike the pending/approved set
  // above, individual offers from a rejected ring stay free to appear in
  // other, different rings).
  const rejectedRingKeys = new Set<string>();
  for (const m of matches) {
    if (m.status !== 'rejected' || !m.ringOffers || m.ringOffers.length === 0) continue;
    rejectedRingKeys.add(([...m.ringOffers] as string[]).sort().join(','));
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

          // Skip if this exact combination was already rejected
          if (rejectedRingKeys.has([...ringOfferIds].sort().join(','))) continue;

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
// ═══════════════════════════════════════════════════════════════════════
// BACKUP — periodic full-system email export + manual restore
// ═══════════════════════════════════════════════════════════════════════

/** Admin: current backup schedule settings, if any. */
app.get('/api/backup/settings', authMiddleware, (_req, res) => {
  const state = loadState();
  res.json(state.backupSettings || null);
});

/** Admin: configure (or update) the backup email/interval. Sends the first backup immediately, then on the given interval. */
app.post('/api/backup/settings', authMiddleware, requirePermission('settings_backup'), async (req, res) => {
  try {
    const { email, intervalHours } = req.body ?? {};
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Ungültige E-Mail-Adresse.' });
      return;
    }
    if (typeof intervalHours !== 'number' || !Number.isFinite(intervalHours) || intervalHours < 1) {
      res.status(400).json({ error: 'Ungültiges Intervall.' });
      return;
    }
    await updateBackupSettings(email, intervalHours);
    logAdminChange(req, 'settings_backup', `Backup-Einstellungen geändert: ${email}, alle ${intervalHours}h`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Admin: disable the backup schedule. */
app.post('/api/backup/disable', authMiddleware, requirePermission('settings_backup'), (_req, res) => {
  disableBackupSettings();
  res.json({ success: true });
});

/** Admin: restore the entire application (state + portal credentials) from a previously exported backup JSON. */
app.post('/api/backup/restore', authMiddleware, requirePermission('settings_backup'), (req, res) => {
  try {
    restoreFromBackup(req.body);
    logAdminChange(req, 'settings_backup', 'Backup eingespielt — Organisation wurde aus Sicherungsdatei wiederhergestellt');
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// NOTE: The employee portal SPA (dist/portal) and the admin SPA (dist) are
// served as static files directly by nginx on their own domains —
// schichtapp.de (portal) and admin.schichtapp.de (admin) — so this backend
// only needs to expose the /api/* endpoints above. See
// /etc/nginx/sites-available/schichtapp.de and admin.schichtapp.de.
// ═══════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`✔ Schichtplan server running on http://localhost:${PORT}`);
  initPlatformOwner();
  initBackupSchedule();
});
