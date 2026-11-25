import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Database,
  Download,
  FileText,
  HardDrive,
  Image as ImageIcon,
  Inbox,
  LayoutTemplate,
  Lock,
  PanelBottom,
  PanelTop,
  Plug,
  Printer,
  RefreshCw,
  RotateCcw,
  Save,
  Shield,
  Store,
  Trash2,
  Upload,
  UserPlus,
} from 'lucide-react';
import {
  ADMIN_PERMISSIONS,
  CASHIER_PERMISSIONS,
  createDefaultSettings,
  db,
  MANAGER_PERMISSIONS,
} from '../db/database';
import {
  clearBusinessDataForFreshStart,
  createBackupRecord,
  exportDatabaseSnapshot,
  logAudit,
  restoreCancelledSaleInvoice,
  restoreDatabaseFromEnvelope,
  updateSettingsSection,
} from '../db/operations';
import { useApp } from '../context/AppContext';
import { DEFAULT_INVOICE_LOGO, InvoicePreviewContent } from '../components/InvoicePreviewContent';
import {
  AppUser,
  CashDrawerMode,
  InvoiceAlign,
  InvoiceBorderStyle,
  InvoiceFormatConfig,
  InvoiceLogoShape,
  InvoiceSurfaceBg,
  Language,
  SaleInvoice,
  UserRole,
} from '../types';
import {
  getPairedSerialPortsCount,
  isWebSerialSupported,
  openCashDrawer,
  pairCashDrawerSerialPort,
} from '../utils/cashDrawer';
import { generateSalt, hashPassword } from '../utils/crypto';
import { downloadTextFile } from '../utils/export';
import { PERMISSION_LABELS, PermissionKey } from '../utils/permissions';
import { formatDateTime, t } from '../i18n/translations';

export type SettingsTabId = 'security' | 'store' | 'printing' | 'invoice' | 'backup';

interface SettingsModuleProps {
  activeTab?: SettingsTabId;
  onTabChange?: (tab: SettingsTabId) => void;
}

