import Dexie, { Table } from 'dexie';
import {
  AppSettings,
  AppUser,
  AuditLog,
  BackupRecord,
  Category,
  Customer,
  CustomerPayment,
  Expense,
  HeldCart,
  Installment,
  LoginLog,
  PriceHistory,
  Product,
  PurchaseInvoice,
  SaleInvoice,
  SaleReturn,
  StockMovement,
  Supplier,
  SupplierPayment,
  SupplierReturn,
  UserPermissions,
} from '../types';
import { generateSalt, hashPassword } from '../utils/crypto';

export const ADMIN_PERMISSIONS: UserPermissions = {
  canSell: true,
  canCancelSale: true,
  canEditInvoice: true,
  canPurchase: true,
  canManageProducts: true,
  canManageCustomers: true,
  canManageSuppliers: true,
  canDeleteRecords: true,
  canViewReports: true,
  canViewProfits: true,
  canManageSettings: true,
  canRestoreCancelled: true,
};

export const CASHIER_PERMISSIONS: UserPermissions = {
  canSell: true,
  canCancelSale: false,
  canEditInvoice: false,
  canPurchase: false,
  canManageProducts: false,
  canManageCustomers: true,
  canManageSuppliers: false,
  canDeleteRecords: false,
  canViewReports: false,
  canViewProfits: false,
  canManageSettings: false,
  canRestoreCancelled: false,
};

export const MANAGER_PERMISSIONS: UserPermissions = {
  canSell: true,
  canCancelSale: true,
  canEditInvoice: true,
  canPurchase: true,
  canManageProducts: true,
  canManageCustomers: true,
  canManageSuppliers: true,
  canDeleteRecords: false,
  canViewReports: true,
  canViewProfits: true,
  canManageSettings: false,
  canRestoreCancelled: true,
};

export function createDefaultSettings(): AppSettings {
  return {
    id: 1,
    storeInfo: {
      storeName: 'سوبر مارشي النور',
      logoDataUrl: '',
      managerName: 'محمد العلمي',
      activityInfo: 'التجارة بالتقسيط والمواد الغذائية العامة',
      address: 'شارع الحسن الثاني رقم 48',
      phone: '0661-428910',
      email: 'contact@annour-market.ma',
      city: 'الدار البيضاء',
      country: 'المغرب',
      currency: 'MAD',
      taxId: 'ICE 002489120000045',
      extraInvoiceInfo: 'سجل تجاري: 418920 — الباتنتا: 34219800',
      defaultLanguage: 'ar',
      taxEnabled: false,
      defaultTaxRate: 20,
      salePrefix: 'VNT',
      saleNextNumber: 1005,
      purchasePrefix: 'ACH',
      purchaseNextNumber: 2003,
      returnPrefix: 'RET',
      returnNextNumber: 3001,
      customerPaymentNextRef: 3,
      supplierPaymentNextRef: 3,
    },
    posConfig: {
      allowNegativeStock: false,
      defaultCostingMethod: 'weighted_avg',
      defaultPriceTier: 'retail',
    },
    security: {
      requireLoginOnStartup: false,
      requireDeletePassword: false,
      deletePasswordHash: '',
      deletePasswordSalt: '',
      requireFinancialConfirm: false,
      maxLoginAttempts: 5,
      autoLockMinutes: 0,
    },
    printing: {
      salesFormat: '80mm',
      purchasesFormat: 'a4',
      receiptsFormat: '80mm',
      connectionType: 'browser',
      copies: 1,
      autoPrint: false,
      previewBeforePrint: true,
      marginMm: 4,
      barcodeLabelWidthMm: 50,
      barcodeLabelHeightMm: 30,
      cashDrawer: {
        enabled: true,
        mode: 'serial_escpos',
        autoOpenOnCashSale: true,
        pin: 0,
        onTimeMs: 100,
        offTimeMs: 200,
        baudRate: 9600,
        customHexCommand: '',
        requireReasonOnManualOpen: false,
      },
    },
    invoiceCustomization: {
      invoiceLanguage: 'ar',
      customHeaderText: '',
      thankYouMessage: 'شكراً لتسوقكم معنا — زيارتكم تسعدنا دائماً',
      returnTerms: 'يمكن استبدال أو إرجاع السلع خلال 48 ساعة مرفقة بوصل الشراء الأصلي.',
      socialContact: 'واتساب: 0661-428910 · فيسبوك: SuperMarcheAnnour',
      extraFooterInfo: 'جميع الأسعار بالدرهم المغربي',
      customFooterPhrase: 'جودة مضمونة وأسعار مناسبة كل يوم',
      signatureLabel: 'توقيع وختم المتجر',
      a4: {
        template: 'modern',
        fontSize: 13,
        showHeader: true,
        headerAlign: 'right',
        headerFontSize: 20,
        headerPaddingY: 12,
        headerBgColor: 'transparent',
        headerBorderStyle: 'solid',
        showCustomHeader: true,
        showLogo: true,
        logoWidth: 120,
        logoHeight: 64,
        logoKeepAspect: true,
        logoShape: 'none',
        logoAlign: 'inherit',
        showStoreName: true,
        showAddress: true,
        showPhone: true,
        showActivity: true,
        showTaxId: true,
        showExtraHeader: true,
        showCustomerInfo: true,
        showSellerName: true,
        showBarcode: true,
        showTaxBreakdown: true,
        showPaymentSummary: true,
        showFooter: true,
        footerAlign: 'center',
        footerFontSize: 11,
        footerPaddingY: 12,
        footerBgColor: 'transparent',
        footerBorderStyle: 'dashed',
        showThankYou: true,
        showReturnTerms: true,
        showSocialContact: true,
        showExtraFooter: true,
        showCustomPhrase: true,
        showSignatureLine: false,
        sectionOrder: ['header', 'meta', 'items', 'totals', 'footer'],
      },
      thermal: {
        template: 'compact',
        fontSize: 11,
        showHeader: true,
        headerAlign: 'center',
        headerFontSize: 15,
        headerPaddingY: 8,
        headerBgColor: 'transparent',
        headerBorderStyle: 'dashed',
        showCustomHeader: true,
        showLogo: true,
        logoWidth: 72,
        logoHeight: 44,
        logoKeepAspect: true,
        logoShape: 'none',
        logoAlign: 'inherit',
        showStoreName: true,
        showAddress: true,
        showPhone: true,
        showActivity: false,
        showTaxId: true,
        showExtraHeader: false,
        showCustomerInfo: true,
        showSellerName: true,
        showBarcode: false,
        showTaxBreakdown: false,
        showPaymentSummary: true,
        showFooter: true,
        footerAlign: 'center',
        footerFontSize: 10,
        footerPaddingY: 8,
        footerBgColor: 'transparent',
        footerBorderStyle: 'dashed',
        showThankYou: true,
        showReturnTerms: true,
        showSocialContact: true,
        showExtraFooter: false,
        showCustomPhrase: true,
        showSignatureLine: false,
        sectionOrder: ['header', 'meta', 'items', 'totals', 'footer'],
      },
    },
    backupConfig: {
      autoBackupEnabled: true,
      autoBackupIntervalHours: 24,
      lastAutoBackupAt: null,
      lastExternalExportAt: null,
      maxRetainedBackups: 10,
      encryptBackupsDefault: false,
    },
  };
}

