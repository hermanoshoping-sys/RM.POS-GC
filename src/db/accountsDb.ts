import Dexie, { Table } from 'dexie';
import { AccountMemberIndex, AppUser, Language, TenantAccount, UserRole } from '../types';
import {
  ADMIN_PERMISSIONS,
  CASHIER_PERMISSIONS,
  DEFAULT_LEGACY_DB_NAME,
  MANAGER_PERMISSIONS,
  MatjarProDB,
  completeFirstRunSetup,
  db,
  switchActiveTenantDatabase,
} from './database';
import { generateSalt, hashPassword, verifyPassword } from '../utils/crypto';
import {
  isValidEmail,
  isValidLicenseFormat,
  isValidPhone,
  looksLikeEmail,
  looksLikePhone,
  normalizeActivationCode,
  normalizeEmail,
  normalizeLicenseNumber,
  normalizePhone,
  verifyLicenseActivationPair,
} from '../utils/license';

export class AccountsRegistryDB extends Dexie {
  accounts!: Table<TenantAccount, string>;
  members!: Table<AccountMemberIndex, number>;

  constructor() {
    super('RM_POS_GC_AccountsRegistryDB');
    this.version(1).stores({
      accounts: '&accountId, &licenseNumber, ownerEmail, ownerPhone, createdAt',
      members: '++id, accountId, [accountId+userId], username, email, phone',
    });
  }
}

export const accountsDb = new AccountsRegistryDB();

export interface RegisterAccountInput {
  storeName: string;
  ownerName: string;
  email?: string;
  phone?: string;
  password: string;
  licenseNumber: string;
  activationCode: string;
  currency: string;
  defaultLanguage: Language;
  loadDemoData: boolean;
}

export interface CreateStaffUserInput {
  username: string;
  fullName: string;
  email?: string;
  phone?: string;
  role: UserRole;
  password: string;
}

function generateAccountId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `acc_${hex}`;
}

export async function listRegisteredAccounts(): Promise<TenantAccount[]> {
  return accountsDb.accounts.orderBy('createdAt').reverse().toArray();
}

export async function getAccountById(accountId: string): Promise<TenantAccount | undefined> {
  return accountsDb.accounts.get(accountId);
}

/**
 * Mirrors the active tenant DB's users into the central account member lookup index
 * (no password hashes are stored in the registry; verification always reads the tenant DB).
 */
export async function syncAccountMembersFromActiveDb(accountId: string): Promise<void> {
  const users = await db.users.toArray();
  const rows: Omit<AccountMemberIndex, 'id'>[] = users
    .filter((u) => u.id !== undefined)
    .map((u) => ({
      accountId,
      userId: u.id!,
      username: u.username.trim(),
      ...(u.email ? { email: normalizeEmail(u.email) } : {}),
      ...(u.phone ? { phone: normalizePhone(u.phone) } : {}),
      fullName: u.fullName,
      role: u.role,
      isActive: u.isActive,
    }));

  await accountsDb.transaction('rw', accountsDb.members, async () => {
    await accountsDb.members.where('accountId').equals(accountId).delete();
    if (rows.length > 0) {
      await accountsDb.members.bulkAdd(rows);
    }
  });
}

/**
 * If an existing single-tenant installation already had users in `MatjarProRetailDB`
 * before multi-account support was introduced, register it as a legacy tenant so data is preserved.
 */
export async function ensureLegacyAccountRegistered(): Promise<TenantAccount | null> {
  const count = await accountsDb.accounts.count();
  if (count > 0) return null;

  await switchActiveTenantDatabase(DEFAULT_LEGACY_DB_NAME);
  const legacyUsers = await db.users.toArray();
  if (legacyUsers.length === 0) return null;

  const settings = await db.settings.get(1);
  const primaryAdmin = legacyUsers.find((u) => u.role === 'admin') ?? legacyUsers[0];
  const nowIso = new Date().toISOString();
  const salt = generateSalt();
  const hash = await hashPassword('LEGACY-MIGRATED', salt);

  const legacyAccount: TenantAccount = {
    accountId: 'acc_legacy_default',
    storeName: settings?.storeInfo.storeName || 'RM.POS GC',
    ownerName: primaryAdmin.fullName,
    ...(primaryAdmin.email ? { ownerEmail: normalizeEmail(primaryAdmin.email) } : {}),
    ...(primaryAdmin.phone ? { ownerPhone: normalizePhone(primaryAdmin.phone) } : {}),
    licenseNumber: 'RMGC-LEGC-0000-0001',
    activationCodeHash: hash,
    activationCodeSalt: salt,
    licenseStatus: 'active',
    activatedAt: nowIso,
    dbName: DEFAULT_LEGACY_DB_NAME,
    createdAt: primaryAdmin.createdAt || nowIso,
  };

  await accountsDb.accounts.put(legacyAccount);
  await syncAccountMembersFromActiveDb(legacyAccount.accountId);
  return legacyAccount;
}

