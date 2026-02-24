/**
 * Employee portal authentication & credential management.
 *
 * Stores employee credentials in data/portal.json:
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
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTAL_FILE = path.join(__dirname, '..', 'data', 'portal.json');

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

function load(): PortalData {
  if (!fs.existsSync(PORTAL_FILE)) {
    return { credentials: {}, sessions: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(PORTAL_FILE, 'utf-8'));
  } catch {
    return { credentials: {}, sessions: {} };
  }
}

function save(data: PortalData): void {
  const dir = path.dirname(PORTAL_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PORTAL_FILE, JSON.stringify(data, null, 2), 'utf-8');
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

/** Create or reset credentials for an employee. Returns { username, oneTimePassword }. */
export function createOrResetCredentials(
  employeeId: string,
  employeeName: string,
): { username: string; oneTimePassword: string } {
  const data = load();

  // Determine existing usernames (excluding this employee's own)
  const existingUsernames = Object.entries(data.credentials)
    .filter(([id]) => id !== employeeId)
    .map(([, c]) => c.username);

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

/** Authenticate an employee by username + password. Returns employeeId and token or null. */
export function authenticateEmployee(
  username: string,
  password: string,
): { employeeId: string; token: string; mustChangePassword: boolean } | null {
  const data = load();

  // Find credential by username
  const entry = Object.entries(data.credentials).find(([, c]) => c.username === username);
  if (!entry) return null;

  const [employeeId, cred] = entry;
  const hash = hashPassword(password, cred.salt);
  if (hash !== cred.passwordHash) return null;

  // Create session (24h)
  const token = crypto.randomUUID();
  data.sessions[token] = {
    employeeId,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  // Prune expired sessions
  const now = new Date().toISOString();
  for (const [t, s] of Object.entries(data.sessions)) {
    if (s.expiresAt < now) delete data.sessions[t];
  }

  save(data);
  return { employeeId, token, mustChangePassword: cred.mustChangePassword };
}

/** Validate a portal token. Returns employeeId or null. */
export function validatePortalToken(token: string): string | null {
  const data = load();
  const session = data.sessions[token];
  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) {
    delete data.sessions[token];
    save(data);
    return null;
  }
  return session.employeeId;
}

/** Change an employee's password. */
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

/** Wipe all credentials and sessions (used on full app reset). */
export function clearAllCredentials(): void {
  save({ credentials: {}, sessions: {} });
}

/** Check whether an employee has portal credentials. */
export function hasCredentials(employeeId: string): boolean {
  const data = load();
  return !!data.credentials[employeeId];
}

/** Get the username for an employee. */
export function getUsername(employeeId: string): string | undefined {
  const data = load();
  return data.credentials[employeeId]?.username;
}

/** Get all usernames (for display in employee management). */
export function getAllCredentialInfo(): Record<string, { username: string; mustChangePassword: boolean }> {
  const data = load();
  const result: Record<string, { username: string; mustChangePassword: boolean }> = {};
  for (const [id, cred] of Object.entries(data.credentials)) {
    result[id] = { username: cred.username, mustChangePassword: cred.mustChangePassword };
  }
  return result;
}