export const SettingsModule: React.FC<SettingsModuleProps> = ({
  activeTab: controlledTab,
  onTabChange,
}) => {
  const {
    lang,
    setLang,
    settings,
    currentUser,
    notify,
    openPrint,
    requestGuardedAction,
    setIsLocked,
    storageInfo,
    requestPersistentStorage,
    runAutoBackupNow,
  } = useApp();

  const [internalTab, setInternalTab] = useState<SettingsTabId>('security');
  const subTab = controlledTab ?? internalTab;
  const setSubTab = (tab: SettingsTabId) => {
    if (onTabChange) onTabChange(tab);
    else setInternalTab(tab);
  };

  const users = useLiveQuery(() => db.users.toArray(), []) ?? [];
  const auditLogs = useLiveQuery(() => db.auditLogs.orderBy('date').reverse().limit(80).toArray(), []) ?? [];
  const loginLogs = useLiveQuery(() => db.loginLogs.orderBy('date').reverse().limit(50).toArray(), []) ?? [];
  const backups = useLiveQuery(() => db.backups.orderBy('date').reverse().toArray(), []) ?? [];
  const latestSale = useLiveQuery(() => db.saleInvoices.orderBy('date').reverse().first(), []);

  // 12.1 Security form states
  const [newLoginPwd, setNewLoginPwd] = useState('');
  const [newDeletePwd, setNewDeletePwd] = useState('');
  const [expandedUserId, setExpandedUserId] = useState<number | null>(null);
  const [newUserForm, setNewUserForm] = useState({
    username: '',
    fullName: '',
    role: 'cashier' as UserRole,
    password: '',
  });

  // 12.2 Store form state
  const [storeForm, setStoreForm] = useState(settings.storeInfo);
  const [posForm, setPosForm] = useState(settings.posConfig);
  React.useEffect(() => {
    setStoreForm(settings.storeInfo);
    setPosForm(settings.posConfig);
  }, [settings]);

  // 12.3 Printing & Cash Drawer state
  const [printForm, setPrintForm] = useState(settings.printing);
  const [pairedDrawerPorts, setPairedDrawerPorts] = useState<number>(0);
  const [drawerBusy, setDrawerBusy] = useState<boolean>(false);
  const serialSupported = isWebSerialSupported();
  React.useEffect(() => {
    setPrintForm(settings.printing);
  }, [settings.printing]);
  React.useEffect(() => {
    getPairedSerialPortsCount().then(setPairedDrawerPorts).catch(() => setPairedDrawerPorts(0));
  }, [subTab]);

  // 12.4 Invoice customization state
  const [invConfigTab, setInvConfigTab] = useState<'a4' | 'thermal'>('thermal');
  const [invEditorPane, setInvEditorPane] = useState<'header' | 'logo' | 'footer' | 'layout'>('header');
  const [thermalPreviewSize, setThermalPreviewSize] = useState<'80mm' | '58mm'>(
    settings.printing.salesFormat === '58mm' ? '58mm' : '80mm'
  );
  const [invForm, setInvForm] = useState(settings.invoiceCustomization);
  React.useEffect(() => {
    setInvForm(settings.invoiceCustomization);
  }, [settings.invoiceCustomization]);

  // 12.5 Backup state
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [backupLabel, setBackupLabel] = useState('');

  const previewSampleInvoice: SaleInvoice = useMemo(() => {
    if (latestSale) return latestSale;
    return {
      invoiceNumber: `${settings.storeInfo.salePrefix}-${settings.storeInfo.saleNextNumber}`,
      date: new Date().toISOString(),
      customerId: 2,
      customerName: 'أحمد الإدريسي',
      sellerId: 1,
      sellerName: currentUser?.fullName ?? 'المدير',
      items: [
        {
          productId: 1,
          productName: 'زيت المائدة لوسيور 2 لتر',
          barcode: '6111035000101',
          unit: 'قنينة',
          quantity: 2,
          unitPrice: 37,
          costPrice: 31.5,
          discount: 0,
          total: 74,
        },
        {
          productId: 2,
          productName: 'حليب سنطرال 1 لتر',
          barcode: '6111035000202',
          unit: 'علبة',
          quantity: 3,
          unitPrice: 10,
          costPrice: 8.4,
          discount: 0,
          total: 30,
        },
      ],
      subtotal: 104,
      discountType: 'fixed',
      discountValue: 4,
      discountAmount: 4,
      taxRate: 0,
      taxAmount: 0,
      total: 100,
      paidAmount: 100,
      remainingAmount: 0,
      changeGiven: 0,
      paymentMethod: 'cash',
      paymentSplits: [{ method: 'cash', amount: 100 }],
      status: 'paid',
      isCredit: false,
      idempotencyKey: 'preview',
    };
  }, [latestSale, settings.storeInfo, currentUser]);

  // 12.1 Handlers
  const handleChangeLoginPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser?.id || newLoginPwd.length < 4) {
      notify(t(lang, 'كلمة السر يجب أن لا تقل عن 4 أحرف', 'Minimum 4 caractères'), 'warning');
      return;
    }
    const salt = generateSalt();
    const hash = await hashPassword(newLoginPwd, salt);
    await db.users.update(currentUser.id, { passwordHash: hash, passwordSalt: salt });
    await logAudit(currentUser, 'PASSWORD_CHANGED', 'user', currentUser.id, 'تغيير كلمة سر الدخول');
    setNewLoginPwd('');
    notify(t(lang, 'تم تحديث كلمة سر الدخول بأمان (PBKDF2)', 'Mot de passe mis à jour'));
  };

  const handleSetDeletePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser || newDeletePwd.length < 4) {
      notify(t(lang, 'كلمة سر الحذف يجب أن لا تقل عن 4 أحرف', 'Minimum 4 caractères'), 'warning');
      return;
    }
    const salt = generateSalt();
    const hash = await hashPassword(newDeletePwd, salt);
    await updateSettingsSection(
      (cur) => ({
        ...cur,
        security: {
          ...cur.security,
          requireDeletePassword: true,
          deletePasswordHash: hash,
          deletePasswordSalt: salt,
        },
      }),
      currentUser,
      'تعيين كلمة سر خاصة بعمليات الحذف'
    );
    setNewDeletePwd('');
    notify(t(lang, 'تم تعيين وتفعيل كلمة سر الحذف', 'Mot de passe de suppression activé'));
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser || !newUserForm.username.trim() || newUserForm.password.length < 4) return;
    const exists = await db.users.where('username').equals(newUserForm.username.trim()).first();
    if (exists) {
      notify(t(lang, 'اسم المستخدم موجود مسبقاً', 'Nom d’utilisateur déjà pris'), 'error');
      return;
    }
    const salt = generateSalt();
    const hash = await hashPassword(newUserForm.password, salt);
    const perms =
      newUserForm.role === 'admin'
        ? ADMIN_PERMISSIONS
        : newUserForm.role === 'manager'
          ? MANAGER_PERMISSIONS
          : CASHIER_PERMISSIONS;
    const id = await db.users.add({
      username: newUserForm.username.trim(),
      fullName: newUserForm.fullName.trim() || newUserForm.username.trim(),
      role: newUserForm.role,
      passwordHash: hash,
      passwordSalt: salt,
      permissions: perms,
      isActive: true,
      createdAt: new Date().toISOString(),
    });
    await logAudit(currentUser, 'USER_CREATED', 'user', id, `إنشاء مستخدم جديد: ${newUserForm.username} (${newUserForm.role})`);
    setNewUserForm({ username: '', fullName: '', role: 'cashier', password: '' });
    notify(t(lang, 'تمت إضافة المستخدم بنجاح', 'Utilisateur créé'));
  };

  const toggleUserActive = async (u: AppUser) => {
    if (u.username === 'admin') return;
    await db.users.update(u.id!, { isActive: !u.isActive });
    if (currentUser) {
      await logAudit(currentUser, 'USER_TOGGLED', 'user', u.id!, `تغيير حالة المستخدم ${u.username}`);
    }
  };

  const handleToggleUserPermission = async (u: AppUser, key: PermissionKey) => {
    if (u.username === 'admin' || !currentUser) return;
    const nextPerms = { ...u.permissions, [key]: !u.permissions[key] };
    await db.users.update(u.id!, { permissions: nextPerms });
    await logAudit(
      currentUser,
      'USER_PERMISSIONS_UPDATED',
      'user',
      u.id!,
      `تعديل صلاحية ${key} للمستخدم ${u.username} إلى ${nextPerms[key] ? 'مفعل' : 'معطل'}`
    );
  };

  const handleRestoreCancelled = async (entityId: string, auditLogId: number) => {
    if (!currentUser?.permissions.canRestoreCancelled) {
      notify(t(lang, 'ليس لديك صلاحية استعادة العمليات الملغاة', 'Permission refusée'), 'error');
      return;
    }
    try {
      await restoreCancelledSaleInvoice(Number(entityId), auditLogId, currentUser);
      notify(t(lang, 'تمت استعادة الفاتورة الملغاة وتحديث المخزون', 'Facture annulée restaurée'));
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  // 12.2 Store Save
  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setStoreForm((prev) => ({ ...prev, logoDataUrl: reader.result as string }));
      }
    };
    reader.readAsDataURL(f);
  };

  const handleSaveStore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    await updateSettingsSection(
      (cur) => ({ ...cur, storeInfo: storeForm, posConfig: posForm }),
      currentUser,
      'تحديث بيانات السوبر مارشي وإعدادات نقطة البيع'
    );
    setLang(storeForm.defaultLanguage);
    notify(t(lang, 'تم حفظ بيانات المتجر بنجاح', 'Informations enregistrées'));
  };

  // 12.3 Printing Save, Instant Paper Size Apply & Test
  const handleSelectSalesPaperFormat = async (nextFormat: 'a4' | '80mm' | '58mm') => {
    const updated = { ...printForm, salesFormat: nextFormat };
    setPrintForm(updated);
    if (nextFormat === '58mm' || nextFormat === '80mm') {
      setThermalPreviewSize(nextFormat);
    }
    if (!currentUser) return;
    await updateSettingsSection(
      (cur) => ({ ...cur, printing: { ...cur.printing, salesFormat: nextFormat } }),
      currentUser,
      `تعيين حجم ورقة الطباعة لفواتير المبيعات: ${nextFormat.toUpperCase()}`
    );
    notify(
      t(
        lang,
        `تم اعتماد حجم الورق ${nextFormat.toUpperCase()} — سيُطبق تلقائياً عند طباعة الفواتير في المبيعات`,
        `Format ${nextFormat.toUpperCase()} activé — appliqué automatiquement aux factures de vente`
      )
    );
  };

  const handleSavePrinting = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    await updateSettingsSection(
      (cur) => ({ ...cur, printing: printForm }),
      currentUser,
      'تحديث إعدادات الطباعة والطابعات'
    );
    notify(t(lang, 'تم حفظ إعدادات الطباعة وتطبيقها تلقائياً', 'Paramètres d’impression enregistrés et appliqués'));
  };

  const handleTestPrinter = async () => {
    openPrint({ type: 'sale_invoice', invoice: previewSampleInvoice, format: printForm.salesFormat });
  };

  const handlePairCashDrawer = async () => {
    setDrawerBusy(true);
    try {
      const res = await pairCashDrawerSerialPort();
      const count = await getPairedSerialPortsCount();
      setPairedDrawerPorts(count);
      notify(lang === 'ar' ? res.messageAr : res.messageFr, res.ok ? 'success' : 'warning');
    } finally {
      setDrawerBusy(false);
    }
  };

  const handleTestCashDrawer = async () => {
    setDrawerBusy(true);
    try {
      const res = await openCashDrawer(printForm.cashDrawer, { promptPairIfNeeded: true });
      const count = await getPairedSerialPortsCount();
      setPairedDrawerPorts(count);
      if (res.ok && currentUser) {
        await logAudit(
          currentUser,
          'CASH_DRAWER_OPENED',
          'cashDrawer',
          'settings-test',
          `اختبار فتح درج النقدية (${res.mode})`
        );
      }
      notify(lang === 'ar' ? res.messageAr : res.messageFr, res.ok ? 'success' : 'error');
    } finally {
      setDrawerBusy(false);
    }
  };

  // 12.4 Invoice Customization Save & Reorder
  const activeFormatCfg: InvoiceFormatConfig =
    invConfigTab === 'a4' ? invForm.a4 : invForm.thermal;

  const updateFormatCfg = (patch: Partial<InvoiceFormatConfig>) => {
    setInvForm((prev) => ({
      ...prev,
      [invConfigTab]: { ...prev[invConfigTab], ...patch },
    }));
  };

  const moveSection = (index: number, dir: -1 | 1) => {
    const arr = [...activeFormatCfg.sectionOrder];
    const target = index + dir;
    if (target < 0 || target >= arr.length) return;
    [arr[index], arr[target]] = [arr[target], arr[index]];
    updateFormatCfg({ sectionOrder: arr });
  };

  const handleResetInvoiceFormat = () => {
    const defaults = createDefaultSettings().invoiceCustomization;
    setInvForm((prev) => ({
      ...prev,
      [invConfigTab]: defaults[invConfigTab],
    }));
    notify(
      t(
        lang,
        'تمت استعادة إعدادات التصميم الافتراضية — اضغط حفظ لتثبيتها',
        'Paramètres par défaut restaurés — cliquez sur Enregistrer'
      ),
      'info'
    );
  };

  const handleSaveInvoiceCustom = async () => {
    if (!currentUser) return;
    await updateSettingsSection(
      (cur) => ({
        ...cur,
        storeInfo: {
          ...cur.storeInfo,
          logoDataUrl: storeForm.logoDataUrl,
          extraInvoiceInfo: storeForm.extraInvoiceInfo,
        },
        invoiceCustomization: invForm,
      }),
      currentUser,
      'تخصيص تصميم وهيدر وفوتر ومقاسات شعار الفاتورة'
    );
    notify(t(lang, 'تم حفظ إعدادات الهيدر والفوتر ومقاسات الشعار بنجاح', 'Design, en-tête, pied de page et logo enregistrés'));
  };

  // 12.5 Backup & Restore Handlers
  const handleCreateManualBackup = async (downloadFile: boolean, useFolderPicker = false) => {
    if (!currentUser) return;
    try {
      const label =
        backupLabel.trim() ||
        `نسخة يدوية ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
      const res = await createBackupRecord(
        'manual',
        label,
        backupPassphrase.trim() || null,
        currentUser
      );
      const fileName = `matjarpro_backup_${new Date().toISOString().slice(0, 10)}${res.encrypted ? '.enc' : ''}.json`;

      if (useFolderPicker && 'showSaveFilePicker' in window) {
        try {
          const handle = await (
            window as unknown as {
              showSaveFilePicker: (opts: unknown) => Promise<{
                createWritable: () => Promise<{ write: (s: string) => Promise<void>; close: () => Promise<void> }>;
              }>;
            }
          ).showSaveFilePicker({ suggestedName: fileName });
          const writable = await handle.createWritable();
          await writable.write(res.envelope);
          await writable.close();
          await updateSettingsSection(
            (c) => ({ ...c, backupConfig: { ...c.backupConfig, lastExternalExportAt: new Date().toISOString() } }),
            currentUser,
            'تحديث تاريخ آخر تصدير خارجي للنسخة الاحتياطية'
          );
          notify(t(lang, 'تم حفظ النسخة الاحتياطية في المجلد الخارجي بنجاح', 'Sauvegarde enregistrée dans le dossier'));
          return;
        } catch {
          // User cancelled picker or sandbox fallback -> regular download
        }
      }

      if (downloadFile) {
        downloadTextFile(res.envelope, fileName);
        await updateSettingsSection(
          (c) => ({ ...c, backupConfig: { ...c.backupConfig, lastExternalExportAt: new Date().toISOString() } }),
          currentUser,
          'تصدير نسخة احتياطية كملف خارجي'
        );
      }
      setBackupLabel('');
      notify(
        t(
          lang,
          `تم إنشاء النسخة الاحتياطية (${(res.sizeBytes / 1024).toFixed(1)} KB${res.encrypted ? ' · مشفرة AES-256' : ''})`,
          `Sauvegarde créée (${(res.sizeBytes / 1024).toFixed(1)} KB)`
        )
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleRestoreFromFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentUser) return;
    try {
      const text = await file.text();
      await restoreDatabaseFromEnvelope(text, restorePassphrase.trim() || null, currentUser);
      notify(t(lang, 'تم التحقق من سلامة النسخة واستعادة قاعدة البيانات بنجاح', 'Base de données restaurée'));
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      e.target.value = '';
    }
  };

  const handleRestoreFromRecord = async (payloadJson: string) => {
    if (!currentUser) return;
    try {
      await restoreDatabaseFromEnvelope(payloadJson, restorePassphrase.trim() || null, currentUser);
      notify(t(lang, 'تمت استعادة النسخة الاحتياطية بنجاح', 'Sauvegarde restaurée'));
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleExportRawDb = async () => {
    const snap = await exportDatabaseSnapshot();
    downloadTextFile(
      snap.rawJson,
      `matjarpro_full_database_${new Date().toISOString().slice(0, 10)}.json`
    );
    if (currentUser) {
      await updateSettingsSection(
        (c) => ({ ...c, backupConfig: { ...c.backupConfig, lastExternalExportAt: new Date().toISOString() } }),
        currentUser,
        'تصدير نسخة كاملة JSON للخارج'
      );
    }
    notify(t(lang, 'تم تصدير نسخة كاملة من قاعدة البيانات', 'Base complète exportée'));
  };

  const handleFreshReset = () => {
    if (!currentUser) return;
    requestGuardedAction({
      title: t(lang, 'تصفير البيانات للبدء التجاري الفعلي', 'Réinitialiser la base pour démarrer'),
      description: t(
        lang,
        'سيتم مسح جميع المنتجات والفواتير والزبناء والموردين والبدء من الصفر (مع الاحتفاظ بحساب المدير وإعدادات المتجر). يُنصح بأخذ نسخة احتياطية أولاً.',
        'Toutes les transactions et fiches seront effacées (paramètres et compte admin conservés).'
      ),
      isSensitiveDelete: true,
      onConfirm: async () => {
        await clearBusinessDataForFreshStart(currentUser);
        notify(t(lang, 'تم تصفير قاعدة البيانات بنجاح', 'Base réinitialisée'));
      },
    });
  };

  const livePreviewSettings = {
    ...settings,
    storeInfo: storeForm,
    invoiceCustomization: invForm,
  };

  return (
    <div className="space-y-3">
      {/* Fallback sub-tabs if mounted standalone */}
      {!controlledTab && (
        <div className="flex flex-nowrap sm:flex-wrap items-center justify-start sm:justify-center gap-2 overflow-x-auto no-scrollbar pb-0.5">
          {(
            [
              { id: 'security', icon: Shield, ar: 'الأمان والصلاحيات', fr: 'Sécurité' },
              { id: 'store', icon: Store, ar: 'بيانات السوبر مارشي', fr: 'Magasin' },
              { id: 'printing', icon: Printer, ar: 'الطباعة', fr: 'Impression' },
              { id: 'invoice', icon: FileText, ar: 'تخصيص الفاتورة', fr: 'Factures' },
              { id: 'backup', icon: Database, ar: 'النسخ الاحتياطي', fr: 'Sauvegarde' },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSubTab(tab.id)}
                className={`inline-flex items-center gap-1.5 rounded-lg border-[1.5px] px-3.5 py-1.5 text-xs font-bold whitespace-nowrap transition-all ${
                  subTab === tab.id
                    ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A] shadow-sm'
                    : 'border-slate-900 bg-white text-slate-900 hover:bg-amber-50'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {lang === 'ar' ? tab.ar : tab.fr}
              </button>
            );
          })}
        </div>
      )}

      {/* 12.1 SECURITY */}
      {subTab === 'security' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-900">
                  {t(lang, 'كلمات السر والحماية', 'Mots de passe & Protection')}
                </h3>
                <button
                  type="button"
                  onClick={() => setIsLocked(true)}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  <Lock className="h-3.5 w-3.5" />
                  {t(lang, 'قفل التطبيق الآن', 'Verrouiller')}
                </button>
              </div>

              <form onSubmit={handleChangeLoginPassword} className="space-y-2 border-b border-slate-100 pb-4">
                <label className="block text-xs font-medium text-slate-700">
                  {t(lang, 'تغيير كلمة سر الدخول للحساب الحالي', 'Changer le mot de passe de connexion')}
                </label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    minLength={4}
                    value={newLoginPwd}
                    onChange={(e) => setNewLoginPwd(e.target.value)}
                    placeholder={t(lang, 'كلمة سر جديدة...', 'Nouveau mot de passe...')}
                    className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  />
                  <button
                    type="submit"
                    className="rounded-lg bg-teal-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-teal-800"
                  >
                    {t(lang, 'تحديث', 'Mettre à jour')}
                  </button>
                </div>
              </form>

              <form onSubmit={handleSetDeletePassword} className="space-y-2 border-b border-slate-100 pb-4">
                <label className="block text-xs font-medium text-slate-700">
                  {t(lang, 'تعيين كلمة سر خاصة بعمليات الحذف الحساسة', 'Mot de passe spécifique de suppression')}
                </label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    minLength={4}
                    value={newDeletePwd}
                    onChange={(e) => setNewDeletePwd(e.target.value)}
                    placeholder={t(lang, 'كلمة سر الحذف...', 'Mot de passe suppression...')}
                    className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs"
                  />
                  <button
                    type="submit"
                    className="rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                  >
                    {t(lang, 'تعيين', 'Définir')}
                  </button>
                </div>
              </form>

              <div className="space-y-2.5 text-xs">
                <label className="flex items-center justify-between cursor-pointer">
                  <span>{t(lang, 'طلب تسجيل الدخول عند فتح التطبيق', 'Exiger connexion au démarrage')}</span>
                  <input
                    type="checkbox"
                    checked={settings.security.requireLoginOnStartup}
                    onChange={(e) =>
                      currentUser &&
                      updateSettingsSection(
                        (c) => ({ ...c, security: { ...c.security, requireLoginOnStartup: e.target.checked } }),
                        currentUser,
                        'تغيير خيار طلب الدخول عند التشغيل'
                      )
                    }
                  />
                </label>
                <label className="flex items-center justify-between cursor-pointer">
                  <span>{t(lang, 'طلب كلمة سر الحذف عند حذف المنتجات/الزبناء/الموردين', 'Mot de passe requis pour suppression')}</span>
                  <input
                    type="checkbox"
                    checked={settings.security.requireDeletePassword}
                    onChange={(e) =>
                      currentUser &&
                      updateSettingsSection(
                        (c) => ({ ...c, security: { ...c.security, requireDeletePassword: e.target.checked } }),
                        currentUser,
                        'تبديل حماية كلمة سر الحذف'
                      )
                    }
                  />
                </label>
                <label className="flex items-center justify-between cursor-pointer">
                  <span>{t(lang, 'تفعيل تأكيد إضافي للعمليات المالية', 'Confirmation supplémentaire des opérations financières')}</span>
                  <input
                    type="checkbox"
                    checked={settings.security.requireFinancialConfirm}
                    onChange={(e) =>
                      currentUser &&
                      updateSettingsSection(
                        (c) => ({ ...c, security: { ...c.security, requireFinancialConfirm: e.target.checked } }),
                        currentUser,
                        'تبديل التأكيد المالي الإضافي'
                      )
                    }
                  />
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                  <div>
                    <label className="block text-slate-600 mb-1">
                      {t(lang, 'الحد الأقصى لمحاولات الدخول', 'Tentatives max')}
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={settings.security.maxLoginAttempts}
                      onChange={(e) =>
                        currentUser &&
                        updateSettingsSection(
                          (c) => ({ ...c, security: { ...c.security, maxLoginAttempts: Number(e.target.value) || 5 } }),
                          currentUser,
                          'تعديل عدد محاولات الدخول'
                        )
                      }
                      className="w-full rounded border border-slate-300 px-2.5 py-1.5 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-600 mb-1">
                      {t(lang, 'القفل التلقائي بعد خمول (دقائق / 0=معطل)', 'Verrouillage auto (min)')}
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="120"
                      value={settings.security.autoLockMinutes}
                      onChange={(e) =>
                        currentUser &&
                        updateSettingsSection(
                          (c) => ({ ...c, security: { ...c.security, autoLockMinutes: Number(e.target.value) || 0 } }),
                          currentUser,
                          'تعديل مدة القفل التلقائي'
                        )
                      }
                      className="w-full rounded border border-slate-300 px-2.5 py-1.5 font-mono"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Users & Permissions */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
              <h3 className="text-sm font-bold text-slate-900">
                {t(lang, 'إدارة المستخدمين والصلاحيات', 'Utilisateurs et permissions')}
              </h3>
              <form onSubmit={handleAddUser} className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  required
                  placeholder={t(lang, 'اسم المستخدم', 'Identifiant')}
                  value={newUserForm.username}
                  onChange={(e) => setNewUserForm({ ...newUserForm, username: e.target.value })}
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                />
                <input
                  required
                  placeholder={t(lang, 'الاسم الكامل', 'Nom complet')}
                  value={newUserForm.fullName}
                  onChange={(e) => setNewUserForm({ ...newUserForm, fullName: e.target.value })}
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                />
                <select
                  value={newUserForm.role}
                  onChange={(e) => setNewUserForm({ ...newUserForm, role: e.target.value as UserRole })}
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                >
                  <option value="cashier">{t(lang, 'بائع (نقطة البيع)', 'Caissier')}</option>
                  <option value="manager">{t(lang, 'مسير (المبيعات والمخزون)', 'Gérant')}</option>
                  <option value="admin">{t(lang, 'مدير عام (كامل الصلاحيات)', 'Administrateur')}</option>
                </select>
                <input
                  required
                  type="password"
                  minLength={4}
                  placeholder={t(lang, 'كلمة السر', 'Mot de passe')}
                  value={newUserForm.password}
                  onChange={(e) => setNewUserForm({ ...newUserForm, password: e.target.value })}
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                />
                <button
                  type="submit"
                  className="sm:col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-teal-700 py-2 text-xs font-semibold text-white hover:bg-teal-800"
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  {t(lang, 'إضافة مستخدم جديد', 'Ajouter utilisateur')}
                </button>
              </form>

              <div className="rounded-lg border border-amber-200 bg-amber-50/80 p-3 text-[11px] text-amber-950 space-y-1">
                <div className="font-bold flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-700" />
                  {t(lang, 'نطاق الحماية المحلية على المتصفح', 'Portée de la sécurité locale')}
                </div>
                <p className="leading-relaxed text-amber-900">
                  {t(
                    lang,
                    'تعمل الصلاحيات وكلمات السر محلياً لتنظيم أدوار البائعين ومنع التعديلات غير المصرح بها على جهاز الكاشير المشترك. يُنصح بتفعيل «طلب الدخول عند فتح التطبيق» وتغيير كلمة سر المدير الافتراضية فوراً.',
                    'Les rôles et mots de passe fonctionnent localement pour séparer les tâches sur un poste partagé. Activez la connexion au démarrage et changez le mot de passe admin par défaut.'
                  )}
                </p>
              </div>

              <div className="divide-y divide-slate-100 border-t border-slate-200">
                {users.map((u) => {
                  const isExpanded = expandedUserId === u.id;
                  const activePermCount = Object.values(u.permissions ?? {}).filter(Boolean).length;
                  return (
                    <div key={u.id} className="py-2.5 text-xs space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="font-semibold text-slate-900">{u.fullName}</div>
                          <div className="text-slate-500 font-mono text-[11px]">
                            @{u.username} · {u.role} · {activePermCount}/12 {t(lang, 'صلاحية', 'perms')}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {u.username !== 'admin' && (
                            <>
                              <button
                                type="button"
                                onClick={() => setExpandedUserId(isExpanded ? null : u.id!)}
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                              >
                                {t(lang, 'الصلاحيات', 'Droits')}
                                {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                              </button>
                              <button
                                type="button"
                                onClick={() => toggleUserActive(u)}
                                className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium ${
                                  u.isActive
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                                    : 'border-slate-200 bg-slate-100 text-slate-500'
                                }`}
                              >
                                {u.isActive ? t(lang, 'نشط', 'Actif') : t(lang, 'معطل', 'Inactif')}
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      {isExpanded && u.username !== 'admin' && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                          {(Object.keys(PERMISSION_LABELS) as PermissionKey[]).map((key) => (
                            <label
                              key={key}
                              className="flex items-center gap-2 text-[11px] text-slate-800 cursor-pointer hover:text-slate-950"
                            >
                              <input
                                type="checkbox"
                                checked={Boolean(u.permissions?.[key])}
                                onChange={() => handleToggleUserPermission(u, key)}
                              />
                              <span>{lang === 'ar' ? PERMISSION_LABELS[key].ar : PERMISSION_LABELS[key].fr}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Audit Log & Login Log */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-8 border-[1.5px] border-slate-900 bg-white overflow-hidden">
              <div className="bg-[#0B274D] text-[#FDE68A] px-3 py-2 text-xs font-extrabold">
                {t(lang, 'سجل التدقيق والعمليات (مع إمكانية استعادة العمليات الملغاة)', 'Journal d’audit & Restauration')}
              </div>
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#FCE08B] text-slate-950">
                      <th className="border border-slate-900 px-2 py-1.5 text-center font-extrabold">{t(lang, 'التاريخ', 'Date')}</th>
                      <th className="border border-slate-900 px-2 py-1.5 text-center font-extrabold">{t(lang, 'المستخدم', 'Utilisateur')}</th>
                      <th className="border border-slate-900 px-2 py-1.5 text-center font-extrabold">{t(lang, 'التفاصيل', 'Détails')}</th>
                      <th className="border border-slate-900 px-2 py-1.5 text-center font-extrabold w-[90px]">{t(lang, 'استعادة', 'Action')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-amber-50/50">
                        <td className="border border-slate-800/80 px-2 py-1.5 text-center font-mono text-[11px] tabular-nums text-slate-600 whitespace-nowrap">
                          {formatDateTime(log.date, lang)}
                        </td>
                        <td className="border border-slate-800/80 px-2 py-1.5 text-center font-bold text-slate-900">{log.userName}</td>
                        <td className="border border-slate-800/80 px-2.5 py-1.5 text-slate-800">{log.details}</td>
                        <td className="border border-slate-800/80 px-2 py-1 text-center">
                          {log.canRestore && !log.restored && log.entityType === 'saleInvoice' && (
                            <button
                              type="button"
                              onClick={() => handleRestoreCancelled(log.entityId, log.id!)}
                              className="inline-flex items-center gap-1 rounded border border-teal-700 bg-teal-50 px-2 py-0.5 text-[11px] font-bold text-teal-900 hover:bg-teal-100"
                            >
                              <RotateCcw className="h-3 w-3" />
                              {t(lang, 'استعادة', 'Restaurer')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="lg:col-span-4 rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="border-b border-slate-200 px-4 py-3 text-sm font-bold text-slate-900">
                {t(lang, 'سجل الدخول والخروج', 'Journal de connexion')}
              </div>
              <div className="max-h-72 overflow-y-auto divide-y divide-slate-100">
                {loginLogs.map((l) => (
                  <div key={l.id} className="p-3 text-xs">
                    <div className="flex justify-between">
                      <span className="font-mono font-semibold text-slate-900">{l.username}</span>
                      <span
                        className={
                          l.status === 'success'
                            ? 'text-emerald-700'
                            : l.status === 'failed' || l.status === 'locked'
                              ? 'text-red-700'
                              : 'text-slate-500'
                        }
                      >
                        {l.status}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {formatDateTime(l.date, lang)} · {l.details}
                    </div>
                  </div>
                ))}
                {loginLogs.length === 0 && (
                  <p className="p-6 text-center text-xs text-slate-400">
                    {t(lang, 'لا توجد سجلات دخول بعد', 'Aucun journal')}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 12.2 STORE INFORMATION */}
      {subTab === 'store' && (
        <form onSubmit={handleSaveStore} className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'اسم السوبر مارشي', 'Nom du magasin')}
              </label>
              <input
                required
                value={storeForm.storeName}
                onChange={(e) => setStoreForm({ ...storeForm, storeName: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'اسم المسؤول', 'Nom du responsable')}
              </label>
              <input
                value={storeForm.managerName}
                onChange={(e) => setStoreForm({ ...storeForm, managerName: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'النشاط التجاري', 'Activité')}
              </label>
              <input
                value={storeForm.activityInfo}
                onChange={(e) => setStoreForm({ ...storeForm, activityInfo: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'العنوان', 'Adresse')}
              </label>
              <input
                value={storeForm.address}
                onChange={(e) => setStoreForm({ ...storeForm, address: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'رقم الهاتف', 'Téléphone')}
              </label>
              <input
                value={storeForm.phone}
                onChange={(e) => setStoreForm({ ...storeForm, phone: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'البريد الإلكتروني', 'Email')}
              </label>
              <input
                value={storeForm.email}
                onChange={(e) => setStoreForm({ ...storeForm, email: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'المدينة / الدولة', 'Ville / Pays')}
              </label>
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={storeForm.city}
                  onChange={(e) => setStoreForm({ ...storeForm, city: e.target.value })}
                  className="rounded-lg border border-slate-300 px-2.5 py-2 text-xs"
                />
                <input
                  value={storeForm.country}
                  onChange={(e) => setStoreForm({ ...storeForm, country: e.target.value })}
                  className="rounded-lg border border-slate-300 px-2.5 py-2 text-xs"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'العملة الافتراضية', 'Devise par défaut')}
              </label>
              <input
                value={storeForm.currency}
                onChange={(e) => setStoreForm({ ...storeForm, currency: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'الرقم الضريبي (ICE / IF)', 'Identifiant fiscal')}
              </label>
              <input
                value={storeForm.taxId}
                onChange={(e) => setStoreForm({ ...storeForm, taxId: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'معلومات إضافية تظهر في الفواتير', 'Informations supplémentaires sur factures')}
              </label>
              <input
                value={storeForm.extraInvoiceInfo}
                onChange={(e) => setStoreForm({ ...storeForm, extraInvoiceInfo: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'شعار المتجر (Logo)', 'Logo du magasin')}
              </label>
              <div className="flex items-center gap-3">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium hover:bg-slate-50">
                  <Upload className="h-3.5 w-3.5" /> {t(lang, 'رفع شعار', 'Importer')}
                  <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
                </label>
                {storeForm.logoDataUrl && (
                  <img
                    src={storeForm.logoDataUrl}
                    alt="logo"
                    referrerPolicy="no-referrer"
                    className="h-10 w-10 rounded border object-contain"
                  />
                )}
              </div>
            </div>
          </div>

          {/* Language, Tax, Numbering, POS Negative Stock */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 border-t border-slate-200 pt-4 text-xs">
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                {t(lang, 'اللغة الافتراضية', 'Langue par défaut')}
              </label>
              <select
                value={storeForm.defaultLanguage}
                onChange={(e) =>
                  setStoreForm({ ...storeForm, defaultLanguage: e.target.value as Language })
                }
                className="w-full rounded-lg border border-slate-300 px-2.5 py-2"
              >
                <option value="ar">العربية (RTL)</option>
                <option value="fr">Français (LTR)</option>
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                {t(lang, 'الضريبة (TVA %)', 'TVA (%)')}
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={storeForm.taxEnabled}
                  onChange={(e) => setStoreForm({ ...storeForm, taxEnabled: e.target.checked })}
                />
                <input
                  type="number"
                  min="0"
                  max="50"
                  value={storeForm.defaultTaxRate}
                  onChange={(e) =>
                    setStoreForm({ ...storeForm, defaultTaxRate: Number(e.target.value) })
                  }
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono"
                />
              </div>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                {t(lang, 'بادئة وترقيم فواتير البيع', 'Préfixe & N° Ventes')}
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                <input
                  value={storeForm.salePrefix}
                  onChange={(e) => setStoreForm({ ...storeForm, salePrefix: e.target.value })}
                  className="rounded-lg border border-slate-300 px-2 py-1.5 font-mono"
                />
                <input
                  type="number"
                  min="1"
                  value={storeForm.saleNextNumber}
                  onChange={(e) =>
                    setStoreForm({ ...storeForm, saleNextNumber: Number(e.target.value) })
                  }
                  className="rounded-lg border border-slate-300 px-2 py-1.5 font-mono"
                />
              </div>
            </div>
            <div className="flex flex-col justify-center">
              <label className="inline-flex items-center gap-2 font-medium text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={posForm.allowNegativeStock}
                  onChange={(e) =>
                    setPosForm({ ...posForm, allowNegativeStock: e.target.checked })
                  }
                />
                {t(lang, 'السماح بالبيع بكميات غير متوفرة في المخزون', 'Autoriser vente stock négatif')}
              </label>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-5 py-2.5 text-xs font-semibold text-white hover:bg-teal-800"
            >
              <Save className="h-4 w-4" />
              {t(lang, 'حفظ بيانات السوبر مارشي', 'Enregistrer')}
            </button>
          </div>
        </form>
      )}

      {/* 12.3 PRINTING — Visual Paper Size Selection (A4, 80mm, 58mm) + Live Preview */}
      {subTab === 'printing' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <form
            onSubmit={handleSavePrinting}
            className="lg:col-span-7 rounded-xl border border-slate-200 bg-white p-6 space-y-5"
          >
            {/* Primary Sales Invoice Paper Size Cards */}
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    {t(lang, 'حجم ورقة الطباعة لفواتير المبيعات (POS)', 'Format papier des factures de vente (POS)')}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {t(
                      lang,
                      'يُطبق اختيارك تلقائياً وفوراً عند طباعة أي فاتورة من وحدة المبيعات',
                      'Votre sélection est appliquée automatiquement à chaque impression depuis le POS'
                    )}
                  </p>
                </div>
                <span className="font-mono text-xs font-bold text-teal-700">
                  {t(lang, 'المفعّل الآن:', 'Actif :')} {printForm.salesFormat.toUpperCase()}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {(
                  [
                    {
                      id: 'a4' as const,
                      title: 'A4',
                      dim: '210 × 297 mm',
                      descAr: 'فاتورة مكتبية كاملة بجدول تفصيلي وباركود',
                      descFr: 'Facture bureau complète avec détails',
                      wClass: 'w-12 h-16',
                    },
                    {
                      id: '80mm' as const,
                      title: '80mm',
                      dim: '80 mm × Roll',
                      descAr: 'تذكرة حرارية قياسية لطابعات الكاشير',
                      descFr: 'Ticket thermique standard caisse',
                      wClass: 'w-9 h-16',
                    },
                    {
                      id: '58mm' as const,
                      title: '58mm',
                      dim: '58 mm × Roll',
                      descAr: 'تذكرة حرارية مدمجة للطابعات المحمولة',
                      descFr: 'Ticket thermique compact / mobile',
                      wClass: 'w-6 h-16',
                    },
                  ] as const
                ).map((paper) => {
                  const selected = printForm.salesFormat === paper.id;
                  return (
                    <button
                      key={paper.id}
                      type="button"
                      onClick={() => handleSelectSalesPaperFormat(paper.id)}
                      className={`relative flex flex-col items-center gap-2 rounded-xl border-2 p-4 text-center transition-all ${
                        selected
                          ? 'border-teal-700 bg-teal-50/70 shadow-sm'
                          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      {selected && (
                        <span className="absolute top-2.5 end-2.5 flex h-5 w-5 items-center justify-center rounded-full bg-teal-700 text-white">
                          <Check className="h-3 w-3" />
                        </span>
                      )}
                      {/* Proportional Paper Silhouette */}
                      <div
                        className={`${paper.wClass} rounded border-2 flex flex-col justify-between p-1.5 ${
                          selected
                            ? 'border-teal-700 bg-white'
                            : 'border-slate-300 bg-slate-50'
                        }`}
                      >
                        <div className="h-1.5 w-full rounded-sm bg-slate-300" />
                        <div className="space-y-1">
                          <div className="h-1 w-full rounded-sm bg-slate-200" />
                          <div className="h-1 w-4/5 rounded-sm bg-slate-200" />
                          <div className="h-1 w-full rounded-sm bg-slate-200" />
                        </div>
                        <div className="h-1.5 w-2/3 mx-auto rounded-sm bg-teal-600/60" />
                      </div>
                      <div>
                        <div className="font-mono text-sm font-extrabold text-slate-900">
                          {paper.title}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500">{paper.dim}</div>
                      </div>
                      <p className="text-[11px] leading-snug text-slate-600">
                        {lang === 'ar' ? paper.descAr : paper.descFr}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Additional Document Formats & Printer Parameters */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 border-t border-slate-200 pt-5 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  {t(lang, 'حجم ورق فواتير المشتريات', 'Format factures achats')}
                </label>
                <select
                  value={printForm.purchasesFormat}
                  onChange={(e) =>
                    setPrintForm({ ...printForm, purchasesFormat: e.target.value as 'a4' | '80mm' | '58mm' })
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                >
                  <option value="a4">A4 (210mm)</option>
                  <option value="80mm">{t(lang, 'حرارية 80mm', 'Thermique 80mm')}</option>
                  <option value="58mm">{t(lang, 'حرارية 58mm', 'Thermique 58mm')}</option>
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  {t(lang, 'حجم ورق وصولات الأداء', 'Format reçus paiement')}
                </label>
                <select
                  value={printForm.receiptsFormat}
                  onChange={(e) =>
                    setPrintForm({ ...printForm, receiptsFormat: e.target.value as 'a4' | '80mm' | '58mm' })
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                >
                  <option value="80mm">{t(lang, 'حرارية 80mm', 'Thermique 80mm')}</option>
                  <option value="58mm">{t(lang, 'حرارية 58mm', 'Thermique 58mm')}</option>
                  <option value="a4">A4 (210mm)</option>
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  {t(lang, 'آلية الطباعة', 'Mode d’impression')}
                </label>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-700 leading-relaxed">
                  <div className="font-bold text-slate-900">
                    {t(lang, 'الطباعة عبر المتصفح وتعريف طابعة النظام', 'Impression via navigateur & pilote système')}
                  </div>
                  <div className="text-slate-600 mt-0.5">
                    {t(
                      lang,
                      'تعمل طابعات A4 وطابعات الإيصالات الحرارية (USB / Bluetooth) بعد تثبيت تعريفها على النظام واختيارها من نافذة الطباعة.',
                      'Les imprimantes A4 et thermiques (USB / Bluetooth) fonctionnent via leur pilote système dans la boîte d’impression.'
                    )}
                  </div>
                </div>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  {t(lang, 'عدد النسخ عند الطباعة', 'Nombre de copies')}
                </label>
                <input
                  type="number"
                  min="1"
                  max="5"
                  value={printForm.copies}
                  onChange={(e) => setPrintForm({ ...printForm, copies: Number(e.target.value) })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  {t(lang, 'هوامش الورقة (mm)', 'Marges papier (mm)')}
                </label>
                <input
                  type="number"
                  min="0"
                  max="25"
                  value={printForm.marginMm}
                  onChange={(e) => setPrintForm({ ...printForm, marginMm: Number(e.target.value) })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  {t(lang, 'أبعاد ملصق الباركود (mm)', 'Étiquette code-barres (mm)')}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    value={printForm.barcodeLabelWidthMm}
                    onChange={(e) =>
                      setPrintForm({ ...printForm, barcodeLabelWidthMm: Number(e.target.value) })
                    }
                    className="rounded-lg border border-slate-300 px-2.5 py-2 font-mono"
                  />
                  <input
                    type="number"
                    value={printForm.barcodeLabelHeightMm}
                    onChange={(e) =>
                      setPrintForm({ ...printForm, barcodeLabelHeightMm: Number(e.target.value) })
                    }
                    className="rounded-lg border border-slate-300 px-2.5 py-2 font-mono"
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-6 text-xs">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={printForm.autoPrint}
                  onChange={(e) => setPrintForm({ ...printForm, autoPrint: e.target.checked })}
                />
                {t(lang, 'طباعة تلقائية فور حفظ فاتورة البيع', 'Impression automatique après vente')}
              </label>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={printForm.previewBeforePrint}
                  onChange={(e) =>
                    setPrintForm({ ...printForm, previewBeforePrint: e.target.checked })
                  }
                />
                {t(lang, 'إظهار معاينة قبل الطباعة', 'Aperçu avant impression')}
              </label>
            </div>

            {/* Cash Drawer (Tiroir-caisse) Settings */}
            <div className="rounded-xl border border-amber-300 bg-amber-50/60 p-4 space-y-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-400 text-slate-950">
                    <Inbox className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="font-bold text-slate-900">
                      {t(lang, 'درج النقدية (Tiroir-caisse)', 'Tiroir-caisse')}
                    </div>
                    <div className="text-[11px] text-slate-600">
                      {t(
                        lang,
                        'فتح الدرج يدوياً من نقطة البيع (زر Tiroir أو F9) أو تلقائياً عند البيع النقدي',
                        'Ouverture manuelle en caisse (Tiroir / F9) ou automatique sur vente espèces'
                      )}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={drawerBusy || !printForm.cashDrawer.enabled}
                  onClick={handleTestCashDrawer}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-700 bg-amber-400 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-300 disabled:opacity-50"
                >
                  <Inbox className="h-3.5 w-3.5" />
                  {t(lang, 'تجربة فتح الدرج (Test Tiroir)', 'Tester le tiroir')}
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-5 pt-1">
                <label className="inline-flex items-center gap-2 cursor-pointer font-semibold text-slate-800">
                  <input
                    type="checkbox"
                    checked={printForm.cashDrawer.enabled}
                    onChange={(e) =>
                      setPrintForm({
                        ...printForm,
                        cashDrawer: { ...printForm.cashDrawer, enabled: e.target.checked },
                      })
                    }
                  />
                  {t(lang, 'تفعيل ميزة فتح الدرج', 'Activer le tiroir-caisse')}
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer text-slate-800">
                  <input
                    type="checkbox"
                    checked={printForm.cashDrawer.autoOpenOnCashSale}
                    onChange={(e) =>
                      setPrintForm({
                        ...printForm,
                        cashDrawer: { ...printForm.cashDrawer, autoOpenOnCashSale: e.target.checked },
                      })
                    }
                  />
                  {t(lang, 'فتح تلقائي عند إتمام بيع نقدي (Espèces)', 'Ouvrir auto. sur vente espèces')}
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer text-slate-800">
                  <input
                    type="checkbox"
                    checked={printForm.cashDrawer.requireReasonOnManualOpen}
                    onChange={(e) =>
                      setPrintForm({
                        ...printForm,
                        cashDrawer: {
                          ...printForm.cashDrawer,
                          requireReasonOnManualOpen: e.target.checked,
                        },
                      })
                    }
                  />
                  {t(lang, 'طلب سبب عند الفتح اليدوي (للمراقبة)', 'Demander un motif à l’ouverture manuelle')}
                </label>
              </div>

              {printForm.cashDrawer.enabled && (
                <div className="space-y-3 border-t border-amber-200 pt-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <label
                      className={`flex items-start gap-2 rounded-lg border p-2.5 cursor-pointer ${
                        printForm.cashDrawer.mode === 'serial_escpos'
                          ? 'border-teal-700 bg-white ring-1 ring-teal-600/30'
                          : 'border-slate-200 bg-white/70'
                      }`}
                    >
                      <input
                        type="radio"
                        name="cashDrawerMode"
                        checked={printForm.cashDrawer.mode === 'serial_escpos'}
                        onChange={() =>
                          setPrintForm({
                            ...printForm,
                            cashDrawer: {
                              ...printForm.cashDrawer,
                              mode: 'serial_escpos' as CashDrawerMode,
                            },
                          })
                        }
                        className="mt-0.5"
                      />
                      <div>
                        <div className="font-bold text-slate-900">
                          {t(lang, 'اتصال مباشر ESC/POS (USB / COM — Web Serial)', 'Direct ESC/POS (USB / COM — Web Serial)')}
                        </div>
                        <div className="text-[11px] text-slate-600 mt-0.5">
                          {t(
                            lang,
                            'يرسل نبضة الفتح مباشرة دون نافذة طباعة (يتطلب Chrome أو Edge على الحاسوب).',
                            'Envoie l’impulsion directement sans boîte d’impression (Chrome/Edge ordinateur).'
                          )}
                        </div>
                      </div>
                    </label>

                    <label
                      className={`flex items-start gap-2 rounded-lg border p-2.5 cursor-pointer ${
                        printForm.cashDrawer.mode === 'printer_driver'
                          ? 'border-teal-700 bg-white ring-1 ring-teal-600/30'
                          : 'border-slate-200 bg-white/70'
                      }`}
                    >
                      <input
                        type="radio"
                        name="cashDrawerMode"
                        checked={printForm.cashDrawer.mode === 'printer_driver'}
                        onChange={() =>
                          setPrintForm({
                            ...printForm,
                            cashDrawer: {
                              ...printForm.cashDrawer,
                              mode: 'printer_driver' as CashDrawerMode,
                            },
                          })
                        }
                        className="mt-0.5"
                      />
                      <div>
                        <div className="font-bold text-slate-900">
                          {t(lang, 'عبر تعريف طابعة النظام (RJ11 / Print Driver)', 'Via pilote imprimante système (RJ11)')}
                        </div>
                        <div className="text-[11px] text-slate-600 mt-0.5">
                          {t(
                            lang,
                            'يعمل مع أي طابعة حرارية متصلة بالدرج عبر كابل RJ11 بعد تفعيل فتح الدرج في إعدادات الطابعة.',
                            'Fonctionne avec toute imprimante thermique RJ11 configurée pour ouvrir le tiroir.'
                          )}
                        </div>
                      </div>
                    </label>
                  </div>

                  {printForm.cashDrawer.mode === 'serial_escpos' && (
                    <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-[11px]">
                          <span className="font-bold text-slate-800">
                            {t(lang, 'حالة المنفذ:', 'État du port :')}{' '}
                          </span>
                          {!serialSupported ? (
                            <span className="font-bold text-red-700">
                              {t(lang, 'غير مدعوم في هذا المتصفح (استخدم Chrome/Edge أو وضع تعريف الطابعة)', 'Non supporté sur ce navigateur')}
                            </span>
                          ) : pairedDrawerPorts > 0 ? (
                            <span className="font-bold text-emerald-700">
                              {t(lang, `مرتبط وجاهز (${pairedDrawerPorts} منفذ)`, `Associé et prêt (${pairedDrawerPorts} port)`)}
                            </span>
                          ) : (
                            <span className="font-semibold text-amber-800">
                              {t(lang, 'لم يتم ربط منفذ بعد', 'Aucun port associé')}
                            </span>
                          )}
                        </div>
                        {serialSupported && (
                          <button
                            type="button"
                            disabled={drawerBusy}
                            onClick={handlePairCashDrawer}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-teal-700 bg-teal-50 px-3 py-1.5 text-[11px] font-bold text-teal-900 hover:bg-teal-100"
                          >
                            <Plug className="h-3.5 w-3.5" />
                            {t(lang, 'ربط منفذ الطابعة / الدرج', 'Associer port série / USB')}
                          </button>
                        )}
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                        <div>
                          <label className="block text-[11px] font-medium text-slate-600 mb-1">
                            {t(lang, 'مخرج الدرج (Pin)', 'Broche RJ11')}
                          </label>
                          <select
                            value={printForm.cashDrawer.pin}
                            onChange={(e) =>
                              setPrintForm({
                                ...printForm,
                                cashDrawer: {
                                  ...printForm.cashDrawer,
                                  pin: Number(e.target.value) === 1 ? 1 : 0,
                                },
                              })
                            }
                            className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs"
                          >
                            <option value={0}>Pin 2 (m=0 · افتراضي)</option>
                            <option value={1}>Pin 5 (m=1)</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-[11px] font-medium text-slate-600 mb-1">
                            {t(lang, 'السرعة (Baud)', 'Baud rate')}
                          </label>
                          <select
                            value={printForm.cashDrawer.baudRate}
                            onChange={(e) =>
                              setPrintForm({
                                ...printForm,
                                cashDrawer: {
                                  ...printForm.cashDrawer,
                                  baudRate: Number(e.target.value) || 9600,
                                },
                              })
                            }
                            className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs"
                          >
                            <option value={9600}>9600</option>
                            <option value={19200}>19200</option>
                            <option value={38400}>38400</option>
                            <option value={115200}>115200</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-[11px] font-medium text-slate-600 mb-1">
                            {t(lang, 'نبضة التشغيل (ms)', 'Impulsion ON (ms)')}
                          </label>
                          <input
                            type="number"
                            min="20"
                            max="500"
                            step="10"
                            value={printForm.cashDrawer.onTimeMs}
                            onChange={(e) =>
                              setPrintForm({
                                ...printForm,
                                cashDrawer: {
                                  ...printForm.cashDrawer,
                                  onTimeMs: Number(e.target.value) || 100,
                                },
                              })
                            }
                            className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-medium text-slate-600 mb-1">
                            {t(lang, 'أمر Hex مخصص (اختياري)', 'Hex perso. (opt.)')}
                          </label>
                          <input
                            dir="ltr"
                            placeholder="1B 70 00 32 64"
                            value={printForm.cashDrawer.customHexCommand ?? ''}
                            onChange={(e) =>
                              setPrintForm({
                                ...printForm,
                                cashDrawer: {
                                  ...printForm.cashDrawer,
                                  customHexCommand: e.target.value,
                                },
                              })
                            }
                            className="w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-4">
              <button
                type="button"
                onClick={handleTestPrinter}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
              >
                <Printer className="h-4 w-4 text-teal-700" />
                {t(
                  lang,
                  `اختبار الطباعة (${printForm.salesFormat.toUpperCase()})`,
                  `Tester l’impression (${printForm.salesFormat.toUpperCase()})`
                )}
              </button>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-5 py-2 text-xs font-semibold text-white hover:bg-teal-800"
              >
                <Save className="h-4 w-4" />
                {t(lang, 'حفظ جميع إعدادات الطباعة', 'Enregistrer les paramètres')}
              </button>
            </div>
          </form>

          {/* Live Paper Format Preview */}
          <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-slate-100 p-4 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-slate-800">
                {t(lang, 'معاينة حية لحجم الورقة المختار', 'Aperçu en direct du format')}
              </span>
              <span className="font-mono font-bold text-teal-800">
                {printForm.salesFormat.toUpperCase()} · {printForm.marginMm}mm
              </span>
            </div>
            <div className="max-h-[620px] overflow-auto rounded-lg bg-slate-200/70 p-3">
              <InvoicePreviewContent
                invoice={previewSampleInvoice}
                settings={{ ...livePreviewSettings, printing: printForm }}
                format={printForm.salesFormat}
              />
            </div>
          </div>
        </div>
      )}

      {/* 12.4 INVOICE CUSTOMIZATION (HEADER, LOGO DIMENSIONS, FOOTER & LIVE PREVIEW) */}
      {subTab === 'invoice' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          {/* Left Control Column */}
          <div className="lg:col-span-6 border-[1.5px] border-slate-900 bg-white overflow-hidden shadow-xs text-xs">
            {/* Golden Top Bar: Format Switcher (Thermal / A4) + Language + Reset */}
            <div className="bg-[#FCE08B] border-b border-slate-900 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setInvConfigTab('thermal')}
                  className={`rounded-lg border-[1.5px] px-3 py-1 font-bold transition-colors ${
                    invConfigTab === 'thermal'
                      ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                      : 'border-slate-900 bg-white text-slate-900 hover:bg-amber-50'
                  }`}
                >
                  {t(lang, 'الحرارية (80 / 58mm)', 'Thermique (80 / 58mm)')}
                </button>
                <button
                  type="button"
                  onClick={() => setInvConfigTab('a4')}
                  className={`rounded-lg border-[1.5px] px-3 py-1 font-bold transition-colors ${
                    invConfigTab === 'a4'
                      ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                      : 'border-slate-900 bg-white text-slate-900 hover:bg-amber-50'
                  }`}
                >
                  {t(lang, 'ورق A4', 'Format A4')}
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <select
                  value={invForm.invoiceLanguage}
                  onChange={(e) =>
                    setInvForm({ ...invForm, invoiceLanguage: e.target.value as Language })
                  }
                  className="rounded-lg border-[1.5px] border-slate-900 bg-white px-2.5 py-1 font-bold text-slate-900"
                >
                  <option value="ar">{t(lang, 'لغة الفاتورة: العربية', 'Facture : Arabe')}</option>
                  <option value="fr">{t(lang, 'لغة الفاتورة: الفرنسية', 'Facture : Français')}</option>
                </select>
                <button
                  type="button"
                  onClick={handleResetInvoiceFormat}
                  title={t(lang, 'استعادة الافتراضي', 'Réinitialiser')}
                  className="inline-flex items-center gap-1 rounded-lg border-[1.5px] border-slate-900 bg-white px-2 py-1 font-bold text-slate-800 hover:bg-amber-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* 4 Control Section Tabs: Header | Logo Dimensions | Footer | Template & Order */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 border-b border-slate-900 bg-slate-50 p-2">
              {(
                [
                  { id: 'header', icon: PanelTop, ar: 'الهيدر (الأعلى)', fr: 'En-tête' },
                  { id: 'logo', icon: ImageIcon, ar: 'مقاسات الشعار', fr: 'Taille Logo' },
                  { id: 'footer', icon: PanelBottom, ar: 'الفوتر (الأسفل)', fr: 'Pied de page' },
                  { id: 'layout', icon: LayoutTemplate, ar: 'القالب والترتيب', fr: 'Modèle & Ordre' },
                ] as const
              ).map((pane) => {
                const Icon = pane.icon;
                const active = invEditorPane === pane.id;
                return (
                  <button
                    key={pane.id}
                    type="button"
                    onClick={() => setInvEditorPane(pane.id)}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-lg border-[1.5px] px-2.5 py-2 font-bold transition-colors ${
                      active
                        ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                        : 'border-slate-900 bg-white text-slate-900 hover:bg-amber-50'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{lang === 'ar' ? pane.ar : pane.fr}</span>
                  </button>
                );
              })}
            </div>

            <div className="p-4 space-y-4">
              {/* PANE 1: HEADER CONTROLS */}
              {invEditorPane === 'header' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between rounded-lg border-[1.5px] border-slate-900 bg-[#FEF3C7]/60 px-3 py-2">
                    <span className="font-bold text-slate-900">
                      {t(lang, 'إظهار الهيدر (رأس الفاتورة)', 'Afficher l’en-tête')}
                    </span>
                    <input
                      type="checkbox"
                      checked={activeFormatCfg.showHeader}
                      onChange={(e) => updateFormatCfg({ showHeader: e.target.checked })}
                      className="h-4 w-4 accent-[#0B274D] cursor-pointer"
                    />
                  </div>

                  {/* Header Alignment & Border */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-bold text-slate-800 mb-1.5">
                        {t(lang, 'محاذاة الهيدر', 'Alignement en-tête')}
                      </label>
                      <div className="grid grid-cols-3 gap-1">
                        {(
                          [
                            ['right', 'يمين', 'Droite'],
                            ['center', 'وسط', 'Centre'],
                            ['left', 'يسار', 'Gauche'],
                          ] as [InvoiceAlign, string, string][]
                        ).map(([val, ar, fr]) => (
                          <button
                            key={val}
                            type="button"
                            onClick={() => updateFormatCfg({ headerAlign: val })}
                            className={`rounded-md border-[1.5px] py-1.5 font-bold ${
                              activeFormatCfg.headerAlign === val
                                ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                                : 'border-slate-300 bg-white text-slate-800 hover:border-slate-900'
                            }`}
                          >
                            {lang === 'ar' ? ar : fr}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="block font-bold text-slate-800 mb-1.5">
                        {t(lang, 'الخط الفاصل أسفل الهيدر', 'Bordure inférieure')}
                      </label>
                      <div className="grid grid-cols-4 gap-1">
                        {(
                          [
                            ['none', 'بدون', 'Aucune'],
                            ['solid', 'متصل', 'Plein'],
                            ['dashed', 'متقطع', 'Tiret'],
                            ['double', 'مزدوج', 'Double'],
                          ] as [InvoiceBorderStyle, string, string][]
                        ).map(([val, ar, fr]) => (
                          <button
                            key={val}
                            type="button"
                            onClick={() => updateFormatCfg({ headerBorderStyle: val })}
                            className={`rounded-md border-[1.5px] py-1.5 font-bold ${
                              activeFormatCfg.headerBorderStyle === val
                                ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                                : 'border-slate-300 bg-white text-slate-800 hover:border-slate-900'
                            }`}
                          >
                            {lang === 'ar' ? ar : fr}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Header Background Color */}
                  <div>
                    <label className="block font-bold text-slate-800 mb-1.5">
                      {t(lang, 'لون خلفية الهيدر', 'Arrière-plan de l’en-tête')}
                    </label>
                    <div className="grid grid-cols-4 gap-1.5">
                      {(
                        [
                          ['transparent', 'شفاف', 'Transparent', 'bg-white text-slate-900'],
                          ['light', 'رمادي فاتح', 'Gris clair', 'bg-slate-100 text-slate-900'],
                          ['gold', 'ذهبي', 'Doré', 'bg-[#FEF3C7] text-slate-900'],
                          ['navy', 'كحلي', 'Marine', 'bg-[#0B274D] text-[#FDE68A]'],
                        ] as [InvoiceSurfaceBg, string, string, string][]
                      ).map(([val, ar, fr, swatch]) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => updateFormatCfg({ headerBgColor: val })}
                          className={`rounded-lg border-[1.5px] py-2 font-bold transition-all ${swatch} ${
                            activeFormatCfg.headerBgColor === val
                              ? 'border-slate-950 ring-2 ring-amber-400'
                              : 'border-slate-300 opacity-85 hover:opacity-100'
                          }`}
                        >
                          {lang === 'ar' ? ar : fr}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Header Title Font Size & Vertical Padding */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-800">
                          {t(lang, 'حجم عنوان الهيدر', 'Taille du titre')}
                        </span>
                        <span className="font-mono font-bold text-[#0B274D]">
                          {activeFormatCfg.headerFontSize}px
                        </span>
                      </div>
                      <input
                        type="range"
                        min={11}
                        max={32}
                        value={activeFormatCfg.headerFontSize}
                        onChange={(e) => updateFormatCfg({ headerFontSize: Number(e.target.value) })}
                        className="w-full accent-[#0B274D]"
                      />
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-800">
                          {t(lang, 'تباعد / ارتفاع الهيدر', 'Marge verticale')}
                        </span>
                        <span className="font-mono font-bold text-[#0B274D]">
                          {activeFormatCfg.headerPaddingY}px
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={40}
                        value={activeFormatCfg.headerPaddingY}
                        onChange={(e) => updateFormatCfg({ headerPaddingY: Number(e.target.value) })}
                        className="w-full accent-[#0B274D]"
                      />
                    </div>
                  </div>

                  {/* Custom Header Text & Extra Info */}
                  <div className="space-y-2 border-t border-slate-200 pt-3">
                    <div className="font-bold text-slate-900">
                      {t(lang, 'نصوص الهيدر القابلة للتعديل', 'Textes personnalisés de l’en-tête')}
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        {t(lang, 'نص مخصص أعلى الهيدر (مثال: بسم الله الرحمن الرحيم أو فاتورة معتمدة)', 'Texte personnalisé haut d’en-tête')}
                      </label>
                      <input
                        value={invForm.customHeaderText}
                        onChange={(e) => setInvForm({ ...invForm, customHeaderText: e.target.value })}
                        placeholder={t(lang, 'أدخل عبارة مخصصة تظهر في الهيدر...', 'Texte d’en-tête personnalisé...')}
                        className="w-full rounded-lg border-[1.5px] border-slate-300 px-2.5 py-1.5 focus:border-slate-900 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        {t(lang, 'معلومات إضافية في الهيدر (السجل التجاري / الباتنتا...)', 'Infos complémentaires (RC / Patente...)')}
                      </label>
                      <input
                        value={storeForm.extraInvoiceInfo}
                        onChange={(e) => setStoreForm({ ...storeForm, extraInvoiceInfo: e.target.value })}
                        placeholder={t(lang, 'سجل تجاري / باتنتا...', 'RC / Patente...')}
                        className="w-full rounded-lg border-[1.5px] border-slate-300 px-2.5 py-1.5 focus:border-slate-900 focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* Header Field Toggles */}
                  <div className="border-t border-slate-200 pt-3">
                    <div className="font-bold text-slate-900 mb-2">
                      {t(lang, 'عناصر الهيدر المعروضة', 'Éléments affichés dans l’en-tête')}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {(
                        [
                          ['showLogo', 'الشعار', 'Logo'],
                          ['showCustomHeader', 'النص المخصص', 'Texte libre'],
                          ['showStoreName', 'اسم المتجر', 'Nom magasin'],
                          ['showActivity', 'النشاط', 'Activité'],
                          ['showAddress', 'العنوان', 'Adresse'],
                          ['showPhone', 'الهاتف', 'Téléphone'],
                          ['showTaxId', 'الرقم الضريبي', 'ICE / IF'],
                          ['showExtraHeader', 'معلومات إضافية', 'Infos supp.'],
                        ] as [keyof InvoiceFormatConfig, string, string][]
                      ).map(([key, ar, fr]) => (
                        <label
                          key={key}
                          className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 cursor-pointer hover:border-slate-400"
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(activeFormatCfg[key])}
                            onChange={(e) => updateFormatCfg({ [key]: e.target.checked })}
                            className="accent-[#0B274D]"
                          />
                          <span className="font-medium text-slate-800">{lang === 'ar' ? ar : fr}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* PANE 2: LOGO DIMENSIONS & STYLING CONTROLS */}
              {invEditorPane === 'logo' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between rounded-lg border-[1.5px] border-slate-900 bg-[#FEF3C7]/60 px-3 py-2">
                    <span className="font-bold text-slate-900">
                      {t(lang, 'إظهار الشعار في الفاتورة والمطبوعات', 'Afficher le logo sur les impressions')}
                    </span>
                    <input
                      type="checkbox"
                      checked={activeFormatCfg.showLogo}
                      onChange={(e) => updateFormatCfg({ showLogo: e.target.checked })}
                      className="h-4 w-4 accent-[#0B274D] cursor-pointer"
                    />
                  </div>

                  {/* Logo Preview & Direct Upload */}
                  <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="flex h-16 w-24 items-center justify-center rounded-lg border border-slate-300 bg-white p-1 overflow-hidden">
                      <img
                        src={storeForm.logoDataUrl || DEFAULT_INVOICE_LOGO}
                        alt="logo"
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                    <div className="flex-1 min-w-[160px] space-y-1.5">
                      <div className="font-bold text-slate-900">
                        {storeForm.logoDataUrl
                          ? t(lang, 'شعار المتجر المخصص', 'Logo personnalisé du magasin')
                          : t(lang, 'الشعار الافتراضي (RM.POS GC)', 'Logo par défaut (RM.POS GC)')}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] border-[#0B274D] bg-[#0B274D] px-3 py-1.5 font-bold text-[#FDE68A] hover:opacity-90">
                          <Upload className="h-3.5 w-3.5" />
                          {t(lang, 'تغيير الشعار', 'Changer le logo')}
                          <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
                        </label>
                        {storeForm.logoDataUrl && (
                          <button
                            type="button"
                            onClick={() => setStoreForm((prev) => ({ ...prev, logoDataUrl: '' }))}
                            className="inline-flex items-center gap-1 rounded-lg border border-red-300 bg-red-50 px-2.5 py-1.5 font-bold text-red-700 hover:bg-red-100"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {t(lang, 'حذف', 'Supprimer')}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Quick Size Presets */}
                  <div>
                    <label className="block font-bold text-slate-800 mb-1.5">
                      {t(lang, 'مقاسات جاهزة سريعة للشعار', 'Tailles rapides du logo')}
                    </label>
                    <div className="grid grid-cols-4 gap-1.5">
                      {(invConfigTab === 'a4'
                        ? [
                            { ar: 'صغير', fr: 'Petit', w: 70, h: 42 },
                            { ar: 'متوسط', fr: 'Moyen', w: 120, h: 64 },
                            { ar: 'كبير', fr: 'Grand', w: 180, h: 96 },
                            { ar: 'بانر عريض', fr: 'Bannière', w: 260, h: 80 },
                          ]
                        : [
                            { ar: 'صغير', fr: 'Petit', w: 48, h: 32 },
                            { ar: 'متوسط', fr: 'Moyen', w: 72, h: 44 },
                            { ar: 'كبير', fr: 'Grand', w: 110, h: 64 },
                            { ar: 'عريض', fr: 'Large', w: 160, h: 52 },
                          ]
                      ).map((preset) => {
                        const isSelected =
                          activeFormatCfg.logoWidth === preset.w &&
                          activeFormatCfg.logoHeight === preset.h;
                        return (
                          <button
                            key={preset.ar}
                            type="button"
                            onClick={() => updateFormatCfg({ logoWidth: preset.w, logoHeight: preset.h })}
                            className={`rounded-lg border-[1.5px] px-2 py-2 text-center transition-colors ${
                              isSelected
                                ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                                : 'border-slate-300 bg-white text-slate-900 hover:border-slate-900 hover:bg-amber-50'
                            }`}
                          >
                            <div className="font-bold">{lang === 'ar' ? preset.ar : preset.fr}</div>
                            <div className="font-mono text-[10px] opacity-80">
                              {preset.w}×{preset.h}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Exact Width & Height Sliders + Numeric Inputs */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="rounded-lg border-[1.5px] border-slate-900 bg-white p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <label className="font-bold text-slate-900">
                          {t(lang, 'عرض الشعار (Width)', 'Largeur (Width)')}
                        </label>
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={24}
                            max={invConfigTab === 'a4' ? 320 : 200}
                            value={activeFormatCfg.logoWidth}
                            onChange={(e) =>
                              updateFormatCfg({
                                logoWidth: Math.max(24, Math.min(320, Number(e.target.value) || 24)),
                              })
                            }
                            className="w-16 rounded border border-slate-300 px-1.5 py-0.5 text-center font-mono font-bold text-slate-900"
                          />
                          <span className="font-mono text-[11px] text-slate-500">px</span>
                        </div>
                      </div>
                      <input
                        type="range"
                        min={24}
                        max={invConfigTab === 'a4' ? 320 : 200}
                        value={activeFormatCfg.logoWidth}
                        onChange={(e) => updateFormatCfg({ logoWidth: Number(e.target.value) })}
                        className="w-full accent-[#0B274D]"
                      />
                    </div>

                    <div className="rounded-lg border-[1.5px] border-slate-900 bg-white p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <label className="font-bold text-slate-900">
                          {t(lang, 'ارتفاع الشعار (Height)', 'Hauteur (Height)')}
                        </label>
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={20}
                            max={invConfigTab === 'a4' ? 200 : 120}
                            value={activeFormatCfg.logoHeight}
                            onChange={(e) =>
                              updateFormatCfg({
                                logoHeight: Math.max(20, Math.min(200, Number(e.target.value) || 20)),
                              })
                            }
                            className="w-16 rounded border border-slate-300 px-1.5 py-0.5 text-center font-mono font-bold text-slate-900"
                          />
                          <span className="font-mono text-[11px] text-slate-500">px</span>
                        </div>
                      </div>
                      <input
                        type="range"
                        min={20}
                        max={invConfigTab === 'a4' ? 200 : 120}
                        value={activeFormatCfg.logoHeight}
                        onChange={(e) => updateFormatCfg({ logoHeight: Number(e.target.value) })}
                        className="w-full accent-[#0B274D]"
                      />
                    </div>
                  </div>

                  {/* Aspect Ratio Lock */}
                  <label className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 cursor-pointer">
                    <span className="font-bold text-slate-800">
                      {t(lang, 'الحفاظ على تناسب أبعاد الشعار (بدون تمطيط)', 'Conserver les proportions du logo')}
                    </span>
                    <input
                      type="checkbox"
                      checked={activeFormatCfg.logoKeepAspect}
                      onChange={(e) => updateFormatCfg({ logoKeepAspect: e.target.checked })}
                      className="h-4 w-4 accent-[#0B274D]"
                    />
                  </label>

                  {/* Logo Shape & Alignment */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-bold text-slate-800 mb-1.5">
                        {t(lang, 'شكل إطار الشعار', 'Forme du logo')}
                      </label>
                      <div className="grid grid-cols-3 gap-1">
                        {(
                          [
                            ['none', 'أصلي', 'Original'],
                            ['rounded', 'حواف دائرية', 'Arrondi'],
                            ['circle', 'دائري', 'Cercle'],
                          ] as [InvoiceLogoShape, string, string][]
                        ).map(([val, ar, fr]) => (
                          <button
                            key={val}
                            type="button"
                            onClick={() => updateFormatCfg({ logoShape: val })}
                            className={`rounded-md border-[1.5px] py-1.5 font-bold ${
                              activeFormatCfg.logoShape === val
                                ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                                : 'border-slate-300 bg-white text-slate-800 hover:border-slate-900'
                            }`}
                          >
                            {lang === 'ar' ? ar : fr}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="block font-bold text-slate-800 mb-1.5">
                        {t(lang, 'موضع / محاذاة الشعار', 'Position du logo')}
                      </label>
                      <div className="grid grid-cols-4 gap-1">
                        {(
                          [
                            ['inherit', 'تلقائي', 'Auto'],
                            ['right', 'يمين', 'Droite'],
                            ['center', 'وسط', 'Centre'],
                            ['left', 'يسار', 'Gauche'],
                          ] as ['inherit' | InvoiceAlign, string, string][]
                        ).map(([val, ar, fr]) => (
                          <button
                            key={val}
                            type="button"
                            onClick={() => updateFormatCfg({ logoAlign: val })}
                            className={`rounded-md border-[1.5px] py-1.5 font-bold ${
                              activeFormatCfg.logoAlign === val
                                ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                                : 'border-slate-300 bg-white text-slate-800 hover:border-slate-900'
                            }`}
                          >
                            {lang === 'ar' ? ar : fr}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* PANE 3: FOOTER CONTROLS */}
              {invEditorPane === 'footer' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between rounded-lg border-[1.5px] border-slate-900 bg-[#FEF3C7]/60 px-3 py-2">
                    <span className="font-bold text-slate-900">
                      {t(lang, 'إظهار الفوتر (أسفل الفاتورة)', 'Afficher le pied de page')}
                    </span>
                    <input
                      type="checkbox"
                      checked={activeFormatCfg.showFooter}
                      onChange={(e) => updateFormatCfg({ showFooter: e.target.checked })}
                      className="h-4 w-4 accent-[#0B274D] cursor-pointer"
                    />
                  </div>

                  {/* Footer Alignment & Border */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-bold text-slate-800 mb-1.5">
                        {t(lang, 'محاذاة الفوتر', 'Alignement pied de page')}
                      </label>
                      <div className="grid grid-cols-3 gap-1">
                        {(
                          [
                            ['right', 'يمين', 'Droite'],
                            ['center', 'وسط', 'Centre'],
                            ['left', 'يسار', 'Gauche'],
                          ] as [InvoiceAlign, string, string][]
                        ).map(([val, ar, fr]) => (
                          <button
                            key={val}
                            type="button"
                            onClick={() => updateFormatCfg({ footerAlign: val })}
                            className={`rounded-md border-[1.5px] py-1.5 font-bold ${
                              activeFormatCfg.footerAlign === val
                                ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                                : 'border-slate-300 bg-white text-slate-800 hover:border-slate-900'
                            }`}
                          >
                            {lang === 'ar' ? ar : fr}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="block font-bold text-slate-800 mb-1.5">
                        {t(lang, 'الخط الفاصل أعلى الفوتر', 'Bordure supérieure')}
                      </label>
                      <div className="grid grid-cols-4 gap-1">
                        {(
                          [
                            ['none', 'بدون', 'Aucune'],
                            ['solid', 'متصل', 'Plein'],
                            ['dashed', 'متقطع', 'Tiret'],
                            ['double', 'مزدوج', 'Double'],
                          ] as [InvoiceBorderStyle, string, string][]
                        ).map(([val, ar, fr]) => (
                          <button
                            key={val}
                            type="button"
                            onClick={() => updateFormatCfg({ footerBorderStyle: val })}
                            className={`rounded-md border-[1.5px] py-1.5 font-bold ${
                              activeFormatCfg.footerBorderStyle === val
                                ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                                : 'border-slate-300 bg-white text-slate-800 hover:border-slate-900'
                            }`}
                          >
                            {lang === 'ar' ? ar : fr}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Footer Background */}
                  <div>
                    <label className="block font-bold text-slate-800 mb-1.5">
                      {t(lang, 'لون خلفية الفوتر', 'Arrière-plan du pied de page')}
                    </label>
                    <div className="grid grid-cols-4 gap-1.5">
                      {(
                        [
                          ['transparent', 'شفاف', 'Transparent', 'bg-white text-slate-900'],
                          ['light', 'رمادي فاتح', 'Gris clair', 'bg-slate-100 text-slate-900'],
                          ['gold', 'ذهبي', 'Doré', 'bg-[#FEF3C7] text-slate-900'],
                          ['navy', 'كحلي', 'Marine', 'bg-[#0B274D] text-[#FDE68A]'],
                        ] as [InvoiceSurfaceBg, string, string, string][]
                      ).map(([val, ar, fr, swatch]) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => updateFormatCfg({ footerBgColor: val })}
                          className={`rounded-lg border-[1.5px] py-2 font-bold transition-all ${swatch} ${
                            activeFormatCfg.footerBgColor === val
                              ? 'border-slate-950 ring-2 ring-amber-400'
                              : 'border-slate-300 opacity-85 hover:opacity-100'
                          }`}
                        >
                          {lang === 'ar' ? ar : fr}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Footer Font Size & Padding */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-800">
                          {t(lang, 'حجم خط الفوتر', 'Taille police pied')}
                        </span>
                        <span className="font-mono font-bold text-[#0B274D]">
                          {activeFormatCfg.footerFontSize}px
                        </span>
                      </div>
                      <input
                        type="range"
                        min={8}
                        max={16}
                        step={0.5}
                        value={activeFormatCfg.footerFontSize}
                        onChange={(e) => updateFormatCfg({ footerFontSize: Number(e.target.value) })}
                        className="w-full accent-[#0B274D]"
                      />
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-800">
                          {t(lang, 'تباعد / ارتفاع الفوتر', 'Marge verticale')}
                        </span>
                        <span className="font-mono font-bold text-[#0B274D]">
                          {activeFormatCfg.footerPaddingY}px
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={40}
                        value={activeFormatCfg.footerPaddingY}
                        onChange={(e) => updateFormatCfg({ footerPaddingY: Number(e.target.value) })}
                        className="w-full accent-[#0B274D]"
                      />
                    </div>
                  </div>

                  {/* Footer Texts + Individual Toggles */}
                  <div className="space-y-2.5 border-t border-slate-200 pt-3">
                    <div className="font-bold text-slate-900">
                      {t(lang, 'محتوى ونصوص الفوتر', 'Contenu et textes du pied de page')}
                    </div>

                    <div className="space-y-1">
                      <label className="inline-flex items-center gap-2 font-semibold text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={activeFormatCfg.showThankYou}
                          onChange={(e) => updateFormatCfg({ showThankYou: e.target.checked })}
                          className="accent-[#0B274D]"
                        />
                        {t(lang, 'رسالة الشكر للزبون', 'Message de remerciement')}
                      </label>
                      <input
                        value={invForm.thankYouMessage}
                        onChange={(e) => setInvForm({ ...invForm, thankYouMessage: e.target.value })}
                        placeholder={t(lang, 'شكراً لتسوقكم معنا...', 'Merci pour votre visite...')}
                        className="w-full rounded-lg border-[1.5px] border-slate-300 px-2.5 py-1.5 focus:border-slate-900 focus:outline-none"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="inline-flex items-center gap-2 font-semibold text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={activeFormatCfg.showReturnTerms}
                          onChange={(e) => updateFormatCfg({ showReturnTerms: e.target.checked })}
                          className="accent-[#0B274D]"
                        />
                        {t(lang, 'شروط البيع والإرجاع', 'Conditions de retour')}
                      </label>
                      <input
                        value={invForm.returnTerms}
                        onChange={(e) => setInvForm({ ...invForm, returnTerms: e.target.value })}
                        placeholder={t(lang, 'شروط الإرجاع والاستبدال...', 'Conditions d’échange...')}
                        className="w-full rounded-lg border-[1.5px] border-slate-300 px-2.5 py-1.5 focus:border-slate-900 focus:outline-none"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="inline-flex items-center gap-2 font-semibold text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={activeFormatCfg.showSocialContact}
                          onChange={(e) => updateFormatCfg({ showSocialContact: e.target.checked })}
                          className="accent-[#0B274D]"
                        />
                        {t(lang, 'وسائل التواصل / واتساب', 'Réseaux / WhatsApp')}
                      </label>
                      <input
                        value={invForm.socialContact}
                        onChange={(e) => setInvForm({ ...invForm, socialContact: e.target.value })}
                        placeholder={t(lang, 'واتساب / فيسبوك / إنستغرام...', 'WhatsApp / Facebook...')}
                        className="w-full rounded-lg border-[1.5px] border-slate-300 px-2.5 py-1.5 focus:border-slate-900 focus:outline-none"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="inline-flex items-center gap-2 font-semibold text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={activeFormatCfg.showExtraFooter}
                          onChange={(e) => updateFormatCfg({ showExtraFooter: e.target.checked })}
                          className="accent-[#0B274D]"
                        />
                        {t(lang, 'معلومات إضافية أسفل الفاتورة', 'Informations supplémentaires')}
                      </label>
                      <input
                        value={invForm.extraFooterInfo}
                        onChange={(e) => setInvForm({ ...invForm, extraFooterInfo: e.target.value })}
                        placeholder={t(lang, 'جميع الأسعار شاملة للضريبة...', 'Tous les prix sont en MAD...')}
                        className="w-full rounded-lg border-[1.5px] border-slate-300 px-2.5 py-1.5 focus:border-slate-900 focus:outline-none"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="inline-flex items-center gap-2 font-semibold text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={activeFormatCfg.showCustomPhrase}
                          onChange={(e) => updateFormatCfg({ showCustomPhrase: e.target.checked })}
                          className="accent-[#0B274D]"
                        />
                        {t(lang, 'العبارة المخصصة أسفل الفاتورة', 'Phrase personnalisée')}
                      </label>
                      <input
                        value={invForm.customFooterPhrase}
                        onChange={(e) => setInvForm({ ...invForm, customFooterPhrase: e.target.value })}
                        placeholder={t(lang, 'عبارة ترويجية أو ملاحظة...', 'Slogan ou remarque...')}
                        className="w-full rounded-lg border-[1.5px] border-slate-300 px-2.5 py-1.5 focus:border-slate-900 focus:outline-none"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="inline-flex items-center gap-2 font-semibold text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={activeFormatCfg.showSignatureLine}
                          onChange={(e) => updateFormatCfg({ showSignatureLine: e.target.checked })}
                          className="accent-[#0B274D]"
                        />
                        {t(lang, 'إظهار خانة التوقيع والختم في الفوتر', 'Afficher zone Cachet & Signature')}
                      </label>
                      {activeFormatCfg.showSignatureLine && (
                        <input
                          value={invForm.signatureLabel}
                          onChange={(e) => setInvForm({ ...invForm, signatureLabel: e.target.value })}
                          placeholder={t(lang, 'توقيع وختم المتجر', 'Cachet & Signature')}
                          className="w-full rounded-lg border-[1.5px] border-slate-300 px-2.5 py-1.5 focus:border-slate-900 focus:outline-none"
                        />
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* PANE 4: TEMPLATE, BODY ELEMENTS & SECTION ORDER */}
              {invEditorPane === 'layout' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-bold text-slate-800 mb-1.5">
                        {t(lang, 'قالب الفاتورة', 'Modèle de facture')}
                      </label>
                      <div className="grid grid-cols-3 gap-1">
                        {(
                          [
                            ['modern', 'حديث', 'Moderne'],
                            ['classic', 'كلاسيكي', 'Classique'],
                            ['compact', 'مضغوط', 'Compact'],
                          ] as const
                        ).map(([val, ar, fr]) => (
                          <button
                            key={val}
                            type="button"
                            onClick={() => updateFormatCfg({ template: val })}
                            className={`rounded-md border-[1.5px] py-1.5 font-bold ${
                              activeFormatCfg.template === val
                                ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                                : 'border-slate-300 bg-white text-slate-800 hover:border-slate-900'
                            }`}
                          >
                            {lang === 'ar' ? ar : fr}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-800">
                          {t(lang, 'حجم خط جسم الفاتورة', 'Taille police générale')}
                        </span>
                        <span className="font-mono font-bold text-[#0B274D]">
                          {activeFormatCfg.fontSize}px
                        </span>
                      </div>
                      <input
                        type="range"
                        min={9}
                        max={16}
                        value={activeFormatCfg.fontSize}
                        onChange={(e) => updateFormatCfg({ fontSize: Number(e.target.value) })}
                        className="w-full accent-[#0B274D]"
                      />
                    </div>
                  </div>

                  {/* Body Element Toggles */}
                  <div className="border-t border-slate-200 pt-3">
                    <div className="font-bold text-slate-900 mb-2">
                      {t(lang, 'عناصر جسم الفاتورة', 'Éléments du corps de facture')}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {(
                        [
                          ['showCustomerInfo', 'بيانات الزبون', 'Infos client'],
                          ['showSellerName', 'اسم البائع', 'Nom vendeur'],
                          ['showBarcode', 'الباركود', 'Code-barres'],
                          ['showTaxBreakdown', 'تفاصيل الضريبة (TVA)', 'Détail TVA'],
                          ['showPaymentSummary', 'ملخص الأداء والباقي', 'Résumé paiement'],
                        ] as [keyof InvoiceFormatConfig, string, string][]
                      ).map(([key, ar, fr]) => (
                        <label
                          key={key}
                          className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 cursor-pointer hover:border-slate-400"
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(activeFormatCfg[key])}
                            onChange={(e) => updateFormatCfg({ [key]: e.target.checked })}
                            className="accent-[#0B274D]"
                          />
                          <span className="font-medium text-slate-800">{lang === 'ar' ? ar : fr}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Section Ordering */}
                  <div className="border-t border-slate-200 pt-3">
                    <div className="font-bold text-slate-900 mb-2">
                      {t(lang, 'ترتيب أقسام الفاتورة', 'Ordre des sections')}
                    </div>
                    <div className="space-y-1.5">
                      {activeFormatCfg.sectionOrder.map((sec, idx) => {
                        const secLabels: Record<typeof sec, { ar: string; fr: string }> = {
                          header: { ar: 'الهيدر (الشعار وبيانات المتجر)', fr: 'En-tête (Logo & Magasin)' },
                          meta: { ar: 'معلومات الفاتورة والزبون', fr: 'Métadonnées & Client' },
                          items: { ar: 'جدول المنتجات والأسعار', fr: 'Tableau des articles' },
                          totals: { ar: 'المجاميع والأداء', fr: 'Totaux & Paiement' },
                          footer: { ar: 'الفوتر (الشكر والشروط والختم)', fr: 'Pied de page' },
                        };
                        return (
                          <div
                            key={sec}
                            className="flex items-center justify-between rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5"
                          >
                            <span className="font-bold text-slate-800">
                              {idx + 1}. {lang === 'ar' ? secLabels[sec].ar : secLabels[sec].fr}
                            </span>
                            <div className="flex gap-1">
                              <button
                                type="button"
                                onClick={() => moveSection(idx, -1)}
                                disabled={idx === 0}
                                className="rounded border border-slate-300 bg-white p-1 hover:bg-amber-50 disabled:opacity-30"
                              >
                                <ArrowUp className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => moveSection(idx, 1)}
                                disabled={idx === activeFormatCfg.sectionOrder.length - 1}
                                className="rounded border border-slate-300 bg-white p-1 hover:bg-amber-50 disabled:opacity-30"
                              >
                                <ArrowDown className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Sticky Save Action */}
              <div className="border-t border-slate-200 pt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleSaveInvoiceCustom}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border-[1.5px] border-[#0B274D] bg-[#0B274D] py-2.5 px-4 text-xs font-bold text-[#FDE68A] hover:opacity-95"
                >
                  <Save className="h-4 w-4" />
                  {t(lang, 'حفظ تخصيص الهيدر والفوتر والشعار', 'Enregistrer la personnalisation')}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    openPrint({
                      type: 'sale_invoice',
                      invoice: previewSampleInvoice,
                      format: invConfigTab === 'a4' ? 'a4' : thermalPreviewSize,
                    })
                  }
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border-[1.5px] border-slate-900 bg-white py-2.5 px-3.5 text-xs font-bold text-slate-900 hover:bg-amber-50"
                >
                  <Printer className="h-4 w-4" />
                  {t(lang, 'طباعة تجريبية', 'Test')}
                </button>
              </div>
            </div>
          </div>

          {/* Right Live Preview Column (Sticky) */}
          <div className="lg:col-span-6 lg:sticky lg:top-28 border-[1.5px] border-slate-900 bg-slate-100 overflow-hidden shadow-xs">
            <div className="bg-[#FCE08B] border-b border-slate-900 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-900">
                  {t(lang, 'معاينة فورية لشكل الفاتورة', 'Aperçu en direct de la facture')}
                </span>
                <span className="font-mono font-bold text-[#0B274D]">
                  ({invConfigTab === 'a4' ? 'A4' : thermalPreviewSize.toUpperCase()} · {activeFormatCfg.logoWidth}×{activeFormatCfg.logoHeight}px)
                </span>
              </div>
              {invConfigTab === 'thermal' && (
                <div className="flex items-center gap-1">
                  {(['80mm', '58mm'] as const).map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      onClick={() => setThermalPreviewSize(sz)}
                      className={`rounded-md border px-2.5 py-0.5 font-mono text-[11px] font-bold ${
                        thermalPreviewSize === sz
                          ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                          : 'border-slate-900 bg-white text-slate-900 hover:bg-amber-50'
                      }`}
                    >
                      {sz.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="p-4 max-h-[760px] overflow-auto">
              <InvoicePreviewContent
                invoice={previewSampleInvoice}
                settings={livePreviewSettings}
                format={invConfigTab === 'a4' ? 'a4' : thermalPreviewSize}
              />
            </div>
          </div>
        </div>
      )}

      {/* 12.5 BACKUP & RESTORE */}
      {subTab === 'backup' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 space-y-4 text-xs">
            <h3 className="text-sm font-bold text-slate-900">
              {t(lang, 'إنشاء وتصدير نسخة احتياطية', 'Créer et exporter une sauvegarde')}
            </h3>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                {t(lang, 'وصف النسخة (اختياري)', 'Libellé (optionnel)')}
              </label>
              <input
                value={backupLabel}
                onChange={(e) => setBackupLabel(e.target.value)}
                placeholder={t(lang, 'مثال: نسخة نهاية الشهر', 'Ex: Fin de mois')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                {t(lang, 'كلمة التشفير AES-256 (اتركها فارغة لنسخة غير مشفرة)', 'Mot de passe de chiffrement AES-256 (optionnel)')}
              </label>
              <input
                type="password"
                value={backupPassphrase}
                onChange={(e) => setBackupPassphrase(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>

            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                onClick={() => handleCreateManualBackup(true, false)}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-teal-700 py-2.5 font-semibold text-white hover:bg-teal-800"
              >
                <Download className="h-4 w-4" />
                {t(lang, 'نسخ احتياطي يدوي وحفظ على الجهاز', 'Sauvegarde manuelle & Télécharger')}
              </button>
              <button
                type="button"
                onClick={() => handleCreateManualBackup(true, true)}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 py-2 font-medium text-slate-700 hover:bg-slate-50"
              >
                <HardDrive className="h-4 w-4" />
                {t(lang, 'الحفظ في مجلد خارجي', 'Enregistrer dans un dossier externe')}
              </button>
              <button
                type="button"
                onClick={handleExportRawDb}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 py-2 font-medium text-slate-700 hover:bg-slate-50"
              >
                <Database className="h-4 w-4" />
                {t(lang, 'تصدير نسخة كاملة من قاعدة البيانات (JSON)', 'Exporter toute la base (JSON)')}
              </button>
            </div>

            {/* Persistent Storage & Eviction Protection Status */}
            <div
              className={`rounded-lg border p-3 space-y-2 ${
                storageInfo.persisted
                  ? 'border-emerald-200 bg-emerald-50/70 text-emerald-950'
                  : 'border-amber-300 bg-amber-50/80 text-amber-950'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold flex items-center gap-1.5">
                  {storageInfo.persisted ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-700 shrink-0" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-amber-700 shrink-0" />
                  )}
                  {storageInfo.persisted
                    ? t(lang, 'التخزين المحلي الدائم مفعّل', 'Stockage persistant activé')
                    : t(lang, 'التخزين المحلي غير محمي من الإخلاء التلقائي', 'Stockage non garanti persistant')}
                </span>
                {storageInfo.supported && !storageInfo.persisted && (
                  <button
                    type="button"
                    onClick={requestPersistentStorage}
                    className="rounded-md bg-amber-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-amber-700"
                  >
                    {t(lang, 'تفعيل الدائم', 'Activer')}
                  </button>
                )}
              </div>
              {storageInfo.quotaBytes !== null && storageInfo.usageBytes !== null && (
                <div className="text-[11px] font-mono tabular-nums text-slate-700">
                  {t(lang, 'المساحة المستخدمة:', 'Utilisé :')}{' '}
                  {(storageInfo.usageBytes / (1024 * 1024)).toFixed(2)} MB /{' '}
                  {(storageInfo.quotaBytes / (1024 * 1024)).toFixed(0)} MB
                </div>
              )}
              <p className="text-[11px] leading-relaxed">
                {t(
                  lang,
                  'النسخ التلقائية تُحفظ داخل قاعدة المتصفح (IndexedDB). لتجنب فقدان البيانات عند مسح بيانات المتصفح أو إخلائها تلقائياً (خصوصاً على iPhone / Safari)، قم بتحميل نسخة احتياطية خارجية دورياً.',
                  'Les sauvegardes auto sont stockées localement (IndexedDB). Pour éviter toute perte si le navigateur efface les données (notamment iOS/Safari), téléchargez régulièrement une copie externe.'
                )}
              </p>
              {settings.backupConfig.lastExternalExportAt && (
                <div className="text-[11px] font-mono text-slate-700">
                  {t(lang, 'آخر تصدير خارجي:', 'Dernier export externe :')}{' '}
                  {formatDateTime(settings.backupConfig.lastExternalExportAt, lang)}
                </div>
              )}
            </div>

            <div className="border-t border-slate-200 pt-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold text-slate-900">
                  {t(lang, 'النسخ الاحتياطي التلقائي المجدول', 'Sauvegarde automatique planifiée')}
                </div>
                <button
                  type="button"
                  onClick={() => runAutoBackupNow(false)}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-800 hover:bg-slate-50"
                >
                  <RefreshCw className="h-3 w-3" />
                  {t(lang, 'تنفيذ الآن', 'Exécuter')}
                </button>
              </div>
              <label className="flex items-center justify-between cursor-pointer">
                <span>{t(lang, 'تفعيل النسخ الاحتياطي التلقائي', 'Activer sauvegarde automatique')}</span>
                <input
                  type="checkbox"
                  checked={settings.backupConfig.autoBackupEnabled}
                  onChange={(e) =>
                    currentUser &&
                    updateSettingsSection(
                      (c) => ({ ...c, backupConfig: { ...c.backupConfig, autoBackupEnabled: e.target.checked } }),
                      currentUser,
                      'تبديل النسخ التلقائي'
                    )
                  }
                />
              </label>
              <div className="text-[11px] text-slate-600 font-mono">
                {t(lang, 'آخر نسخة تلقائية:', 'Dernière sauvegarde auto :')}{' '}
                {settings.backupConfig.lastAutoBackupAt
                  ? formatDateTime(settings.backupConfig.lastAutoBackupAt, lang)
                  : t(lang, 'لم تُنفذ بعد', 'Pas encore exécutée')}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-600 mb-1">{t(lang, 'كل (ساعة)', 'Intervalle (h)')}</label>
                  <input
                    type="number"
                    min="1"
                    max="168"
                    value={settings.backupConfig.autoBackupIntervalHours}
                    onChange={(e) =>
                      currentUser &&
                      updateSettingsSection(
                        (c) => ({
                          ...c,
                          backupConfig: {
                            ...c.backupConfig,
                            autoBackupIntervalHours: Number(e.target.value) || 24,
                          },
                        }),
                        currentUser,
                        'تعديل مواعيد النسخ التلقائي'
                      )
                    }
                    className="w-full rounded border border-slate-300 px-2 py-1 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">{t(lang, 'عدد النسخ المحتفظ بها', 'Max conservées')}</label>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={settings.backupConfig.maxRetainedBackups}
                    onChange={(e) =>
                      currentUser &&
                      updateSettingsSection(
                        (c) => ({
                          ...c,
                          backupConfig: {
                            ...c.backupConfig,
                            maxRetainedBackups: Number(e.target.value) || 10,
                          },
                        }),
                        currentUser,
                        'تعديل عدد النسخ المحتفظ بها'
                      )
                    }
                    className="w-full rounded border border-slate-300 px-2 py-1 font-mono"
                  />
                </div>
              </div>
            </div>

            <div className="border-t border-slate-200 pt-4">
              <button
                type="button"
                onClick={handleFreshReset}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-red-50 py-2 text-xs font-semibold text-red-700 hover:bg-red-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t(lang, 'تصفير البيانات التجريبية والبدء الفعلي من الصفر', 'Réinitialiser pour démarrer à zéro')}
              </button>
            </div>
          </div>

          {/* Restore & Backup History */}
          <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white p-5 space-y-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  {t(lang, 'استعادة نسخة احتياطية وقائمة النسخ السابقة', 'Restauration & Historique des sauvegardes')}
                </h3>
                <p className="text-slate-500">
                  {t(lang, 'يتم التحقق تلقائياً من سلامة الملف (SHA-256) قبل الاستعادة', 'Vérification d’intégrité SHA-256 avant restauration')}
                </p>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800">
                <Upload className="h-3.5 w-3.5" />
                {t(lang, 'استعادة من ملف', 'Restaurer un fichier')}
                <input type="file" accept=".json" onChange={handleRestoreFromFile} className="hidden" />
              </label>
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">
                {t(lang, 'كلمة فك التشفير (عند استعادة نسخة مشفرة)', 'Mot de passe de déchiffrement (si chiffrée)')}
              </label>
              <input
                type="password"
                value={restorePassphrase}
                onChange={(e) => setRestorePassphrase(e.target.value)}
                placeholder="••••••••"
                className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-1.5"
              />
            </div>

            <div className="border-[1.5px] border-slate-900 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#FCE08B] text-slate-950">
                      <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold">{t(lang, 'التاريخ والوقت', 'Date')}</th>
                      <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold">{t(lang, 'الوصف / التشفير', 'Libellé')}</th>
                      <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold">{t(lang, 'الحجم', 'Taille')}</th>
                      <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold">{t(lang, 'إجراءات', 'Actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backups.map((b) => (
                      <tr key={b.id} className="hover:bg-amber-50/50">
                        <td className="border border-slate-800/80 px-2.5 py-1.5 text-center font-mono text-[11px] tabular-nums text-slate-700">{formatDateTime(b.date, lang)}</td>
                        <td className="border border-slate-800/80 px-2.5 py-1.5">
                          <div className="font-bold text-slate-950">{b.label}</div>
                          <div className="font-mono text-[10px] text-slate-500">
                            {b.encrypted ? 'AES-256-GCM' : 'JSON'} · SHA256: {b.checksum.slice(0, 12)}...
                          </div>
                        </td>
                        <td className="border border-slate-800/80 px-2.5 py-1.5 text-center font-mono tabular-nums">
                          {(b.sizeBytes / 1024).toFixed(1)} KB
                        </td>
                        <td className="border border-slate-800/80 px-2 py-1.5 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                downloadTextFile(
                                  b.payloadJson,
                                  `backup_${b.date.slice(0, 10)}_${b.id}.json`
                                )
                              }
                              className="rounded border border-slate-800 bg-white px-2 py-0.5 text-[11px] font-bold hover:bg-[#FCE08B]"
                            >
                              {t(lang, 'تحميل', 'Télécharger')}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRestoreFromRecord(b.payloadJson)}
                              className="rounded bg-teal-700 px-2.5 py-0.5 text-[11px] font-bold text-white hover:bg-teal-800"
                            >
                              {t(lang, 'استعادة', 'Restaurer')}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {backups.length === 0 && (
                      <tr>
                        <td colSpan={4} className="border border-slate-800/80 p-8 text-center text-slate-400">
                          {t(lang, 'لم يتم حفظ نسخ احتياطية داخلية بعد — اضغط "نسخ احتياطي يدوي"', 'Aucune sauvegarde locale enregistrée')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
