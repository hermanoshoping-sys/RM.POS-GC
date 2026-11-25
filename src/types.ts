export type Language = 'ar' | 'fr';

export type SectionId =
  | 'home'
  | 'dashboard'
  | 'customers'
  | 'suppliers'
  | 'categories'
  | 'products'
  | 'pos'
  | 'purchases'
  | 'inventory'
  | 'stocktake'
  | 'payments'
  | 'reports'
  | 'profit_reports'
  | 'settings';

export type PaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'check' | 'credit';

export type InvoiceStatus = 'paid' | 'partial' | 'unpaid' | 'cancelled';

export type UserRole = 'admin' | 'manager' | 'cashier' | 'stock_keeper';

export interface UserPermissions {
  canSell: boolean;
  canCancelSale: boolean;
  canEditInvoice: boolean;
  canPurchase: boolean;
  canManageProducts: boolean;
  canManageCustomers: boolean;
  canManageSuppliers: boolean;
  canDeleteRecords: boolean;
  canViewReports: boolean;
  canViewProfits: boolean;
  canManageSettings: boolean;
  canRestoreCancelled: boolean;
}

export interface AppUser {
  id?: number;
  username: string;
  fullName: string;
  role: UserRole;
  passwordHash: string;
  passwordSalt: string;
  permissions: UserPermissions;
  isActive: boolean;
  createdAt: string;
}

export interface Category {
  id?: number;
  nameAr: string;
  nameFr: string;
  parentId: number | null;
  icon: string;
  imageUrl?: string;
  description: string;
  sortOrder: number;
  createdAt: string;
}

