import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  CASHIER_PERMISSIONS,
  MANAGER_PERMISSIONS,
  completeFirstRunSetup,
  createDefaultSettings,
  db,
  ensureDatabaseInitialized,
  resetDatabaseInitState,
} from '../database';
import * as ops from '../operations';
import { AppUser } from '../../types';

const makeUser = (
  id: number,
  username: string,
  role: AppUser['role'],
  permissions: AppUser['permissions']
): AppUser => ({
  id,
  username,
  fullName: username,
  role,
  passwordHash: 'hash',
  passwordSalt: 'salt',
  permissions: { ...permissions },
  isActive: true,
  createdAt: new Date().toISOString(),
});

const adminUser = makeUser(1, 'admin', 'admin', ADMIN_PERMISSIONS);
const managerUser = makeUser(2, 'manager', 'manager', MANAGER_PERMISSIONS);
const cashierUser = makeUser(3, 'cashier', 'cashier', CASHIER_PERMISSIONS);

async function resetDbForOps() {
  resetDatabaseInitState();
  await db.delete();
  await db.open();
  await db.settings.put(createDefaultSettings());
  await db.users.bulkPut([adminUser, managerUser, cashierUser]);
  await db.customers.bulkPut([
    {
      id: 1,
      fullName: 'زبون عابر',
      phone: '',
      address: '',
      creditLimit: 0,
      openingBalance: 0,
      creditBalance: 0,
      createdAt: new Date().toISOString(),
    },
    {
      id: 2,
      fullName: 'أحمد التاجر',
      phone: '0600000001',
      address: 'الدار البيضاء',
      creditLimit: 5000,
      openingBalance: 0,
      creditBalance: 0,
      createdAt: new Date().toISOString(),
    },
  ]);
  await db.suppliers.put({
    id: 1,
    businessName: 'مورد الشمال',
    phone: '0522000001',
    address: 'طنجة',
    openingBalance: 0,
    creditBalance: 0,
    createdAt: new Date().toISOString(),
  });
}

describe('First-run onboarding & secure defaults', () => {
  beforeEach(async () => {
    resetDatabaseInitState();
    await db.delete();
    await db.open();
  });

  it('initializes with zero seeded users, login required on startup, and backup encryption on by default', async () => {
    await ensureDatabaseInitialized();
    const usersCount = await db.users.count();
    const productsCount = await db.products.count();
    const settings = await db.settings.get(1);

    expect(usersCount).toBe(0);
    expect(productsCount).toBe(0);
    expect(settings?.security.requireLoginOnStartup).toBe(true);
    expect(settings?.backupConfig.encryptBackupsDefault).toBe(true);
  });

  it('completeFirstRunSetup enforces password >= 6 chars and respects optional demo data flag', async () => {
    await ensureDatabaseInitialized();

    await expect(
      completeFirstRunSetup({
        storeName: 'متجر التجربة',
        currency: 'MAD',
        defaultLanguage: 'ar',
        adminUsername: 'boss',
        adminFullName: 'المدير',
        adminPassword: '123',
        loadDemoData: false,
      })
    ).rejects.toThrow();

    const admin = await completeFirstRunSetup({
      storeName: 'متجر التجربة',
      currency: 'MAD',
      defaultLanguage: 'ar',
      adminUsername: 'boss',
      adminFullName: 'المدير العام',
      adminPassword: 'StrongPassword123',
      loadDemoData: false,
    });

    expect(admin.username).toBe('boss');
    expect(admin.role).toBe('admin');
    expect(await db.users.count()).toBe(1);
    expect(await db.products.count()).toBe(0);

    // Repeat with loadDemoData: true on fresh DB
    resetDatabaseInitState();
    await db.delete();
    await db.open();
    await ensureDatabaseInitialized();
    await completeFirstRunSetup({
      storeName: 'متجر مع بيانات',
      currency: 'MAD',
      defaultLanguage: 'ar',
      adminUsername: 'owner',
      adminFullName: 'المالك',
      adminPassword: 'StrongPassword123',
      loadDemoData: true,
    });
    expect(await db.products.count()).toBeGreaterThan(0);
  });
});

