/**
 * Platform-level users for orga.schichtapp.de — people who can create and
 * manage organizations, invite Admin/Leitung/Betrachter accounts, and view
 * the cross-org changelog. Mirrors adminAuth.ts's pattern (invite by email,
 * one-time password, mustChangePassword, delete, admin-triggered password
 * reset), stored in data/platformUsers.json.
 *
 * The original bootstrap credential (data/platformOwner.json, username
 * "owner", generated on first boot — see initPlatformOwner()) is migrated
 * once (migrateOwnerAccount(), mirrors adminAuth.ts's migrateLegacyAccount())
 * into a real, ordinary PlatformUser record — editable, resettable, and
 * deletable through the normal Einstellungen UI exactly like any invited
 * account, instead of being a permanent, invisible fallback. It keeps
 * logging in by its original username ("owner") via the `username` field,
 * alongside personal accounts which log in by email.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const PLATFORM_OWNER_FILE = path.join(DATA_DIR, 'platformOwner.json');
const PLATFORM_USERS_FILE = path.join(DATA_DIR, 'platformUsers.json');

/** The one-time email address the migrated bootstrap "owner" account is seeded with, for the reset-password-via-email flow. */
const OWNER_MIGRATION_EMAIL = 'leonardkoebernik@gmail.com';

interface PlatformOwnerData {
  username: string;
  passwordHash: string;
  salt: string;
}

export interface PlatformUser {
  id: string;
  name: string;
  email: string;
  /** Only set for the migrated bootstrap "owner" account — lets it keep logging in by username instead of email. */
  username?: string;
  createdAt: string;
}

interface PlatformCredential {
  passwordHash: string;
  salt: string;
  mustChangePassword: boolean;
}