export interface Product {
  id?: number;
  name: string;
  sku: string;
  barcode: string;
  categoryId: number | null;
  unit: string;
  purchasePrice: number;
  salePrice: number;
  wholesalePrice: number;
  secondSalePrice: number;
  quantity: number;
  minStock: number;
  expiryDate?: string;
  lotNumber?: string;
  isActive: boolean;
  isWeighted: boolean;
  imageUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PriceHistory {
  id?: number;
  productId: number;
  productName: string;
  oldPurchasePrice: number;
  newPurchasePrice: number;
  oldSalePrice: number;
  newSalePrice: number;
  changedBy: string;
  changedAt: string;
  note?: string;
}

export interface Customer {
  id?: number;
  fullName: string;
  phone: string;
  address: string;
  creditLimit: number;
  openingBalance: number;
  creditBalance?: number; // Surplus / advance credit owed to customer
  notes?: string;
  createdAt: string;
}

export interface Supplier {
  id?: number;
  businessName: string;
  phone: string;
  address: string;
  taxId?: string;
  openingBalance: number;
  creditBalance?: number; // Advance credit with supplier
  notes?: string;
  createdAt: string;
}

export type InstallmentFrequency = 'weekly' | 'biweekly' | 'monthly';
export type InstallmentStatus = 'pending' | 'partial' | 'paid' | 'overdue';

export interface Installment {
  id?: number;
  saleInvoiceId: number;
  saleInvoiceNumber: string;
  customerId: number;
  customerName: string;
  installmentNumber: number;
  totalInstallments: number;
  dueDate: string; // YYYY-MM-DD
  amount: number;
  paidAmount: number;
  remainingAmount: number;
  status: InstallmentStatus;
  paidAt?: string;
  notes?: string;
}

export interface PaymentSplit {
  method: PaymentMethod;
  amount: number;
}

export interface SaleInvoiceItem {
  productId: number;
  productName: string;
  barcode: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  costPrice: number; // COGS snapshot at sale time
  discount: number;
  total: number;
  returnedQty?: number;
}

export interface SaleInvoice {
  id?: number;
  invoiceNumber: string;
  date: string;
  customerId: number | null;
  customerName: string;
  sellerId: number;
  sellerName: string;
  items: SaleInvoiceItem[];
  subtotal: number;
  discountType: 'fixed' | 'percent';
  discountValue: number;
  discountAmount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  paidAmount: number;
  remainingAmount: number;
  changeGiven: number;
  paymentMethod: PaymentMethod;
  paymentSplits: PaymentSplit[];
  status: InvoiceStatus;
  isCredit: boolean;
  dueDate?: string;
  installmentCount?: number;
  installmentFrequency?: InstallmentFrequency;
  creditApplied?: number;
  cancelReason?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  idempotencyKey: string;
  notes?: string;
}

export interface SaleReturnItem {
  productId: number;
  productName: string;
  barcode: string;
  quantity: number;
  unitPrice: number;
  costPrice: number;
  total: number;
}

export interface SaleReturn {
  id?: number;
  returnNumber: string;
  saleInvoiceId: number;
  saleInvoiceNumber: string;
  date: string;
  customerId: number | null;
  customerName: string;
  items: SaleReturnItem[];
  totalAmount: number;
  totalCost: number;
  debtReduction?: number; // Portion deducted from unpaid invoice balance
  cashRefund?: number; // Portion actually refunded in cash/card/bank or credited
  creditAdded?: number; // Portion added to customer.creditBalance when refunded as store credit
  refundMethod: PaymentMethod;
  userId: number;
  userName: string;
  reason: string;
}

export interface HeldCart {
  id?: number;
  label: string;
  customerId: number | null;
  items: SaleInvoiceItem[];
  discountType: 'fixed' | 'percent';
  discountValue: number;
  createdAt: string;
  sellerName: string;
}

export interface PurchaseInvoiceItem {
  productId: number;
  productName: string;
  barcode: string;
  unit: string;
  quantity: number;
  unitCost: number;
  discount: number;
  total: number;
  returnedQty?: number;
}

export interface PurchaseInvoice {
  id?: number;
  invoiceNumber: string;
  date: string;
  supplierId: number;
  supplierName: string;
  userId: number;
  userName: string;
  items: PurchaseInvoiceItem[];
  subtotal: number;
  discountAmount: number;
  total: number;
  paidAmount: number;
  remainingAmount: number;
  paymentMethod: PaymentMethod;
  status: InvoiceStatus;
  costingMethod: 'weighted_avg' | 'last_cost';
  cancelReason?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  idempotencyKey: string;
  notes?: string;
}

export interface SupplierReturnItem {
  productId: number;
  productName: string;
  barcode: string;
  quantity: number;
  unitCost: number;
  total: number;
}

export interface SupplierReturn {
  id?: number;
  returnNumber: string;
  purchaseInvoiceId: number;
  purchaseInvoiceNumber: string;
  date: string;
  supplierId: number;
  supplierName: string;
  items: SupplierReturnItem[];
  totalAmount: number;
  settlementMethod: 'cash' | 'credit_note' | 'bank_transfer';
  userId: number;
  userName: string;
  reason: string;
}

export type StockMovementType =
  | 'sale'
  | 'sale_return'
  | 'sale_cancel'
  | 'purchase'
  | 'supplier_return'
  | 'purchase_cancel'
  | 'adjustment'
  | 'damage'
  | 'loss';

export interface StockMovement {
  id?: number;
  date: string;
  productId: number;
  productName: string;
  barcode: string;
  type: StockMovementType;
  quantityDelta: number;
  beforeQty: number;
  afterQty: number;
  unitCost: number;
  unitPrice: number;
  referenceNumber: string;
  userId: number;
  userName: string;
  note?: string;
}

export interface CustomerPayment {
  id?: number;
  refNumber: number; // Sequential starting from 1
  date: string;
  customerId: number;
  customerName: string;
  invoiceIds: number[];
  invoiceNumbers: string[];
  amount: number;
  openingBalancePaid?: number;
  creditAdded?: number;
  remainingAfter: number;
  paymentMethod: PaymentMethod;
  userId: number;
  userName: string;
  notes?: string;
  isCancelled?: boolean;
  idempotencyKey: string;
}

export interface SupplierPayment {
  id?: number;
  refNumber: number; // Sequential starting from 1
  date: string;
  supplierId: number;
  supplierName: string;
  purchaseIds: number[];
  purchaseNumbers: string[];
  amount: number;
  openingBalancePaid?: number;
  creditAdded?: number;
  remainingAfter: number;
  paymentMethod: PaymentMethod;
  userId: number;
  userName: string;
  notes?: string;
  isCancelled?: boolean;
  idempotencyKey: string;
}

export interface Expense {
  id?: number;
  name: string;
  category: string;
  amount: number;
  date: string;
  paymentMethod: PaymentMethod;
  userId: number;
  userName: string;
  notes?: string;
  attachmentDataUrl?: string;
  isCancelled?: boolean;
}

export interface AuditLog {
  id?: number;
  date: string;
  userId: number;
  userName: string;
  action: string;
  entityType: string;
  entityId: string;
  details: string;
  canRestore?: boolean;
  restored?: boolean;
}

export interface LoginLog {
  id?: number;
  date: string;
  username: string;
  status: 'success' | 'failed' | 'logout' | 'locked';
  details: string;
}

export interface BackupRecord {
  id?: number;
  date: string;
  type: 'manual' | 'auto';
  sizeBytes: number;
  encrypted: boolean;
  checksum: string;
  label: string;
  payloadJson: string;
}

export type InvoiceSurfaceBg = 'transparent' | 'light' | 'gold' | 'navy';
export type InvoiceBorderStyle = 'none' | 'solid' | 'dashed' | 'double';
export type InvoiceLogoShape = 'none' | 'rounded' | 'circle';
export type InvoiceAlign = 'right' | 'center' | 'left';

export interface InvoiceFormatConfig {
  template: 'classic' | 'modern' | 'compact';
  fontSize: number; // px
  // Header controls
  showHeader: boolean;
  headerAlign: InvoiceAlign;
  headerFontSize: number; // px for store title
  headerPaddingY: number; // px vertical padding
  headerBgColor: InvoiceSurfaceBg;
  headerBorderStyle: InvoiceBorderStyle;
  showCustomHeader: boolean;
  // Logo controls
  showLogo: boolean;
  logoWidth: number; // px
  logoHeight: number; // px
  logoKeepAspect: boolean;
  logoShape: InvoiceLogoShape;
  logoAlign: 'inherit' | InvoiceAlign;
  // Header field toggles
  showStoreName: boolean;
  showAddress: boolean;
  showPhone: boolean;
  showActivity: boolean;
  showTaxId: boolean;
  showExtraHeader: boolean;
  // Body toggles
  showCustomerInfo: boolean;
  showSellerName: boolean;
  showBarcode: boolean;
  showTaxBreakdown: boolean;
  showPaymentSummary: boolean;
  // Footer controls
  showFooter: boolean;
  footerAlign: InvoiceAlign;
  footerFontSize: number; // px
  footerPaddingY: number; // px
  footerBgColor: InvoiceSurfaceBg;
  footerBorderStyle: InvoiceBorderStyle;
  showThankYou: boolean;
  showReturnTerms: boolean;
  showSocialContact: boolean;
  showExtraFooter: boolean;
  showCustomPhrase: boolean;
  showSignatureLine: boolean;
  sectionOrder: ('header' | 'meta' | 'items' | 'totals' | 'footer')[];
}

export type CashDrawerMode = 'serial_escpos' | 'printer_driver';

export interface CashDrawerConfig {
  enabled: boolean;
  mode: CashDrawerMode;
  autoOpenOnCashSale: boolean;
  pin: 0 | 1; // 0 = Pin 2 (default), 1 = Pin 5
  onTimeMs: number;
  offTimeMs: number;
  baudRate: number;
  customHexCommand?: string;
  requireReasonOnManualOpen: boolean;
}

export interface AppSettings {
  id: number; // Always 1
  storeInfo: {
    storeName: string;
    logoDataUrl: string;
    managerName: string;
    activityInfo: string;
    address: string;
    phone: string;
    email: string;
    city: string;
    country: string;
    currency: string;
    taxId: string;
    extraInvoiceInfo: string;
    defaultLanguage: Language;
    taxEnabled: boolean;
    defaultTaxRate: number;
    salePrefix: string;
    saleNextNumber: number;
    purchasePrefix: string;
    purchaseNextNumber: number;
    returnPrefix: string;
    returnNextNumber: number;
    customerPaymentNextRef: number;
    supplierPaymentNextRef: number;
  };
  posConfig: {
    allowNegativeStock: boolean;
    defaultCostingMethod: 'weighted_avg' | 'last_cost';
    defaultPriceTier: 'retail' | 'wholesale' | 'second';
  };
  security: {
    requireLoginOnStartup: boolean;
    requireDeletePassword: boolean;
    deletePasswordHash: string;
    deletePasswordSalt: string;
    requireFinancialConfirm: boolean;
    maxLoginAttempts: number;
    autoLockMinutes: number; // 0 = disabled
  };
  printing: {
    salesFormat: 'a4' | '80mm' | '58mm';
    purchasesFormat: 'a4' | '80mm' | '58mm';
    receiptsFormat: 'a4' | '80mm' | '58mm';
    connectionType: 'browser';
    copies: number;
    autoPrint: boolean;
    previewBeforePrint: boolean;
    marginMm: number;
    barcodeLabelWidthMm: number;
    barcodeLabelHeightMm: number;
    cashDrawer: CashDrawerConfig;
  };
  invoiceCustomization: {
    invoiceLanguage: Language;
    customHeaderText: string;
    thankYouMessage: string;
    returnTerms: string;
    socialContact: string;
    extraFooterInfo: string;
    customFooterPhrase: string;
    signatureLabel: string;
    a4: InvoiceFormatConfig;
    thermal: InvoiceFormatConfig;
  };
  backupConfig: {
    autoBackupEnabled: boolean;
    autoBackupIntervalHours: number;
    lastAutoBackupAt: string | null;
    lastExternalExportAt?: string | null;
    maxRetainedBackups: number;
    encryptBackupsDefault: boolean;
  };
}