describe('POS Price Override & Discount Ceiling Enforcement (service layer)', () => {
  let prodId: number;

  beforeEach(async () => {
    await resetDbForOps();
    prodId = await ops.createProductWithOpeningStock(
      {
        name: 'قهوة عربية',
        sku: 'COF-1',
        barcode: '555111',
        categoryId: null,
        unit: 'علبة',
        purchasePrice: 40,
        salePrice: 100,
        wholesalePrice: 90,
        secondSalePrice: 95,
        quantity: 50,
        minStock: 5,
        isActive: true,
        isWeighted: false,
      },
      adminUser
    );
  });

  it('blocks cashier from overriding price or giving any discount inside createSaleInvoice', async () => {
    // Price override attempt (80 instead of catalog 100/90/95)
    await expect(
      ops.createSaleInvoice(
        {
          customerId: 1,
          customerName: 'زبون عابر',
          items: [
            {
              productId: prodId,
              productName: 'قهوة عربية',
              barcode: '555111',
              unit: 'علبة',
              quantity: 1,
              unitPrice: 80,
              costPrice: 40,
              discount: 0,
              total: 80,
            },
          ],
          discountType: 'fixed',
          discountValue: 0,
          taxRate: 0,
          paymentSplits: [{ method: 'cash', amount: 80 }],
          tenderedAmount: 80,
          isCredit: false,
          idempotencyKey: 'cashier-price-override',
        },
        cashierUser
      )
    ).rejects.toThrow();

    // Invoice discount attempt by cashier
    await expect(
      ops.createSaleInvoice(
        {
          customerId: 1,
          customerName: 'زبون عابر',
          items: [
            {
              productId: prodId,
              productName: 'قهوة عربية',
              barcode: '555111',
              unit: 'علبة',
              quantity: 1,
              unitPrice: 100,
              costPrice: 40,
              discount: 0,
              total: 100,
            },
          ],
          discountType: 'percent',
          discountValue: 5,
          taxRate: 0,
          paymentSplits: [{ method: 'cash', amount: 95 }],
          tenderedAmount: 95,
          isCredit: false,
          idempotencyKey: 'cashier-disc',
        },
        cashierUser
      )
    ).rejects.toThrow();

    // Standard catalog price with zero discount succeeds
    const valid = await ops.createSaleInvoice(
      {
        customerId: 1,
        customerName: 'زبون عابر',
        items: [
          {
            productId: prodId,
            productName: 'قهوة عربية',
            barcode: '555111',
            unit: 'علبة',
            quantity: 1,
            unitPrice: 100,
            costPrice: 40,
            discount: 0,
            total: 100,
          },
        ],
        discountType: 'fixed',
        discountValue: 0,
        taxRate: 0,
        paymentSplits: [{ method: 'cash', amount: 100 }],
        tenderedAmount: 100,
        isCredit: false,
        idempotencyKey: 'cashier-ok',
      },
      cashierUser
    );
    expect(valid.total).toBe(100);
  });

  it('enforces maxDiscountPercent ceiling for manager across line + invoice discounts', async () => {
    // Manager maxDiscountPercent is 30%. Line discount 20 + invoice discount 15 on 100 = 35% -> must reject
    await expect(
      ops.createSaleInvoice(
        {
          customerId: 1,
          customerName: 'زبون عابر',
          items: [
            {
              productId: prodId,
              productName: 'قهوة عربية',
              barcode: '555111',
              unit: 'علبة',
              quantity: 1,
              unitPrice: 100,
              costPrice: 40,
              discount: 20,
              total: 80,
            },
          ],
          discountType: 'fixed',
          discountValue: 15,
          taxRate: 0,
          paymentSplits: [{ method: 'cash', amount: 65 }],
          tenderedAmount: 65,
          isCredit: false,
          idempotencyKey: 'mgr-over-cap',
        },
        managerUser
      )
    ).rejects.toThrow();

    // Manager custom price (85) + 20% discount -> allowed
    const allowed = await ops.createSaleInvoice(
      {
        customerId: 1,
        customerName: 'زبون عابر',
        items: [
          {
            productId: prodId,
            productName: 'قهوة عربية',
            barcode: '555111',
            unit: 'علبة',
            quantity: 1,
            unitPrice: 85,
            costPrice: 40,
            discount: 0,
            total: 85,
          },
        ],
        discountType: 'percent',
        discountValue: 20,
        taxRate: 0,
        paymentSplits: [{ method: 'cash', amount: 68 }],
        tenderedAmount: 68,
        isCredit: false,
        idempotencyKey: 'mgr-within-cap',
      },
      managerUser
    );
    expect(allowed.total).toBe(68);
  });
});