interface PlatformUsersData {
  users: PlatformUser[];
  credentials: Record<string, PlatformCredential>;
  /** Marks that the one-time migration of platformOwner.json into a real PlatformUser record has run. */
  ownerMigrated?: boolean;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function hashPassword(password: string, salt: string): string {
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

// ─── Legacy bootstrap credential file (data/platformOwner.json) ─────────
// Only used at startup (initPlatformOwner, for a genuinely fresh install)
// and by the one-time migration below — no longer consulted at login time.

function loadOwnerRaw(): PlatformOwnerData | null {
  if (!fs.existsSync(PLATFORM_OWNER_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(PLATFORM_OWNER_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

/** Call once at server startup. Creates the platform-owner bootstrap file with a random password on first run and prints it to the log. No-op on subsequent boots. */
export function initPlatformOwner(): void {
  ensureDataDir();
  if (fs.existsSync(PLATFORM_OWNER_FILE)) return;

  const username = 'owner';
  const password = crypto.randomBytes(9).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  const data: PlatformOwnerData = { username, passwordHash: hashPassword(password, salt), salt };
  fs.writeFileSync(PLATFORM_OWNER_FILE, JSON.stringify(data, null, 2), 'utf-8');

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' Platform-Owner-Zugang für orga.schichtapp.de wurde erstellt:');
  console.log(`   Benutzername: ${username}`);
  console.log(`   Passwort:     ${password}`);
  console.log(' Bitte jetzt notieren — dieses Passwort wird nicht erneut angezeigt.');
  console.log('═══════════════════════════════════════════════════════════════');
}

/**
 * One-time migration: copies the bootstrap credential (username + hashed
 * password, unchanged) into a real PlatformUser record so it shows up in
 * the normal Zugänge list and can be reset/deleted like any other account.
 */
function migrateOwnerAccount(data: PlatformUsersData): PlatformUsersData {
  if (data.ownerMigrated) return data;
  data.ownerMigrated = true;
  const alreadyExists = data.users.some(u => u.username === 'owner');
  const owner = loadOwnerRaw();
  if (owner && !alreadyExists) {
    const id = `platform-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    data.users.push({
      id,
      name: 'Owner',
      email: OWNER_MIGRATION_EMAIL,
      username: 'owner',
      createdAt: new Date().toISOString(),
    });
    data.credentials[id] = { passwordHash: owner.passwordHash, salt: owner.salt, mustChangePassword: false };
  }
  save(data);
  return data;
}

// ─── Personal platform-user accounts (data/platformUsers.json) ──────────

function load(): PlatformUsersData {
  ensureDataDir();
  let data: PlatformUsersData;
  if (!fs.existsSync(PLATFORM_USERS_FILE)) {
    data = { users: [], credentials: {} };
  } else {
    try {
      data = JSON.parse(fs.readFileSync(PLATFORM_USERS_FILE, 'utf-8'));
    } catch {
      data = { users: [], credentials: {} };
    }
  }
  return migrateOwnerAccount(data);
}

function save(data: PlatformUsersData): void {
  ensureDataDir();
  fs.writeFileSync(PLATFORM_USERS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function generateOneTimePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 8; i++) pwd += chars[crypto.randomInt(chars.length)];
  return pwd;
}

export function listPlatformUsers(): PlatformUser[] {
  return load().users;
}

export function getPlatformUser(id: string): PlatformUser | null {
  return load().users.find(u => u.id === id) || null;
}

export function invitePlatformUser(name: string, email: string): { user: PlatformUser; oneTimePassword: string } | { error: string } {
  const data = load();
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return { error: 'Ungültige E-Mail-Adresse.' };
  }
  if (data.users.some(u => u.email.toLowerCase() === normalizedEmail)) {
    return { error: 'Diese E-Mail-Adresse ist bereits registriert.' };
  }

  const user: PlatformUser = {
    id: `platform-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name,
    email: normalizedEmail,
    createdAt: new Date().toISOString(),
  };
  const oneTimePassword = generateOneTimePassword();
  const salt = crypto.randomBytes(16).toString('hex');
  data.users.push(user);
  data.credentials[user.id] = { passwordHash: hashPassword(oneTimePassword, salt), salt, mustChangePassword: true };
  save(data);
  return { user, oneTimePassword };
}

/** Regenerate a one-time password for an account (self-service or admin-triggered) — the only way a platform account's password ever changes, besides the forced first-use setup right after this. */
export function resetPlatformUserPassword(id: string): { oneTimePassword: string } | null {
  const data = load();
  if (!data.users.some(u => u.id === id)) return null;
  const oneTimePassword = generateOneTimePassword();
  const salt = crypto.randomBytes(16).toString('hex');
  data.credentials[id] = { passwordHash: hashPassword(oneTimePassword, salt), salt, mustChangePassword: true };
  save(data);
  return { oneTimePassword };
}

/** Deletes a platform account — refuses to delete the last remaining one so orga.schichtapp.de never becomes totally inaccessible. */
export function deletePlatformUser(id: string): { success: true } | { error: string } {
  const data = load();
  const idx = data.users.findIndex(u => u.id === id);
  if (idx === -1) return { error: 'Nicht gefunden.' };
  if (data.users.length <= 1) return { error: 'Es muss mindestens ein Plattform-Zugang bestehen bleiben.' };
  data.users.splice(idx, 1);
  delete data.credentials[id];
  save(data);
  return { success: true };
}

/** Matches by email (personal accounts) or by the reserved `username` field (the migrated "owner" account). */
function authenticatePlatformUser(identifier: string, password: string): { user: PlatformUser; mustChangePassword: boolean } | null {
  const data = load();
  const normalized = identifier.trim().toLowerCase();
  const user = data.users.find(u => u.email.toLowerCase() === normalized || u.username?.toLowerCase() === normalized);
  if (!user) return null;
  const cred = data.credentials[user.id];
  if (!cred) return null;
  if (hashPassword(password, cred.salt) !== cred.passwordHash) return null;
  return { user, mustChangePassword: cred.mustChangePassword };
}

/** Sets a new password directly — only ever called right after a one-time-password login (mustChangePassword flow), never as a general "change my password anytime" action. */
export function changePlatformUserPassword(id: string, newPassword: string): boolean {
  const data = load();
  if (!data.users.some(u => u.id === id)) return false;
  const salt = crypto.randomBytes(16).toString('hex');
  data.credentials[id] = { passwordHash: hashPassword(newPassword, salt), salt, mustChangePassword: false };
  save(data);
  return true;
}

// ─── Unified login ────────────────────────────────────────────────────
// Accepts either a personal account (email) or the migrated owner account
// (its reserved username "owner") — both are real PlatformUser records.

export interface PlatformLoginResult {
  user: PlatformUser;
  mustChangePassword: boolean;
}

export function authenticatePlatform(identifier: string, password: string): PlatformLoginResult | null {
  return authenticatePlatformUser(identifier, password);
}
