/**
 * Boards — Trello-style task boards, independent of the shift-scheduling
 * domain (state.json/stateDiff.ts/changelog). One directory per organization
 * (data/orgs/<orgId>/boards.json + board-attachments/), matching the
 * per-org file pattern established by portalAuth.ts/db.ts's state.json.
 *
 * Any authenticated admin-dashboard account (admin/leitung/betrachter) can
 * create and use boards — this is a personal/collaborative tool, not part
 * of the shift-planning permission system.
 */

import fs from 'node:fs';
import path from 'node:path';
import { currentOrgId } from './orgContext.js';
import { orgDataDir } from './db.js';
import { listAdminUsers } from './adminAuth.js';
import type { Board, BoardComment, BoardSection, BoardSubtask, BoardTask, BoardVisibility } from '../src/types.js';

export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
}

interface BoardsData {
  boards: Board[];
  attachments: Record<string, AttachmentMeta>;
}

export interface BoardSession {
  organizationId: string;
  adminUserId: string;
}

function boardsFilePath(orgId: string): string {
  return path.join(orgDataDir(orgId), 'boards.json');
}

export function attachmentsDir(orgId: string): string {
  return path.join(orgDataDir(orgId), 'board-attachments');
}

function loadFor(orgId: string): BoardsData {
  const file = boardsFilePath(orgId);
  if (!fs.existsSync(file)) return { boards: [], attachments: {} };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(data.boards)) data.boards = [];
    if (!data.attachments || typeof data.attachments !== 'object') data.attachments = {};
    return data;
  } catch {
    return { boards: [], attachments: {} };
  }
}

