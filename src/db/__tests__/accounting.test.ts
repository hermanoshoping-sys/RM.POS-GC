import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS, createDefaultSettings, db } from '../database';
import * as ops from '../operations';
import { computeDashboardFinancials } from '../../utils/dashboardMetrics';
import { AppUser } from '../../types';

const adminUser: AppUser = {
  id: 1,
  username: 'admin',
  fullName: 'المدير',
  role: 'admin',
  passwordHash: 'hash',
  passwordSalt: 'salt',
  permissions: { ...ADMIN_PERMISSIONS },
  isActive: true,
  createdAt: new Date().toISOString(),
};

async function resetDb() {
  await db.delete();
  await db.open();
  await db.settings.put(createDefaultSettings());
  await db.users.put(adminUser);
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
      fullName: 'أحمد',
      phone: '0600000000',
      address: 'الرباط',
      creditLimit: 10000,
      openingBalance: 0,
      creditBalance: 0,
      createdAt: new Date().toISOString(),
    },
  ]);
  await db.suppliers.put({
    id: 1,
    businessName: 'مورد الأطلس',
    phone: '0522000000',
    address: 'الدار البيضاء',
    openingBalance: 0,
    creditBalance: 0,
    createdAt: new Date().toISOString(),
  });
}

describe('Accounting bugs (TDD Red -> Green)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('Bug 1: product creation records opening_balance stock movement and updateProductWithPriceHistory blocks direct quantity edits', async () => {
    const createFn = (ops as unknown as Record<string, unknown>).createProductWithOpeningStock as
      | ((data: Record<string, unknown>, user: AppUser) => Promise<number>)
      | undefined;
    expect(createFn).toBeTypeOf('function');

    const prodId = await createFn!(
      {
        name: 'زيت زيتون',
        sku: 'OIL-99',
        barcode: '6111999999',
        categoryId: null,
        unit: 'قنينة',
        purchasePrice: 50,
        salePrice: 65,
        wholesalePrice: 60,
        secondSalePrice: 62,
        quantity: 20,
        minStock: 5,
        isActive: true,
        isWeighted: false,
      },
      adminUser
    );

    const movements = await db.stockMovements.where('productId').equals(prodId).toArray();
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe('opening_balance');
    expect(movements[0].quantityDelta).toBe(20);
    expect(movements[0].beforeQty).toBe(0);
    expect(movements[0].afterQty).toBe(20);

    // Editing product must NOT overwrite quantity directly
    await ops.updateProductWithPriceHistory(prodId, { name: 'زيت زيتون ممتاز', quantity: 999 }, adminUser);
    const updated = await db.products.get(prodId);
    expect(updated?.name).toBe('زيت زيتون ممتاز');
    expect(updated?.quantity).toBe(20);
  });

  it('Bug 2: cancelPurchaseInvoice cancels linked supplier payments or credits supplier balance', async () => {
    const prodId = await db.products.add({
      name: 'دقيق',
      sku: 'FLR-1',
      barcode: '111',
      categoryId: null,
      unit: 'كيس',
      purchasePrice: 20,
      salePrice: 30,
      wholesalePrice: 25,
      secondSalePrice: 28,
      quantity: 0,
      minStock: 2,
      isActive: true,
      isWeighted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const purchase = await ops.createPurchaseInvoice(
      {
        supplierId: 1,
        supplierName: 'مورد الأطلس',
        items: [
          {
            productId: prodId,
            productName: 'دقيق',
            barcode: '111',
            unit: 'كيس',
            quantity: 10,
            unitCost: 20,
            discount: 0,
            total: 200,
          },
        ],
        discountAmount: 0,
        paidAmount: 200,
        paymentMethod: 'cash',
        costingMethod: 'weighted_avg',
        idempotencyKey: 'test-pur-1',
      },
      adminUser
    );

    const paymentsBefore = await db.supplierPayments.toArray();
    expect(paymentsBefore).toHaveLength(1);
    expect(paymentsBefore[0].isCancelled).toBeFalsy();

    await ops.cancelPurchaseInvoice(purchase.id!, 'خطأ في الفاتورة', adminUser);

    const paymentsAfter = await db.supplierPayments.toArray();
    const supplierAfter = await db.suppliers.get(1);
    const paymentCancelled = paymentsAfter[0].isCancelled === true;
    const creditedSupplier = (supplierAfter?.creditBalance ?? 0) >= 200;
    expect(paymentCancelled || creditedSupplier).toBe(true);
  });

  it('Bug 3: createSupplierReturn credits excess credit_note to supplier.creditBalance and records cash/bank refunds', async () => {
    const prodId = await db.products.add({
      name: 'سكر',
      sku: 'SUG-1',
      barcode: '222',
      categoryId: null,
      unit: 'علبة',
      purchasePrice: 10,
      salePrice: 15,
      wholesalePrice: 13,
      secondSalePrice: 14,
      quantity: 0,
      minStock: 2,
      isActive: true,
      isWeighted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Purchase 10 units @ 10 = 100, paid 80, remaining 20
    const purchase = await ops.createPurchaseInvoice(
      {
        supplierId: 1,
        supplierName: 'مورد الأطلس',
        items: [
          {
            productId: prodId,
            productName: 'سكر',
            barcode: '222',
            unit: 'علبة',
            quantity: 10,
            unitCost: 10,
            discount: 0,
            total: 100,
          },
        ],
        discountAmount: 0,
        paidAmount: 80,
        paymentMethod: 'cash',
        costingMethod: 'weighted_avg',
        idempotencyKey: 'test-pur-ret-1',
      },
      adminUser
    );

    // Return 5 units = 50 as credit_note: 20 reduces debt, 30 must go to supplier.creditBalance
    const ret1 = await ops.createSupplierReturn(
      purchase.id!,
      [{ productId: prodId, productName: 'سكر', barcode: '222', quantity: 5, unitCost: 10, total: 50 }],
      'credit_note',
      'تالف',
      adminUser
    );
    const supAfter1 = await db.suppliers.get(1);
    const purAfter1 = await db.purchaseInvoices.get(purchase.id!);
    expect(purAfter1?.remainingAmount).toBe(0);
    expect(supAfter1?.creditBalance).toBe(30);
    expect((ret1 as unknown as { creditAdded?: number }).creditAdded).toBe(30);

    // Return 2 more units = 20 as cash refund: must record cashRefund=20 and reduce purchase.paidAmount
    const ret2 = await ops.createSupplierReturn(
      purchase.id!,
      [{ productId: prodId, productName: 'سكر', barcode: '222', quantity: 2, unitCost: 10, total: 20 }],
      'cash',
      'استرداد نقدي',
      adminUser
    );
    const purAfter2 = await db.purchaseInvoices.get(purchase.id!);
    expect((ret2 as unknown as { refundAmount?: number }).refundAmount).toBe(20);
    expect(purAfter2?.paidAmount).toBe(60);
  });

  it('Bug 4: cancelled sale invoices are cloned as a new invoice instead of restoring mutated history', async () => {
    const cloneFn = (ops as unknown as Record<string, unknown>).cloneSaleInvoiceAsNew as
      | ((sourceId: number, user: AppUser) => Promise<{ id?: number; invoiceNumber: string; status: string }>)
      | undefined;
    expect(cloneFn).toBeTypeOf('function');
    expect((ops as unknown as Record<string, unknown>).restoreCancelledSaleInvoice).toBeUndefined();

    const prodId = await db.products.add({
      name: 'شاي',
      sku: 'TEA-1',
      barcode: '333',
      categoryId: null,
      unit: 'علبة',
      purchasePrice: 10,
      salePrice: 20,
      wholesalePrice: 18,
      secondSalePrice: 19,
      quantity: 10,
      minStock: 1,
      isActive: true,
      isWeighted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const sale = await ops.createSaleInvoice(
      {
        customerId: 2,
        customerName: 'أحمد',
        items: [
          {
            productId: prodId,
            productName: 'شاي',
            barcode: '333',
            unit: 'علبة',
            quantity: 2,
            unitPrice: 20,
            costPrice: 10,
            discount: 0,
            total: 40,
          },
        ],
        discountType: 'fixed',
        discountValue: 0,
        taxRate: 0,
        paymentSplits: [],
        tenderedAmount: 0,
        isCredit: true,
        installmentCount: 2,
        idempotencyKey: 'test-sale-clone-1',
      },
      adminUser
    );

    await ops.cancelSaleInvoice(sale.id!, 'ملغاة', adminUser);
    const cloned = await cloneFn!(sale.id!, adminUser);
    expect(cloned.id).not.toBe(sale.id);
    expect(cloned.invoiceNumber).not.toBe(sale.invoiceNumber);
    expect(cloned.status).toBe('unpaid');
    const oldStillCancelled = await db.saleInvoices.get(sale.id!);
    expect(oldStillCancelled?.status).toBe('cancelled');
    const newInsts = await db.installments.where('saleInvoiceId').equals(cloned.id!).toArray();
    expect(newInsts).toHaveLength(2);
  });

  it('Bug 5: Dashboard financials exclude returns of cancelled invoices and subtract tax from revenue', () => {
    const now = new Date().toISOString();
    const validSale = {
      id: 1,
      invoiceNumber: 'VNT-1',
      date: now,
      customerId: 1,
      customerName: 'زبون',
      sellerId: 1,
      sellerName: 'مدير',
      items: [
        { productId: 1, productName: 'A', barcode: '1', unit: 'u', quantity: 2, unitPrice: 100, costPrice: 60, discount: 0, total: 200 },
      ],
      subtotal: 200,
      discountType: 'fixed' as const,
      discountValue: 0,
      discountAmount: 0,
      taxRate: 20,
      taxAmount: 40,
      total: 240,
      paidAmount: 240,
      remainingAmount: 0,
      changeGiven: 0,
      paymentMethod: 'cash' as const,
      paymentSplits: [{ method: 'cash' as const, amount: 240 }],
      status: 'paid' as const,
      isCredit: false,
      idempotencyKey: 'k1',
    };
    const cancelledSale = {
      ...validSale,
      id: 2,
      invoiceNumber: 'VNT-2',
      status: 'cancelled' as const,
      idempotencyKey: 'k2',
    };
    const returnOnCancelled = {
      id: 1,
      returnNumber: 'RET-1',
      saleInvoiceId: 2,
      saleInvoiceNumber: 'VNT-2',
      date: now,
      customerId: 1,
      customerName: 'زبون',
      items: [{ productId: 1, productName: 'A', barcode: '1', quantity: 1, unitPrice: 120, costPrice: 60, total: 120 }],
      totalAmount: 120,
      totalCost: 60,
      refundMethod: 'cash' as const,
      userId: 1,
      userName: 'مدير',
      reason: 'test',
    };

    const summary = computeDashboardFinancials([validSale, cancelledSale], [returnOnCancelled], []);
    // Returns of cancelled invoice must be ignored, and 40 tax subtracted from 240 gross => 200 net revenue, COGS 120 => profit 80
    expect(summary.totalReturnsGross).toBe(0);
    expect(summary.netRevenue).toBe(200);
    expect(summary.netProfit).toBe(80);
  });

  it('Bug 6: updateSaleInvoiceControlled validates stock and blocks edits when invoice has installments or payments', async () => {
    const prodId = await db.products.add({
      name: 'حليب',
      sku: 'MLK-1',
      barcode: '444',
      categoryId: null,
      unit: 'علبة',
      purchasePrice: 8,
      salePrice: 10,
      wholesalePrice: 9,
      secondSalePrice: 9.5,
      quantity: 5,
      minStock: 1,
      isActive: true,
      isWeighted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Invoice with installments (credit sale)
    const creditSale = await ops.createSaleInvoice(
      {
        customerId: 2,
        customerName: 'أحمد',
        items: [
          { productId: prodId, productName: 'حليب', barcode: '444', unit: 'علبة', quantity: 1, unitPrice: 10, costPrice: 8, discount: 0, total: 10 },
        ],
        discountType: 'fixed',
        discountValue: 0,
        taxRate: 0,
        paymentSplits: [],
        tenderedAmount: 0,
        isCredit: true,
        installmentCount: 2,
        idempotencyKey: 'test-edit-inst',
      },
      adminUser
    );

    await expect(
      ops.updateSaleInvoiceControlled(
        creditSale.id!,
        {
          items: [
            { productId: prodId, productName: 'حليب', barcode: '444', unit: 'علبة', quantity: 2, unitPrice: 10, costPrice: 8, discount: 0, total: 20 },
          ],
          discountAmount: 0,
        },
        adminUser
      )
    ).rejects.toThrow();

    // Unpaid invoice without installments or payments -> must still enforce stock limit!
    const bareInvoiceId = await db.saleInvoices.add({
      invoiceNumber: 'VNT-BARE-1',
      date: new Date().toISOString(),
      customerId: 1,
      customerName: 'زبون عابر',
      sellerId: 1,
      sellerName: 'المدير',
      items: [
        { productId: prodId, productName: 'حليب', barcode: '444', unit: 'علبة', quantity: 1, unitPrice: 10, costPrice: 8, discount: 0, total: 10 },
      ],
      subtotal: 10,
      discountType: 'fixed',
      discountValue: 0,
      discountAmount: 0,
      taxRate: 0,
      taxAmount: 0,
      total: 10,
      paidAmount: 0,
      remainingAmount: 10,
      changeGiven: 0,
      paymentMethod: 'credit',
      paymentSplits: [],
      status: 'unpaid',
      isCredit: true,
      idempotencyKey: 'bare-1',
    });

    // Remaining stock is 4; requesting deltaSold = 10 (total qty 11) must fail when allowNegativeStock=false
    await expect(
      ops.updateSaleInvoiceControlled(
        bareInvoiceId,
        {
          items: [
            { productId: prodId, productName: 'حليب', barcode: '444', unit: 'علبة', quantity: 11, unitPrice: 10, costPrice: 8, discount: 0, total: 110 },
          ],
          discountAmount: 0,
        },
        adminUser
      )
    ).rejects.toThrow();
  });
});
