/**
 * Admin-panel user accounts — three roles:
 *   - admin:     full access to everything in their organization.
 *   - leitung:   configurable per-area permissions (see AdminPermissionArea).
 *   - betrachter: read-only everywhere, no mutations allowed at all.
 *
 * One directory shared across all organizations (data/adminUsers.json),
 * since login happens on the single shared admin.schichtapp.de domain
 * before the organization is known (resolved by email, mirroring how the
 * employee portal resolves the organization by username in portalAuth.ts).
 *
 * Sessions are kept in-memory in server/index.ts (same convention the app
 * already used for the legacy shared admin login — sessions don't survive a
 * server restart, which was already true before this change).
 *
 * NOTE on role history: this used to be a 2-role system (`leitung` = full
 * access, `manager` = default-department-filter only). Renamed/migrated
 * (migrateRoles(), runs once on load) to: old leitung -> admin, old manager
 * -> leitung (granted all permission areas, so nobody's effective access
 * changed at migration time — an Admin can dial individual areas back
 * afterwards).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOrganizations } from './db.js';

/** Reserved "email" (not a real address) used to store the legacy shared spm2026 login as a normal, editable AdminUser record — see migrateLegacyAccount(). */
export const LEGACY_LOGIN_USERNAME = 'spm2026';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const ADMIN_USERS_FILE = path.join(DATA_DIR, 'adminUsers.json');

export type AdminRole = 'admin' | 'leitung' | 'betrachter';

/**
 * Configurable permission areas for the `leitung` role. Team management and
 * full data reset are always admin-only and never appear here. Org-wide tab
 * visibility (which tabs exist AT ALL for Admin/Leitung or for Betrachter)
 * is also always admin-only now — not delegatable — so there is no
 * 'settings_tabs' area; instead each Leitung/Betrachter gets their own
 * personal show/hide preference (see AdminUser.personalTabVisibility) within
 * whatever the Admin has org-wide allowed.
 */
export const ADMIN_PERMISSION_AREAS = [
  'employees',
  'departments',
  'planning',
  'calendar',
  'swaps',
  'settings_holidays',
  'settings_swapconfig',
  'settings_backup',
] as const;
export type AdminPermissionArea = typeof ADMIN_PERMISSION_AREAS[number];

export interface AdminUser {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: AdminRole;
  /** Only meaningful when role === 'leitung'. */
  permissions?: AdminPermissionArea[];
  createdAt: string;
  /** Self-service per-account tab show/hide preference (Leitung/Betrachter only) — always intersected with the Admin-controlled org-wide max, never lets a tab the Admin disallowed reappear. */
  personalTabVisibility?: Record<string, boolean>;
}

interface AdminCredential {
  passwordHash: string;
  salt: string;
  mustChangePassword: boolean;
}

