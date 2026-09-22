/**
 * Forderungen (receivables/claims) tool — data + business logic, served at
 * forderung.schichtapp.de. One directory per organization
 * (data/orgs/<orgId>/forderungen.json), matching the per-org file pattern
 * already used by state.json/portal.json/boards.json.
 *
 * Field model mirrors the standalone prototype in /beispiel (see its
 * README) with one deliberate change: that prototype drove its workflow off
 * the imported SAP/HighRadius "Aktionsstatus" values and a free-text
 * "zuständig" name. Here `aktionsstatus` is kept only as an imported,
 * read-only reference field, and the actual workflow is:
 *   - `kanbanStatus`: a tool-managed three-state field (offen/in_arbeit/done)
 *     driving the "Meine Forderungen" Kanban board.
 *   - `assignedLeitungId`: a real AdminUser id (role 'leitung') instead of a
 *     free-text name — exactly the gap the prototype's README flagged
 *     ("fehlt dafür noch ein Feld... aktuell bewusst nicht eigenmächtig
 *     ergänzt").
 *
 * SOURCE_FIELDS are overwritten on every Excel re-import; WORKFLOW_FIELDS
 * are only ever changed inside the tool and survive re-imports untouched —
 * same rationale as the prototype: a monthly re-import must never wipe out
 * work already done.
 */

import fs from 'node:fs';
import path from 'node:path';
import { orgDataDir } from './db.js';
import { listAdminUsers } from './adminAuth.js';
import { AttachmentMeta, MAX_ATTACHMENT_SIZE, MAX_ATTACHMENTS_PER_COMMENT, isAllowedAttachmentType, sanitizeFilename } from './attachments.js';
import * as forderungRules from './forderungRules.js';

export { MAX_ATTACHMENT_SIZE, MAX_ATTACHMENTS_PER_COMMENT };

export const SOURCE_FIELD_KEYS = [
  'verkaufsbuero', 'serviceLeiter', 'debitor', 'kundentyp', 'kundenname',
  'rechnungsnummer', 'auftragVertrag', 'equipment', 'text', 'reklamationsgrund',
  'resolver', 'aktionsstatus', 'faelligeForderung', 'altforderungen180', 'pwbMonatsende',
] as const;
export type SourceFieldKey = typeof SOURCE_FIELD_KEYS[number];

export const NUMERIC_SOURCE_FIELDS = new Set(['faelligeForderung', 'altforderungen180', 'pwbMonatsende']);

export type KanbanStatus = 'offen' | 'in_arbeit' | 'done' | 'archiviert';

export interface ForderungHistoryEntry {
  at: string;
  actorName: string;
  action: string;
  detail?: string;
}

export interface ForderungComment {
  id: string;
  authorId: string | null; // null for system/import-authored notes, if ever needed
  authorName: string;
  text: string;
  attachmentIds: string[];
  createdAt: string;
}

export interface ForderungRecord {
  id: string;
  organizationId: string;
  /** Dedup key: `${debitor}::${rechnungsnummer}`, lowercased/trimmed. Empty string only transiently — records without both are rejected before creation. */
  key: string;

  // ── Source fields (Excel) ──────────────────────────────────────────
  verkaufsbuero: string;
  serviceLeiter: string;
  debitor: string;
  kundentyp: string;
  kundenname: string;
  rechnungsnummer: string;
  auftragVertrag: string;
  equipment: string;
  text: string;
  reklamationsgrund: string;
  resolver: string;
  /** Imported status text (e.g. SAP/HighRadius process code) — informational only, not the workflow driver. */
  aktionsstatus: string;
  faelligeForderung: number;
  altforderungen180: number;
  pwbMonatsende: number;

  // ── Workflow fields (tool-managed) ─────────────────────────────────
  kanbanStatus: KanbanStatus;
  assignedLeitungId: string | null;
  notizen: string;

  // ── Bookkeeping ─────────────────────────────────────────────────────
  missingInLastImport: boolean;
  missingSince: string | null;
  lastSourceImportAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  history: ForderungHistoryEntry[];
  comments: ForderungComment[];
}

interface ImportSummary {
  importedAt: string;
  createdCount: number;
  updatedCount: number;
  reappearedCount: number;
  skippedCount: number;
  missingCount: number;
}

interface ForderungenData {
  records: Record<string, ForderungRecord>;
  lastImportAt: string | null;
  lastImportSummary: ImportSummary | null;
  attachments: Record<string, AttachmentMeta>;
}

