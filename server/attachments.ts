/**
 * Shared attachment validation/storage primitives for any "comment with
 * files" feature (boards.ts, forderungen.ts) — one set of limits and one
 * filename-sanitizer instead of drifting per-feature copies.
 */

export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
}

const ALLOWED_ATTACHMENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_ATTACHMENTS_PER_COMMENT = 5;

export function isAllowedAttachmentType(mime: string): boolean {
  return ALLOWED_ATTACHMENT_TYPES.has(mime);
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'datei';
}