interface AdminUsersData {
  users: AdminUser[];
  credentials: Record<string, AdminCredential>; // keyed by AdminUser.id
  /** Marks that the leitung/manager -> admin/leitung role rename has run. */
  rolesMigrated?: boolean;
  /** Marks that the one-time seeding of the legacy spm2026 login as a real, editable AdminUser record has run. */
  legacyAccountMigrated?: boolean;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function migrateRoles(data: AdminUsersData): AdminUsersData {
  if (data.rolesMigrated) return data;
  for (const user of data.users) {
    const raw = user.role as string;
    if (raw === 'leitung') {
      // old full-access role -> new admin
      (user as any).role = 'admin';
    } else if (raw === 'manager') {
      // old default-department-filter role -> new leitung, keep the same
      // effective access by granting every permission area
      (user as any).role = 'leitung';
      user.permissions = [...ADMIN_PERMISSION_AREAS];
    }
  }
  data.rolesMigrated = true;
  save(data);
  return data;
}

/**
 * The legacy shared admin login (username "spm2026", password "schichtplan2026!")
 * used to be a hardcoded credential check in index.ts, invisible in any
 * organization's Zugänge/Team list. Seed it once as a real, ordinary AdminUser
 * record (role admin) for the first organization — editable/deletable/
 * re-assignable through the normal Team UI exactly like any invited account.
 * If it's later deleted or its role/password changed, the spm2026 login
 * reflects that (it's just a normal account now, not a permanent fallback).
 */
function migrateLegacyAccount(data: AdminUsersData): AdminUsersData {
  if (data.legacyAccountMigrated) return data;
  data.legacyAccountMigrated = true;
  const firstOrg = listOrganizations()[0];
  const alreadyExists = data.users.some(u => u.email.toLowerCase() === LEGACY_LOGIN_USERNAME);
  if (firstOrg && !alreadyExists) {
    const id = `admin-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const salt = crypto.randomBytes(16).toString('hex');
    data.users.push({
      id,
      organizationId: firstOrg.id,
      name: 'Admin',
      email: LEGACY_LOGIN_USERNAME,
      role: 'admin',
      createdAt: new Date().toISOString(),
    });
    data.credentials[id] = {
      passwordHash: hashPassword('schichtplan2026!', salt),
      salt,
      mustChangePassword: false,
    };
  }
  save(data);
  return data;
}

function load(): AdminUsersData {
  ensureDataDir();
  let data: AdminUsersData;
  if (!fs.existsSync(ADMIN_USERS_FILE)) {
    data = { users: [], credentials: {} };
  } else {
    try {
      data = JSON.parse(fs.readFileSync(ADMIN_USERS_FILE, 'utf-8'));
    } catch {
      data = { users: [], credentials: {} };
    }
  }
  data = migrateRoles(data);
  data = migrateLegacyAccount(data);
  return data;
}

function save(data: AdminUsersData): void {
  ensureDataDir();
  fs.writeFileSync(ADMIN_USERS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function hashPassword(password: string, salt: string): string {
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

export function generateOneTimePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  for (let i = 0; i < 8; i++) pwd += chars[crypto.randomInt(chars.length)];
  return pwd;
}

/** List admin users belonging to an organization. */
export function listAdminUsers(organizationId: string): AdminUser[] {
  return load().users.filter(u => u.organizationId === organizationId);
}

export function getAdminUser(id: string): AdminUser | null {
  return load().users.find(u => u.id === id) || null;
}

/** Invite (create) a new admin user for an organization. Returns the user + one-time password to email them, or an error. */
export function inviteAdminUser(
  organizationId: string,
  name: string,
  email: string,
  role: AdminRole,
  permissions?: AdminPermissionArea[],
): { user: AdminUser; oneTimePassword: string } | { error: string } {
  const data = load();
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return { error: 'Ungültige E-Mail-Adresse.' };
  }
  if (data.users.some(u => u.email.toLowerCase() === normalizedEmail)) {
    return { error: 'Diese E-Mail-Adresse ist bereits als Admin-Zugang registriert.' };
  }

  const user: AdminUser = {
    id: `admin-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    organizationId,
    name,
    email: normalizedEmail,
    role,
    permissions: role === 'leitung' ? (permissions ?? []).filter(p => (ADMIN_PERMISSION_AREAS as readonly string[]).includes(p)) : undefined,
    createdAt: new Date().toISOString(),
  };
  const oneTimePassword = generateOneTimePassword();
  const salt = crypto.randomBytes(16).toString('hex');

  data.users.push(user);
  data.credentials[user.id] = {
    passwordHash: hashPassword(oneTimePassword, salt),
    salt,
    mustChangePassword: true,
  };
  save(data);
  return { user, oneTimePassword };
}

/** Reset an existing admin user's password (used for resending an invite). */
export function resetAdminPassword(id: string): { oneTimePassword: string } | null {
  const data = load();
  if (!data.users.some(u => u.id === id)) return null;
  const oneTimePassword = generateOneTimePassword();
  const salt = crypto.randomBytes(16).toString('hex');
  data.credentials[id] = {
    passwordHash: hashPassword(oneTimePassword, salt),
    salt,
    mustChangePassword: true,
  };
  save(data);
  return { oneTimePassword };
}

/** Update an admin user's role and (for leitung) their granted permission areas. */
export function updateAdminUserRole(id: string, role: AdminRole, permissions?: AdminPermissionArea[]): AdminUser | null {
  const data = load();
  const user = data.users.find(u => u.id === id);
  if (!user) return null;
  user.role = role;
  const nextPermissions = permissions ?? user.permissions ?? [];
  user.permissions = role === 'leitung'
    ? nextPermissions.filter(p => (ADMIN_PERMISSION_AREAS as readonly string[]).includes(p))
    : undefined;
  save(data);
  return user;
}

/** Self-service: a Leitung/Betrachter sets their own personal tab show/hide preference. Caller (index.ts) is responsible for clamping against the org-wide max before calling this. */
export function updatePersonalTabVisibility(id: string, vis: Record<string, boolean>): AdminUser | null {
  const data = load();
  const user = data.users.find(u => u.id === id);
  if (!user) return null;
  user.personalTabVisibility = vis;
  save(data);
  return user;
}

export function deleteAdminUser(id: string): boolean {
  const data = load();
  const idx = data.users.findIndex(u => u.id === id);
  if (idx === -1) return false;
  data.users.splice(idx, 1);
  delete data.credentials[id];
  save(data);
  return true;
}

/** Authenticate by email + password (organization isn't known until the email matches — mirrors portalAuth's username scan). */
export function authenticateAdmin(email: string, password: string): { user: AdminUser; mustChangePassword: boolean } | null {
  const data = load();
  const normalizedEmail = email.trim().toLowerCase();
  const user = data.users.find(u => u.email.toLowerCase() === normalizedEmail);
  if (!user) return null;
  const cred = data.credentials[user.id];
  if (!cred) return null;
  const hash = hashPassword(password, cred.salt);
  if (hash !== cred.passwordHash) return null;
  return { user, mustChangePassword: cred.mustChangePassword };
}

export function changeAdminPassword(id: string, newPassword: string): boolean {
  const data = load();
  if (!data.users.some(u => u.id === id)) return false;
  const salt = crypto.randomBytes(16).toString('hex');
  data.credentials[id] = {
    passwordHash: hashPassword(newPassword, salt),
    salt,
    mustChangePassword: false,
  };
  save(data);
  return true;
}

/** Re-check a password against an existing admin user's current credential (used for "confirm with your own password" actions). */
export function verifyAdminPassword(id: string, password: string): boolean {
  const data = load();
  const cred = data.credentials[id];
  if (!cred) return false;
  return hashPassword(password, cred.salt) === cred.passwordHash;
}
