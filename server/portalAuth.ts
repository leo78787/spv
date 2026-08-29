/**
 * Employee portal authentication & credential management — multi-tenant.
 *
 * Stores employee credentials per-organization in data/orgs/<orgId>/portal.json:
 * {
 *   credentials: {
 *     [employeeId]: {
 *       username: string,
 *       passwordHash: string,    // bcrypt-style: simple sha256 + salt for portability
 *       mustChangePassword: boolean,
 *       createdAt: string,
 *     }
 *   },
 *   sessions: {
 *     [token]: { employeeId: string, expiresAt: string }
 *   }
 * }
 *
 * Which organization load()/save() (used by every function below except the
 * cross-org ones) operate on is resolved implicitly from the current
 * request's AsyncLocalStorage context (see orgContext.ts) — set up by
 * portalAuthMiddleware once the token has been resolved to an organization.
 *
 * Portal session tokens are prefixed with their organization id
 * (`<orgId>::<uuid>`) so that validatePortalToken() — called before any org
 * context exists — can resolve which org's portal.json to check without
 * scanning every organization on every request. Login (by username, before
 * we know the org) is the one place that legitimately scans all orgs.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { currentOrgId } from './orgContext.js';
import { orgDataDir, listOrganizations } from './db.js';

interface Credential {
  username: string;
  passwordHash: string; // hex(sha256(password + salt))
  salt: string;
  mustChangePassword: boolean;
  createdAt: string;
}

interface Session {
  employeeId: string;
  expiresAt: string;
}

interface PortalData {
  credentials: Record<string, Credential>;   // keyed by employeeId
  sessions: Record<string, Session>;          // keyed by token
}

function portalFilePath(orgId: string): string {
  return path.join(orgDataDir(orgId), 'portal.json');
}

function loadFor(orgId: string): PortalData {
  const file = portalFilePath(orgId);
  if (!fs.existsSync(file)) {
    return { credentials: {}, sessions: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return { credentials: {}, sessions: {} };
  }
}

function saveFor(orgId: string, data: PortalData): void {
  const dir = path.dirname(portalFilePath(orgId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(portalFilePath(orgId), JSON.stringify(data, null, 2), 'utf-8');
}

function load(): PortalData {
  return loadFor(currentOrgId());
}

function save(data: PortalData): void {
  saveFor(currentOrgId(), data);
}

function hashPassword(password: string, salt: string): string {
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

/** Generate a human-readable one-time password (8 chars). */
export function generateOneTimePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 8; i++) {
    pwd += chars[crypto.randomInt(chars.length)];
  }
  return pwd;
}

/** Generate a username from employee name (lowercase, no spaces, append number if needed). */
export function generateUsername(name: string, existingUsernames: string[]): string {
  const base = name
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');

  let candidate = base;
  let i = 1;
  while (existingUsernames.includes(candidate)) {
    candidate = `${base}${i}`;
    i++;
  }
  return candidate;
}

/** All usernames across every organization — usernames must be globally unique since portal login resolves the organization by scanning for a username match. */
function allUsernamesPlatformWide(excludeEmployeeId?: string): string[] {
  const usernames: string[] = [];
  for (const org of listOrganizations()) {
    const data = loadFor(org.id);
    for (const [id, cred] of Object.entries(data.credentials)) {
      if (id === excludeEmployeeId) continue;
      usernames.push(cred.username);
    }
  }
  return usernames;
}

/** Create or reset credentials for an employee (in the current org context). Returns { username, oneTimePassword }. */
export function createOrResetCredentials(
  employeeId: string,
  employeeName: string,
): { username: string; oneTimePassword: string } {
  const data = load();

  const existingUsernames = allUsernamesPlatformWide(employeeId);

  // Keep existing username if already set, otherwise generate one
  const existingCred = data.credentials[employeeId];
  const username = existingCred?.username || generateUsername(employeeName, existingUsernames);

  const oneTimePassword = generateOneTimePassword();
  const salt = crypto.randomBytes(16).toString('hex');

  data.credentials[employeeId] = {
    username,
    passwordHash: hashPassword(oneTimePassword, salt),
    salt,
    mustChangePassword: true,
    createdAt: new Date().toISOString(),
  };

  save(data);
  return { username, oneTimePassword };
}

/** Authenticate an employee by username + password, scanning across all organizations (the org isn't known until the username matches). Returns employeeId, organizationId and a token, or null. */
export function authenticateEmployee(
  username: string,
  password: string,
): { employeeId: string; organizationId: string; token: string; mustChangePassword: boolean } | null {
  for (const org of listOrganizations()) {
    const data = loadFor(org.id);
    const entry = Object.entries(data.credentials).find(([, c]) => c.username === username);
    if (!entry) continue;

    const [employeeId, cred] = entry;
    const hash = hashPassword(password, cred.salt);
    if (hash !== cred.passwordHash) return null; // username is unique platform-wide — wrong password, stop here

    const token = `${org.id}::${crypto.randomUUID()}`;
    data.sessions[token] = {
      employeeId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };

    // Prune expired sessions for this org while we're here.
    const now = new Date().toISOString();
    for (const [t, s] of Object.entries(data.sessions)) {
      if (s.expiresAt < now) delete data.sessions[t];
    }

    saveFor(org.id, data);
    return { employeeId, organizationId: org.id, token, mustChangePassword: cred.mustChangePassword };
  }
  return null;
}

/** Validate a portal token (org-prefixed, see module docs). Returns { employeeId, organizationId } or null. */
export function validatePortalToken(token: string): { employeeId: string; organizationId: string } | null {
  const sepIdx = token.indexOf('::');
  if (sepIdx === -1) return null;
  const orgId = token.slice(0, sepIdx);

  const data = loadFor(orgId);
  const session = data.sessions[token];
  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) {
    delete data.sessions[token];
    saveFor(orgId, data);
    return null;
  }
  return { employeeId: session.employeeId, organizationId: orgId };
}

/** Change an employee's password (in the current org context). */
export function changePassword(employeeId: string, newPassword: string): boolean {
  const data = load();
  const cred = data.credentials[employeeId];
  if (!cred) return false;

  const salt = crypto.randomBytes(16).toString('hex');
  cred.passwordHash = hashPassword(newPassword, salt);
  cred.salt = salt;
  cred.mustChangePassword = false;

  save(data);
  return true;
}

/** Wipe all credentials and sessions for the current org (used on org reset). */
export function clearAllCredentials(): void {
  save({ credentials: {}, sessions: {} });
}

/** Check whether an employee (in the current org context) has portal credentials. */
export function hasCredentials(employeeId: string): boolean {
  const data = load();
  return !!data.credentials[employeeId];
}

/** Get the username for an employee (in the current org context). */
export function getUsername(employeeId: string): string | undefined {
  const data = load();
  return data.credentials[employeeId]?.username;
}

/** Get all usernames (in the current org context) for display in employee management. */
export function getAllCredentialInfo(): Record<string, { username: string; mustChangePassword: boolean }> {
  const data = load();
  const result: Record<string, { username: string; mustChangePassword: boolean }> = {};
  for (const [id, cred] of Object.entries(data.credentials)) {
    result[id] = { username: cred.username, mustChangePassword: cred.mustChangePassword };
  }
  return result;
}

/** Read the complete portal data (credentials + sessions) for the current org — used for full-system backups. */
export function getFullPortalData(): PortalData {
  return load();
}

/** Overwrite the complete portal data (credentials + sessions) for the current org — used to restore from a backup. */
export function restorePortalData(data: PortalData): void {
  save(data);
}
