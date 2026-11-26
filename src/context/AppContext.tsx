import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  db,
  normalizeSettings,
  switchActiveTenantDatabase,
} from '../db/database';
import {
  ensureLegacyAccountRegistered,
  listRegisteredAccounts,
} from '../db/accountsDb';
import { createBackupRecord } from '../db/operations';
import {
  AppSettings,
  AppUser,
  Customer,
  CustomerPayment,
  Language,
  Product,
  PurchaseInvoice,
  SaleInvoice,
  SectionId,
  Supplier,
  SupplierPayment,
  SupplierReturn,
  TenantAccount,
} from '../types';
import { verifyPassword } from '../utils/crypto';
import { canAccessSection } from '../utils/permissions';

const LAST_ACCOUNT_KEY = 'rmpos_last_account_id_v1';

export type PrintableDocument =
  | { type: 'sale_invoice'; invoice: SaleInvoice; format?: 'a4' | '80mm' | '58mm' }
  | { type: 'purchase_invoice'; invoice: PurchaseInvoice; format?: 'a4' | '80mm' | '58mm' }
  | { type: 'customer_payment'; payment: CustomerPayment; format?: 'a4' | '80mm' | '58mm' }
  | { type: 'supplier_payment'; payment: SupplierPayment; format?: 'a4' | '80mm' | '58mm' }
  | { type: 'supplier_return'; ret: SupplierReturn }
  | {
      type: 'customer_statement';
      customer: Customer;
      invoices: SaleInvoice[];
      payments: CustomerPayment[];
    }
  | {
      type: 'supplier_statement';
      supplier: Supplier;
      purchases: PurchaseInvoice[];
      payments: SupplierPayment[];
      returns: SupplierReturn[];
    }
  | { type: 'barcode_labels'; products: { product: Product; copies: number }[] }
  | {
      type: 'generic_report';
      title: string;
      subtitle: string;
      columns: string[];
      rows: (string | number)[][];
      summaryItems?: { label: string; value: string }[];
    };

export interface ToastMessage {
  id: number;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
}

export interface StoragePersistenceInfo {
  supported: boolean;
  persisted: boolean;
  usageBytes: number;
  quotaBytes: number;
}

interface DeleteGuardRequest {
  title: string;
  description: string;
  requirePassword: boolean;
  onConfirm: () => Promise<void> | void;
}