function filePath(orgId: string): string {
  return path.join(orgDataDir(orgId), 'forderungen.json');
}

/** Where uploaded comment attachments are stored on disk, one directory per org — matches boards.ts's board-attachments/ pattern. */
export function attachmentsDir(orgId: string): string {
  return path.join(orgDataDir(orgId), 'forderung-attachments');
}

export function attachmentFilePath(orgId: string, attachmentId: string, meta: AttachmentMeta): string {
  return path.join(attachmentsDir(orgId), `${attachmentId}-${sanitizeFilename(meta.filename)}`);
}

/** Every claim in an org is visible to every role with Forderungen access (see canViewForderungRecord in index.ts), so attachment lookup only needs to stay scoped to the org — no per-record permission check. */
export function resolveAttachment(orgId: string, attachmentId: string): AttachmentMeta | null {
  return load(orgId).attachments[attachmentId] || null;
}

function load(orgId: string): ForderungenData {
  const file = filePath(orgId);
  if (!fs.existsSync(file)) return { records: {}, lastImportAt: null, lastImportSummary: null, attachments: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return {
      records: parsed.records && typeof parsed.records === 'object' ? parsed.records : {},
      lastImportAt: parsed.lastImportAt ?? null,
      lastImportSummary: parsed.lastImportSummary ?? null,
      attachments: parsed.attachments && typeof parsed.attachments === 'object' ? parsed.attachments : {},
    };
  } catch {
    return { records: {}, lastImportAt: null, lastImportSummary: null, attachments: {} };
  }
}