function saveFor(orgId: string, data: BoardsData): void {
  const dir = path.dirname(boardsFilePath(orgId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(boardsFilePath(orgId), JSON.stringify(data, null, 2), 'utf-8');
}

function load(): BoardsData {
  return loadFor(currentOrgId());
}

function save(data: BoardsData): void {
  saveFor(currentOrgId(), data);
}

function freshId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── Visibility & sharing ──────────────────────────────────────────────────

export function canSeeBoard(board: Board, session: BoardSession): boolean {
  if (board.organizationId !== session.organizationId) return false;
  if (board.ownerId === session.adminUserId) return true;
  if (board.visibility === 'organization') return true;
  if (board.visibility === 'selected') return (board.visibleToUserIds || []).includes(session.adminUserId);
  return false;
}

/** Every AdminUser id the board is shared with (owner always included). */
export function boardSharedUserIds(board: Board): string[] {
  if (board.visibility === 'organization') {
    const orgUserIds = listAdminUsers(board.organizationId).map(u => u.id);
    return Array.from(new Set([...orgUserIds, board.ownerId]));
  }
  if (board.visibility === 'selected') {
    return Array.from(new Set([...(board.visibleToUserIds || []), board.ownerId]));
  }
  return [board.ownerId];
}

// ── Boards ────────────────────────────────────────────────────────────────

export function listBoards(session: BoardSession): Board[] {
  const data = load();
  return data.boards.filter(b => canSeeBoard(b, session));
}

export function getBoard(id: string, session: BoardSession): Board | null {
  const data = load();
  const board = data.boards.find(b => b.id === id);
  if (!board || !canSeeBoard(board, session)) return null;
  return board;
}

export function createBoard(
  session: BoardSession,
  ownerName: string,
  input: { name: string; visibility: BoardVisibility; visibleToUserIds?: string[] },
): Board {
  const data = load();
  const board: Board = {
    id: freshId('board'),
    organizationId: session.organizationId,
    name: input.name.trim() || 'Neues Board',
    type: 'kanban',
    visibility: input.visibility,
    visibleToUserIds: input.visibility === 'selected' ? (input.visibleToUserIds || []) : undefined,
    ownerId: session.adminUserId,
    ownerName,
    createdAt: new Date().toISOString(),
    sections: [],
  };
  data.boards.push(board);
  save(data);
  return board;
}

/** Board settings (name/visibility/membership) are owner-only. */
export function updateBoard(
  id: string,
  session: BoardSession,
  updates: { name?: string; visibility?: BoardVisibility; visibleToUserIds?: string[] },
): Board | { error: string } {
  const data = load();
  const board = data.boards.find(b => b.id === id);
  if (!board || board.organizationId !== session.organizationId) return { error: 'Board nicht gefunden.' };
  if (board.ownerId !== session.adminUserId) return { error: 'Nur der Ersteller kann die Board-Einstellungen ändern.' };
  if (updates.name !== undefined) board.name = updates.name.trim() || board.name;
  if (updates.visibility !== undefined) board.visibility = updates.visibility;
  if (updates.visibleToUserIds !== undefined) board.visibleToUserIds = updates.visibleToUserIds;
  if (board.visibility !== 'selected') board.visibleToUserIds = undefined;
  // Assignees that are no longer part of the shared set are dropped, not left dangling.
  const shared = new Set(boardSharedUserIds(board));
  for (const section of board.sections) {
    for (const task of section.tasks) {
      task.assigneeIds = task.assigneeIds.filter(id => shared.has(id));
    }
  }
  save(data);
  return board;
}

export function deleteBoard(id: string, session: BoardSession): boolean {
  const data = load();
  const board = data.boards.find(b => b.id === id);
  if (!board || board.organizationId !== session.organizationId || board.ownerId !== session.adminUserId) return false;
  data.boards = data.boards.filter(b => b.id !== id);
  save(data);
  return true;
}

// ── Sections ──────────────────────────────────────────────────────────────

export function addSection(boardId: string, session: BoardSession, name: string): BoardSection | { error: string } {
  const data = load();
  const board = data.boards.find(b => b.id === boardId);
  if (!board || !canSeeBoard(board, session)) return { error: 'Board nicht gefunden.' };
  const section: BoardSection = {
    id: freshId('section'),
    name: name.trim() || 'Abschnitt',
    order: board.sections.length,
    tasks: [],
  };
  board.sections.push(section);
  save(data);
  return section;
}

export function renameSection(boardId: string, sectionId: string, session: BoardSession, name: string): boolean {
  const data = load();
  const board = data.boards.find(b => b.id === boardId);
  if (!board || !canSeeBoard(board, session)) return false;
  const section = board.sections.find(s => s.id === sectionId);
  if (!section) return false;
  section.name = name.trim() || section.name;
  save(data);
  return true;
}

export function deleteSection(boardId: string, sectionId: string, session: BoardSession): boolean {
  const data = load();
  const board = data.boards.find(b => b.id === boardId);
  if (!board || !canSeeBoard(board, session)) return false;
  board.sections = board.sections.filter(s => s.id !== sectionId);
  save(data);
  return true;
}

// ── Tasks ─────────────────────────────────────────────────────────────────

function validateAssignees(board: Board, assigneeIds: string[] | undefined): string[] {
  if (!assigneeIds || assigneeIds.length === 0) return [];
  const shared = new Set(boardSharedUserIds(board));
  return assigneeIds.filter(id => shared.has(id));
}

export function addTask(
  boardId: string,
  sectionId: string,
  session: BoardSession,
  input: { title: string; description?: string; deadline?: string; assigneeIds?: string[] },
): BoardTask | { error: string } {
  const data = load();
  const board = data.boards.find(b => b.id === boardId);
  if (!board || !canSeeBoard(board, session)) return { error: 'Board nicht gefunden.' };
  const section = board.sections.find(s => s.id === sectionId);
  if (!section) return { error: 'Abschnitt nicht gefunden.' };
  const task: BoardTask = {
    id: freshId('task'),
    title: input.title.trim() || 'Neue Aufgabe',
    description: input.description?.trim() || undefined,
    done: false,
    deadline: input.deadline || undefined,
    assigneeIds: validateAssignees(board, input.assigneeIds),
    subtasks: [],
    comments: [],
    order: section.tasks.length,
    createdAt: new Date().toISOString(),
    createdBy: session.adminUserId,
  };
  section.tasks.push(task);
  save(data);
  return task;
}

/** Field edits, done-toggle, and move-between-sections (via targetSectionId/order) all go through here. */
export function updateTask(
  boardId: string,
  taskId: string,
  session: BoardSession,
  updates: { title?: string; description?: string; done?: boolean; deadline?: string | null; assigneeIds?: string[]; targetSectionId?: string; order?: number },
): BoardTask | { error: string } {
  const data = load();
  const board = data.boards.find(b => b.id === boardId);
  if (!board || !canSeeBoard(board, session)) return { error: 'Board nicht gefunden.' };
  let currentSection: BoardSection | undefined;
  let task: BoardTask | undefined;
  for (const s of board.sections) {
    const found = s.tasks.find(t => t.id === taskId);
    if (found) { currentSection = s; task = found; break; }
  }
  if (!task || !currentSection) return { error: 'Aufgabe nicht gefunden.' };

  if (updates.title !== undefined) task.title = updates.title.trim() || task.title;
  if (updates.description !== undefined) task.description = updates.description.trim() || undefined;
  if (updates.done !== undefined) task.done = updates.done;
  if (updates.deadline !== undefined) task.deadline = updates.deadline || undefined;
  if (updates.assigneeIds !== undefined) task.assigneeIds = validateAssignees(board, updates.assigneeIds);

  if (updates.targetSectionId && updates.targetSectionId !== currentSection.id) {
    const targetSection = board.sections.find(s => s.id === updates.targetSectionId);
    if (!targetSection) return { error: 'Zielabschnitt nicht gefunden.' };
    currentSection.tasks = currentSection.tasks.filter(t => t.id !== taskId);
    const order = updates.order ?? targetSection.tasks.length;
    targetSection.tasks.splice(Math.max(0, Math.min(order, targetSection.tasks.length)), 0, task);
  } else if (updates.order !== undefined) {
    currentSection.tasks = currentSection.tasks.filter(t => t.id !== taskId);
    currentSection.tasks.splice(Math.max(0, Math.min(updates.order, currentSection.tasks.length)), 0, task);
  }

  save(data);
  return task;
}

export function deleteTask(boardId: string, taskId: string, session: BoardSession): boolean {
  const data = load();
  const board = data.boards.find(b => b.id === boardId);
  if (!board || !canSeeBoard(board, session)) return false;
  for (const s of board.sections) s.tasks = s.tasks.filter(t => t.id !== taskId);
  save(data);
  return true;
}

// ── Subtasks ──────────────────────────────────────────────────────────────

function findTask(board: Board, taskId: string): BoardTask | undefined {
  for (const s of board.sections) {
    const t = s.tasks.find(t => t.id === taskId);
    if (t) return t;
  }
  return undefined;
}

export function addSubtask(boardId: string, taskId: string, session: BoardSession, title: string): BoardSubtask | { error: string } {
  const data = load();
  const board = data.boards.find(b => b.id === boardId);
  if (!board || !canSeeBoard(board, session)) return { error: 'Board nicht gefunden.' };
  const task = findTask(board, taskId);
  if (!task) return { error: 'Aufgabe nicht gefunden.' };
  const subtask: BoardSubtask = { id: freshId('subtask'), title: title.trim() || 'Unteraufgabe', done: false };
  task.subtasks.push(subtask);
  save(data);
  return subtask;
}

export function toggleSubtask(boardId: string, taskId: string, subtaskId: string, session: BoardSession, done: boolean): boolean {
  const data = load();
  const board = data.boards.find(b => b.id === boardId);
  if (!board || !canSeeBoard(board, session)) return false;
  const task = findTask(board, taskId);
  const subtask = task?.subtasks.find(s => s.id === subtaskId);
  if (!subtask) return false;
  subtask.done = done;
  save(data);
  return true;
}

export function deleteSubtask(boardId: string, taskId: string, subtaskId: string, session: BoardSession): boolean {
  const data = load();
  const board = data.boards.find(b => b.id === boardId);
  if (!board || !canSeeBoard(board, session)) return false;
  const task = findTask(board, taskId);
  if (!task) return false;
  task.subtasks = task.subtasks.filter(s => s.id !== subtaskId);
  save(data);
  return true;
}

// ── Comments & attachments ───────────────────────────────────────────────

const ALLOWED_ATTACHMENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_ATTACHMENTS_PER_COMMENT = 5;
export function isAllowedAttachmentType(mime: string): boolean {
  return ALLOWED_ATTACHMENT_TYPES.has(mime);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'datei';
}

export function addComment(
  boardId: string,
  taskId: string,
  session: BoardSession,
  authorName: string,
  text: string,
  files: { originalname: string; mimetype: string; size: number; buffer: Buffer }[],
): BoardComment | { error: string } {
  const data = load();
  const board = data.boards.find(b => b.id === boardId);
  if (!board || !canSeeBoard(board, session)) return { error: 'Board nicht gefunden.' };
  const task = findTask(board, taskId);
  if (!task) return { error: 'Aufgabe nicht gefunden.' };
  if (!text.trim() && files.length === 0) return { error: 'Kommentar ist leer.' };
  if (files.length > MAX_ATTACHMENTS_PER_COMMENT) return { error: `Maximal ${MAX_ATTACHMENTS_PER_COMMENT} Dateien pro Kommentar.` };

  const dir = attachmentsDir(session.organizationId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const attachmentIds: string[] = [];
  for (const file of files) {
    if (!isAllowedAttachmentType(file.mimetype)) return { error: `Dateityp nicht erlaubt: ${file.originalname}` };
    if (file.size > MAX_ATTACHMENT_SIZE) return { error: `Datei zu groß (max. 10MB): ${file.originalname}` };
    const attachmentId = freshId('att');
    const storedName = `${attachmentId}-${sanitizeFilename(file.originalname)}`;
    fs.writeFileSync(path.join(dir, storedName), file.buffer);
    data.attachments[attachmentId] = { filename: file.originalname, mimeType: file.mimetype, size: file.size };
    attachmentIds.push(attachmentId);
  }

  const comment: BoardComment = {
    id: freshId('comment'),
    authorId: session.adminUserId,
    authorName,
    text: text.trim(),
    attachmentIds,
    createdAt: new Date().toISOString(),
  };
  task.comments.push(comment);
  save(data);
  return comment;
}

export function deleteComment(boardId: string, taskId: string, commentId: string, session: BoardSession): boolean {
  const data = load();
  const board = data.boards.find(b => b.id === boardId);
  if (!board || !canSeeBoard(board, session)) return false;
  const task = findTask(board, taskId);
  if (!task) return false;
  const comment = task.comments.find(c => c.id === commentId);
  if (!comment || comment.authorId !== session.adminUserId) return false;
  task.comments = task.comments.filter(c => c.id !== commentId);
  save(data);
  return true;
}

/** Resolve which board (if any, within the session's org) a given attachment belongs to, for the download endpoint's permission check. */
export function resolveAttachmentBoard(attachmentId: string, session: BoardSession): { board: Board; meta: AttachmentMeta } | null {
  const data = load();
  const meta = data.attachments[attachmentId];
  if (!meta) return null;
  const board = data.boards.find(b =>
    b.sections.some(s => s.tasks.some(t => t.comments.some(c => c.attachmentIds.includes(attachmentId)))),
  );
  if (!board || !canSeeBoard(board, session)) return null;
  return { board, meta };
}

export function attachmentFilePath(orgId: string, attachmentId: string, meta: AttachmentMeta): string {
  return path.join(attachmentsDir(orgId), `${attachmentId}-${sanitizeFilename(meta.filename)}`);
}
