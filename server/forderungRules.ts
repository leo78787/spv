/**
 * Forderungen rules engine — user-defined conditions ("Service Leiter = X")
 * that trigger an action ("zuweisen an Leitung Y" / "Status auf Archiviert
 * setzen"). One directory-file per organization
 * (data/orgs/<orgId>/forderungRules.json), matching the per-org pattern
 * already used by forderungen.json/boards.json.
 *
 * A rule's `mode` only controls whether it participates in AUTOMATIC
 * evaluation on Excel import ('permanent') or not ('once'). Either mode can
 * always be triggered manually ("Jetzt ausführen") — for a 'once' rule
 * that's its only trigger; for a 'permanent' rule it's an optional backfill
 * so a newly saved rule can also apply to the existing backlog, not just
 * future imports. This module only owns rule CRUD + the pure matching
 * predicate; applying a match to a record (mutating it, writing history,
 * persisting) stays in forderungen.ts, which already owns that data.
 */

import fs from 'node:fs';
import path from 'node:path';
import { orgDataDir } from './db.js';
import { listAdminUsers } from './adminAuth.js';
import type { ForderungRecord, KanbanStatus, SourceFieldKey } from './forderungen.js';
import { NUMERIC_SOURCE_FIELDS } from './forderungen.js';

export type RuleOperator = 'eq' | 'neq' | 'contains' | 'empty' | 'not_empty' | 'gt' | 'lt' | 'gte' | 'lte';

export interface RuleCondition {
  field: SourceFieldKey;
  operator: RuleOperator;
  value: string;
}

export type RuleActionType = 'assign' | 'set_status';

export interface RuleAction {
  type: RuleActionType;
  assignedLeitungId?: string | null; // for 'assign' (null = "nicht zugewiesen")
  kanbanStatus?: KanbanStatus; // for 'set_status'
}

export type RuleMode = 'permanent' | 'once';

export interface ForderungRule {
  id: string;
  name: string;
  mode: RuleMode;
  active: boolean;
  conditions: RuleCondition[]; // AND-combined
  action: RuleAction;
  createdAt: string;
  createdBy: string;
  lastRunAt: string | null;
  lastRunMatchCount: number;
  lastRunChangedCount: number;
}

interface RulesData {
  rules: ForderungRule[];
}

function filePath(orgId: string): string {
  return path.join(orgDataDir(orgId), 'forderungRules.json');
}

function load(orgId: string): RulesData {
  const file = filePath(orgId);
  if (!fs.existsSync(file)) return { rules: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return { rules: Array.isArray(parsed.rules) ? parsed.rules : [] };
  } catch {
    return { rules: [] };
  }
}