interface AppContextValue {
  ready: boolean;
  needsFirstRunSetup: boolean;
  setNeedsFirstRunSetup: (needs: boolean) => void;
  accounts: TenantAccount[];
  activeAccount: TenantAccount | null;
  authPortalMode: 'login' | 'register';
  setAuthPortalMode: (mode: 'login' | 'register') => void;
  refreshAccounts: () => Promise<TenantAccount[]>;
  activateAccountSession: (
    account: TenantAccount,
    user: AppUser,
    backupPassphrase?: string | null
  ) => Promise<void>;
  signOutAccount: (mode?: 'login' | 'register') => void;
  lang: Language;
  setLang: (lang: Language) => void;
  activeSection: SectionId;
  setActiveSection: (sec: SectionId) => void;
  settings: AppSettings;
  currentUser: AppUser | null;
  setCurrentUser: (u: AppUser | null) => void;
  isLocked: boolean;
  setIsLocked: (locked: boolean) => void;
  notify: (message: string, type?: ToastMessage['type']) => void;
  toasts: ToastMessage[];
  dismissToast: (id: number) => void;
  printDoc: PrintableDocument | null;
  openPrint: (doc: PrintableDocument) => void;
  closePrint: () => void;
  requestGuardedAction: (req: {
    title: string;
    description: string;
    isSensitiveDelete?: boolean;
    isFinancialConfirm?: boolean;
    onConfirm: () => Promise<void> | void;
  }) => void;
  guardRequest: DeleteGuardRequest | null;
  closeGuard: () => void;
  verifyDeletePassword: (password: string) => Promise<boolean>;
  storageInfo: StoragePersistenceInfo;
  requestPersistentStorage: () => Promise<boolean>;
  runAutoBackupNow: (silent?: boolean) => Promise<boolean>;
  hasSessionBackupPassphrase: boolean;
  getSessionBackupPassphrase: () => string | null;
  setSessionBackupPassphrase: (pass: string | null) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

async function syncOverdueInstallmentsInActiveDb(): Promise<void> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const openInsts = await db.installments.toArray();
  const overdueIds = openInsts
    .filter(
      (i) =>
        i.id &&
        i.remainingAmount > 0.005 &&
        i.status !== 'overdue' &&
        i.dueDate < todayIso
    )
    .map((i) => i.id!);
  if (overdueIds.length > 0) {
    await Promise.all(
      overdueIds.map((id) => db.installments.update(id, { status: 'overdue' }))
    );
  }
}

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [ready, setReady] = useState(false);
  const [needsFirstRunSetup, setNeedsFirstRunSetup] = useState(false);
  const [accounts, setAccounts] = useState<TenantAccount[]>([]);
  const [activeAccount, setActiveAccount] = useState<TenantAccount | null>(null);
  const [authPortalMode, setAuthPortalMode] = useState<'login' | 'register'>('login');
  const [lang, setLangState] = useState<Language>('ar');
  const [activeSection, setActiveSectionState] = useState<SectionId>('home');
  const [currentUser, setCurrentUserState] = useState<AppUser | null>(null);
  const [isLocked, setIsLockedState] = useState(true);
  const [hasSessionBackupPassphrase, setHasSessionBackupPassphrase] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [printDoc, setPrintDoc] = useState<PrintableDocument | null>(null);
  const [guardRequest, setGuardRequest] = useState<DeleteGuardRequest | null>(null);
  const [storageInfo, setStorageInfo] = useState<StoragePersistenceInfo>({
    supported: typeof navigator !== 'undefined' && Boolean(navigator.storage?.persist),
    persisted: false,
    usageBytes: 0,
    quotaBytes: 0,
  });

  const idleTimerRef = useRef<number | null>(null);
  const runningAutoBackupRef = useRef(false);
  // Keep backup encryption passphrase in memory ONLY — never persisted to disk/localStorage
  const sessionBackupPassphraseRef = useRef<string | null>(null);

  const setSessionBackupPassphrase = useCallback((pass: string | null) => {
    const clean = pass && pass.trim().length > 0 ? pass.trim() : null;
    sessionBackupPassphraseRef.current = clean;
    setHasSessionBackupPassphrase(Boolean(clean));
  }, []);

  const getSessionBackupPassphrase = useCallback(() => sessionBackupPassphraseRef.current, []);

  const setIsLocked = useCallback((locked: boolean) => {
    setIsLockedState(locked);
    if (locked) {
      sessionBackupPassphraseRef.current = null;
      setHasSessionBackupPassphrase(false);
    }
  }, []);

  const refreshAccounts = useCallback(async (): Promise<TenantAccount[]> => {
    const list = await listRegisteredAccounts();
    setAccounts(list);
    return list;
  }, []);

  const liveSettings = useLiveQuery(
    async () => (activeAccount ? await db.settings.get(1) : undefined),
    [activeAccount?.accountId, ready]
  );
  const settings = React.useMemo(() => normalizeSettings(liveSettings), [liveSettings]);

  const notify = useCallback((message: string, type: ToastMessage['type'] = 'success') => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((prev) => [...prev.slice(-3), { id, type, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 3800);
  }, []);

  const refreshStorageEstimate = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.storage) return;
    try {
      const persisted = navigator.storage.persisted
        ? await navigator.storage.persisted()
        : false;
      const estimate = navigator.storage.estimate ? await navigator.storage.estimate() : {};
      setStorageInfo({
        supported: Boolean(navigator.storage.persist),
        persisted,
        usageBytes: estimate.usage ?? 0,
        quotaBytes: estimate.quota ?? 0,
      });
    } catch {
      // Ignore browser storage estimation restrictions
    }
  }, []);

  const requestPersistentStorage = useCallback(async (): Promise<boolean> => {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
      return false;
    }
    try {
      const granted = await navigator.storage.persist();
      await refreshStorageEstimate();
      return granted;
    } catch {
      return false;
    }
  }, [refreshStorageEstimate]);

  // Boot multi-tenant accounts registry, migrate legacy DB if present, and request persistent storage
  useEffect(() => {
    let active = true;
    (async () => {
      await ensureLegacyAccountRegistered();
      const registered = await listRegisteredAccounts();
      if (!active) return;

      setAccounts(registered);

      // Request persistent storage automatically so browsers are less likely to evict IndexedDB
      if (typeof navigator !== 'undefined' && navigator.storage) {
        try {
          const alreadyPersisted = navigator.storage.persisted
            ? await navigator.storage.persisted()
            : false;
          if (!alreadyPersisted && navigator.storage.persist) {
            await navigator.storage.persist();
          }
        } catch {
          // Non-fatal if browser denies persist()
        }
        await refreshStorageEstimate();
      }

      if (registered.length === 0) {
        setNeedsFirstRunSetup(true);
        setAuthPortalMode('register');
        setActiveAccount(null);
        setCurrentUserState(null);
        setIsLockedState(true);
      } else {
        let savedLastId: string | null = null;
        try {
          savedLastId = window.localStorage.getItem(LAST_ACCOUNT_KEY);
        } catch {
          savedLastId = null;
        }
        const preferred =
          registered.find((a) => a.accountId === savedLastId) ?? registered[0];
        await switchActiveTenantDatabase(preferred.dbName);
        if (!active) return;

        const savedSettings = await db.settings.get(1);
        if (savedSettings?.storeInfo.defaultLanguage) {
          setLangState(savedSettings.storeInfo.defaultLanguage);
        }
        await syncOverdueInstallmentsInActiveDb();

        setActiveAccount(preferred);
        setNeedsFirstRunSetup(false);
        setAuthPortalMode('login');
        // Never auto-login; require explicit authentication on startup
        setCurrentUserState(null);
        setIsLockedState(true);
      }

      setReady(true);
    })();
    return () => {
      active = false;
    };
  }, [refreshStorageEstimate]);

  const activateAccountSession = useCallback(
    async (account: TenantAccount, user: AppUser, backupPassphrase?: string | null) => {
      await switchActiveTenantDatabase(account.dbName);
      await syncOverdueInstallmentsInActiveDb();
      const savedSettings = await db.settings.get(1);
      if (savedSettings?.storeInfo.defaultLanguage) {
        setLangState(savedSettings.storeInfo.defaultLanguage);
      }
      try {
        window.localStorage.setItem(LAST_ACCOUNT_KEY, account.accountId);
      } catch {
        // Ignore storage errors
      }
      const latestAccounts = await listRegisteredAccounts();
      setAccounts(latestAccounts);
      const freshAccount =
        latestAccounts.find((a) => a.accountId === account.accountId) ?? account;
      setActiveAccount(freshAccount);
      setNeedsFirstRunSetup(false);
      setAuthPortalMode('login');
      if (backupPassphrase !== undefined) {
        setSessionBackupPassphrase(backupPassphrase);
      }
      setCurrentUserState(user);
      setActiveSectionState(canAccessSection(user, 'home') ? 'home' : 'pos');
      setIsLockedState(false);
    },
    [setSessionBackupPassphrase]
  );

  const signOutAccount = useCallback((mode: 'login' | 'register' = 'login') => {
    sessionBackupPassphraseRef.current = null;
    setHasSessionBackupPassphrase(false);
    setCurrentUserState(null);
    setActiveAccount(null);
    setActiveSectionState('home');
    setAuthPortalMode(mode);
    setIsLockedState(true);
  }, []);

  // Real Automatic External Backup Scheduler (checks on startup + every 5 minutes)
  const runAutoBackupNow = useCallback(
    async (silent = false): Promise<boolean> => {
      if (runningAutoBackupRef.current) return false;
      if (!currentUser || !activeAccount || isLocked || needsFirstRunSetup) return false;

      runningAutoBackupRef.current = true;
      try {
        const latestSettings = normalizeSettings(await db.settings.get(1));
        const pass = sessionBackupPassphraseRef.current;
        if (latestSettings.backupConfig.encryptBackupsDefault && !pass) {
          if (!silent) {
            notify(
              lang === 'ar'
                ? 'التشفير مفعّل افتراضياً — أدخل كلمة مرور النسخ الاحتياطي في الإعدادات أولاً'
                : 'Le chiffrement est actif par défaut — définissez un mot de passe de sauvegarde dans Paramètres',
              'warning'
            );
          }
          return false;
        }

        const now = new Date();
        const label = `نسخة تلقائية (${activeAccount.storeName}) — ${now.toLocaleDateString('ar-MA')} ${now.toLocaleTimeString('ar-MA', { hour: '2-digit', minute: '2-digit' })}`;
        const res = await createBackupRecord('auto', label, pass, currentUser, {
          allowUnencryptedFallback: !latestSettings.backupConfig.encryptBackupsDefault,
        });
        await refreshStorageEstimate();
        if (!silent) {
          const where =
            res.storageLocation === 'directory'
              ? lang === 'ar'
                ? `في المجلد الخارجي (${res.folderName || ''})`
                : `dans le dossier externe (${res.folderName || ''})`
              : res.storageLocation === 'download'
                ? lang === 'ar'
                  ? 'وتم تنزيل الملف اليومي'
                  : 'et téléchargée localement'
                : '';
          notify(
            lang === 'ar'
              ? `تم إنشاء نسخة احتياطية تلقائية${res.encrypted ? ' مشفرة' : ''} ${where}`
              : `Sauvegarde automatique${res.encrypted ? ' chiffrée' : ''} créée ${where}`,
            'info'
          );
        }
        return true;
      } catch (err) {
        if (!silent) {
          notify((err as Error).message, 'error');
        }
        return false;
      } finally {
        runningAutoBackupRef.current = false;
      }
    },
    [currentUser, activeAccount, isLocked, needsFirstRunSetup, lang, notify, refreshStorageEstimate]
  );

  useEffect(() => {
    if (
      !ready ||
      needsFirstRunSetup ||
      isLocked ||
      !currentUser ||
      !activeAccount ||
      !settings.backupConfig.autoBackupEnabled
    ) {
      return;
    }

    const checkAndRunAutoBackup = async () => {
      const latestSettings = await db.settings.get(1);
      const cfg = latestSettings?.backupConfig;
      if (!cfg?.autoBackupEnabled) return;

      const intervalMs = Math.max(1, cfg.autoBackupIntervalHours || 24) * 60 * 60 * 1000;
      const lastTs = cfg.lastAutoBackupAt ? new Date(cfg.lastAutoBackupAt).getTime() : 0;
      const isDue = !lastTs || Number.isNaN(lastTs) || Date.now() - lastTs >= intervalMs;
      if (isDue) {
        await runAutoBackupNow(true);
      }
    };

    const startupTimeout = window.setTimeout(() => {
      checkAndRunAutoBackup();
    }, 2500);
    const intervalId = window.setInterval(() => {
      checkAndRunAutoBackup();
    }, 5 * 60 * 1000);

    return () => {
      window.clearTimeout(startupTimeout);
      window.clearInterval(intervalId);
    };
  }, [
    ready,
    needsFirstRunSetup,
    isLocked,
    currentUser,
    activeAccount,
    settings.backupConfig.autoBackupEnabled,
    settings.backupConfig.autoBackupIntervalHours,
    runAutoBackupNow,
  ]);

  // Sync HTML lang & dir (RTL Arabic / LTR French)
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);

  // Auto-lock after idle minutes if configured in Security
  useEffect(() => {
    const minutes = settings.security.autoLockMinutes;
    if (!minutes || minutes <= 0 || isLocked || !activeAccount) return;

    const resetTimer = () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => {
        setIsLocked(true);
        if (currentUser) {
          db.loginLogs.add({
            date: new Date().toISOString(),
            username: currentUser.username,
            status: 'locked',
            details: `قفل تلقائي بعد ${minutes} دقيقة من الخمول`,
          });
        }
      }, minutes * 60 * 1000);
    };

    const events = ['mousemove', 'keydown', 'click', 'touchstart'];
    events.forEach((ev) => window.addEventListener(ev, resetTimer, { passive: true }));
    resetTimer();
    return () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      events.forEach((ev) => window.removeEventListener(ev, resetTimer));
    };
  }, [settings.security.autoLockMinutes, isLocked, currentUser, activeAccount, setIsLocked]);

  const setActiveSection = useCallback(
    (sec: SectionId) => {
      if (currentUser && !canAccessSection(currentUser, sec)) {
        notify(
          lang === 'ar'
            ? 'ليس لديك صلاحية الوصول إلى هذا القسم'
            : 'Vous n’avez pas la permission d’accéder à cette section',
          'warning'
        );
        return;
      }
      setActiveSectionState(sec);
    },
    [currentUser, lang, notify]
  );

  const setCurrentUser = useCallback((u: AppUser | null) => {
    setCurrentUserState(u);
    if (u) {
      setActiveSectionState((prev) => (canAccessSection(u, prev) ? prev : 'home'));
    }
  }, []);

  const setLang = useCallback((next: Language) => {
    setLangState(next);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const openPrint = useCallback((doc: PrintableDocument) => {
    setPrintDoc(doc);
  }, []);

  const closePrint = useCallback(() => {
    setPrintDoc(null);
  }, []);

  const requestGuardedAction = useCallback(
    (req: {
      title: string;
      description: string;
      isSensitiveDelete?: boolean;
      isFinancialConfirm?: boolean;
      onConfirm: () => Promise<void> | void;
    }) => {
      const needsDeletePwd =
        Boolean(req.isSensitiveDelete) &&
        settings.security.requireDeletePassword &&
        Boolean(settings.security.deletePasswordHash);
      const needsModal =
        needsDeletePwd ||
        Boolean(req.isSensitiveDelete) ||
        (Boolean(req.isFinancialConfirm) && settings.security.requireFinancialConfirm);

      if (!needsModal) {
        Promise.resolve(req.onConfirm()).catch((err: Error) => notify(err.message, 'error'));
        return;
      }

      setGuardRequest({
        title: req.title,
        description: req.description,
        requirePassword: needsDeletePwd,
        onConfirm: req.onConfirm,
      });
    },
    [settings.security, notify]
  );

  const closeGuard = useCallback(() => setGuardRequest(null), []);

  const verifyDeletePassword = useCallback(
    async (password: string): Promise<boolean> => {
      if (!settings.security.deletePasswordHash) return true;
      return verifyPassword(
        password,
        settings.security.deletePasswordSalt,
        settings.security.deletePasswordHash
      );
    },
    [settings.security]
  );

  return (
    <AppContext.Provider
      value={{
        ready,
        needsFirstRunSetup,
        setNeedsFirstRunSetup,
        accounts,
        activeAccount,
        authPortalMode,
        setAuthPortalMode,
        refreshAccounts,
        activateAccountSession,
        signOutAccount,
        lang,
        setLang,
        activeSection,
        setActiveSection,
        settings,
        currentUser,
        setCurrentUser,
        isLocked,
        setIsLocked,
        notify,
        toasts,
        dismissToast,
        printDoc,
        openPrint,
        closePrint,
        requestGuardedAction,
        guardRequest,
        closeGuard,
        verifyDeletePassword,
        storageInfo,
        requestPersistentStorage,
        runAutoBackupNow,
        hasSessionBackupPassphrase,
        getSessionBackupPassphrase,
        setSessionBackupPassphrase,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
