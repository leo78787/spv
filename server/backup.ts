/**
 * Full-system backup/restore: periodic email export + manual restore.
 * Multi-tenant: each organization has its own independent schedule (stored
 * in its own state.json under `backupSettings`) and its own timer.
 *
 * A backup bundles everything needed to restore one organization exactly:
 * - its admin state (employees, departments, planning periods, holidays,
 *   labels, swap settings, tab visibility, swap offers/matches, ...)
 * - its employee portal data (credentials, password hashes/salts, sessions)
 *
 * Scheduling runs in-process via per-org timers (this app runs as one
 * systemd-managed instance, so no external cron/queue is needed). On
 * restart, initBackupSchedule() resumes every organization's cadence based
 * on its persisted lastSentAt, sending an overdue backup immediately if
 * needed rather than silently drifting.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadState, saveState, listOrganizations, orgDataDir } from './db.js';
import { getFullPortalData, restorePortalData } from './portalAuth.js';
import { sendMail } from './mailer.js';
import { runWithOrg, currentOrgId } from './orgContext.js';

export interface BackupSettings {
  email: string;
  intervalHours: number;
  enabled: boolean;
  lastSentAt?: string;
}

function ensureBackupsDir(orgId: string): string {
  const dir = path.join(orgDataDir(orgId), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build the full exportable backup payload for the current org: everything needed to restore it exactly. */
export function buildBackupPayload(): any {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    state: loadState(),
    portal: getFullPortalData(),
  };
}

async function sendBackupEmailNow(email: string): Promise<void> {
  const payload = buildBackupPayload();
  const json = JSON.stringify(payload, null, 2);
  const dateLabel = new Date(payload.exportedAt).toLocaleString('de-DE');
  const filename = `schichtplan-backup-${payload.exportedAt.slice(0, 10)}.json`;

  await sendMail({
    to: email,
    subject: 'Schichtplan Manager – Backup',
    text: `Anbei das Backup vom ${dateLabel}.\n\nDiese Datei enthält alle Daten der Organisation (Mitarbeiter, Zugangsdaten, Planungsperioden, Einstellungen) und kann im Admin-Bereich unter Einstellungen -> Backup zur Wiederherstellung hochgeladen werden.\n\nBitte bewahren Sie diese Datei sicher auf — sie enthält sensible Zugangsdaten.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #4f46e5; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin:0;">Schichtplan Manager – Backup</h2>
        </div>
        <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
          <p>Anbei das Backup vom <strong>${dateLabel}</strong>.</p>
          <p style="color:#6b7280;font-size:14px;">Diese Datei enthält alle Daten der Organisation (Mitarbeiter, Zugangsdaten, Planungsperioden, Einstellungen) und kann im Admin-Bereich unter <strong>Einstellungen → Backup</strong> zur Wiederherstellung hochgeladen werden.</p>
          <p style="color:#b91c1c;font-size:13px;">Bitte bewahren Sie diese Datei sicher auf — sie enthält sensible Zugangsdaten.</p>
        </div>
      </div>
    `,
    attachments: [{ filename, content: json, contentType: 'application/json' }],
  });
}

const backupTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearBackupTimer(orgId: string) {
  const t = backupTimers.get(orgId);
  if (t) { clearTimeout(t); backupTimers.delete(orgId); }
}

function scheduleNext(orgId: string, intervalHours: number) {
  clearBackupTimer(orgId);
  const ms = Math.max(1, intervalHours) * 60 * 60 * 1000;
  backupTimers.set(orgId, setTimeout(() => { runBackupCycle(orgId); }, ms));
}

async function runBackupCycle(orgId: string): Promise<void> {
  await runWithOrg(orgId, async () => {
    const state = loadState();
    const settings: BackupSettings | undefined = state.backupSettings;
    if (!settings?.enabled) return;
    try {
      await sendBackupEmailNow(settings.email);
      const fresh = loadState(); // re-load in case other admin activity saved state meanwhile
      if (fresh.backupSettings) {
        fresh.backupSettings.lastSentAt = new Date().toISOString();
        saveState(fresh);
      }
    } catch (err) {
      console.error(`[backup] failed to send scheduled backup email for org ${orgId}:`, err);
    }
    scheduleNext(orgId, settings.intervalHours);
  });
}

/** Call once at server startup to resume every organization's previously configured backup schedule. */
export function initBackupSchedule(): void {
  for (const org of listOrganizations()) {
    runWithOrg(org.id, () => {
      const state = loadState();
      const settings: BackupSettings | undefined = state.backupSettings;
      if (!settings?.enabled) return;
      const intervalMs = Math.max(1, settings.intervalHours) * 60 * 60 * 1000;
      const lastSentMs = settings.lastSentAt ? new Date(settings.lastSentAt).getTime() : 0;
      const elapsed = Date.now() - lastSentMs;
      if (!settings.lastSentAt || elapsed >= intervalMs) {
        // Overdue (or never sent) — send now, which also schedules the next one.
        runBackupCycle(org.id);
      } else {
        clearBackupTimer(org.id);
        backupTimers.set(org.id, setTimeout(() => { runBackupCycle(org.id); }, intervalMs - elapsed));
      }
    });
  }
}

/** Save new backup settings for the current org and immediately send the first backup email ("sofort eine E-Mail"). */
export async function updateBackupSettings(email: string, intervalHours: number): Promise<void> {
  const orgId = currentOrgId();
  const state = loadState();
  state.backupSettings = { email, intervalHours, enabled: true, lastSentAt: undefined };
  saveState(state);
  await runBackupCycle(orgId);
}

export function disableBackupSettings(): void {
  const orgId = currentOrgId();
  const state = loadState();
  if (state.backupSettings) {
    state.backupSettings.enabled = false;
    saveState(state);
  }
  clearBackupTimer(orgId);
}

/**
 * Restore the current organization (admin state + portal credentials) from
 * a previously exported backup payload. A timestamped safety copy of the
 * data being overwritten is kept in data/orgs/<orgId>/backups/ first, since
 * this is otherwise irreversible.
 */
export function restoreFromBackup(payload: any): void {
  if (!payload || typeof payload !== 'object' || !payload.state || typeof payload.state !== 'object'
      || !payload.portal || typeof payload.portal !== 'object') {
    throw new Error('Ungültiges Backup-Format.');
  }

  const orgId = currentOrgId();
  const backupsDir = ensureBackupsDir(orgId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.writeFileSync(path.join(backupsDir, `pre-restore-state-${stamp}.json`), JSON.stringify(loadState(), null, 2));
    fs.writeFileSync(path.join(backupsDir, `pre-restore-portal-${stamp}.json`), JSON.stringify(getFullPortalData(), null, 2));
  } catch (err) {
    console.error('[backup] failed to save pre-restore safety copy (continuing with restore):', err);
  }

  saveState(payload.state);
  restorePortalData(payload.portal);

  // Re-arm this org's schedule in case the restored state carries its own backupSettings.
  clearBackupTimer(orgId);
  const state = loadState();
  const settings: BackupSettings | undefined = state.backupSettings;
  if (settings?.enabled) scheduleNext(orgId, settings.intervalHours);
}