function save(orgId: string, data: ForderungenData): void {
  const dir = path.dirname(filePath(orgId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath(orgId), JSON.stringify(data, null, 2), 'utf-8');
}

function genId(): string {
  return `frd-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Dedup key used to match an Excel row to an existing record. Empty when either half is missing — such rows can't be safely matched and are rejected by the caller. */
export function buildRecordKey(debitor: string | undefined | null, rechnungsnummer: string | undefined | null): string {
  const d = (debitor ?? '').trim().toLowerCase();
  const r = (rechnungsnummer ?? '').trim().toLowerCase();
  if (!d || !r) return '';
  return `${d}::${r}`;
}

function emptyRecord(orgId: string): ForderungRecord {
  const now = new Date().toISOString();
  return {
    id: genId(),
    organizationId: orgId,
    key: '',
    verkaufsbuero: '', serviceLeiter: '', debitor: '', kundentyp: '', kundenname: '',
    rechnungsnummer: '', auftragVertrag: '', equipment: '', text: '', reklamationsgrund: '',
    resolver: '', aktionsstatus: '', faelligeForderung: 0, altforderungen180: 0, pwbMonatsende: 0,
    kanbanStatus: 'offen',
    assignedLeitungId: null,
    notizen: '',
    missingInLastImport: false,
    missingSince: null,
    lastSourceImportAt: null,
    createdAt: now,
    updatedAt: now,
    createdBy: '',
    history: [],
    comments: [],
  };
}

function pushHistory(record: ForderungRecord, actorName: string, action: string, detail?: string): void {
  record.history.push({ at: new Date().toISOString(), actorName, action, detail });
}

export function listRecords(orgId: string): ForderungRecord[] {
  return Object.values(load(orgId).records).sort((a, b) => a.debitor.localeCompare(b.debitor));
}

export function getRecord(orgId: string, id: string): ForderungRecord | null {
  return load(orgId).records[id] || null;
}

/** Records assigned to a specific Leitung AdminUser id — the "Meine Forderungen" board's data source. */
export function listAssignedTo(orgId: string, adminUserId: string): ForderungRecord[] {
  return listRecords(orgId).filter(r => r.assignedLeitungId === adminUserId);
}

export interface ManualCreateInput {
  debitor: string;
  rechnungsnummer: string;
  kundenname?: string;
  verkaufsbuero?: string;
  serviceLeiter?: string;
  kundentyp?: string;
  auftragVertrag?: string;
  equipment?: string;
  text?: string;
  reklamationsgrund?: string;
  resolver?: string;
  aktionsstatus?: string;
  faelligeForderung?: number;
  altforderungen180?: number;
  pwbMonatsende?: number;
  assignedLeitungId?: string | null;
  notizen?: string;
}

export function createRecordManually(orgId: string, input: ManualCreateInput, actorName: string): { record: ForderungRecord } | { error: string } {
  const key = buildRecordKey(input.debitor, input.rechnungsnummer);
  if (!key) return { error: 'Debitor und Rechnungsnummer sind erforderlich.' };
  const data = load(orgId);
  if (Object.values(data.records).some(r => r.key === key)) {
    return { error: 'Eine Forderung mit diesem Debitor + dieser Rechnungsnummer existiert bereits.' };
  }
  if (input.assignedLeitungId && !listAdminUsers(orgId).some(u => u.id === input.assignedLeitungId && u.role === 'leitung')) {
    return { error: 'Zugewiesene Person ist keine Leitung dieser Organisation.' };
  }

  const record = emptyRecord(orgId);
  record.key = key;
  record.debitor = input.debitor.trim();
  record.rechnungsnummer = input.rechnungsnummer.trim();
  record.kundenname = input.kundenname?.trim() ?? '';
  record.verkaufsbuero = input.verkaufsbuero?.trim() ?? '';
  record.serviceLeiter = input.serviceLeiter?.trim() ?? '';
  record.kundentyp = input.kundentyp?.trim() ?? '';
  record.auftragVertrag = input.auftragVertrag?.trim() ?? '';
  record.equipment = input.equipment?.trim() ?? '';
  record.text = input.text?.trim() ?? '';
  record.reklamationsgrund = input.reklamationsgrund?.trim() ?? '';
  record.resolver = input.resolver?.trim() ?? '';
  record.aktionsstatus = input.aktionsstatus?.trim() ?? '';
  record.faelligeForderung = Number(input.faelligeForderung) || 0;
  record.altforderungen180 = Number(input.altforderungen180) || 0;
  record.pwbMonatsende = Number(input.pwbMonatsende) || 0;
  record.assignedLeitungId = input.assignedLeitungId || null;
  record.notizen = input.notizen?.trim() ?? '';
  record.createdBy = actorName;
  pushHistory(record, actorName, 'Angelegt', 'Manuell erfasst');
  if (record.assignedLeitungId) pushHistory(record, actorName, 'Zugewiesen');

  data.records[record.id] = record;
  save(orgId, data);
  return { record };
}

export interface WorkflowPatch {
  kanbanStatus?: KanbanStatus;
  assignedLeitungId?: string | null;
  notizen?: string;
}

export function updateWorkflow(orgId: string, id: string, patch: WorkflowPatch, actorName: string): { record: ForderungRecord } | { error: string } {
  const data = load(orgId);
  const record = data.records[id];
  if (!record) return { error: 'Forderung nicht gefunden.' };

  if (patch.assignedLeitungId !== undefined && patch.assignedLeitungId !== null) {
    // Leitung/Forderung accounts work claims assigned to them; Admin can
    // also take on a claim directly (e.g. to work it personally) — only
    // Betrachter (no Forderungen access at all) is not a valid assignee.
    if (!listAdminUsers(orgId).some(u => u.id === patch.assignedLeitungId && (u.role === 'leitung' || u.role === 'forderung' || u.role === 'admin'))) {
      return { error: 'Zugewiesene Person ist kein Admin-, Leitung- oder Forderung-Zugang dieser Organisation.' };
    }
  }

  const changes: string[] = [];
  if (patch.kanbanStatus !== undefined && patch.kanbanStatus !== record.kanbanStatus) {
    changes.push(`Status: "${KANBAN_LABELS[record.kanbanStatus]}" → "${KANBAN_LABELS[patch.kanbanStatus]}"`);
    record.kanbanStatus = patch.kanbanStatus;
  }
  if (patch.assignedLeitungId !== undefined && patch.assignedLeitungId !== record.assignedLeitungId) {
    changes.push('Zuständigkeit geändert');
    record.assignedLeitungId = patch.assignedLeitungId;
  }
  if (patch.notizen !== undefined && patch.notizen !== record.notizen) {
    changes.push('Notizen aktualisiert');
    record.notizen = patch.notizen;
  }

  if (changes.length) {
    record.updatedAt = new Date().toISOString();
    pushHistory(record, actorName, 'Bearbeitet', changes.join(' | '));
    save(orgId, data);
  }
  return { record };
}

export function addComment(
  orgId: string,
  id: string,
  authorId: string | null,
  authorName: string,
  text: string,
  files: { originalname: string; mimetype: string; size: number; buffer: Buffer }[] = [],
): { record: ForderungRecord } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed && files.length === 0) return { error: 'Kommentar ist leer.' };
  if (files.length > MAX_ATTACHMENTS_PER_COMMENT) return { error: `Maximal ${MAX_ATTACHMENTS_PER_COMMENT} Dateien pro Kommentar.` };
  const data = load(orgId);
  const record = data.records[id];
  if (!record) return { error: 'Forderung nicht gefunden.' };

  const dir = attachmentsDir(orgId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const attachmentIds: string[] = [];
  for (const file of files) {
    if (!isAllowedAttachmentType(file.mimetype)) return { error: `Dateityp nicht erlaubt: ${file.originalname}` };
    if (file.size > MAX_ATTACHMENT_SIZE) return { error: `Datei zu groß (max. 10MB): ${file.originalname}` };
    const attachmentId = genId();
    const storedName = `${attachmentId}-${sanitizeFilename(file.originalname)}`;
    fs.writeFileSync(path.join(dir, storedName), file.buffer);
    data.attachments[attachmentId] = { filename: file.originalname, mimeType: file.mimetype, size: file.size };
    attachmentIds.push(attachmentId);
  }

  record.comments.push({ id: genId(), authorId, authorName, text: trimmed, attachmentIds, createdAt: new Date().toISOString() });
  record.updatedAt = new Date().toISOString();
  save(orgId, data);
  return { record };
}

export function deleteRecordRow(orgId: string, id: string): boolean {
  const data = load(orgId);
  if (!data.records[id]) return false;
  delete data.records[id];
  save(orgId, data);
  return true;
}

export const KANBAN_LABELS: Record<KanbanStatus, string> = {
  offen: 'Offen',
  in_arbeit: 'In Arbeit',
  done: 'Done',
  archiviert: 'Archiviert',
};

// ─── Excel import ───────────────────────────────────────────────────────
// Rows arrive already normalized+keyed to SourceFieldKey by the client
// (public/forderung/js/model.js + excelImport.js mirror the /beispiel
// prototype's column-detection heuristic and SheetJS parsing) — this
// function only performs the server-side dedup/merge/persist step.

export type NormalizedImportRow = Partial<Record<SourceFieldKey, string | number>>;

export interface ImportRunSummary extends ImportSummary {
  rulesAppliedCount: number;
  skippedRows: { row: NormalizedImportRow; reason: string }[];
}

export function applyImport(orgId: string, rows: NormalizedImportRow[], actorName: string): ImportRunSummary {
  const data = load(orgId);
  const now = new Date().toISOString();
  const touchedKeys = new Set<string>();
  let createdCount = 0;
  let updatedCount = 0;
  let reappearedCount = 0;
  const skippedRows: { row: NormalizedImportRow; reason: string }[] = [];

  for (const row of rows) {
    const key = buildRecordKey(String(row.debitor ?? ''), String(row.rechnungsnummer ?? ''));
    if (!key) {
      skippedRows.push({ row, reason: 'Debitor oder Rechnungsnummer fehlt' });
      continue;
    }
    touchedKeys.add(key);
    const existing = Object.values(data.records).find(r => r.key === key);
    if (existing) {
      applySourceFields(existing, row);
      existing.lastSourceImportAt = now;
      existing.updatedAt = now;
      if (existing.missingInLastImport) {
        existing.missingInLastImport = false;
        existing.missingSince = null;
        reappearedCount++;
        pushHistory(existing, 'Import', 'Wieder in aktueller Excel-Liste enthalten');
      }
      updatedCount++;
    } else {
      const record = emptyRecord(orgId);
      record.key = key;
      applySourceFields(record, row);
      record.lastSourceImportAt = now;
      record.createdBy = 'Import';
      pushHistory(record, actorName, 'Import', 'Angelegt durch Excel-Import');
      data.records[record.id] = record;
      createdCount++;
    }
  }

  let missingCount = 0;
  for (const record of Object.values(data.records)) {
    if (!touchedKeys.has(record.key)) {
      if (!record.missingInLastImport) {
        record.missingInLastImport = true;
        record.missingSince = now;
        pushHistory(record, 'Import', 'Nicht mehr in aktueller Excel-Liste enthalten');
      }
      missingCount++;
    }
  }

  // Permanent rules only ever evaluate the records THIS import actually
  // touched (created or updated) — matches "wenn es importiert wird", and
  // never silently re-touches records an admin already edited by hand.
  const touchedRecords = Object.values(data.records).filter(r => touchedKeys.has(r.key));
  const rulesAppliedCount = applyImportRules(orgId, touchedRecords, actorName);

  const summary: ImportRunSummary = {
    importedAt: now,
    createdCount,
    updatedCount,
    reappearedCount,
    skippedCount: skippedRows.length,
    missingCount,
    rulesAppliedCount,
    skippedRows,
  };
  data.lastImportAt = now;
  data.lastImportSummary = {
    importedAt: now, createdCount, updatedCount, reappearedCount,
    skippedCount: skippedRows.length, missingCount,
  };
  save(orgId, data);
  return summary;
}

/** Applies one matched rule's action to a record; returns whether anything actually changed. Shared by the automatic import path and the manual "Jetzt ausführen" path. */
function applyRuleActionToRecord(orgId: string, record: ForderungRecord, rule: forderungRules.ForderungRule, actorName: string): boolean {
  let changed = false;
  if (rule.action.type === 'assign') {
    const nextId = rule.action.assignedLeitungId ?? null;
    if (record.assignedLeitungId !== nextId) { record.assignedLeitungId = nextId; changed = true; }
  } else if (rule.action.type === 'set_status' && rule.action.kanbanStatus) {
    if (record.kanbanStatus !== rule.action.kanbanStatus) { record.kanbanStatus = rule.action.kanbanStatus; changed = true; }
  }
  if (changed) {
    record.updatedAt = new Date().toISOString();
    pushHistory(record, actorName, 'Regel angewendet', `„${rule.name}" – ${forderungRules.describeAction(orgId, rule)}`);
  }
  return changed;
}