export function normalizeSettings(saved?: Partial<AppSettings> | null): AppSettings {
  const defaults = createDefaultSettings();
  if (!saved) return defaults;
  return {
    id: saved.id ?? defaults.id,
    storeInfo: { ...defaults.storeInfo, ...(saved.storeInfo ?? {}) },
    posConfig: { ...defaults.posConfig, ...(saved.posConfig ?? {}) },
    security: { ...defaults.security, ...(saved.security ?? {}) },
    printing: {
      ...defaults.printing,
      ...(saved.printing ?? {}),
      connectionType: 'browser',
      cashDrawer: {
        ...defaults.printing.cashDrawer,
        ...(saved.printing?.cashDrawer ?? {}),
      },
    },
    invoiceCustomization: {
      ...defaults.invoiceCustomization,
      ...(saved.invoiceCustomization ?? {}),
      a4: {
        ...defaults.invoiceCustomization.a4,
        ...(saved.invoiceCustomization?.a4 ?? {}),
      },
      thermal: {
        ...defaults.invoiceCustomization.thermal,
        ...(saved.invoiceCustomization?.thermal ?? {}),
      },
    },
    backupConfig: { ...defaults.backupConfig, ...(saved.backupConfig ?? {}) },
  };
}

export class MatjarProDB extends Dexie {
  users!: Table<AppUser, number>;
  categories!: Table<Category, number>;
  products!: Table<Product, number>;
  priceHistory!: Table<PriceHistory, number>;
  customers!: Table<Customer, number>;
  suppliers!: Table<Supplier, number>;
  saleInvoices!: Table<SaleInvoice, number>;
  saleReturns!: Table<SaleReturn, number>;
  installments!: Table<Installment, number>;
  heldCarts!: Table<HeldCart, number>;
  purchaseInvoices!: Table<PurchaseInvoice, number>;
  supplierReturns!: Table<SupplierReturn, number>;
  stockMovements!: Table<StockMovement, number>;
  customerPayments!: Table<CustomerPayment, number>;
  supplierPayments!: Table<SupplierPayment, number>;
  expenses!: Table<Expense, number>;
  auditLogs!: Table<AuditLog, number>;
  loginLogs!: Table<LoginLog, number>;
  backups!: Table<BackupRecord, number>;
  settings!: Table<AppSettings, number>;