/**
 * Registers a brand-new, completely isolated store account bound to a verified
 * license number + activation code pair, with email and/or phone login.
 */
export async function registerNewAccount(
  input: RegisterAccountInput
): Promise<{ account: TenantAccount; adminUser: AppUser }> {
  const storeName = input.storeName.trim();
  const ownerName = input.ownerName.trim();
  const cleanEmail = normalizeEmail(input.email);
  const cleanPhone = normalizePhone(input.phone);
  const normLicense = normalizeLicenseNumber(input.licenseNumber);
  const normActivation = normalizeActivationCode(input.activationCode);

  if (storeName.length < 2) {
    throw new Error('يرجى إدخال اسم المتجر أو الحساب (حرفين على الأقل)');
  }
  if (ownerName.length < 2) {
    throw new Error('يرجى إدخال الاسم الكامل لصاحب الحساب / المدير');
  }
  if (!cleanEmail && !cleanPhone) {
    throw new Error('يرجى إدخال البريد الإلكتروني أو رقم الهاتف على الأقل');
  }
  if (cleanEmail && !isValidEmail(cleanEmail)) {
    throw new Error('صيغة البريد الإلكتروني غير صالحة');
  }
  if (cleanPhone && !isValidPhone(cleanPhone)) {
    throw new Error('صيغة رقم الهاتف غير صالحة (8 إلى 15 رقماً)');
  }
  if (!input.password || input.password.length < 6) {
    throw new Error('كلمة السر يجب أن تتكون من 6 أحرف على الأقل');
  }

  // Verify License Number format + Activation Code cryptographic match
  if (!isValidLicenseFormat(normLicense)) {
    throw new Error('صيغة رقم الرخصة غير صالحة (المتوقع: RMGC-XXXX-XXXX-XXXX)');
  }
  const licenseValid = await verifyLicenseActivationPair(normLicense, normActivation);
  if (!licenseValid) {
    throw new Error(
      'رقم التفعيل غير مطابق لرقم الرخصة — يرجى التحقق من رقم الرخصة ورقم التفعيل'
    );
  }

  // Ensure license is unique (1 license = 1 independent account)
  const existingLicense = await accountsDb.accounts
    .where('licenseNumber')
    .equals(normLicense)
    .first();
  if (existingLicense) {
    throw new Error('رقم الرخصة هذا مستخدم مسبقاً لحساب آخر — لكل حساب رخصة مستقلة');
  }

  // Ensure email and phone are unique across accounts for unambiguous login routing
  if (cleanEmail) {
    const emailTaken = await accountsDb.members.where('email').equals(cleanEmail).first();
    if (emailTaken) {
      throw new Error('هذا البريد الإلكتروني مسجل مسبقاً في حساب آخر');
    }
  }
  if (cleanPhone) {
    const phoneTaken = await accountsDb.members.where('phone').equals(cleanPhone).first();
    if (phoneTaken) {
      throw new Error('رقم الهاتف هذا مسجل مسبقاً في حساب آخر');
    }
  }

  const accountId = generateAccountId();
  const dbName = `RM_POS_GC_TENANT_${accountId}`;
  const nowIso = new Date().toISOString();
  const activationSalt = generateSalt();
  const activationHash = await hashPassword(normActivation, activationSalt);

  // Derive a clean default admin username from email/phone
  const derivedUsername = cleanEmail
    ? cleanEmail.split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 20) || 'admin'
    : `admin_${cleanPhone.replace(/\D/g, '').slice(-6)}`;

  // Provision the dedicated isolated IndexedDB for this account
  await switchActiveTenantDatabase(dbName);
  const adminUser = await completeFirstRunSetup({
    storeName,
    currency: input.currency || 'د.م',
    defaultLanguage: input.defaultLanguage || 'ar',
    adminUsername: derivedUsername.length >= 3 ? derivedUsername : 'admin',
    adminFullName: ownerName,
    adminEmail: cleanEmail || undefined,
    adminPhone: cleanPhone || undefined,
    adminPassword: input.password,
    loadDemoData: input.loadDemoData,
  });

  const account: TenantAccount = {
    accountId,
    storeName,
    ownerName,
    ...(cleanEmail ? { ownerEmail: cleanEmail } : {}),
    ...(cleanPhone ? { ownerPhone: cleanPhone } : {}),
    licenseNumber: normLicense,
    activationCodeHash: activationHash,
    activationCodeSalt: activationSalt,
    licenseStatus: 'active',
    activatedAt: nowIso,
    dbName,
    createdAt: nowIso,
  };

  await accountsDb.accounts.put(account);
  await syncAccountMembersFromActiveDb(accountId);

  return { account, adminUser };
}