/** Runs every active permanent rule (in saved order) against the records THIS import touched — the "wenn es importiert wird" trigger. Rules run in order so a later rule can override an earlier one's effect on the same record. */
function applyImportRules(orgId: string, touchedRecords: ForderungRecord[], actorName: string): number {
  if (touchedRecords.length === 0) return 0;
  const rules = forderungRules.listRules(orgId).filter(r => r.active && r.mode === 'permanent');
  if (rules.length === 0) return 0;
  let totalChanged = 0;
  const matchCounts = new Map<string, number>();
  const changedCounts = new Map<string, number>();
  for (const record of touchedRecords) {
    for (const rule of rules) {
      if (forderungRules.matchesRule(record, rule)) {
        matchCounts.set(rule.id, (matchCounts.get(rule.id) || 0) + 1);
        if (applyRuleActionToRecord(orgId, record, rule, actorName)) {
          changedCounts.set(rule.id, (changedCounts.get(rule.id) || 0) + 1);
          totalChanged++;
        }
      }
    }
  }
  for (const rule of rules) {
    if (matchCounts.has(rule.id)) forderungRules.recordRuleRun(orgId, rule.id, matchCounts.get(rule.id)!, changedCounts.get(rule.id) || 0);
  }
  return totalChanged;
}

/**
 * Manual "Jetzt ausführen": runs ONE rule (any mode) against every current
 * record in the org. The sole trigger for a 'once' rule; an optional
 * backfill for a 'permanent' rule (so a newly saved rule can also catch up
 * on the existing backlog, not just future imports).
 */