describe('Cash Sessions & Drawer Reconciliation (version 3)', () => {
  beforeEach(async () => {
    await resetDbForOps();
  });

  it('computes exact expectedCash formula without double-counting POS sales and calculates variance', async () => {
    const prodId = await ops.createProductWithOpeningStock(
      {
        name: 'عسل',
        sku: 'HNY-1',
        barcode: '777',
        categoryId: null,
        unit: 'قنينة',
        purchasePrice: 50,
        salePrice: 100,
        wholesalePrice: 90,
        secondSalePrice: 95,
        quantity: 20,
        minStock: 2,
        isActive: true,
        isWeighted: false,
      },
      adminUser
    );

    // Pre-existing credit sale (before shift opens) to collect cash on during the shift
    const priorCreditSale = await ops.createSaleInvoice(
      {
        customerId: 2,
        customerName: 'أحمد التاجر',
        items: [
          {
            productId: prodId,
            productName: 'عسل',
            barcode: '777',
            unit: 'قنينة',
            quantity: 2,
            unitPrice: 100,
            costPrice: 50,
            discount: 0,
            total: 200,
          },
        ],
        discountType: 'fixed',
        discountValue: 0,
        taxRate: 0,
        paymentSplits: [],
        tenderedAmount: 0,
        isCredit: true,
        idempotencyKey: 'prior-credit',
      },
      adminUser
    );
    // Backdate prior sale slightly so it's strictly before shift opening
    await db.saleInvoices.update(priorCreditSale.id!, {
      date: new Date(Date.now() - 60_000).toISOString(),
    });

    // Open shift with openingBalance = 500
    const session = await ops.openCashSession(500, adminUser, 'وردية الصباح');
    expect(session.status).toBe('open');
    await expect(ops.openCashSession(100, adminUser)).rejects.toThrow();

    // 1) Cash sale to registered customer (200) -> must count ONCE in cashSales (NOT again in cashCollections)
    const sale1 = await ops.createSaleInvoice(
      {
        customerId: 2,
        customerName: 'أحمد التاجر',
        items: [
          {
            productId: prodId,
            productName: 'عسل',
            barcode: '777',
            unit: 'قنينة',
            quantity: 2,
            unitPrice: 100,
            costPrice: 50,
            discount: 0,
            total: 200,
          },
        ],
        discountType: 'fixed',
        discountValue: 0,
        taxRate: 0,
        paymentSplits: [{ method: 'cash', amount: 200 }],
        tenderedAmount: 200,
        isCredit: false,
        idempotencyKey: 'shift-sale-cash',
      },
      adminUser
    );

    // Card sale (100) -> must NOT affect cashSales
    await ops.createSaleInvoice(
      {
        customerId: 1,
        customerName: 'زبون عابر',
        items: [
          {
            productId: prodId,
            productName: 'عسل',
            barcode: '777',
            unit: 'قنينة',
            quantity: 1,
            unitPrice: 100,
            costPrice: 50,
            discount: 0,
            total: 100,
          },
        ],
        discountType: 'fixed',
        discountValue: 0,
        taxRate: 0,
        paymentSplits: [{ method: 'card', amount: 100 }],
        tenderedAmount: 100,
        isCredit: false,
        idempotencyKey: 'shift-sale-card',
      },
      adminUser
    );

    // 2) Cash collection on prior debt = 150
    await ops.recordCustomerPayment(
      {
        customerId: 2,
        customerName: 'أحمد التاجر',
        amount: 150,
        paymentMethod: 'cash',
        date: new Date().toISOString(),
        invoiceIds: [priorCreditSale.id!],
        notes: 'تحصيل قسط',
        idempotencyKey: 'shift-coll-1',
      },
      adminUser
    );

    // 3) Cash refund (return 1 unit from sale1 = 100)
    await ops.createSaleReturn(
      sale1.id!,
      [{ productId: prodId, productName: 'عسل', barcode: '777', quantity: 1, unitPrice: 100, costPrice: 50, total: 100 }],
      'cash',
      'إرجاع',
      adminUser
    );

    // 4) Cash expense = 40 (and bank expense = 60 ignored)
    await ops.addExpenseRecord(
      {
        name: 'كهرباء',
        category: 'utilities',
        amount: 40,
        paymentMethod: 'cash',
        date: new Date().toISOString(),
      },
      adminUser
    );
    await ops.addExpenseRecord(
      {
        name: 'إنترنت',
        category: 'utilities',
        amount: 60,
        paymentMethod: 'bank_transfer',
        date: new Date().toISOString(),
      },
      adminUser
    );

    // 5) Cash supplier payment = 70
    await ops.createPurchaseInvoice(
      {
        supplierId: 1,
        supplierName: 'مورد الشمال',
        items: [
          {
            productId: prodId,
            productName: 'عسل',
            barcode: '777',
            unit: 'قنينة',
            quantity: 2,
            unitCost: 50,
            discount: 0,
            total: 100,
          },
        ],
        discountAmount: 0,
        paidAmount: 70,
        paymentMethod: 'cash',
        costingMethod: 'weighted_avg',
        idempotencyKey: 'shift-pur-1',
      },
      adminUser
    );

    // Expected: 500 + 200 + 150 - 100 - 40 - 70 = 640
    const closed = await ops.closeCashSession(session.id!, 635, adminUser, 'نقص 5 دراهم');
    expect(closed.openingBalance).toBe(500);
    expect(closed.cashSales).toBe(200);
    expect(closed.cashCollections).toBe(150);
    expect(closed.cashRefunds).toBe(100);
    expect(closed.cashExpenses).toBe(40);
    expect(closed.cashSupplierPayments).toBe(70);
    expect(closed.expectedCash).toBe(640);
    expect(closed.countedCash).toBe(635);
    expect(closed.variance).toBe(-5);
    expect(closed.status).toBe('closed');
  });
});

