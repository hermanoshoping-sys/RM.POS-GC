import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  User as FirebaseUser,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  Unsubscribe,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  FIREBASE_DATABASE_ID,
  FIREBASE_PROJECT_ID,
  firebaseAuth,
  firestoreDb,
  googleAuthProvider,
  handleFirestoreError,
  OperationType,
} from '../firebase';
import { db, switchActiveTenantDatabase } from '../db/database';
import {
  syncAccountMembersFromActiveDb,
  syncAccountStoreMetadata,
  upsertLocalTenantAccount,
} from '../db/accountsDb';
import { AppUser, TenantAccount } from '../types';
import { normalizeEmail } from '../utils/license';

const DEVICE_ID_STORAGE_KEY = 'rmpos_cloud_device_id_v1';

export const SYNCED_TABLES = [
  'users',
  'categories',
  'products',
  'priceHistory',
  'customers',
  'suppliers',
  'saleInvoices',
  'saleReturns',
  'installments',
  'heldCarts',
  'purchaseInvoices',
  'supplierReturns',
  'stockMovements',
  'customerPayments',
  'supplierPayments',
  'expenses',
  'cashSessions',
  'auditLogs',
  'loginLogs',
  'settings',
] as const;

export type SyncedTableName = (typeof SYNCED_TABLES)[number];

export interface CloudAccountDoc {
  accountId: string;
  ownerUid: string;
  ownerEmail: string;
  ownerPhone?: string;
  ownerName: string;
  storeName: string;
  licenseNumber: string;
  activationCodeHash: string;
  activationCodeSalt: string;
  licenseStatus: 'active' | 'revoked';
  activatedAt: string;
  syncRevision: number;
  lastSyncedDeviceId?: string;
  lastSyncedAt?: Timestamp | null;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]{3,128}$/;

export function getStableDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing && VALID_ID_REGEX.test(existing)) {
      return existing;
    }
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const created = `dev_${hex}`;
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return 'dev_browser_session';
  }
}