export function runRuleNow(orgId: string, ruleId: string, actorName: string): { matchCount: number; changedCount: number } | { error: string } {
  const rule = forderungRules.getRule(orgId, ruleId);
  if (!rule) return { error: 'Regel nicht gefunden.' };
  const data = load(orgId);
  let matchCount = 0;
  let changedCount = 0;
  for (const record of Object.values(data.records)) {
    if (forderungRules.matchesRule(record, rule)) {
      matchCount++;
      if (applyRuleActionToRecord(orgId, record, rule, actorName)) changedCount++;
    }
  }
  if (changedCount > 0) save(orgId, data);
  forderungRules.recordRuleRun(orgId, ruleId, matchCount, changedCount);
  return { matchCount, changedCount };
}

function applySourceFields(record: ForderungRecord, row: NormalizedImportRow): void {
  for (const key of SOURCE_FIELD_KEYS) {
    if (!(key in row)) continue;
    const raw = row[key];
    if (NUMERIC_SOURCE_FIELDS.has(key)) {
      (record as any)[key] = typeof raw === 'number' ? raw : (parseFloat(String(raw).replace(/\./g, '').replace(',', '.')) || 0);
    } else {
      (record as any)[key] = String(raw ?? '').trim();
    }
  }
}

export function getLastImportInfo(orgId: string): { at: string | null; summary: ImportSummary | null } {
  const data = load(orgId);
  return { at: data.lastImportAt, summary: data.lastImportSummary };
}