describe('External Encrypted Backups, Pre-Restore/Pre-Reset Safety Backups & Audit Cleanup', () => {
  beforeEach(async () => {
    await resetDbForOps();
  });

  it('requires encryption by default, omits payloadJson from IndexedDB, auto-backs up before restore & reset, and clears auditLogs on fresh start', async () => {
    // 1) Encryption default requires passphrase
    await expect(
      ops.createBackupRecord('manual', 'بدون كلمة سر', null, adminUser, { skipExternalWrite: true })
    ).rejects.toThrow();

    // 2) Encrypted backup stores metadata only (NO payloadJson in db.backups)
    const backup = await ops.createBackupRecord('manual', 'نسخة مشفرة', 'MySecretPass99', adminUser, {
      skipExternalWrite: true,
    });
    expect(backup.encrypted).toBe(true);
    const savedRow = await db.backups.get(backup.id!);
    expect(savedRow?.payloadJson).toBeUndefined();
    expect(savedRow?.fileName).toContain('.enc.json');

    // 3) Restore creates a pre-restore auto backup
    const backupsBeforeRestore = await db.backups.count();
    await ops.restoreDatabaseFromEnvelope(backup.envelope, 'MySecretPass99', adminUser, {
      preBackupPassphrase: 'MySecretPass99',
      skipExternalWrite: true,
    });
    const backupsAfterRestore = await db.backups.count();
    expect(backupsAfterRestore).toBe(backupsBeforeRestore + 1);

    // 4) Open a cash session + add audit logs, then clearBusinessDataForFreshStart
    await ops.openCashSession(100, adminUser);
    await ops.logAudit(adminUser, 'CUSTOM_ACTION', 'test', 1, 'سجل قديم');
    expect(await db.auditLogs.count()).toBeGreaterThan(0);
    expect(await db.cashSessions.count()).toBe(1);

    const backupsBeforeClear = await db.backups.count();
    await ops.clearBusinessDataForFreshStart(adminUser, {
      backupPassphrase: 'MySecretPass99',
      skipExternalWrite: true,
    });

    // Pre-reset safety backup recorded, auditLogs & cashSessions cleared
    expect(await db.backups.count()).toBe(backupsBeforeClear + 1);
    expect(await db.auditLogs.count()).toBe(0);
    expect(await db.cashSessions.count()).toBe(0);
    // Users & walk-in customer preserved
    expect(await db.users.count()).toBe(3);
    expect((await db.customers.get(1))?.fullName).toContain('زبون عابر');
  });
});
