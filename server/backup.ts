/**
 * Full-system backup/restore: periodic email export + manual restore.
 *
 * A backup bundles everything needed to restore the app exactly:
 * - the admin state (employees, departments, planning periods, holidays,
 *   labels, swap settings, tab visibility, swap offers/matches, ...)
 * - the employee portal data (credentials, password hashes/salts, sessions)
 *
 * Scheduling runs in-process via a single timer (this app runs as one
 * systemd-managed instance, so no external cron/queue is needed). On
 * restart, initBackupSchedule() resumes the configured cadence based on the
 * persisted lastSentAt, sending an overdue backup immediately if needed
 * rather than silently drifting.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState, saveState } from './db.js';
import { getFullPortalData, restorePortalData } from './portalAuth.js';
import { sendMail } from './mailer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUPS_DIR = path.join(__dirname, '..', 'data', 'backups');

export interface BackupSettings {
  email: string;
  intervalHours: number;
  enabled: boolean;
  lastSentAt?: string;
}

function ensureBackupsDir() {
  if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

/** Build the full exportable backup payload: everything needed to restore the app exactly. */
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
    text: `Anbei das Backup vom ${dateLabel}.\n\nDiese Datei enthält alle Daten der Anwendung (Mitarbeiter, Zugangsdaten, Planungsperioden, Einstellungen) und kann im Admin-Bereich unter Einstellungen -> Backup zur Wiederherstellung hochgeladen werden.\n\nBitte bewahren Sie diese Datei sicher auf — sie enthält sensible Zugangsdaten.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #4f46e5; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin:0;">Schichtplan Manager – Backup</h2>
        </div>
        <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
          <p>Anbei das Backup vom <strong>${dateLabel}</strong>.</p>
          <p style="color:#6b7280;font-size:14px;">Diese Datei enthält alle Daten der Anwendung (Mitarbeiter, Zugangsdaten, Planungsperioden, Einstellungen) und kann im Admin-Bereich unter <strong>Einstellungen → Backup</strong> zur Wiederherstellung hochgeladen werden.</p>
          <p style="color:#b91c1c;font-size:13px;">Bitte bewahren Sie diese Datei sicher auf — sie enthält sensible Zugangsdaten.</p>
        </div>
      </div>
    `,
    attachments: [{ filename, content: json, contentType: 'application/json' }],
  });
}

let backupTimer: ReturnType<typeof setTimeout> | null = null;

function clearBackupTimer() {
  if (backupTimer) { clearTimeout(backupTimer); backupTimer = null; }
}

function scheduleNext(intervalHours: number) {
  clearBackupTimer();
  const ms = Math.max(1, intervalHours) * 60 * 60 * 1000;
  backupTimer = setTimeout(runBackupCycle, ms);
}

async function runBackupCycle(): Promise<void> {
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
    console.error('[backup] failed to send scheduled backup email:', err);
  }
  scheduleNext(settings.intervalHours);
}

/** Call once at server startup to resume any previously configured backup schedule. */
export function initBackupSchedule(): void {
  const state = loadState();
  const settings: BackupSettings | undefined = state.backupSettings;
  if (!settings?.enabled) return;
  const intervalMs = Math.max(1, settings.intervalHours) * 60 * 60 * 1000;
  const lastSentMs = settings.lastSentAt ? new Date(settings.lastSentAt).getTime() : 0;
  const elapsed = Date.now() - lastSentMs;
  if (!settings.lastSentAt || elapsed >= intervalMs) {
    // Overdue (or never sent) — send now, which also schedules the next one.
    runBackupCycle();
  } else {
    clearBackupTimer();
    backupTimer = setTimeout(runBackupCycle, intervalMs - elapsed);
  }
}

/** Save new backup settings and immediately send the first backup email ("sofort eine E-Mail"). */
export async function updateBackupSettings(email: string, intervalHours: number): Promise<void> {
  const state = loadState();
  state.backupSettings = { email, intervalHours, enabled: true, lastSentAt: undefined };
  saveState(state);
  await runBackupCycle();
}

export function disableBackupSettings(): void {
  const state = loadState();
  if (state.backupSettings) {
    state.backupSettings.enabled = false;
    saveState(state);
  }
  clearBackupTimer();
}

/**
 * Restore the entire application (admin state + portal credentials) from a
 * previously exported backup payload. A timestamped safety copy of the data
 * being overwritten is kept in data/backups/ first, since this is otherwise
 * irreversible.
 */
export function restoreFromBackup(payload: any): void {
  if (!payload || typeof payload !== 'object' || !payload.state || typeof payload.state !== 'object'
      || !payload.portal || typeof payload.portal !== 'object') {
    throw new Error('Ungültiges Backup-Format.');
  }

  ensureBackupsDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.writeFileSync(path.join(BACKUPS_DIR, `pre-restore-state-${stamp}.json`), JSON.stringify(loadState(), null, 2));
    fs.writeFileSync(path.join(BACKUPS_DIR, `pre-restore-portal-${stamp}.json`), JSON.stringify(getFullPortalData(), null, 2));
  } catch (err) {
    console.error('[backup] failed to save pre-restore safety copy (continuing with restore):', err);
  }

  saveState(payload.state);
  restorePortalData(payload.portal);

  // Re-arm the schedule in case the restored state carries its own backupSettings.
  clearBackupTimer();
  initBackupSchedule();
}
