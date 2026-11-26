import { AppUser, SectionId, UserPermissions } from '../types';

export type BooleanPermissionKey = Exclude<keyof UserPermissions, 'maxDiscountPercent'>;
export type PermissionKey = BooleanPermissionKey;

export const SECTION_REQUIRED_PERMISSION: Partial<Record<SectionId, PermissionKey | PermissionKey[]>> = {
  // 'home' and 'dashboard' are accessible to any authenticated user (with inner widgets gated)
  customers: 'canManageCustomers',
  suppliers: 'canManageSuppliers',
  categories: 'canManageProducts',
  products: 'canManageProducts',
  pos: 'canSell',
  purchases: 'canPurchase',
  // Inventory viewing requires product management OR selling/purchasing, stocktake requires canManageProducts
  inventory: ['canManageProducts', 'canSell', 'canPurchase'],
  stocktake: 'canManageProducts',
  // Payments require managing customers, suppliers, or selling
  payments: ['canManageCustomers', 'canManageSuppliers', 'canSell'],
  reports: 'canViewReports',
  profit_reports: 'canViewProfits',
  settings: 'canManageSettings',
};

export function hasPermission(user: AppUser | null | undefined, perm: PermissionKey): boolean {
  if (!user) return false;
  if (!user.isActive) return false;
  return Boolean(user.permissions?.[perm]);
}

export function getMaxDiscountPercent(user: AppUser | null | undefined): number {
  if (!user || !user.isActive) return 0;
  if (!user.permissions?.canGiveDiscount) return 0;
  const raw = user.permissions.maxDiscountPercent;
  if (typeof raw !== 'number' || Number.isNaN(raw)) {
    return user.role === 'admin' ? 100 : 0;
  }
  return Math.max(0, Math.min(100, raw));
}

export function canAccessSection(user: AppUser | null | undefined, section: SectionId): boolean {
  if (!user || !user.isActive) return false;
  if (section === 'home' || section === 'dashboard') return true;

  const req = SECTION_REQUIRED_PERMISSION[section];
  if (!req) return true;
  if (Array.isArray(req)) {
    return req.some((key) => Boolean(user.permissions?.[key]));
  }
  return Boolean(user.permissions?.[req]);
}

export function assertPermission(
  user: AppUser | null | undefined,
  perm: PermissionKey,
  customMessage?: string
): void {
  if (!hasPermission(user, perm)) {
    throw new Error(
      customMessage ||
        'ليس لديك الصلاحية لتنفيذ هذه العملية / Vous n’avez pas la permission d’effectuer cette action'
    );
  }
}

export const PERMISSION_LABELS: Record<PermissionKey, { ar: string; fr: string }> = {
  canSell: { ar: 'البيع ونقطة البيع', fr: 'Vente & Caisse POS' },
  canOverridePrice: { ar: 'تعديل أسعار البيع يدوياً في الكاشير', fr: 'Modifier le prix unitaire en caisse' },
  canGiveDiscount: { ar: 'منح خصومات على الفواتير والأسطر', fr: 'Accorder des remises sur facture' },
  canCancelSale: { ar: 'إلغاء فواتير البيع', fr: 'Annuler ventes' },
  canEditInvoice: { ar: 'تعديل الفواتير والمرتجعات', fr: 'Modifier factures & retours' },
  canPurchase: { ar: 'المشتريات ومرتجعات الموردين', fr: 'Achats & retours fournisseurs' },
  canManageProducts: { ar: 'إدارة المنتجات والعائلات والمخزون', fr: 'Gérer produits, familles & stock' },
  canManageCustomers: { ar: 'إدارة الزبناء والديون والأقساط', fr: 'Gérer clients, crédits & échéances' },
  canManageSuppliers: { ar: 'إدارة الموردين والمستحقات', fr: 'Gérer fournisseurs & dettes' },
  canDeleteRecords: { ar: 'حذف السجلات الحساسة', fr: 'Supprimer enregistrements' },
  canViewReports: { ar: 'الاطلاع على التقارير العامة', fr: 'Voir rapports généraux' },
  canViewProfits: { ar: 'الاطلاع على تقارير الأرباح والهوامش', fr: 'Voir rapports de bénéfices' },
  canManageSettings: { ar: 'إدارة إعدادات التطبيق والمستخدمين', fr: 'Gérer paramètres & utilisateurs' },
  canRestoreCancelled: { ar: 'نسخ الفواتير الملغاة كفاتورة جديدة', fr: 'Dupliquer factures annulées' },
};