/**
 * Authenticates an account owner or staff member by Email, Phone Number, or Username.
 * Automatically routes to the user's isolated account database and switches `db` upon success.
 */
export async function authenticateAccountUser(input: {
  identifier: string;
  password: string;
  preferredAccountId?: string | null;
}): Promise<{ account: TenantAccount; user: AppUser }> {
  const rawId = input.identifier.trim();
  const password = input.password;
  if (!rawId || !password) {
    throw new Error('يرجى إدخال البريد الإلكتروني أو رقم الهاتف وكلمة السر');
  }

  const isEmailInput = looksLikeEmail(rawId);
  const isPhoneInput = !isEmailInput && looksLikePhone(rawId);
  const normEmail = isEmailInput ? normalizeEmail(rawId) : '';
  const normPhone = isPhoneInput ? normalizePhone(rawId) : '';

  let candidateMembers: AccountMemberIndex[] = [];

  if (isEmailInput) {
    candidateMembers = await accountsDb.members.where('email').equals(normEmail).toArray();
  } else if (isPhoneInput) {
    candidateMembers = await accountsDb.members.where('phone').equals(normPhone).toArray();
    // Also fallback to username match in case a legacy username is numeric
    if (candidateMembers.length === 0) {
      candidateMembers = await accountsDb.members.where('username').equals(rawId).toArray();
    }
  } else {
    candidateMembers = await accountsDb.members.where('username').equals(rawId).toArray();
  }

  if (input.preferredAccountId) {
    candidateMembers = candidateMembers.filter(
      (m) => m.accountId === input.preferredAccountId
    );
  }

  // Deduplicate candidate accounts while preserving order
  const uniqueAccountIds = Array.from(new Set(candidateMembers.map((m) => m.accountId)));

  for (const accId of uniqueAccountIds) {
    const account = await accountsDb.accounts.get(accId);
    if (!account || account.licenseStatus !== 'active') continue;

    // Inspect tenant DB in isolation without switching active `db` until password succeeds
    const tempDb = new MatjarProDB(account.dbName);
    let matchedUser: AppUser | undefined;
    try {
      await tempDb.open();
      const users = await tempDb.users.toArray();
      matchedUser = users.find((u) => {
        if (!u.isActive) return false;
        if (isEmailInput) return normalizeEmail(u.email) === normEmail;
        if (isPhoneInput) {
          return normalizePhone(u.phone) === normPhone || u.username === rawId;
        }
        return u.username === rawId;
      });
      if (matchedUser) {
        const ok = await verifyPassword(password, matchedUser.passwordSalt, matchedUser.passwordHash);
        if (!ok) {
          matchedUser = undefined;
        }
      }
    } finally {
      tempDb.close();
    }

    if (matchedUser) {
      await switchActiveTenantDatabase(account.dbName);
      await db.loginLogs.add({
        date: new Date().toISOString(),
        username: matchedUser.username,
        status: 'success',
        details: `تسجيل دخول ناجح (${isEmailInput ? 'بريد إلكتروني' : isPhoneInput ? 'رقم هاتف' : 'اسم مستخدم'})`,
      });
      return { account, user: matchedUser };
    }
  }

  throw new Error('بيانات الدخول غير صحيحة أو الحساب غير مفعل');
}