  constructor() {
    super('MatjarProRetailDB');
    this.version(1).stores({
      users: '++id, &username, role, isActive',
      categories: '++id, nameAr, nameFr, parentId, sortOrder',
      products: '++id, name, sku, barcode, categoryId, isActive, quantity, expiryDate',
      priceHistory: '++id, productId, changedAt',
      customers: '++id, fullName, phone',
      suppliers: '++id, businessName, phone',
      saleInvoices: '++id, &invoiceNumber, date, customerId, sellerId, status, &idempotencyKey',
      saleReturns: '++id, &returnNumber, saleInvoiceId, date, customerId',
      heldCarts: '++id, createdAt',
      purchaseInvoices: '++id, &invoiceNumber, date, supplierId, status, &idempotencyKey',
      supplierReturns: '++id, &returnNumber, purchaseInvoiceId, date, supplierId',
      stockMovements: '++id, date, productId, type, referenceNumber',
      customerPayments: '++id, &refNumber, date, customerId, &idempotencyKey',
      supplierPayments: '++id, &refNumber, date, supplierId, &idempotencyKey',
      expenses: '++id, date, category, userId',
      auditLogs: '++id, date, userId, entityType, action',
      loginLogs: '++id, date, username, status',
      backups: '++id, date, type',
      settings: 'id',
    });
    this.version(2).stores({
      users: '++id, &username, role, isActive',
      categories: '++id, nameAr, nameFr, parentId, sortOrder',
      products: '++id, name, sku, barcode, categoryId, isActive, quantity, expiryDate',
      priceHistory: '++id, productId, changedAt',
      customers: '++id, fullName, phone',
      suppliers: '++id, businessName, phone',
      saleInvoices: '++id, &invoiceNumber, date, customerId, sellerId, status, &idempotencyKey',
      saleReturns: '++id, &returnNumber, saleInvoiceId, date, customerId',
      installments: '++id, saleInvoiceId, customerId, dueDate, status',
      heldCarts: '++id, createdAt',
      purchaseInvoices: '++id, &invoiceNumber, date, supplierId, status, &idempotencyKey',
      supplierReturns: '++id, &returnNumber, purchaseInvoiceId, date, supplierId',
      stockMovements: '++id, date, productId, type, referenceNumber',
      customerPayments: '++id, &refNumber, date, customerId, &idempotencyKey',
      supplierPayments: '++id, &refNumber, date, supplierId, &idempotencyKey',
      expenses: '++id, date, category, userId',
      auditLogs: '++id, date, userId, entityType, action',
      loginLogs: '++id, date, username, status',
      backups: '++id, date, type',
      settings: 'id',
    });
  }
}

export const db = new MatjarProDB();

function daysAgoIso(days: number, hour = 10, min = 30): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, min, 0, 0);
  return d.toISOString();
}

function daysFromNowDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

let initPromise: Promise<void> | null = null;

export function ensureDatabaseInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = initializeDatabaseOnce();
  }
  return initPromise;
}