function clampString(val: string, maxLen: number): string {
  const trimmed = val.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function timestampToIso(ts: unknown): string {
  if (ts && typeof ts === 'object' && 'toDate' in ts && typeof (ts as Timestamp).toDate === 'function') {
    return (ts as Timestamp).toDate().toISOString();
  }
  if (typeof ts === 'string' && ts.length > 0) return ts;
  return new Date().toISOString();
}

/**
 * Recursively strips `undefined`, NaN, and oversized inline base64 blobs
 * so every Firestore native map/list chunk stays strictly valid and well under 1MB.
 */
function sanitizeForFirestore(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    // Prevent huge embedded data URLs (images/attachments) from blowing past Firestore's 1MB limit
    if (value.startsWith('data:') && value.length > 48_000) {
      return '';
    }
    if (value.length > 50_000) {
      return value.slice(0, 50_000);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForFirestore(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || typeof v === 'function') continue;
      out[k] = sanitizeForFirestore(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Splits a sanitized list of records into bounded chunks (<= 50 items AND <= 180KB JSON estimate)
 * matching our Firestore blueprint & security rules (`items.size() <= 100`).
 */
function splitIntoBoundedChunks(records: Record<string, unknown>[]): Record<string, unknown>[][] {
  if (records.length === 0) {
    return [[]];
  }
  const chunks: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];
  let currentBytes = 0;
  const MAX_ITEMS = 50;
  const MAX_BYTES = 180_000;

  for (const row of records) {
    const approxSize = JSON.stringify(row).length;
    if (
      current.length > 0 &&
      (current.length >= MAX_ITEMS || currentBytes + approxSize > MAX_BYTES)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += approxSize;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export function formatFirebaseAuthError(error: unknown, lang: 'ar' | 'fr'): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  const msg = error instanceof Error ? error.message : String(error);

  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return lang === 'ar'
      ? 'تم إغلاق نافذة تسجيل الدخول قبل إتمام العملية.'
      : 'La fenêtre de connexion a été fermée avant la fin.';
  }
  if (code === 'auth/popup-blocked') {
    return lang === 'ar'
      ? 'قام المتصفح بحظر النافذة المنبثقة. يرجى السماح بالنوافذ المنبثقة ثم المحاولة مجدداً.'
      : 'La fenêtre pop-up a été bloquée par le navigateur. Autorisez les pop-ups puis réessayez.';
  }
  if (code === 'auth/operation-not-allowed') {
    return lang === 'ar'
      ? 'تسجيل الدخول بالبريد وكلمة السر غير مفعّل بعد في لوحة Firebase Console — استخدم زر «الدخول عبر بريد Google» أعلاه (يعمل فوراً) أو فعّل Email/Password من Firebase Console.'
      : 'La connexion E-mail/Mot de passe n’est pas activée dans Firebase Console — utilisez « Continuer avec Google » ci-dessus ou activez Email/Password dans Firebase Console.';
  }
  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found'
  ) {
    return lang === 'ar'
      ? 'البريد الإلكتروني أو كلمة السر السحابية غير صحيحة.'
      : 'Adresse e-mail ou mot de passe cloud incorrect.';
  }
  if (code === 'auth/email-already-in-use') {
    return lang === 'ar'
      ? 'هذا البريد الإلكتروني مسجل مسبقاً — يرجى تسجيل الدخول به مباشرة.'
      : 'Cette adresse e-mail est déjà enregistrée — connectez-vous directement.';
  }
  if (code === 'auth/weak-password') {
    return lang === 'ar'
      ? 'كلمة السر يجب أن تتكون من 6 أحرف على الأقل.'
      : 'Le mot de passe doit contenir au moins 6 caractères.';
  }
  if (code === 'auth/network-request-failed') {
    return lang === 'ar'
      ? 'لا يوجد اتصال بالإنترنت حالياً. يمكنك العمل محلياً وستتم المزامنة عند عودة الاتصال.'
      : 'Pas de connexion Internet. Vous pouvez travailler hors ligne et synchroniser plus tard.';
  }
  if (msg.toLowerCase().includes('quota exceeded')) {
    const upgradeUrl = `https://console.firebase.google.com/project/${FIREBASE_PROJECT_ID}/firestore/databases/${FIREBASE_DATABASE_ID}/data?openUpgradeDialog=true`;
    return lang === 'ar'
      ? `تم بلوغ الحد اليومي المجاني لقاعدة البيانات السحابية. ستتجدد الحصة غداً (${upgradeUrl}).`
      : `Quota quotidien gratuit Firestore atteint. Réinitialisation demain (${upgradeUrl}).`;
  }
  return msg;
}

export async function signInWithGoogleEmail(): Promise<FirebaseUser> {
  const result = await signInWithPopup(firebaseAuth, googleAuthProvider);
  if (result.user.emailVerified) {
    await ensureCloudUserProfile(result.user);
  }
  return result.user;
}

export async function signInWithCloudEmailPassword(
  email: string,
  password: string
): Promise<FirebaseUser> {
  const cleanEmail = normalizeEmail(email);
  const result = await signInWithEmailAndPassword(firebaseAuth, cleanEmail, password);
  if (result.user.emailVerified) {
    await ensureCloudUserProfile(result.user);
  }
  return result.user;
}

export async function registerWithCloudEmailPassword(
  email: string,
  password: string,
  displayName: string
): Promise<FirebaseUser> {
  const cleanEmail = normalizeEmail(email);
  const result = await createUserWithEmailAndPassword(firebaseAuth, cleanEmail, password);
  const cleanName = clampString(displayName || cleanEmail.split('@')[0] || 'User', 120);
  await updateProfile(result.user, { displayName: cleanName });
  await sendEmailVerification(result.user);
  return result.user;
}

export async function resendCloudEmailVerification(): Promise<void> {
  const user = firebaseAuth.currentUser;
  if (!user) throw new Error('لا يوجد حساب بريد إلكتروني متصل حالياً');
  await sendEmailVerification(user);
}

export async function signOutCloudEmail(): Promise<void> {
  await signOut(firebaseAuth);
}

/**
 * Ensures `/users/{uid}` exists and matches our blueprint constraints strictly.
 */
export async function ensureCloudUserProfile(
  user: FirebaseUser,
  activeAccountId?: string
): Promise<void> {
  if (!user.email || !user.emailVerified) return;
  const userPath = `users/${user.uid}`;
  const ref = doc(firestoreDb, 'users', user.uid);
  const cleanEmail = clampString(normalizeEmail(user.email), 160);
  const cleanName = clampString(user.displayName || cleanEmail.split('@')[0] || 'Owner', 120);
  const cleanPhoto = user.photoURL ? clampString(user.photoURL, 500) : undefined;

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      const payload: Record<string, unknown> = {
        uid: user.uid,
        email: cleanEmail,
        displayName: cleanName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (cleanPhoto) payload.photoURL = cleanPhoto;
      if (activeAccountId && VALID_ID_REGEX.test(activeAccountId)) {
        payload.activeAccountId = activeAccountId;
      }
      await setDoc(ref, payload);
    } else {
      const patch: Record<string, unknown> = {
        email: cleanEmail,
        displayName: cleanName,
        updatedAt: serverTimestamp(),
      };
      if (cleanPhoto) patch.photoURL = cleanPhoto;
      if (activeAccountId && VALID_ID_REGEX.test(activeAccountId)) {
        patch.activeAccountId = activeAccountId;
      }
      await updateDoc(ref, patch);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }
}

/**
 * Lists all cloud store accounts belonging strictly to `uid`.
 * Uses `where('ownerUid', '==', uid)` to satisfy Firestore security rules' `allow list` check.
 */
export async function listCloudAccountsForUser(uid: string): Promise<CloudAccountDoc[]> {
  const accountsPath = `users/${uid}/accounts`;
  try {
    const q = query(
      collection(firestoreDb, 'users', uid, 'accounts'),
      where('ownerUid', '==', uid)
    );
    const snap = await getDocs(q);
    const list: CloudAccountDoc[] = [];
    snap.forEach((docSnap) => {
      const data = docSnap.data() as CloudAccountDoc;
      list.push({ ...data, accountId: docSnap.id });
    });
    return list.sort((a, b) => {
      const ta = timestampToIso(a.lastSyncedAt ?? a.updatedAt ?? a.activatedAt);
      const tb = timestampToIso(b.lastSyncedAt ?? b.updatedAt ?? b.activatedAt);
      return tb.localeCompare(ta);
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, accountsPath);
  }
}

/**
 * Computes a fast deterministic fingerprint of the active Dexie database's business data
 * to avoid unnecessary cloud writes when nothing changed.
 */
export async function computeActiveDbSyncFingerprint(): Promise<string> {
  const counts = await Promise.all(
    SYNCED_TABLES.map(async (tableName) => {
      const table = db.table(tableName);
      const rows = await table.toArray();
      return `${tableName}:${rows.length}:${JSON.stringify(rows).length}`;
    })
  );
  return counts.join('|');
}

/**
 * Pushes the active tenant's entire Dexie database into Cloud Firestore as bounded native-map chunks
 * under `/users/{uid}/accounts/{accountId}/tableChunks/{chunkId}`.
 */
export async function publishActiveAccountToCloud(
  user: FirebaseUser,
  account: TenantAccount
): Promise<{ syncRevision: number; syncedAtIso: string }> {
  if (!user.email || !user.emailVerified) {
    throw new Error('يرجى تأكيد البريد الإلكتروني أولاً قبل تفعيل المزامنة السحابية');
  }
  const uid = user.uid;
  const email = clampString(normalizeEmail(user.email), 160);
  const deviceId = getStableDeviceId();

  await ensureCloudUserProfile(user, account.accountId);

  const accountPath = `users/${uid}/accounts/${account.accountId}`;
  const accountRef = doc(firestoreDb, 'users', uid, 'accounts', account.accountId);

  let existingRevision = 0;
  let accountExists = false;
  try {
    const existingSnap = await getDoc(accountRef);
    if (existingSnap.exists()) {
      accountExists = true;
      const existingData = existingSnap.data() as CloudAccountDoc;
      existingRevision = Number(existingData.syncRevision) || 0;
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, accountPath);
  }

  const nextRevision = Math.max(existingRevision, account.syncRevision ?? 0) + 1;

  // Ensure the parent CloudAccount document exists BEFORE writing tableChunks (Master Gate requirement)
  if (!accountExists) {
    const createPayload: Record<string, unknown> = {
      accountId: account.accountId,
      ownerUid: uid,
      ownerEmail: email,
      ownerName: clampString(account.ownerName || user.displayName || 'Owner', 120),
      storeName: clampString(account.storeName || 'RM.POS GC', 140),
      licenseNumber: account.licenseNumber,
      activationCodeHash: clampString(account.activationCodeHash, 200),
      activationCodeSalt: clampString(account.activationCodeSalt, 128),
      licenseStatus: 'active',
      activatedAt: clampString(account.activatedAt || new Date().toISOString(), 40),
      syncRevision: existingRevision,
      lastSyncedDeviceId: deviceId,
      lastSyncedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    if (account.ownerPhone && account.ownerPhone.trim().length > 0) {
      createPayload.ownerPhone = clampString(account.ownerPhone, 32);
    }
    try {
      await setDoc(accountRef, createPayload);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, accountPath);
    }
  }

  // Fetch existing chunk IDs so we use `updateDoc` on existing chunks (preserving immutable `createdAt`)
  // and clean up any stale chunks from tables that shrank.
  const chunksColPath = `users/${uid}/accounts/${account.accountId}/tableChunks`;
  const existingChunkIds = new Set<string>();
  try {
    const existingChunksQuery = query(
      collection(firestoreDb, 'users', uid, 'accounts', account.accountId, 'tableChunks'),
      where('ownerUid', '==', uid)
    );
    const existingChunksSnap = await getDocs(existingChunksQuery);
    existingChunksSnap.forEach((d) => existingChunkIds.add(d.id));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, chunksColPath);
  }

  // Read all 20 local Dexie tables and write bounded native-map chunks
  const activeChunkIds = new Set<string>();
  for (const tableName of SYNCED_TABLES) {
    const rawRows = await db.table(tableName).toArray();
    const sanitizedRows = rawRows.map(
      (row) => sanitizeForFirestore(row) as Record<string, unknown>
    );
    const chunks = splitIntoBoundedChunks(sanitizedRows);
    const totalChunks = chunks.length;

    for (let idx = 0; idx < chunks.length; idx++) {
      const items = chunks[idx];
      const chunkId = `${tableName}_c${idx}`;
      activeChunkIds.add(chunkId);
      const chunkPath = `${chunksColPath}/${chunkId}`;
      const chunkRef = doc(
        firestoreDb,
        'users',
        uid,
        'accounts',
        account.accountId,
        'tableChunks',
        chunkId
      );

      try {
        if (existingChunkIds.has(chunkId)) {
          await updateDoc(chunkRef, {
            chunkIndex: idx,
            totalChunks,
            itemCount: items.length,
            items,
            syncRevision: nextRevision,
            updatedAt: serverTimestamp(),
          });
        } else {
          await setDoc(chunkRef, {
            ownerUid: uid,
            accountId: account.accountId,
            tableName,
            chunkIndex: idx,
            totalChunks,
            itemCount: items.length,
            items,
            syncRevision: nextRevision,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      } catch (error) {
        handleFirestoreError(
          error,
          existingChunkIds.has(chunkId) ? OperationType.UPDATE : OperationType.CREATE,
          chunkPath
        );
      }
    }
  }

  // Delete stale chunk docs that are no longer needed
  for (const oldChunkId of existingChunkIds) {
    if (!activeChunkIds.has(oldChunkId)) {
      const delPath = `${chunksColPath}/${oldChunkId}`;
      try {
        await deleteDoc(
          doc(
            firestoreDb,
            'users',
            uid,
            'accounts',
            account.accountId,
            'tableChunks',
            oldChunkId
          )
        );
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, delPath);
      }
    }
  }

  // Publish the new syncRevision on the parent CloudAccount document (triggers real-time onSnapshot on other devices)
  try {
    await updateDoc(accountRef, {
      syncRevision: nextRevision,
      lastSyncedDeviceId: deviceId,
      lastSyncedAt: serverTimestamp(),
      storeName: clampString(account.storeName || 'RM.POS GC', 140),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, accountPath);
  }

  const syncedAtIso = new Date().toISOString();
  await syncAccountStoreMetadata(account.accountId, {
    cloudUid: uid,
    cloudEmail: email,
    ownerEmail: email,
    syncRevision: nextRevision,
    lastSyncedAt: syncedAtIso,
  });

  return { syncRevision: nextRevision, syncedAtIso };
}

/**
 * Pulls a CloudAccount and all of its table chunks from Cloud Firestore into a local isolated Dexie DB,
 * registers it in `accountsDb`, and returns the local TenantAccount + primary owner AppUser.
 */
export async function pullCloudAccountToLocal(
  uid: string,
  cloudAccount: CloudAccountDoc
): Promise<{ account: TenantAccount; ownerUser: AppUser | null }> {
  const chunksColPath = `users/${uid}/accounts/${cloudAccount.accountId}/tableChunks`;
  const grouped = new Map<SyncedTableName, { chunkIndex: number; items: Record<string, unknown>[] }[]>();

  try {
    const q = query(
      collection(firestoreDb, 'users', uid, 'accounts', cloudAccount.accountId, 'tableChunks'),
      where('ownerUid', '==', uid)
    );
    const snap = await getDocs(q);
    snap.forEach((docSnap) => {
      const data = docSnap.data() as {
        tableName?: SyncedTableName;
        chunkIndex?: number;
        items?: Record<string, unknown>[];
      };
      if (!data.tableName || !Array.isArray(data.items)) return;
      const list = grouped.get(data.tableName) ?? [];
      list.push({
        chunkIndex: Number(data.chunkIndex) || 0,
        items: data.items,
      });
      grouped.set(data.tableName, list);
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, chunksColPath);
  }

  const dbName = `RM_POS_GC_TENANT_${cloudAccount.accountId}`;
  await switchActiveTenantDatabase(dbName);

  const dexieTables = SYNCED_TABLES.map((name) => db.table(name));

  await db.transaction('rw', dexieTables, async () => {
    for (const tableName of SYNCED_TABLES) {
      const table = db.table(tableName);
      const chunks = grouped.get(tableName);
      if (!chunks) continue;
      chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
      const rows = chunks.flatMap((c) => c.items);
      await table.clear();
      if (rows.length > 0) {
        await table.bulkPut(rows);
      }
    }
  });

  const lastSyncedAtIso = timestampToIso(cloudAccount.lastSyncedAt ?? cloudAccount.updatedAt);
  const localAccount: TenantAccount = {
    accountId: cloudAccount.accountId,
    storeName: cloudAccount.storeName,
    ownerName: cloudAccount.ownerName,
    ownerEmail: cloudAccount.ownerEmail,
    ...(cloudAccount.ownerPhone ? { ownerPhone: cloudAccount.ownerPhone } : {}),
    licenseNumber: cloudAccount.licenseNumber,
    activationCodeHash: cloudAccount.activationCodeHash,
    activationCodeSalt: cloudAccount.activationCodeSalt,
    licenseStatus: cloudAccount.licenseStatus === 'active' ? 'active' : 'suspended',
    activatedAt: cloudAccount.activatedAt,
    dbName,
    createdAt: timestampToIso(cloudAccount.createdAt ?? cloudAccount.activatedAt),
    cloudUid: uid,
    cloudEmail: cloudAccount.ownerEmail,
    syncRevision: cloudAccount.syncRevision,
    lastSyncedAt: lastSyncedAtIso,
  };

  await upsertLocalTenantAccount(localAccount);
  await syncAccountMembersFromActiveDb(localAccount.accountId);

  const users = await db.users.toArray();
  const normCloudEmail = normalizeEmail(cloudAccount.ownerEmail);
  const ownerUser =
    users.find((u) => u.isActive && normalizeEmail(u.email) === normCloudEmail) ??
    users.find((u) => u.isActive && u.role === 'admin') ??
    users.find((u) => u.isActive) ??
    null;

  return { account: localAccount, ownerUser };
}

/**
 * Attaches a real-time Firestore `onSnapshot` listener on `/users/{uid}/accounts/{accountId}`
 * so changes pushed from another device are detected immediately.
 */
export function subscribeToCloudAccountChanges(
  uid: string,
  accountId: string,
  onUpdate: (cloudAcc: CloudAccountDoc) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  const path = `users/${uid}/accounts/${accountId}`;
  const ref = doc(firestoreDb, 'users', uid, 'accounts', accountId);
  return onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) return;
      const data = snap.data() as CloudAccountDoc;
      onUpdate({ ...data, accountId: snap.id });
    },
    (error) => {
      if (onError) onError(error);
      try {
        handleFirestoreError(error, OperationType.GET, path);
      } catch {
        // Logged via handleFirestoreError; avoid crashing snapshot callback silently
      }
    }
  );
}