/**
 * Adds a staff user strictly inside the currently active account's isolated database
 * and indexes their email/phone/username in the central member directory.
 */
export async function createStaffUserInActiveAccount(
  accountId: string | null,
  input: CreateStaffUserInput,
  actor: AppUser
): Promise<AppUser> {
  if (!actor.permissions.canManageSettings && actor.role !== 'admin') {
    throw new Error('ليس لديك صلاحية إضافة مستخدمين');
  }
  const username = input.username.trim();
  const fullName = input.fullName.trim() || username;
  const cleanEmail = normalizeEmail(input.email);
  const cleanPhone = normalizePhone(input.phone);

  if (username.length < 3) {
    throw new Error('اسم المستخدم يجب أن يحتوي على 3 أحرف على الأقل');
  }
  if (!input.password || input.password.length < 6) {
    throw new Error('كلمة سر المستخدم يجب أن تتكون من 6 أحرف على الأقل');
  }
  if (cleanEmail && !isValidEmail(cleanEmail)) {
    throw new Error('صيغة البريد الإلكتروني غير صالحة');
  }
  if (cleanPhone && !isValidPhone(cleanPhone)) {
    throw new Error('صيغة رقم الهاتف غير صالحة (8 إلى 15 رقماً)');
  }

  const usernameExists = await db.users.where('username').equals(username).first();
  if (usernameExists) {
    throw new Error('اسم المستخدم موجود مسبقاً داخل هذا الحساب');
  }

  if (cleanEmail) {
    const globalEmail = await accountsDb.members.where('email').equals(cleanEmail).first();
    if (globalEmail) {
      throw new Error('هذا البريد الإلكتروني مستخدم مسبقاً');
    }
  }
  if (cleanPhone) {
    const globalPhone = await accountsDb.members.where('phone').equals(cleanPhone).first();
    if (globalPhone) {
      throw new Error('رقم الهاتف هذا مستخدم مسبقاً');
    }
  }

  const salt = generateSalt();
  const hash = await hashPassword(input.password, salt);
  const perms =
    input.role === 'admin'
      ? { ...ADMIN_PERMISSIONS }
      : input.role === 'manager'
        ? { ...MANAGER_PERMISSIONS }
        : { ...CASHIER_PERMISSIONS };

  const record: AppUser = {
    username,
    ...(cleanEmail ? { email: cleanEmail } : {}),
    ...(cleanPhone ? { phone: cleanPhone } : {}),
    fullName,
    role: input.role,
    passwordHash: hash,
    passwordSalt: salt,
    permissions: perms,
    isActive: true,
    createdAt: new Date().toISOString(),
  };

  const id = await db.users.add(record);
  const created: AppUser = { ...record, id };

  await db.auditLogs.add({
    date: new Date().toISOString(),
    userId: actor.id ?? 1,
    userName: actor.fullName,
    action: 'USER_CREATED',
    entityType: 'user',
    entityId: String(id),
    details: `إنشاء مستخدم جديد داخل الحساب: ${username} (${input.role})${cleanEmail ? ` · ${cleanEmail}` : ''}${cleanPhone ? ` · ${cleanPhone}` : ''}`,
  });

  if (accountId) {
    await syncAccountMembersFromActiveDb(accountId);
  }
  return created;
}

/**
 * Updates storeName in the central registry whenever an account updates its store name in Settings.
 */
export async function syncAccountStoreMetadata(
  accountId: string,
  patch: Partial<
    Pick<
      TenantAccount,
      'storeName' | 'ownerEmail' | 'ownerPhone' | 'cloudUid' | 'cloudEmail' | 'syncRevision' | 'lastSyncedAt'
    >
  >
): Promise<void> {
  await accountsDb.accounts.update(accountId, patch);
}

/**
 * Inserts or updates a local TenantAccount entry pulled from Cloud Firestore.
 */
export async function upsertLocalTenantAccount(account: TenantAccount): Promise<void> {
  await accountsDb.accounts.put(account);
}