async function initializeDatabaseOnce(): Promise<void> {
  const existingSettings = await db.settings.get(1);
  if (existingSettings) return;

  const adminSalt = generateSalt();
  const adminHash = await hashPassword('admin123', adminSalt);
  const cashierSalt = generateSalt();
  const cashierHash = await hashPassword('1234', cashierSalt);

  await db.transaction(
    'rw',
    [
      db.settings,
      db.users,
      db.categories,
      db.products,
      db.customers,
      db.suppliers,
      db.purchaseInvoices,
      db.saleInvoices,
      db.installments,
      db.stockMovements,
      db.customerPayments,
      db.supplierPayments,
      db.expenses,
      db.auditLogs,
    ],
    async () => {
      const check = await db.settings.get(1);
      if (check) return;

      await db.settings.put(createDefaultSettings());

      await db.users.bulkAdd([
        {
          id: 1,
          username: 'admin',
          fullName: 'محمد العلمي (المدير)',
          role: 'admin',
          passwordHash: adminHash,
          passwordSalt: adminSalt,
          permissions: ADMIN_PERMISSIONS,
          isActive: true,
          createdAt: daysAgoIso(30),
        },
        {
          id: 2,
          username: 'cashier1',
          fullName: 'سلمى بنعلي (بائعة)',
          role: 'cashier',
          passwordHash: cashierHash,
          passwordSalt: cashierSalt,
          permissions: CASHIER_PERMISSIONS,
          isActive: true,
          createdAt: daysAgoIso(25),
        },
      ]);

      // Categories (Parent & Sub-categories)
      await db.categories.bulkAdd([
        { id: 1, nameAr: 'المواد الغذائية الأساسية', nameFr: 'Épicerie de base', parentId: null, icon: 'wheat', description: 'الدقيق، الزيوت، السكر، الحبوب والقطاني', sortOrder: 1, createdAt: daysAgoIso(30) },
        { id: 2, nameAr: 'الزيوت والسمن', nameFr: 'Huiles & Matières grasses', parentId: 1, icon: 'droplet', description: 'زيت المائدة، زيت الزيتون والزبدة', sortOrder: 2, createdAt: daysAgoIso(30) },
        { id: 3, nameAr: 'الحليب ومشتقاته', nameFr: 'Produits laitiers', parentId: null, icon: 'milk', description: 'الحليب، الياغورت، الأجبان والزبدة', sortOrder: 3, createdAt: daysAgoIso(30) },
        { id: 4, nameAr: 'المشروبات والعصائر', nameFr: 'Boissons & Jus', parentId: null, icon: 'cup-soda', description: 'المياه المعدنية، الشاي، القهوة والعصائر', sortOrder: 4, createdAt: daysAgoIso(30) },
        { id: 5, nameAr: 'مواد التنظيف والنظافة', nameFr: 'Hygiène & Entretien', parentId: null, icon: 'sparkles', description: 'مساحيق الغسيل، الصابون ومنظفات المنزل', sortOrder: 5, createdAt: daysAgoIso(30) },
        { id: 6, nameAr: 'الفواكه والخضروات الموزونة', nameFr: 'Fruits & Légumes (Pesée)', parentId: null, icon: 'apple', description: 'منتجات تباع بالوزن (الكيلوغرام)', sortOrder: 6, createdAt: daysAgoIso(30) },
      ]);

      // Products
      await db.products.bulkAdd([
        { id: 1, name: 'زيت المائدة لوسيور 2 لتر', sku: 'OIL-001', barcode: '6111035000101', categoryId: 2, unit: 'قنينة', purchasePrice: 31.5, salePrice: 37.0, wholesalePrice: 34.5, secondSalePrice: 36.0, quantity: 42, minStock: 10, expiryDate: daysFromNowDate(240), lotNumber: 'LOT-26A', isActive: true, isWeighted: false, createdAt: daysAgoIso(28), updatedAt: daysAgoIso(2) },
        { id: 2, name: 'حليب سنطرال كامل الدسم 1 لتر', sku: 'DAI-001', barcode: '6111035000202', categoryId: 3, unit: 'علبة', purchasePrice: 8.4, salePrice: 10.0, wholesalePrice: 9.2, secondSalePrice: 9.5, quantity: 65, minStock: 20, expiryDate: daysFromNowDate(12), lotNumber: 'LOT-L88', isActive: true, isWeighted: false, createdAt: daysAgoIso(28), updatedAt: daysAgoIso(1) },
        { id: 3, name: 'سكر كوسومار قوالب 2 كغ', sku: 'GRO-001', barcode: '6111035000303', categoryId: 1, unit: 'علبة', purchasePrice: 11.2, salePrice: 13.5, wholesalePrice: 12.5, secondSalePrice: 13.0, quantity: 38, minStock: 15, expiryDate: daysFromNowDate(400), lotNumber: 'LOT-S12', isActive: true, isWeighted: false, createdAt: daysAgoIso(28), updatedAt: daysAgoIso(3) },
        { id: 4, name: 'شاي أخضر سلطان 200 غ', sku: 'BEV-001', barcode: '6111035000404', categoryId: 4, unit: 'علبة', purchasePrice: 14.0, salePrice: 18.0, wholesalePrice: 16.5, secondSalePrice: 17.0, quantity: 7, minStock: 10, expiryDate: daysFromNowDate(310), lotNumber: 'LOT-T09', isActive: true, isWeighted: false, createdAt: daysAgoIso(28), updatedAt: daysAgoIso(2) },
        { id: 5, name: 'مسحوق غسيل أريال 1.5 كغ', sku: 'CLN-001', barcode: '6111035000505', categoryId: 5, unit: 'حزمة', purchasePrice: 36.0, salePrice: 44.0, wholesalePrice: 41.0, secondSalePrice: 42.5, quantity: 19, minStock: 8, expiryDate: daysFromNowDate(500), lotNumber: 'LOT-C44', isActive: true, isWeighted: false, createdAt: daysAgoIso(26), updatedAt: daysAgoIso(4) },
        { id: 6, name: 'دقيق ممتاز ميمونة 5 كغ', sku: 'GRO-002', barcode: '6111035000606', categoryId: 1, unit: 'حزمة', purchasePrice: 24.5, salePrice: 29.0, wholesalePrice: 27.0, secondSalePrice: 28.0, quantity: 26, minStock: 10, expiryDate: daysFromNowDate(150), lotNumber: 'LOT-F21', isActive: true, isWeighted: false, createdAt: daysAgoIso(26), updatedAt: daysAgoIso(5) },
        { id: 7, name: 'ماء معدني سيدي علي 1.5 لتر', sku: 'BEV-002', barcode: '6111035000707', categoryId: 4, unit: 'قنينة', purchasePrice: 4.1, salePrice: 6.0, wholesalePrice: 5.0, secondSalePrice: 5.5, quantity: 96, minStock: 24, expiryDate: daysFromNowDate(360), lotNumber: 'LOT-W19', isActive: true, isWeighted: false, createdAt: daysAgoIso(25), updatedAt: daysAgoIso(1) },
        { id: 8, name: 'جبن مثلثات لافاش كيري 16 قطعة', sku: 'DAI-002', barcode: '6111035000808', categoryId: 3, unit: 'علبة', purchasePrice: 17.5, salePrice: 21.5, wholesalePrice: 19.5, secondSalePrice: 20.5, quantity: 4, minStock: 10, expiryDate: daysFromNowDate(20), lotNumber: 'LOT-CH3', isActive: true, isWeighted: false, createdAt: daysAgoIso(24), updatedAt: daysAgoIso(2) },
        { id: 9, name: 'تفاح أحمر إفران (موزون)', sku: 'WGT-001', barcode: '2000101000009', categoryId: 6, unit: 'كيلوغرام', purchasePrice: 11.0, salePrice: 15.0, wholesalePrice: 13.5, secondSalePrice: 14.0, quantity: 18.5, minStock: 5, expiryDate: daysFromNowDate(9), lotNumber: 'LOT-FR1', isActive: true, isWeighted: true, createdAt: daysAgoIso(10), updatedAt: daysAgoIso(1) },
        { id: 10, name: 'قهوة سريعة الذوبان 100 غ', sku: 'BEV-003', barcode: '6111035001010', categoryId: 4, unit: 'علبة', purchasePrice: 29.0, salePrice: 36.0, wholesalePrice: 33.0, secondSalePrice: 34.5, quantity: 0, minStock: 6, expiryDate: daysFromNowDate(280), lotNumber: 'LOT-CF5', isActive: true, isWeighted: false, createdAt: daysAgoIso(22), updatedAt: daysAgoIso(1) },
      ]);

      // Customers
      await db.customers.bulkAdd([
        { id: 1, fullName: 'زبون عابر (نقدي)', phone: '0000-000000', address: 'البيع المباشر', creditLimit: 0, openingBalance: 0, notes: 'حساب افتراضي للمبيعات النقدية السريعة', createdAt: daysAgoIso(30) },
        { id: 2, fullName: 'أحمد الإدريسي', phone: '0662-118293', address: 'حي المعاريف، الزنقة 12', creditLimit: 3000, openingBalance: 0, notes: 'زبون منتظم — دفع شهري', createdAt: daysAgoIso(25) },
        { id: 3, fullName: 'فاطمة الزهراء المنصوري', phone: '0671-843210', address: 'حي الألفة، الإقامة 4', creditLimit: 2000, openingBalance: 0, notes: 'تشتري بالتقسيط للأسر', createdAt: daysAgoIso(20) },
        { id: 4, fullName: 'مقهى السعادة (يوسف التازي)', phone: '0668-905512', address: 'شارع الزرقطوني 110', creditLimit: 5000, openingBalance: 0, notes: 'تموين يومي بالحليب والسكر والشاي', createdAt: daysAgoIso(18) },
      ]);

      // Suppliers
      await db.suppliers.bulkAdd([
        { id: 1, businessName: 'شركة الأطلس لتوزيع المواد الغذائية', phone: '0522-349811', address: 'المنطقة الصناعية عين السبع', taxId: 'ICE 001523980000012', openingBalance: 0, notes: 'مورد الزيوت والدقيق والسكر', createdAt: daysAgoIso(30) },
        { id: 2, businessName: 'تعاونية الشاوية للألبان', phone: '0522-784512', address: 'طريق الجديدة كلم 9', taxId: 'ICE 001984210000088', openingBalance: 0, notes: 'توصيل يومي لمنتجات الحليب والأجبان', createdAt: daysAgoIso(28) },
        { id: 3, businessName: 'مؤسسة الصفا لمواد التنظيف والمشروبات', phone: '0522-612090', address: 'سيدي معروف، الدار البيضاء', taxId: 'ICE 002109440000031', openingBalance: 0, notes: 'دفع خلال 30 يوماً', createdAt: daysAgoIso(25) },
      ]);

      // Purchase Invoices
      await db.purchaseInvoices.bulkAdd([
        {
          id: 1,
          invoiceNumber: 'ACH-2001',
          date: daysAgoIso(10, 9, 15),
          supplierId: 1,
          supplierName: 'شركة الأطلس لتوزيع المواد الغذائية',
          userId: 1,
          userName: 'محمد العلمي (المدير)',
          items: [
            { productId: 1, productName: 'زيت المائدة لوسيور 2 لتر', barcode: '6111035000101', unit: 'قنينة', quantity: 50, unitCost: 31.5, discount: 0, total: 1575 },
            { productId: 3, productName: 'سكر كوسومار قوالب 2 كغ', barcode: '6111035000303', unit: 'علبة', quantity: 50, unitCost: 11.2, discount: 0, total: 560 },
            { productId: 6, productName: 'دقيق ممتاز ميمونة 5 كغ', barcode: '6111035000606', unit: 'حزمة', quantity: 30, unitCost: 24.5, discount: 0, total: 735 },
          ],
          subtotal: 2870,
          discountAmount: 0,
          total: 2870,
          paidAmount: 2000,
          remainingAmount: 870,
          paymentMethod: 'bank_transfer',
          status: 'partial',
          costingMethod: 'weighted_avg',
          idempotencyKey: 'seed-ach-2001',
          notes: 'دفعة أولى بتحويل بنكي',
        },
        {
          id: 2,
          invoiceNumber: 'ACH-2002',
          date: daysAgoIso(5, 11, 0),
          supplierId: 2,
          supplierName: 'تعاونية الشاوية للألبان',
          userId: 1,
          userName: 'محمد العلمي (المدير)',
          items: [
            { productId: 2, productName: 'حليب سنطرال كامل الدسم 1 لتر', barcode: '6111035000202', unit: 'علبة', quantity: 80, unitCost: 8.4, discount: 0, total: 672 },
            { productId: 8, productName: 'جبن مثلثات لافاش كيري 16 قطعة', barcode: '6111035000808', unit: 'علبة', quantity: 20, unitCost: 17.5, discount: 0, total: 350 },
          ],
          subtotal: 1022,
          discountAmount: 0,
          total: 1022,
          paidAmount: 1022,
          remainingAmount: 0,
          paymentMethod: 'cash',
          status: 'paid',
          costingMethod: 'weighted_avg',
          idempotencyKey: 'seed-ach-2002',
          notes: 'تموين أسبوعي نقداً',
        },
      ]);

      // Sales Invoices
      await db.saleInvoices.bulkAdd([
        {
          id: 1,
          invoiceNumber: 'VNT-1001',
          date: daysAgoIso(4, 14, 20),
          customerId: 2,
          customerName: 'أحمد الإدريسي',
          sellerId: 1,
          sellerName: 'محمد العلمي (المدير)',
          items: [
            { productId: 1, productName: 'زيت المائدة لوسيور 2 لتر', barcode: '6111035000101', unit: 'قنينة', quantity: 4, unitPrice: 37, costPrice: 31.5, discount: 0, total: 148 },
            { productId: 3, productName: 'سكر كوسومار قوالب 2 كغ', barcode: '6111035000303', unit: 'علبة', quantity: 6, unitPrice: 13.5, costPrice: 11.2, discount: 0, total: 81 },
            { productId: 5, productName: 'مسحوق غسيل أريال 1.5 كغ', barcode: '6111035000505', unit: 'حزمة', quantity: 2, unitPrice: 44, costPrice: 36, discount: 0, total: 88 },
          ],
          subtotal: 317,
          discountType: 'fixed',
          discountValue: 7,
          discountAmount: 7,
          taxRate: 0,
          taxAmount: 0,
          total: 310,
          paidAmount: 200,
          remainingAmount: 110,
          changeGiven: 0,
          paymentMethod: 'cash',
          paymentSplits: [{ method: 'cash', amount: 200 }],
          status: 'partial',
          isCredit: true,
          idempotencyKey: 'seed-vnt-1001',
          notes: 'باقي المبلغ يسدد نهاية الأسبوع',
        },
        {
          id: 2,
          invoiceNumber: 'VNT-1002',
          date: daysAgoIso(2, 16, 45),
          customerId: 4,
          customerName: 'مقهى السعادة (يوسف التازي)',
          sellerId: 2,
          sellerName: 'سلمى بنعلي (بائعة)',
          items: [
            { productId: 2, productName: 'حليب سنطرال كامل الدسم 1 لتر', barcode: '6111035000202', unit: 'علبة', quantity: 15, unitPrice: 10, costPrice: 8.4, discount: 0, total: 150 },
            { productId: 4, productName: 'شاي أخضر سلطان 200 غ', barcode: '6111035000404', unit: 'علبة', quantity: 8, unitPrice: 18, costPrice: 14, discount: 0, total: 144 },
            { productId: 7, productName: 'ماء معدني سيدي علي 1.5 لتر', barcode: '6111035000707', unit: 'قنينة', quantity: 24, unitPrice: 6, costPrice: 4.1, discount: 0, total: 144 },
          ],
          subtotal: 438,
          discountType: 'fixed',
          discountValue: 0,
          discountAmount: 0,
          taxRate: 0,
          taxAmount: 0,
          total: 438,
          paidAmount: 0,
          remainingAmount: 438,
          changeGiven: 0,
          paymentMethod: 'credit',
          paymentSplits: [],
          status: 'unpaid',
          isCredit: true,
          idempotencyKey: 'seed-vnt-1002',
        },
        {
          id: 3,
          invoiceNumber: 'VNT-1003',
          date: daysAgoIso(1, 11, 10),
          customerId: 1,
          customerName: 'زبون عابر (نقدي)',
          sellerId: 2,
          sellerName: 'سلمى بنعلي (بائعة)',
          items: [
            { productId: 6, productName: 'دقيق ممتاز ميمونة 5 كغ', barcode: '6111035000606', unit: 'حزمة', quantity: 4, unitPrice: 29, costPrice: 24.5, discount: 0, total: 116 },
            { productId: 8, productName: 'جبن مثلثات لافاش كيري 16 قطعة', barcode: '6111035000808', unit: 'علبة', quantity: 5, unitPrice: 21.5, costPrice: 17.5, discount: 0, total: 107.5 },
            { productId: 9, productName: 'تفاح أحمر إفران (موزون)', barcode: '2000101000009', unit: 'كيلوغرام', quantity: 2.5, unitPrice: 15, costPrice: 11, discount: 0, total: 37.5 },
          ],
          subtotal: 261,
          discountType: 'fixed',
          discountValue: 0,
          discountAmount: 0,
          taxRate: 0,
          taxAmount: 0,
          total: 261,
          paidAmount: 261,
          remainingAmount: 0,
          changeGiven: 39,
          paymentMethod: 'cash',
          paymentSplits: [{ method: 'cash', amount: 261 }],
          status: 'paid',
          isCredit: false,
          idempotencyKey: 'seed-vnt-1003',
        },
        {
          id: 4,
          invoiceNumber: 'VNT-1004',
          date: daysAgoIso(0, 9, 40),
          customerId: 3,
          customerName: 'فاطمة الزهراء المنصوري',
          sellerId: 1,
          sellerName: 'محمد العلمي (المدير)',
          items: [
            { productId: 1, productName: 'زيت المائدة لوسيور 2 لتر', barcode: '6111035000101', unit: 'قنينة', quantity: 4, unitPrice: 37, costPrice: 31.5, discount: 0, total: 148 },
            { productId: 5, productName: 'مسحوق غسيل أريال 1.5 كغ', barcode: '6111035000505', unit: 'حزمة', quantity: 3, unitPrice: 44, costPrice: 36, discount: 0, total: 132 },
            { productId: 2, productName: 'حليب سنطرال كامل الدسم 1 لتر', barcode: '6111035000202', unit: 'علبة', quantity: 6, unitPrice: 10, costPrice: 8.4, discount: 0, total: 60 },
          ],
          subtotal: 340,
          discountType: 'fixed',
          discountValue: 10,
          discountAmount: 10,
          taxRate: 0,
          taxAmount: 0,
          total: 330,
          paidAmount: 330,
          remainingAmount: 0,
          changeGiven: 0,
          paymentMethod: 'card',
          paymentSplits: [{ method: 'card', amount: 330 }],
          status: 'paid',
          isCredit: false,
          idempotencyKey: 'seed-vnt-1004',
        },
      ]);

      // Sample Installment schedules for existing credit invoices
      await db.installments.bulkAdd([
        {
          id: 1,
          saleInvoiceId: 1,
          saleInvoiceNumber: 'VNT-1001',
          customerId: 2,
          customerName: 'أحمد الإدريسي',
          installmentNumber: 1,
          totalInstallments: 1,
          dueDate: daysFromNowDate(3),
          amount: 110,
          paidAmount: 0,
          remainingAmount: 110,
          status: 'pending',
          notes: 'قسط باقي الفاتورة VNT-1001',
        },
        {
          id: 2,
          saleInvoiceId: 2,
          saleInvoiceNumber: 'VNT-1002',
          customerId: 4,
          customerName: 'مقهى السعادة (يوسف التازي)',
          installmentNumber: 1,
          totalInstallments: 2,
          dueDate: daysFromNowDate(-1),
          amount: 219,
          paidAmount: 0,
          remainingAmount: 219,
          status: 'overdue',
          notes: 'القسط الأول من VNT-1002',
        },
        {
          id: 3,
          saleInvoiceId: 2,
          saleInvoiceNumber: 'VNT-1002',
          customerId: 4,
          customerName: 'مقهى السعادة (يوسف التازي)',
          installmentNumber: 2,
          totalInstallments: 2,
          dueDate: daysFromNowDate(14),
          amount: 219,
          paidAmount: 0,
          remainingAmount: 219,
          status: 'pending',
          notes: 'القسط الثاني من VNT-1002',
        },
      ]);

      // Customer Payments (sequential refNumber starting at 1)
      await db.customerPayments.bulkAdd([
        {
          id: 1,
          refNumber: 1,
          date: daysAgoIso(4, 14, 20),
          customerId: 2,
          customerName: 'أحمد الإدريسي',
          invoiceIds: [1],
          invoiceNumbers: ['VNT-1001'],
          amount: 200,
          remainingAfter: 110,
          paymentMethod: 'cash',
          userId: 1,
          userName: 'محمد العلمي (المدير)',
          notes: 'تسبيق عند الفاتورة',
          idempotencyKey: 'seed-cpay-1',
        },
        {
          id: 2,
          refNumber: 2,
          date: daysAgoIso(0, 9, 40),
          customerId: 3,
          customerName: 'فاطمة الزهراء المنصوري',
          invoiceIds: [4],
          invoiceNumbers: ['VNT-1004'],
          amount: 330,
          remainingAfter: 0,
          paymentMethod: 'card',
          userId: 1,
          userName: 'محمد العلمي (المدير)',
          notes: 'أداء بالبطاقة البنكية',
          idempotencyKey: 'seed-cpay-2',
        },
      ]);

      // Supplier Payments (sequential refNumber starting at 1)
      await db.supplierPayments.bulkAdd([
        {
          id: 1,
          refNumber: 1,
          date: daysAgoIso(10, 9, 15),
          supplierId: 1,
          supplierName: 'شركة الأطلس لتوزيع المواد الغذائية',
          purchaseIds: [1],
          purchaseNumbers: ['ACH-2001'],
          amount: 2000,
          remainingAfter: 870,
          paymentMethod: 'bank_transfer',
          userId: 1,
          userName: 'محمد العلمي (المدير)',
          notes: 'تحويل بنكي أول',
          idempotencyKey: 'seed-spay-1',
        },
        {
          id: 2,
          refNumber: 2,
          date: daysAgoIso(5, 11, 0),
          supplierId: 2,
          supplierName: 'تعاونية الشاوية للألبان',
          purchaseIds: [2],
          purchaseNumbers: ['ACH-2002'],
          amount: 1022,
          remainingAfter: 0,
          paymentMethod: 'cash',
          userId: 1,
          userName: 'محمد العلمي (المدير)',
          notes: 'أداء كامل عند التسليم',
          idempotencyKey: 'seed-spay-2',
        },
      ]);

      // Expenses
      await db.expenses.bulkAdd([
        {
          id: 1,
          name: 'فاتورة الكهرباء والماء — الشهر الحالي',
          category: 'electricity_water',
          amount: 145,
          date: daysAgoIso(3, 12, 0),
          paymentMethod: 'cash',
          userId: 1,
          userName: 'محمد العلمي (المدير)',
          notes: 'أداء وكالة التوزيع',
        },
        {
          id: 2,
          name: 'مصاريف النقل والتفريغ',
          category: 'transport',
          amount: 80,
          date: daysAgoIso(1, 15, 0),
          paymentMethod: 'cash',
          userId: 1,
          userName: 'محمد العلمي (المدير)',
          notes: 'توصيل بضائع المستودع',
        },
      ]);

      // Stock Movements matching purchases & sales
      await db.stockMovements.bulkAdd([
        { date: daysAgoIso(10, 9, 15), productId: 1, productName: 'زيت المائدة لوسيور 2 لتر', barcode: '6111035000101', type: 'purchase', quantityDelta: 50, beforeQty: 0, afterQty: 50, unitCost: 31.5, unitPrice: 37, referenceNumber: 'ACH-2001', userId: 1, userName: 'محمد العلمي (المدير)' },
        { date: daysAgoIso(5, 11, 0), productId: 2, productName: 'حليب سنطرال كامل الدسم 1 لتر', barcode: '6111035000202', type: 'purchase', quantityDelta: 80, beforeQty: 6, afterQty: 86, unitCost: 8.4, unitPrice: 10, referenceNumber: 'ACH-2002', userId: 1, userName: 'محمد العلمي (المدير)' },
        { date: daysAgoIso(4, 14, 20), productId: 1, productName: 'زيت المائدة لوسيور 2 لتر', barcode: '6111035000101', type: 'sale', quantityDelta: -4, beforeQty: 50, afterQty: 46, unitCost: 31.5, unitPrice: 37, referenceNumber: 'VNT-1001', userId: 1, userName: 'محمد العلمي (المدير)' },
        { date: daysAgoIso(2, 16, 45), productId: 2, productName: 'حليب سنطرال كامل الدسم 1 لتر', barcode: '6111035000202', type: 'sale', quantityDelta: -15, beforeQty: 86, afterQty: 71, unitCost: 8.4, unitPrice: 10, referenceNumber: 'VNT-1002', userId: 2, userName: 'سلمى بنعلي (بائعة)' },
        { date: daysAgoIso(0, 9, 40), productId: 1, productName: 'زيت المائدة لوسيور 2 لتر', barcode: '6111035000101', type: 'sale', quantityDelta: -4, beforeQty: 46, afterQty: 42, unitCost: 31.5, unitPrice: 37, referenceNumber: 'VNT-1004', userId: 1, userName: 'محمد العلمي (المدير)' },
        { date: daysAgoIso(0, 9, 40), productId: 2, productName: 'حليب سنطرال كامل الدسم 1 لتر', barcode: '6111035000202', type: 'sale', quantityDelta: -6, beforeQty: 71, afterQty: 65, unitCost: 8.4, unitPrice: 10, referenceNumber: 'VNT-1004', userId: 1, userName: 'محمد العلمي (المدير)' },
      ]);

      await db.auditLogs.add({
        date: daysAgoIso(0, 9, 0),
        userId: 1,
        userName: 'محمد العلمي (المدير)',
        action: 'SYSTEM_INIT',
        entityType: 'database',
        entityId: '1',
        details: 'تهيئة قاعدة البيانات المحلية بنجاح مع بيانات متجر نموذجية جاهزة للعمل الفعلي',
      });
    }
  );
}