function save(orgId: string, data: RulesData): void {
  const dir = path.dirname(filePath(orgId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath(orgId), JSON.stringify(data, null, 2), 'utf-8');
}

function genId(): string {
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const VALID_OPERATORS: RuleOperator[] = ['eq', 'neq', 'contains', 'empty', 'not_empty', 'gt', 'lt', 'gte', 'lte'];
const VALID_FIELDS: SourceFieldKey[] = [
  'verkaufsbuero', 'serviceLeiter', 'debitor', 'kundentyp', 'kundenname',
  'rechnungsnummer', 'auftragVertrag', 'equipment', 'text', 'reklamationsgrund',
  'resolver', 'aktionsstatus', 'faelligeForderung', 'altforderungen180', 'pwbMonatsende',
];
const VALID_STATUSES: KanbanStatus[] = ['offen', 'in_arbeit', 'done', 'archiviert'];

export interface RuleInput {
  name: string;
  mode: RuleMode;
  conditions: { field: string; operator: string; value: string }[];
  action: { type: string; assignedLeitungId?: string | null; kanbanStatus?: string };
}

function validateInput(orgId: string, input: RuleInput): RuleCondition[] | { error: string } {
  const name = (input.name || '').trim();
  if (!name) return { error: 'Name der Regel fehlt.' };
  if (input.mode !== 'permanent' && input.mode !== 'once') return { error: 'Ungültiger Modus.' };
  if (!Array.isArray(input.conditions) || input.conditions.length === 0) return { error: 'Mindestens eine Bedingung erforderlich.' };

  const conditions: RuleCondition[] = [];
  for (const c of input.conditions) {
    if (!VALID_FIELDS.includes(c.field as SourceFieldKey)) return { error: `Unbekanntes Feld: ${c.field}` };
    if (!VALID_OPERATORS.includes(c.operator as RuleOperator)) return { error: `Unbekannter Operator: ${c.operator}` };
    const needsValue = c.operator !== 'empty' && c.operator !== 'not_empty';
    if (needsValue && !String(c.value ?? '').trim()) return { error: 'Bedingung benötigt einen Vergleichswert.' };
    conditions.push({ field: c.field as SourceFieldKey, operator: c.operator as RuleOperator, value: String(c.value ?? '').trim() });
  }

  if (input.action.type === 'assign') {
    const id = input.action.assignedLeitungId;
    if (id) {
      const validAssignee = listAdminUsers(orgId).some(u => u.id === id && (u.role === 'leitung' || u.role === 'forderung' || u.role === 'admin'));
      if (!validAssignee) return { error: 'Zugewiesene Person ist kein Admin-, Leitung- oder Forderung-Zugang dieser Organisation.' };
    }
  } else if (input.action.type === 'set_status') {
    if (!VALID_STATUSES.includes(input.action.kanbanStatus as KanbanStatus)) return { error: 'Ungültiger Status.' };
  } else {
    return { error: 'Unbekannte Aktion.' };
  }

  return conditions;
}

function toAction(input: RuleInput['action']): RuleAction {
  return input.type === 'assign'
    ? { type: 'assign', assignedLeitungId: input.assignedLeitungId || null }
    : { type: 'set_status', kanbanStatus: input.kanbanStatus as KanbanStatus };
}

export function listRules(orgId: string): ForderungRule[] {
  return load(orgId).rules;
}

export function getRule(orgId: string, id: string): ForderungRule | null {
  return load(orgId).rules.find(r => r.id === id) || null;
}

export function createRule(orgId: string, input: RuleInput, actorName: string): ForderungRule | { error: string } {
  const conditions = validateInput(orgId, input);
  if ('error' in conditions) return conditions;
  const data = load(orgId);
  const rule: ForderungRule = {
    id: genId(),
    name: input.name.trim(),
    mode: input.mode,
    active: true,
    conditions,
    action: toAction(input.action),
    createdAt: new Date().toISOString(),
    createdBy: actorName,
    lastRunAt: null,
    lastRunMatchCount: 0,
    lastRunChangedCount: 0,
  };
  data.rules.push(rule);
  save(orgId, data);
  return rule;
}

export function updateRule(orgId: string, id: string, input: Partial<RuleInput> & { active?: boolean }): ForderungRule | { error: string } {
  const data = load(orgId);
  const rule = data.rules.find(r => r.id === id);
  if (!rule) return { error: 'Regel nicht gefunden.' };

  if (input.active !== undefined) rule.active = !!input.active;

  const touchesRuleBody = input.name !== undefined || input.mode !== undefined || input.conditions !== undefined || input.action !== undefined;
  if (touchesRuleBody) {
    const merged: RuleInput = {
      name: input.name ?? rule.name,
      mode: input.mode ?? rule.mode,
      conditions: input.conditions ?? rule.conditions,
      action: input.action ?? rule.action,
    };
    const conditions = validateInput(orgId, merged);
    if ('error' in conditions) return conditions;
    rule.name = merged.name.trim();
    rule.mode = merged.mode;
    rule.conditions = conditions;
    rule.action = toAction(merged.action);
  }

  save(orgId, data);
  return rule;
}

export function deleteRule(orgId: string, id: string): boolean {
  const data = load(orgId);
  const idx = data.rules.findIndex(r => r.id === id);
  if (idx === -1) return false;
  data.rules.splice(idx, 1);
  save(orgId, data);
  return true;
}

/** Records a run (both the automatic import path and the manual "Jetzt ausführen" path call this). */
export function recordRuleRun(orgId: string, id: string, matchCount: number, changedCount: number): void {
  const data = load(orgId);
  const rule = data.rules.find(r => r.id === id);
  if (!rule) return;
  rule.lastRunAt = new Date().toISOString();
  rule.lastRunMatchCount = matchCount;
  rule.lastRunChangedCount = changedCount;
  save(orgId, data);
}

function matchesCondition(record: ForderungRecord, cond: RuleCondition): boolean {
  const raw = (record as unknown as Record<string, unknown>)[cond.field];
  if (NUMERIC_SOURCE_FIELDS.has(cond.field)) {
    const num = Number(raw) || 0;
    const cmp = Number(cond.value) || 0;
    switch (cond.operator) {
      case 'eq': return num === cmp;
      case 'neq': return num !== cmp;
      case 'gt': return num > cmp;
      case 'lt': return num < cmp;
      case 'gte': return num >= cmp;
      case 'lte': return num <= cmp;
      case 'empty': return !num;
      case 'not_empty': return !!num;
      default: return false;
    }
  }
  const str = String(raw ?? '').trim();
  const cmp = cond.value.trim();
  switch (cond.operator) {
    case 'eq': return str.toLowerCase() === cmp.toLowerCase();
    case 'neq': return str.toLowerCase() !== cmp.toLowerCase();
    case 'contains': return str.toLowerCase().includes(cmp.toLowerCase());
    case 'empty': return str === '';
    case 'not_empty': return str !== '';
    default: return false;
  }
}

export function matchesRule(record: ForderungRecord, rule: ForderungRule): boolean {
  return rule.conditions.every(c => matchesCondition(record, c));
}

const STATUS_LABELS_SHORT: Record<KanbanStatus, string> = { offen: 'Offen', in_arbeit: 'In Arbeit', done: 'Done', archiviert: 'Archiviert' };

/** Human-readable action text for the rule's history entry — resolves the assignee id to a name so the audit trail reads naturally. */
export function describeAction(orgId: string, rule: ForderungRule): string {
  if (rule.action.type === 'assign') {
    if (!rule.action.assignedLeitungId) return 'Zuweisung entfernt';
    const user = listAdminUsers(orgId).find(u => u.id === rule.action.assignedLeitungId);
    return `zugewiesen an ${user ? user.name : 'unbekannt'}`;
  }
  return `Status gesetzt auf „${STATUS_LABELS_SHORT[rule.action.kanbanStatus!]}"`;
}
