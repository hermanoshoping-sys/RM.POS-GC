import { db, createDefaultSettings } from './database';
import {
  AppSettings,
  AppUser,
  CashSession,
  CustomerPayment,
  Expense,
  Installment,
  InstallmentFrequency,
  PaymentMethod,
  PaymentSplit,
  Product,
  PurchaseInvoice,
  PurchaseInvoiceItem,
  SaleInvoice,
  SaleInvoiceItem,
  SaleReturn,
  SaleReturnItem,
  StockMovementType,
  SupplierPayment,
  SupplierReturn,
  SupplierReturnItem,
} from '../types';
import { computeSha256, decryptBackupPayload, encryptBackupPayload } from '../utils/crypto';
import { assertPermission, getMaxDiscountPercent } from '../utils/permissions';
import { calculateSaleReturnBreakdown, toSaleReturnItems } from '../utils/returns';
import { saveBackupExternally } from '../utils/backupStorage';

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function addInstallmentInterval(baseDateStr: string, stepIndex: number, freq: InstallmentFrequency): string {
  const parts = baseDateStr.split('-').map(Number);
  const d =
    parts.length === 3 && !parts.some(Number.isNaN)
      ? new Date(parts[0], parts[1] - 1, parts[2])
      : new Date();
  if (stepIndex > 0) {
    if (freq === 'weekly') d.setDate(d.getDate() + stepIndex * 7);
    else if (freq === 'biweekly') d.setDate(d.getDate() + stepIndex * 14);
    else d.setMonth(d.getMonth() + stepIndex);
  }
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function defaultFirstDueDate(freq: InstallmentFrequency): string {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return addInstallmentInterval(today, 1, freq);
}

export function makeIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function logAudit(
  user: AppUser,
  action: string,
  entityType: string,
  entityId: string | number,
  details: string,
  canRestore = false
): Promise<void> {
  await db.auditLogs.add({
    date: new Date().toISOString(),
    userId: user.id ?? 1,
    userName: user.fullName,
    action,
    entityType,
    entityId: String(entityId),
    details,
    canRestore,
    restored: false,
  });
}

// ============================================================
// SALES OPERATIONS (Transactional, Idempotent, Auto Stock + Ledger)
// ============================================================
export interface CreateSaleInput {
  customerId: number | null;
  customerName: string;
  items: SaleInvoiceItem[];
  discountType: 'fixed' | 'percent';
  discountValue: number;
  taxRate: number;
  paymentSplits: PaymentSplit[];
  tenderedAmount: number;
  isCredit: boolean;
  dueDate?: string;
  installmentCount?: number;
  installmentFrequency?: InstallmentFrequency;
  applyCreditBalance?: boolean;
  notes?: string;
  idempotencyKey: string;
}

export async function createSaleInvoice(
  input: CreateSaleInput,
  user: AppUser
): Promise<SaleInvoice> {
  assertPermission(user, 'canSell', 'ليس لديك صلاحية إنشاء فواتير البيع');
  if (!input.items.length) {
    throw new Error('لا يمكن إنشاء فاتورة فارغة / Impossible de créer une facture vide');
  }

  return db.transaction(
    'rw',
    [
      db.saleInvoices,
      db.products,
      db.stockMovements,
      db.customerPayments,
      db.customers,
      db.installments,
      db.settings,
      db.auditLogs,
    ],
    async () => {
      // Idempotency guard: prevent duplicate financial transactions
      const existing = await db.saleInvoices
        .where('idempotencyKey')
        .equals(input.idempotencyKey)
        .first();
      if (existing) {
        return existing;
      }

      const settings = (await db.settings.get(1)) ?? createDefaultSettings();
      const allowNeg = settings.posConfig.allowNegativeStock;

      // Validate stock, price override permissions & snapshot COGS
      const enrichedItems: SaleInvoiceItem[] = [];
      let grossBeforeDiscounts = 0;
      let lineDiscountsTotal = 0;

      for (const item of input.items) {
        const product = await db.products.get(item.productId);
        if (!product) {
          throw new Error(`المنتج غير موجود: ${item.productName}`);
        }
        if (!allowNeg && product.quantity < item.quantity) {
          throw new Error(
            `الكمية غير متوفرة للمنتج "${product.name}" (المتوفر: ${product.quantity})`
          );
        }

        const cleanUnitPrice = round2(Math.max(0, item.unitPrice));
        const cleanLineDiscount = round2(Math.max(0, item.discount || 0));

        // Enforce price override permission server/service-side
        if (!user.permissions?.canOverridePrice) {
          const allowedPrices = [
            product.salePrice,
            product.wholesalePrice,
            product.secondSalePrice,
          ].filter((p) => typeof p === 'number' && p >= 0);
          const matchesCatalogPrice = allowedPrices.some(
            (p) => Math.abs(p - cleanUnitPrice) <= 0.005
          );
          if (!matchesCatalogPrice) {
            throw new Error(
              `ليس لديك صلاحية تعديل سعر البيع للمنتج "${product.name}" / Modification du prix non autorisée`
            );
          }
        }

        const lineGross = round2(item.quantity * cleanUnitPrice);
        const cappedLineDiscount = Math.min(lineGross, cleanLineDiscount);
        grossBeforeDiscounts = round2(grossBeforeDiscounts + lineGross);
        lineDiscountsTotal = round2(lineDiscountsTotal + cappedLineDiscount);

        enrichedItems.push({
          ...item,
          unitPrice: cleanUnitPrice,
          discount: cappedLineDiscount,
          costPrice: product.purchasePrice,
          total: round2(lineGross - cappedLineDiscount),
          returnedQty: 0,
        });
      }

      const subtotal = round2(enrichedItems.reduce((s, i) => s + i.total, 0));
      const discountAmount =
        input.discountType === 'percent'
          ? round2((subtotal * Math.min(100, Math.max(0, input.discountValue))) / 100)
          : round2(Math.min(subtotal, Math.max(0, input.discountValue)));

      // Enforce discount permission & maximum discount ceiling (line + invoice discounts combined)
      const totalDiscountApplied = round2(lineDiscountsTotal + discountAmount);
      if (totalDiscountApplied > 0.005) {
        if (!user.permissions?.canGiveDiscount) {
          throw new Error(
            'ليس لديك صلاحية منح الخصومات / Vous n’avez pas l’autorisation d’accorder des remises'
          );
        }
        const maxPct = getMaxDiscountPercent(user);
        const effectivePct =
          grossBeforeDiscounts > 0
            ? (totalDiscountApplied / grossBeforeDiscounts) * 100
            : 100;
        if (effectivePct > maxPct + 0.01) {
          throw new Error(
            `نسبة الخصم (${effectivePct.toFixed(1)}%) تتجاوز السقف المسموح لك (${maxPct}%) / Remise supérieure au plafond autorisé (${maxPct}%)`
          );
        }
      }

      const taxable = Math.max(0, round2(subtotal - discountAmount));
      const taxAmount = round2((taxable * Math.max(0, input.taxRate)) / 100);
      const total = round2(taxable + taxAmount);

      const splitsPaid = round2(
        input.paymentSplits
          .filter((p) => p.method !== 'credit' && p.amount > 0)
          .reduce((s, p) => s + p.amount, 0)
      );

      // Load customer for credit balance application & credit limit enforcement
      const customer =
        input.customerId && input.customerId > 0
          ? await db.customers.get(input.customerId)
          : undefined;

      let creditApplied = 0;
      if (
        input.applyCreditBalance &&
        customer &&
        customer.id &&
        customer.id > 1 &&
        (customer.creditBalance ?? 0) > 0.005
      ) {
        const stillNeeded = round2(Math.max(0, total - splitsPaid));
        creditApplied = round2(Math.min(customer.creditBalance ?? 0, stillNeeded));
      }

      const paidAmount = round2(Math.min(total, Math.max(0, splitsPaid + creditApplied)));
      const remainingAmount = round2(Math.max(0, total - paidAmount));
      const changeGiven = round2(Math.max(0, input.tenderedAmount - total));

      // Enforce credit sale rules & customer credit limit
      if (remainingAmount > 0.005) {
        if (!customer || !customer.id || customer.id === 1) {
          throw new Error(
            'لا يمكن البيع بالآجل للزبون العابر — يرجى اختيار زبون مسجل / Vente à crédit impossible pour un client de passage'
          );
        }
        if (customer.creditLimit > 0) {
          const customerInvoices = await db.saleInvoices
            .where('customerId')
            .equals(customer.id)
            .toArray();
          const openInvoicesDebt = customerInvoices
            .filter((s) => s.status !== 'cancelled')
            .reduce((sum, s) => sum + s.remainingAmount, 0);
          const currentDebt = round2(openInvoicesDebt + Math.max(0, customer.openingBalance || 0));
          const projectedDebt = round2(currentDebt + remainingAmount);
          if (projectedDebt > customer.creditLimit + 0.005) {
            const available = round2(Math.max(0, customer.creditLimit - currentDebt));
            throw new Error(
              `تجاوز سقف الائتمان للزبون "${customer.fullName}"! السقف: ${customer.creditLimit.toFixed(2)} — الدين الحالي: ${currentDebt.toFixed(2)} — المتاح: ${available.toFixed(2)} — المطلوب بالآجل: ${remainingAmount.toFixed(2)}`
            );
          }
        }
      }

      const status =
        remainingAmount <= 0.005 ? 'paid' : paidAmount > 0 ? 'partial' : 'unpaid';
      const primaryMethod: PaymentMethod =
        splitsPaid <= 0 && creditApplied <= 0
          ? 'credit'
          : input.paymentSplits.find((p) => p.amount > 0)?.method ?? 'cash';

      const installmentFrequency: InstallmentFrequency = input.installmentFrequency || 'monthly';
      const installmentCount =
        remainingAmount > 0.005
          ? Math.max(1, Math.min(36, Math.floor(input.installmentCount || 1)))
          : undefined;
      const firstDueDate =
        remainingAmount > 0.005
          ? input.dueDate || defaultFirstDueDate(installmentFrequency)
          : undefined;

      const invoiceNumber = `${settings.storeInfo.salePrefix}-${settings.storeInfo.saleNextNumber}`;
      const nowIso = new Date().toISOString();

      const invoice: SaleInvoice = {
        invoiceNumber,
        date: nowIso,
        customerId: input.customerId,
        customerName: input.customerName || 'زبون عابر (نقدي)',
        sellerId: user.id ?? 1,
        sellerName: user.fullName,
        items: enrichedItems,
        subtotal,
        discountType: input.discountType,
        discountValue: input.discountValue,
        discountAmount,
        taxRate: input.taxRate,
        taxAmount,
        total,
        paidAmount,
        remainingAmount,
        changeGiven,
        paymentMethod: primaryMethod,
        paymentSplits: input.paymentSplits.filter((p) => p.amount > 0),
        status,
        isCredit: remainingAmount > 0.005 || input.isCredit,
        dueDate: firstDueDate,
        installmentCount,
        installmentFrequency: remainingAmount > 0.005 ? installmentFrequency : undefined,
        creditApplied: creditApplied > 0 ? creditApplied : undefined,
        idempotencyKey: input.idempotencyKey,
        notes: input.notes,
      };

      const invoiceId = await db.saleInvoices.add(invoice);
      invoice.id = invoiceId;

      // Deduct applied customer credit balance
      if (creditApplied > 0 && customer?.id) {
        await db.customers.update(customer.id, {
          creditBalance: round2(Math.max(0, (customer.creditBalance ?? 0) - creditApplied)),
        });
      }

      // Generate Installment schedule for credit portion
      if (remainingAmount > 0.005 && customer?.id && installmentCount && firstDueDate) {
        const baseInstallment = round2(Math.floor((remainingAmount / installmentCount) * 100) / 100);
        let allocated = 0;
        const rows: Installment[] = [];
        for (let idx = 0; idx < installmentCount; idx++) {
          const isLast = idx === installmentCount - 1;
          const instAmount = isLast
            ? round2(remainingAmount - allocated)
            : baseInstallment;
          allocated = round2(allocated + instAmount);
          const due = addInstallmentInterval(firstDueDate, idx, installmentFrequency);
          rows.push({
            saleInvoiceId: invoiceId,
            saleInvoiceNumber: invoiceNumber,
            customerId: customer.id,
            customerName: invoice.customerName,
            installmentNumber: idx + 1,
            totalInstallments: installmentCount,
            dueDate: due,
            amount: instAmount,
            paidAmount: 0,
            remainingAmount: instAmount,
            status: 'pending',
            notes: `قسط ${idx + 1}/${installmentCount} من الفاتورة ${invoiceNumber}`,
          });
        }
        await db.installments.bulkAdd(rows);
      }

      // Update product stock & insert stock movements
      for (const item of enrichedItems) {
        const product = await db.products.get(item.productId);
        if (product) {
          const beforeQty = product.quantity;
          const afterQty = round2(beforeQty - item.quantity);
          await db.products.update(product.id!, {
            quantity: afterQty,
            updatedAt: nowIso,
          });
          await db.stockMovements.add({
            date: nowIso,
            productId: product.id!,
            productName: product.name,
            barcode: product.barcode,
            type: 'sale',
            quantityDelta: -item.quantity,
            beforeQty,
            afterQty,
            unitCost: item.costPrice,
            unitPrice: item.unitPrice,
            referenceNumber: invoiceNumber,
            userId: user.id ?? 1,
            userName: user.fullName,
            note: `بيع فاتورة ${invoiceNumber}`,
          });
        }
      }

      // Record payment entry automatically if splitsPaid > 0 and linked to a registered customer
      let nextCustRef = settings.storeInfo.customerPaymentNextRef;
      if (splitsPaid > 0 && input.customerId && input.customerId > 1) {
        await db.customerPayments.add({
          refNumber: nextCustRef,
          date: nowIso,
          customerId: input.customerId,
          customerName: invoice.customerName,
          invoiceIds: [invoiceId],
          invoiceNumbers: [invoiceNumber],
          amount: Math.min(total, splitsPaid),
          remainingAfter: remainingAmount,
          paymentMethod: primaryMethod,
          userId: user.id ?? 1,
          userName: user.fullName,
          notes: `أداء فوري عند البيع (${invoiceNumber})`,
          idempotencyKey: `${input.idempotencyKey}-pay`,
        });
        nextCustRef += 1;
      }

      await db.settings.update(1, {
        storeInfo: {
          ...settings.storeInfo,
          saleNextNumber: settings.storeInfo.saleNextNumber + 1,
          customerPaymentNextRef: nextCustRef,
        },
      });

      await db.auditLogs.add({
        date: nowIso,
        userId: user.id ?? 1,
        userName: user.fullName,
        action: 'SALE_CREATED',
        entityType: 'saleInvoice',
        entityId: String(invoiceId),
        details: `إنشاء فاتورة بيع ${invoiceNumber} بمبلغ ${total.toFixed(2)} — الزبون: ${invoice.customerName}${remainingAmount > 0.005 ? ` (آجل: ${remainingAmount.toFixed(2)} على ${installmentCount} قسط)` : ''}`,
      });

      return invoice;
    }
  );
}

// Never permanently delete approved invoices: cancel with reverse stock movements & audit log
export async function cancelSaleInvoice(
  invoiceId: number,
  reason: string,
  user: AppUser
): Promise<void> {
  assertPermission(user, 'canCancelSale', 'ليس لديك صلاحية إلغاء فواتير البيع');
  if (!reason.trim()) {
    throw new Error('يرجى إدخال سبب إلغاء الفاتورة / Veuillez saisir le motif d’annulation');
  }
  await db.transaction(
    'rw',
    [db.saleInvoices, db.products, db.stockMovements, db.customerPayments, db.installments, db.customers, db.auditLogs],
    async () => {
      const inv = await db.saleInvoices.get(invoiceId);
      if (!inv) throw new Error('الفاتورة غير موجودة');
      if (inv.status === 'cancelled') throw new Error('الفاتورة ملغاة مسبقاً');

      const nowIso = new Date().toISOString();
      await db.saleInvoices.update(invoiceId, {
        status: 'cancelled',
        cancelReason: reason.trim(),
        cancelledAt: nowIso,
        cancelledBy: user.fullName,
      });

      // Remove unpaid/linked installments for cancelled invoice
      await db.installments.where('saleInvoiceId').equals(invoiceId).delete();

      // Refund any creditBalance that was consumed on this invoice
      if (inv.creditApplied && inv.creditApplied > 0 && inv.customerId && inv.customerId > 1) {
        const cust = await db.customers.get(inv.customerId);
        if (cust) {
          await db.customers.update(inv.customerId, {
            creditBalance: round2((cust.creditBalance ?? 0) + inv.creditApplied),
          });
        }
      }

      // Reverse stock for unreturned quantities
      for (const item of inv.items) {
        const netToRestore = round2(item.quantity - (item.returnedQty ?? 0));
        if (netToRestore <= 0) continue;
        const prod = await db.products.get(item.productId);
        if (prod) {
          const beforeQty = prod.quantity;
          const afterQty = round2(beforeQty + netToRestore);
          await db.products.update(prod.id!, { quantity: afterQty, updatedAt: nowIso });
          await db.stockMovements.add({
            date: nowIso,
            productId: prod.id!,
            productName: prod.name,
            barcode: prod.barcode,
            type: 'sale_cancel',
            quantityDelta: netToRestore,
            beforeQty,
            afterQty,
            unitCost: item.costPrice,
            unitPrice: item.unitPrice,
            referenceNumber: inv.invoiceNumber,
            userId: user.id ?? 1,
            userName: user.fullName,
            note: `قيد عكسي لإلغاء فاتورة ${inv.invoiceNumber}: ${reason}`,
          });
        }
      }

      // Mark linked payments cancelled if they were solely for this invoice
      const linkedPayments = await db.customerPayments.toArray();
      for (const p of linkedPayments) {
        if (p.invoiceIds.length === 1 && p.invoiceIds[0] === invoiceId && !p.isCancelled) {
          await db.customerPayments.update(p.id!, { isCancelled: true });
        }
      }

      await db.auditLogs.add({
        date: nowIso,
        userId: user.id ?? 1,
        userName: user.fullName,
        action: 'SALE_CANCELLED',
        entityType: 'saleInvoice',
        entityId: String(invoiceId),
        details: `إلغاء فاتورة بيع ${inv.invoiceNumber} (${inv.total.toFixed(2)}) — السبب: ${reason}`,
        canRestore: true,
        restored: false,
      });
    }
  );
}

// Clone a cancelled invoice as a brand-new invoice instead of mutating deleted installments/payments
export async function cloneSaleInvoiceAsNew(
  sourceInvoiceId: number,
  user: AppUser,
  auditLogId?: number
): Promise<SaleInvoice> {
  assertPermission(user, 'canRestoreCancelled', 'ليس لديك صلاحية نسخ الفواتير الملغاة');
  assertPermission(user, 'canSell', 'ليس لديك صلاحية إنشاء فواتير البيع');

  const source = await db.saleInvoices.get(sourceInvoiceId);
  if (!source || source.status !== 'cancelled') {
    throw new Error('الفاتورة غير ملغاة أو غير موجودة');
  }

  const cloneInput: CreateSaleInput = {
    customerId: source.customerId,
    customerName: source.customerName,
    items: source.items.map((it) => ({
      ...it,
      returnedQty: 0,
    })),
    discountType: source.discountType,
    discountValue: source.discountValue,
    taxRate: source.taxRate,
    paymentSplits: source.paymentSplits.map((sp) => ({ ...sp })),
    tenderedAmount: source.paidAmount,
    isCredit: source.isCredit,
    dueDate: source.dueDate,
    installmentCount: source.installmentCount,
    installmentFrequency: source.installmentFrequency,
    applyCreditBalance: Boolean(source.creditApplied && source.creditApplied > 0),
    notes: `${source.notes ? `${source.notes} — ` : ''}نسخة جديدة من الفاتورة الملغاة ${source.invoiceNumber}`,
    idempotencyKey: makeIdempotencyKey('clone-sale'),
  };

  const cloned = await createSaleInvoice(cloneInput, user);

  if (auditLogId) {
    await db.auditLogs.update(auditLogId, { restored: true });
  }
  await logAudit(
    user,
    'SALE_CLONED',
    'saleInvoice',
    cloned.id ?? '',
    `نسخ الفاتورة الملغاة ${source.invoiceNumber} كفاتورة جديدة ${cloned.invoiceNumber}`
  );

  return cloned;
}

export async function updateSaleInvoiceControlled(
  invoiceId: number,
  updates: { items: SaleInvoiceItem[]; discountAmount: number; notes?: string },
  user: AppUser
): Promise<void> {
  assertPermission(user, 'canEditInvoice', 'ليس لديك صلاحية تعديل الفواتير');
  await db.transaction(
    'rw',
    [
      db.saleInvoices,
      db.products,
      db.stockMovements,
      db.installments,
      db.customerPayments,
      db.settings,
      db.auditLogs,
    ],
    async () => {
      const inv = await db.saleInvoices.get(invoiceId);
      if (!inv) throw new Error('الفاتورة غير موجودة');
      if (inv.status === 'cancelled') throw new Error('لا يمكن تعديل فاتورة ملغاة');

      // Block edits if the invoice already has payments or installments attached
      if (inv.paidAmount > 0.005) {
        throw new Error(
          'لا يمكن تعديل فاتورة مسجل عليها مدفوعات — يرجى إلغاؤها ونسخها كفاتورة جديدة'
        );
      }
      const linkedInstallmentsCount = await db.installments
        .where('saleInvoiceId')
        .equals(invoiceId)
        .count();
      if (linkedInstallmentsCount > 0) {
        throw new Error(
          'لا يمكن تعديل فاتورة مرتبطة بجدول أقساط — يرجى إلغاؤها ونسخها كفاتورة جديدة'
        );
      }
      const allPayments = await db.customerPayments.toArray();
      const hasActivePayment = allPayments.some(
        (p) => !p.isCancelled && p.invoiceIds.includes(invoiceId)
      );
      if (hasActivePayment) {
        throw new Error(
          'لا يمكن تعديل فاتورة مرتبطة بدفعات زبون — يرجى إلغاؤها ونسخها كفاتورة جديدة'
        );
      }

      const settings = (await db.settings.get(1)) ?? createDefaultSettings();
      const allowNeg = settings.posConfig.allowNegativeStock;

      const nowIso = new Date().toISOString();
      // Compute stock delta per product
      const oldMap = new Map<number, number>();
      inv.items.forEach((i) => oldMap.set(i.productId, (oldMap.get(i.productId) ?? 0) + i.quantity));
      const newMap = new Map<number, number>();
      updates.items.forEach((i) =>
        newMap.set(i.productId, (newMap.get(i.productId) ?? 0) + i.quantity)
      );

      const allProductIds = new Set([...oldMap.keys(), ...newMap.keys()]);

      // First pass: validate stock availability before mutating anything
      for (const pid of allProductIds) {
        const deltaSold = round2((newMap.get(pid) ?? 0) - (oldMap.get(pid) ?? 0));
        if (deltaSold <= 0.0001) continue;
        const prod = await db.products.get(pid);
        if (!prod) {
          throw new Error(`المنتج غير موجود (#${pid})`);
        }
        if (!allowNeg && prod.quantity < deltaSold) {
          throw new Error(
            `الكمية غير متوفرة للمنتج "${prod.name}" (المتوفر: ${prod.quantity}، المطلوب الإضافي: ${deltaSold})`
          );
        }
      }

      // Second pass: apply stock adjustments and movements
      for (const pid of allProductIds) {
        const deltaSold = round2((newMap.get(pid) ?? 0) - (oldMap.get(pid) ?? 0));
        if (Math.abs(deltaSold) < 0.0001) continue;
        const prod = await db.products.get(pid);
        if (prod) {
          const beforeQty = prod.quantity;
          const afterQty = round2(beforeQty - deltaSold);
          await db.products.update(pid, { quantity: afterQty, updatedAt: nowIso });
          await db.stockMovements.add({
            date: nowIso,
            productId: pid,
            productName: prod.name,
            barcode: prod.barcode,
            type: 'adjustment',
            quantityDelta: -deltaSold,
            beforeQty,
            afterQty,
            unitCost: prod.purchasePrice,
            unitPrice: prod.salePrice,
            referenceNumber: inv.invoiceNumber,
            userId: user.id ?? 1,
            userName: user.fullName,
            note: `تعديل كمية فاتورة بيع ${inv.invoiceNumber}`,
          });
        }
      }

      const subtotal = round2(updates.items.reduce((s, i) => s + i.total, 0));
      const taxable = Math.max(0, round2(subtotal - updates.discountAmount));
      const taxAmount = round2((taxable * inv.taxRate) / 100);
      const total = round2(taxable + taxAmount);
      const remainingAmount = round2(Math.max(0, total - inv.paidAmount));
      const status =
        remainingAmount <= 0.005 ? 'paid' : inv.paidAmount > 0 ? 'partial' : 'unpaid';

      await db.saleInvoices.update(invoiceId, {
        items: updates.items,
        subtotal,
        discountAmount: updates.discountAmount,
        discountValue: updates.discountAmount,
        discountType: 'fixed',
        taxAmount,
        total,
        remainingAmount,
        status,
        notes: updates.notes,
      });

      await db.auditLogs.add({
        date: nowIso,
        userId: user.id ?? 1,
        userName: user.fullName,
        action: 'SALE_EDITED',
        entityType: 'saleInvoice',
        entityId: String(invoiceId),
        details: `تعديل فاتورة بيع ${inv.invoiceNumber} — الإجمالي الجديد: ${total.toFixed(2)}`,
      });
    }
  );
}

export async function createSaleReturn(
  saleInvoiceId: number,
  returnItems: SaleReturnItem[],
  refundMethod: PaymentMethod,
  reason: string,
  user: AppUser
): Promise<SaleReturn> {
  assertPermission(user, 'canSell', 'ليس لديك صلاحية تسجيل مرتجعات المبيعات');
  if (!returnItems.length) throw new Error('اختر منتجاً واحداً على الأقل للإرجاع');

  return db.transaction(
    'rw',
    [
      db.saleInvoices,
      db.saleReturns,
      db.products,
      db.stockMovements,
      db.installments,
      db.customers,
      db.settings,
      db.auditLogs,
    ],
    async () => {
      const inv = await db.saleInvoices.get(saleInvoiceId);
      if (!inv) throw new Error('الفاتورة الأصلية غير موجودة');
      if (inv.status === 'cancelled') throw new Error('لا يمكن تسجيل مرتجع لفاتورة ملغاة');

      const settings = (await db.settings.get(1)) ?? createDefaultSettings();
      const returnNumber = `${settings.storeInfo.returnPrefix}-${settings.storeInfo.returnNextNumber}`;
      const nowIso = new Date().toISOString();

      // Sum prior returns on this invoice so cumulative refunds never exceed inv.total
      const priorReturns = await db.saleReturns
        .where('saleInvoiceId')
        .equals(saleInvoiceId)
        .toArray();
      const previousReturnedTotal = round2(
        priorReturns.reduce((s, r) => s + r.totalAmount, 0)
      );

      // Validate requested quantities against invoice items
      const updatedInvItems = inv.items.map((it) => ({ ...it }));
      const requestedQtys: Record<number, number> = {};
      for (const rItem of returnItems) {
        const line = updatedInvItems.find((i) => i.productId === rItem.productId);
        if (!line) throw new Error(`المنتج ${rItem.productName} غير موجود في الفاتورة`);
        const available = round2(line.quantity - (line.returnedQty ?? 0));
        if (rItem.quantity <= 0 || rItem.quantity > available + 0.001) {
          throw new Error(`الكمية المرتجعة تتجاوز الكمية المباعة لـ ${rItem.productName}`);
        }
        requestedQtys[rItem.productId] = round2((requestedQtys[rItem.productId] ?? 0) + rItem.quantity);
      }

      // Recalculate exact net refund accounting for line discount, invoice discount, and tax
      const breakdown = calculateSaleReturnBreakdown(inv, requestedQtys, previousReturnedTotal);
      const exactItems = toSaleReturnItems(breakdown.items);

      for (const calcItem of breakdown.items) {
        const line = updatedInvItems.find((i) => i.productId === calcItem.productId);
        if (line) {
          line.returnedQty = round2((line.returnedQty ?? 0) + calcItem.quantity);
        }

        const prod = await db.products.get(calcItem.productId);
        if (prod) {
          const beforeQty = prod.quantity;
          const afterQty = round2(beforeQty + calcItem.quantity);
          await db.products.update(prod.id!, { quantity: afterQty, updatedAt: nowIso });
          await db.stockMovements.add({
            date: nowIso,
            productId: prod.id!,
            productName: prod.name,
            barcode: prod.barcode,
            type: 'sale_return',
            quantityDelta: calcItem.quantity,
            beforeQty,
            afterQty,
            unitCost: calcItem.costPrice,
            unitPrice: calcItem.effectiveUnitPrice,
            referenceNumber: returnNumber,
            userId: user.id ?? 1,
            userName: user.fullName,
            note: `مرتجع زبون من الفاتورة ${inv.invoiceNumber}: ${reason}`,
          });
        }
      }

      // Separate debt reduction vs actual cash/credit refund
      const { debtReduction, cashRefund, newInvoiceRemaining, newInvoicePaid } = breakdown;
      const newStatus =
        newInvoiceRemaining <= 0.005
          ? 'paid'
          : newInvoicePaid > 0
            ? 'partial'
            : 'unpaid';

      await db.saleInvoices.update(saleInvoiceId, {
        items: updatedInvItems,
        remainingAmount: newInvoiceRemaining,
        paidAmount: newInvoicePaid,
        status: newStatus,
      });

      // Reduce open installments of this invoice by debtReduction (latest due first)
      if (debtReduction > 0.005) {
        const invInstallments = (
          await db.installments.where('saleInvoiceId').equals(saleInvoiceId).toArray()
        )
          .filter((inst) => inst.remainingAmount > 0.005)
          .sort((a, b) => b.dueDate.localeCompare(a.dueDate));

        let remReduce = debtReduction;
        for (const inst of invInstallments) {
          if (remReduce <= 0.005) break;
          const cut = round2(Math.min(remReduce, inst.remainingAmount));
          const nextAmount = round2(Math.max(0, inst.amount - cut));
          const nextRem = round2(Math.max(0, inst.remainingAmount - cut));
          await db.installments.update(inst.id!, {
            amount: nextAmount,
            remainingAmount: nextRem,
            status: nextRem <= 0.005 ? 'paid' : inst.paidAmount > 0 ? 'partial' : inst.status,
            paidAt: nextRem <= 0.005 ? nowIso : inst.paidAt,
          });
          remReduce = round2(remReduce - cut);
        }
      }

      // If cashRefund > 0 and refundMethod === 'credit' on registered customer, store as customer creditBalance
      let creditAdded = 0;
      if (cashRefund > 0.005 && refundMethod === 'credit' && inv.customerId && inv.customerId > 1) {
        const cust = await db.customers.get(inv.customerId);
        if (cust) {
          creditAdded = cashRefund;
          await db.customers.update(inv.customerId, {
            creditBalance: round2((cust.creditBalance ?? 0) + creditAdded),
          });
        }
      }

      const saleRet: SaleReturn = {
        returnNumber,
        saleInvoiceId,
        saleInvoiceNumber: inv.invoiceNumber,
        date: nowIso,
        customerId: inv.customerId,
        customerName: inv.customerName,
        items: exactItems,
        totalAmount: breakdown.totalReturnAmount,
        totalCost: breakdown.totalCost,
        debtReduction,
        cashRefund: creditAdded > 0 ? 0 : cashRefund,
        creditAdded: creditAdded > 0 ? creditAdded : undefined,
        refundMethod,
        userId: user.id ?? 1,
        userName: user.fullName,
        reason,
      };

      const retId = await db.saleReturns.add(saleRet);
      saleRet.id = retId;

      await db.settings.update(1, {
        storeInfo: {
          ...settings.storeInfo,
          returnNextNumber: settings.storeInfo.returnNextNumber + 1,
        },
      });

      await db.auditLogs.add({
        date: nowIso,
        userId: user.id ?? 1,
        userName: user.fullName,
        action: 'SALE_RETURN',
        entityType: 'saleReturn',
        entityId: String(retId),
        details: `مرتجع مبيعات ${returnNumber} من ${inv.invoiceNumber}: الإجمالي ${breakdown.totalReturnAmount.toFixed(2)} (تخفيض دين: ${debtReduction.toFixed(2)} — استرداد: ${cashRefund.toFixed(2)}${creditAdded > 0 ? ' رصيد زبون' : ''})`,
      });

      return saleRet;
    }
  );
}

// ============================================================
// PURCHASE & SUPPLIER RETURN OPERATIONS
// ============================================================
export interface CreatePurchaseInput {
  supplierId: number;
  supplierName: string;
  items: PurchaseInvoiceItem[];
  discountAmount: number;
  paidAmount: number;
  paymentMethod: PaymentMethod;
  costingMethod: 'weighted_avg' | 'last_cost';
  notes?: string;
  idempotencyKey: string;
}

export async function createPurchaseInvoice(
  input: CreatePurchaseInput,
  user: AppUser
): Promise<PurchaseInvoice> {
  assertPermission(user, 'canPurchase', 'ليس لديك صلاحية إنشاء فواتير الشراء');
  if (!input.items.length) throw new Error('أضف منتجاً واحداً على الأقل لفاتورة الشراء');

  return db.transaction(
    'rw',
    [
      db.purchaseInvoices,
      db.products,
      db.priceHistory,
      db.stockMovements,
      db.supplierPayments,
      db.settings,
      db.auditLogs,
    ],
    async () => {
      const existing = await db.purchaseInvoices
        .where('idempotencyKey')
        .equals(input.idempotencyKey)
        .first();
      if (existing) return existing;

      const settings = (await db.settings.get(1)) ?? createDefaultSettings();
      const invoiceNumber = `${settings.storeInfo.purchasePrefix}-${settings.storeInfo.purchaseNextNumber}`;
      const nowIso = new Date().toISOString();

      const subtotal = round2(input.items.reduce((s, i) => s + i.total, 0));
      const total = round2(Math.max(0, subtotal - input.discountAmount));
      const paidAmount = round2(Math.min(total, Math.max(0, input.paidAmount)));
      const remainingAmount = round2(Math.max(0, total - paidAmount));
      const status =
        remainingAmount <= 0.005 ? 'paid' : paidAmount > 0 ? 'partial' : 'unpaid';

      const purchase: PurchaseInvoice = {
        invoiceNumber,
        date: nowIso,
        supplierId: input.supplierId,
        supplierName: input.supplierName,
        userId: user.id ?? 1,
        userName: user.fullName,
        items: input.items.map((i) => ({ ...i, returnedQty: 0 })),
        subtotal,
        discountAmount: input.discountAmount,
        total,
        paidAmount,
        remainingAmount,
        paymentMethod: paidAmount <= 0 ? 'credit' : input.paymentMethod,
        status,
        costingMethod: input.costingMethod,
        idempotencyKey: input.idempotencyKey,
        notes: input.notes,
      };

      const purchaseId = await db.purchaseInvoices.add(purchase);
      purchase.id = purchaseId;

      for (const item of input.items) {
        const prod = await db.products.get(item.productId);
        if (prod) {
          const beforeQty = prod.quantity;
          const afterQty = round2(beforeQty + item.quantity);
          const oldCost = prod.purchasePrice;
          let newCost = item.unitCost;
          if (input.costingMethod === 'weighted_avg' && beforeQty > 0 && afterQty > 0) {
            newCost = round2(
              (beforeQty * oldCost + item.quantity * item.unitCost) / afterQty
            );
          }

          await db.products.update(prod.id!, {
            quantity: afterQty,
            purchasePrice: newCost,
            updatedAt: nowIso,
          });

          if (Math.abs(newCost - oldCost) > 0.005) {
            await db.priceHistory.add({
              productId: prod.id!,
              productName: prod.name,
              oldPurchasePrice: oldCost,
              newPurchasePrice: newCost,
              oldSalePrice: prod.salePrice,
              newSalePrice: prod.salePrice,
              changedBy: user.fullName,
              changedAt: nowIso,
              note: `تحديث تلقائي من فاتورة شراء ${invoiceNumber} (${input.costingMethod === 'weighted_avg' ? 'متوسط مرجح' : 'آخر سعر'})`,
            });
          }

          await db.stockMovements.add({
            date: nowIso,
            productId: prod.id!,
            productName: prod.name,
            barcode: prod.barcode,
            type: 'purchase',
            quantityDelta: item.quantity,
            beforeQty,
            afterQty,
            unitCost: item.unitCost,
            unitPrice: prod.salePrice,
            referenceNumber: invoiceNumber,
            userId: user.id ?? 1,
            userName: user.fullName,
            note: `شراء من ${input.supplierName}`,
          });
        }
      }

      let nextSupRef = settings.storeInfo.supplierPaymentNextRef;
      if (paidAmount > 0) {
        await db.supplierPayments.add({
          refNumber: nextSupRef,
          date: nowIso,
          supplierId: input.supplierId,
          supplierName: input.supplierName,
          purchaseIds: [purchaseId],
          purchaseNumbers: [invoiceNumber],
          amount: paidAmount,
          remainingAfter: remainingAmount,
          paymentMethod: input.paymentMethod,
          userId: user.id ?? 1,
          userName: user.fullName,
          notes: `أداء فوري عند فاتورة الشراء ${invoiceNumber}`,
          idempotencyKey: `${input.idempotencyKey}-pay`,
        });
        nextSupRef += 1;
      }

      await db.settings.update(1, {
        storeInfo: {
          ...settings.storeInfo,
          purchaseNextNumber: settings.storeInfo.purchaseNextNumber + 1,
          supplierPaymentNextRef: nextSupRef,
        },
      });

      await db.auditLogs.add({
        date: nowIso,
        userId: user.id ?? 1,
        userName: user.fullName,
        action: 'PURCHASE_CREATED',
        entityType: 'purchaseInvoice',
        entityId: String(purchaseId),
        details: `إنشاء فاتورة مشتريات ${invoiceNumber} بمبلغ ${total.toFixed(2)} — المورد: ${input.supplierName}`,
      });

      return purchase;
    }
  );
}

export async function cancelPurchaseInvoice(
  purchaseId: number,
  reason: string,
  user: AppUser
): Promise<void> {
  assertPermission(user, 'canPurchase', 'ليس لديك صلاحية إلغاء فواتير الشراء');
  if (!reason.trim()) throw new Error('أدخل سبب الإلغاء');
  await db.transaction(
    'rw',
    [db.purchaseInvoices, db.products, db.stockMovements, db.supplierPayments, db.suppliers, db.auditLogs],
    async () => {
      const inv = await db.purchaseInvoices.get(purchaseId);
      if (!inv) throw new Error('فاتورة الشراء غير موجودة');
      if (inv.status === 'cancelled') throw new Error('ملغاة مسبقاً');
      const nowIso = new Date().toISOString();

      await db.purchaseInvoices.update(purchaseId, {
        status: 'cancelled',
        cancelReason: reason,
        cancelledAt: nowIso,
        cancelledBy: user.fullName,
      });

      for (const item of inv.items) {
        const netToDeduct = round2(item.quantity - (item.returnedQty ?? 0));
        if (netToDeduct <= 0) continue;
        const prod = await db.products.get(item.productId);
        if (prod) {
          const beforeQty = prod.quantity;
          const afterQty = round2(Math.max(0, beforeQty - netToDeduct));
          await db.products.update(prod.id!, { quantity: afterQty, updatedAt: nowIso });
          await db.stockMovements.add({
            date: nowIso,
            productId: prod.id!,
            productName: prod.name,
            barcode: prod.barcode,
            type: 'purchase_cancel',
            quantityDelta: -netToDeduct,
            beforeQty,
            afterQty,
            unitCost: item.unitCost,
            unitPrice: prod.salePrice,
            referenceNumber: inv.invoiceNumber,
            userId: user.id ?? 1,
            userName: user.fullName,
            note: `إلغاء فاتورة شراء ${inv.invoiceNumber}: ${reason}`,
          });
        }
      }

      // Cancel sole-invoice supplier payments linked to this purchase
      const supPayments = await db.supplierPayments
        .where('supplierId')
        .equals(inv.supplierId)
        .toArray();
      let cancelledPaidTotal = 0;
      for (const p of supPayments) {
        if (!p.isCancelled && p.purchaseIds.length === 1 && p.purchaseIds[0] === purchaseId) {
          await db.supplierPayments.update(p.id!, { isCancelled: true });
          cancelledPaidTotal = round2(cancelledPaidTotal + p.amount);
        }
      }

      // Any remaining paid portion (e.g. from multi-invoice batch payment) becomes supplier creditBalance
      const unreversedPaid = round2(Math.max(0, inv.paidAmount - cancelledPaidTotal));
      if (unreversedPaid > 0.005) {
        const sup = await db.suppliers.get(inv.supplierId);
        if (sup) {
          await db.suppliers.update(inv.supplierId, {
            creditBalance: round2((sup.creditBalance ?? 0) + unreversedPaid),
          });
        }
      }

      await db.auditLogs.add({
        date: nowIso,
        userId: user.id ?? 1,
        userName: user.fullName,
        action: 'PURCHASE_CANCELLED',
        entityType: 'purchaseInvoice',
        entityId: String(purchaseId),
        details: `إلغاء فاتورة شراء ${inv.invoiceNumber} — السبب: ${reason}${cancelledPaidTotal > 0 ? ` (إلغاء دفعات: ${cancelledPaidTotal.toFixed(2)})` : ''}${unreversedPaid > 0 ? ` (رصيد للمورد: ${unreversedPaid.toFixed(2)})` : ''}`,
        canRestore: false,
      });
    }
  );
}

export async function createSupplierReturn(
  purchaseInvoiceId: number,
  items: SupplierReturnItem[],
  settlementMethod: 'cash' | 'credit_note' | 'bank_transfer',
  reason: string,
  user: AppUser
): Promise<SupplierReturn> {
  assertPermission(user, 'canPurchase', 'ليس لديك صلاحية تسجيل مرتجعات الموردين');
  if (!items.length) throw new Error('اختر منتجاً واحداً على الأقل لإرجاعه للمورد');

  return db.transaction(
    'rw',
    [db.purchaseInvoices, db.supplierReturns, db.suppliers, db.products, db.stockMovements, db.settings, db.auditLogs],
    async () => {
      const purchase = await db.purchaseInvoices.get(purchaseInvoiceId);
      if (!purchase) throw new Error('فاتورة الشراء غير موجودة');
      if (purchase.status === 'cancelled') throw new Error('لا يمكن الإرجاع من فاتورة ملغاة');

      const settings = (await db.settings.get(1)) ?? createDefaultSettings();
      const returnNumber = `SRET-${settings.storeInfo.returnNextNumber}`;
      const nowIso = new Date().toISOString();

      let totalAmount = 0;
      const updatedItems = purchase.items.map((it) => ({ ...it }));

      for (const rItem of items) {
        const line = updatedItems.find((i) => i.productId === rItem.productId);
        if (!line) throw new Error(`المنتج ${rItem.productName} غير موجود في الفاتورة`);
        const maxRet = round2(line.quantity - (line.returnedQty ?? 0));
        if (rItem.quantity <= 0 || rItem.quantity > maxRet + 0.001) {
          throw new Error(`الكمية المرتجعة تتجاوز الكمية المشتراة لـ ${rItem.productName}`);
        }
        line.returnedQty = round2((line.returnedQty ?? 0) + rItem.quantity);
        totalAmount = round2(totalAmount + rItem.total);

        const prod = await db.products.get(rItem.productId);
        if (prod) {
          const beforeQty = prod.quantity;
          const afterQty = round2(Math.max(0, beforeQty - rItem.quantity));
          await db.products.update(prod.id!, { quantity: afterQty, updatedAt: nowIso });
          await db.stockMovements.add({
            date: nowIso,
            productId: prod.id!,
            productName: prod.name,
            barcode: prod.barcode,
            type: 'supplier_return',
            quantityDelta: -rItem.quantity,
            beforeQty,
            afterQty,
            unitCost: rItem.unitCost,
            unitPrice: prod.salePrice,
            referenceNumber: returnNumber,
            userId: user.id ?? 1,
            userName: user.fullName,
            note: `إرجاع للمورد ${purchase.supplierName} (${purchase.invoiceNumber}): ${reason}`,
          });
        }
      }

      let debtReduction = 0;
      let creditAdded = 0;
      let refundAmount = 0;
      let newRemaining = purchase.remainingAmount;
      let newPaid = purchase.paidAmount;

      if (settlementMethod === 'credit_note') {
        debtReduction = round2(Math.min(purchase.remainingAmount, totalAmount));
        newRemaining = round2(Math.max(0, purchase.remainingAmount - debtReduction));
        creditAdded = round2(Math.max(0, totalAmount - debtReduction));

        if (creditAdded > 0.005) {
          const sup = await db.suppliers.get(purchase.supplierId);
          if (sup) {
            await db.suppliers.update(purchase.supplierId, {
              creditBalance: round2((sup.creditBalance ?? 0) + creditAdded),
            });
          }
        }
      } else {
        // cash or bank_transfer refund from supplier
        refundAmount = totalAmount;
        const paidCut = round2(Math.min(purchase.paidAmount, totalAmount));
        newPaid = round2(Math.max(0, purchase.paidAmount - paidCut));
        const extraDebtCut = round2(Math.max(0, totalAmount - paidCut));
        if (extraDebtCut > 0.005) {
          debtReduction = round2(Math.min(purchase.remainingAmount, extraDebtCut));
          newRemaining = round2(Math.max(0, purchase.remainingAmount - debtReduction));
        }
      }

      const newStatus =
        newRemaining <= 0.005 ? 'paid' : newPaid > 0 ? 'partial' : 'unpaid';

      await db.purchaseInvoices.update(purchaseInvoiceId, {
        items: updatedItems,
        paidAmount: newPaid,
        remainingAmount: newRemaining,
        status: newStatus,
      });

      const supRet: SupplierReturn = {
        returnNumber,
        purchaseInvoiceId,
        purchaseInvoiceNumber: purchase.invoiceNumber,
        date: nowIso,
        supplierId: purchase.supplierId,
        supplierName: purchase.supplierName,
        items,
        totalAmount,
        debtReduction: debtReduction > 0 ? debtReduction : undefined,
        creditAdded: creditAdded > 0 ? creditAdded : undefined,
        refundAmount: refundAmount > 0 ? refundAmount : undefined,
        settlementMethod,
        userId: user.id ?? 1,
        userName: user.fullName,
        reason,
      };

      const id = await db.supplierReturns.add(supRet);
      supRet.id = id;

      await db.settings.update(1, {
        storeInfo: {
          ...settings.storeInfo,
          returnNextNumber: settings.storeInfo.returnNextNumber + 1,
        },
      });

      await db.auditLogs.add({
        date: nowIso,
        userId: user.id ?? 1,
        userName: user.fullName,
        action: 'SUPPLIER_RETURN',
        entityType: 'supplierReturn',
        entityId: String(id),
        details: `إرجاع للمورد ${purchase.supplierName} (${returnNumber}) بمبلغ ${totalAmount.toFixed(2)}${creditAdded > 0 ? ` (رصيد مضاف: ${creditAdded.toFixed(2)})` : ''}${refundAmount > 0 ? ` (استرداد ${settlementMethod === 'cash' ? 'نقدي' : 'بنكي'}: ${refundAmount.toFixed(2)})` : ''}`,
      });

      return supRet;
    }
  );
}

// ============================================================
// PAYMENTS (Sequential Ref # starting at 1, Multi-invoice + Opening Balance + Installments + Overpayment Guard)
// ============================================================
export async function recordCustomerPayment(
  input: {
    customerId: number;
    customerName: string;
    invoiceIds: number[];
    installmentId?: number;
    amount: number;
    paymentMethod: PaymentMethod;
    date: string;
    notes?: string;
    allowOverpaymentAsCredit?: boolean;
    idempotencyKey: string;
  },
  user: AppUser
): Promise<CustomerPayment> {
  if (!user.permissions?.canManageCustomers && !user.permissions?.canSell) {
    throw new Error('ليس لديك صلاحية تحصيل دفعات الزبناء');
  }
  if (input.amount <= 0) throw new Error('يجب أن يكون مبلغ الدفعة أكبر من الصفر');

  return db.transaction(
    'rw',
    [db.customerPayments, db.saleInvoices, db.customers, db.installments, db.settings, db.auditLogs],
    async () => {
      const existing = await db.customerPayments
        .where('idempotencyKey')
        .equals(input.idempotencyKey)
        .first();
      if (existing) return existing;

      const customer = await db.customers.get(input.customerId);
      if (!customer) throw new Error('الزبون غير موجود');

      const allCustInvsBefore = (
        await db.saleInvoices.where('customerId').equals(input.customerId).toArray()
      ).filter((x) => x.status !== 'cancelled' && x.remainingAmount > 0.005);

      const openingOwed = round2(Math.max(0, customer.openingBalance || 0));
      const invoicesOwed = round2(
        allCustInvsBefore.reduce((sum, inv) => sum + inv.remainingAmount, 0)
      );
      const totalCustomerOwed = round2(openingOwed + invoicesOwed);

      if (input.amount > totalCustomerOwed + 0.005 && !input.allowOverpaymentAsCredit) {
        throw new Error(
          `المبلغ المدفوع (${input.amount.toFixed(2)}) يتجاوز إجمالي الدين المستحق (${totalCustomerOwed.toFixed(2)}). خفّض المبلغ أو فعّل خيار «تسجيل الفائض كرصيد للزبون».`
        );
      }

      const settings = (await db.settings.get(1)) ?? createDefaultSettings();
      const refNumber = settings.storeInfo.customerPaymentNextRef;
      const nowIso = input.date || new Date().toISOString();

      let targetInvoices =
        input.invoiceIds.length > 0
          ? (await db.saleInvoices.bulkGet(input.invoiceIds)).filter(
              (x): x is SaleInvoice => !!x && x.status !== 'cancelled' && x.remainingAmount > 0.005
            )
          : allCustInvsBefore;

      targetInvoices = targetInvoices.sort((a, b) => a.date.localeCompare(b.date));

      let remainingToAllocate = round2(input.amount);
      let openingBalancePaid = 0;
      const touchedIds: number[] = [];
      const touchedNumbers: string[] = [];

      // If no specific invoices were picked, settle opening balance first (oldest prior balance)
      if (input.invoiceIds.length === 0 && openingOwed > 0.005 && remainingToAllocate > 0.005) {
        openingBalancePaid = round2(Math.min(remainingToAllocate, openingOwed));
        remainingToAllocate = round2(remainingToAllocate - openingBalancePaid);
      }

      // Apply to target invoices & settle their installments chronologically
      for (const inv of targetInvoices) {
        if (remainingToAllocate <= 0.005) break;
        const apply = round2(Math.min(remainingToAllocate, inv.remainingAmount));
        const newPaid = round2(inv.paidAmount + apply);
        const newRem = round2(Math.max(0, inv.remainingAmount - apply));
        const newStatus = newRem <= 0.005 ? 'paid' : 'partial';

        await db.saleInvoices.update(inv.id!, {
          paidAmount: newPaid,
          remainingAmount: newRem,
          status: newStatus,
        });
        touchedIds.push(inv.id!);
        touchedNumbers.push(inv.invoiceNumber);

        // Settle installments linked to this invoice
        const openInsts = (
          await db.installments.where('saleInvoiceId').equals(inv.id!).toArray()
        )
          .filter((inst) => inst.remainingAmount > 0.005)
          .sort((a, b) => {
            if (input.installmentId && a.id === input.installmentId) return -1;
            if (input.installmentId && b.id === input.installmentId) return 1;
            return a.dueDate.localeCompare(b.dueDate);
          });

        let instPool = apply;
        for (const inst of openInsts) {
          if (instPool <= 0.005) break;
          const instPay = round2(Math.min(instPool, inst.remainingAmount));
          const nextInstPaid = round2(inst.paidAmount + instPay);
          const nextInstRem = round2(Math.max(0, inst.remainingAmount - instPay));
          await db.installments.update(inst.id!, {
            paidAmount: nextInstPaid,
            remainingAmount: nextInstRem,
            status: nextInstRem <= 0.005 ? 'paid' : 'partial',
            paidAt: nextInstRem <= 0.005 ? nowIso : inst.paidAt,
          });
          instPool = round2(instPool - instPay);
        }

        remainingToAllocate = round2(remainingToAllocate - apply);
      }

      // If specific invoices were chosen and money still remains, also settle openingBalance
      if (remainingToAllocate > 0.005 && openingOwed - openingBalancePaid > 0.005) {
        const extraOpening = round2(
          Math.min(remainingToAllocate, round2(openingOwed - openingBalancePaid))
        );
        openingBalancePaid = round2(openingBalancePaid + extraOpening);
        remainingToAllocate = round2(remainingToAllocate - extraOpening);
      }

      // If specific invoices were chosen and money still remains, settle other open invoices
      if (input.invoiceIds.length > 0 && remainingToAllocate > 0.005) {
        const otherOpen = allCustInvsBefore
          .filter((i) => !touchedIds.includes(i.id!))
          .sort((a, b) => a.date.localeCompare(b.date));
        for (const inv of otherOpen) {
          if (remainingToAllocate <= 0.005) break;
          const apply = round2(Math.min(remainingToAllocate, inv.remainingAmount));
          const newPaid = round2(inv.paidAmount + apply);
          const newRem = round2(Math.max(0, inv.remainingAmount - apply));
          await db.saleInvoices.update(inv.id!, {
            paidAmount: newPaid,
            remainingAmount: newRem,
            status: newRem <= 0.005 ? 'paid' : 'partial',
          });
          touchedIds.push(inv.id!);
          touchedNumbers.push(inv.invoiceNumber);
          remainingToAllocate = round2(remainingToAllocate - apply);
        }
      }

      const newOpeningBalance = round2(Math.max(0, openingOwed - openingBalancePaid));
      let creditAdded = 0;
      if (remainingToAllocate > 0.005 && input.allowOverpaymentAsCredit) {
        creditAdded = remainingToAllocate;
      }

      if (openingBalancePaid > 0.005 || creditAdded > 0.005) {
        await db.customers.update(input.customerId, {
          openingBalance: newOpeningBalance,
          creditBalance: round2((customer.creditBalance ?? 0) + creditAdded),
        });
      }

      // Compute customer total remaining balance after payment (open invoices + remaining opening balance)
      const allCustInvs = await db.saleInvoices
        .where('customerId')
        .equals(input.customerId)
        .toArray();
      const remainingInvoicesAfter = allCustInvs
        .filter((i) => i.status !== 'cancelled')
        .reduce((s, i) => s + i.remainingAmount, 0);
      const remainingAfter = round2(remainingInvoicesAfter + newOpeningBalance);

      if (openingBalancePaid > 0.005) {
        touchedNumbers.unshift('رصيد افتتاحي');
      }

      const payment: CustomerPayment = {
        refNumber,
        date: nowIso,
        customerId: input.customerId,
        customerName: input.customerName,
        invoiceIds: touchedIds,
        invoiceNumbers: touchedNumbers,
        amount: round2(input.amount),
        openingBalancePaid: openingBalancePaid > 0 ? openingBalancePaid : undefined,
        creditAdded: creditAdded > 0 ? creditAdded : undefined,
        remainingAfter,
        paymentMethod: input.paymentMethod,
        userId: user.id ?? 1,
        userName: user.fullName,
        notes: input.notes,
        idempotencyKey: input.idempotencyKey,
      };

      const id = await db.customerPayments.add(payment);
      payment.id = id;

      await db.settings.update(1, {
        storeInfo: {
          ...settings.storeInfo,
          customerPaymentNextRef: refNumber + 1,
        },
      });

      await db.auditLogs.add({
        date: new Date().toISOString(),
        userId: user.id ?? 1,
        userName: user.fullName,
        action: 'CUSTOMER_PAYMENT',
        entityType: 'customerPayment',
        entityId: String(id),
        details: `تحصيل دفعة رقم #${refNumber} من ${input.customerName} بمبلغ ${input.amount.toFixed(2)}${openingBalancePaid > 0 ? ` (منها ${openingBalancePaid.toFixed(2)} للرصيد الافتتاحي)` : ''}${creditAdded > 0 ? ` (فائض ${creditAdded.toFixed(2)} سُجل كرصيد للزبون)` : ''}`,
      });

      return payment;
    }
  );
}

export async function recordSupplierPayment(
  input: {
    supplierId: number;
    supplierName: string;
    purchaseIds: number[];
    amount: number;
    paymentMethod: PaymentMethod;
    date: string;
    notes?: string;
    allowOverpaymentAsCredit?: boolean;
    idempotencyKey: string;
  },
  user: AppUser
): Promise<SupplierPayment> {
  if (!user.permissions?.canManageSuppliers && !user.permissions?.canPurchase) {
    throw new Error('ليس لديك صلاحية تسديد دفعات الموردين');
  }
  if (input.amount <= 0) throw new Error('يجب أن يكون مبلغ الدفعة أكبر من الصفر');

  return db.transaction(
    'rw',
    [db.supplierPayments, db.purchaseInvoices, db.suppliers, db.settings, db.auditLogs],
    async () => {
      const existing = await db.supplierPayments
        .where('idempotencyKey')
        .equals(input.idempotencyKey)
        .first();
      if (existing) return existing;

      const supplier = await db.suppliers.get(input.supplierId);
      if (!supplier) throw new Error('المورد غير موجود');

      const allSupInvsBefore = (
        await db.purchaseInvoices.where('supplierId').equals(input.supplierId).toArray()
      ).filter((x) => x.status !== 'cancelled' && x.remainingAmount > 0.005);

      const openingOwed = round2(Math.max(0, supplier.openingBalance || 0));
      const invoicesOwed = round2(
        allSupInvsBefore.reduce((sum, inv) => sum + inv.remainingAmount, 0)
      );
      const totalSupplierOwed = round2(openingOwed + invoicesOwed);

      if (input.amount > totalSupplierOwed + 0.005 && !input.allowOverpaymentAsCredit) {
        throw new Error(
          `المبلغ المدفوع (${input.amount.toFixed(2)}) يتجاوز إجمالي المستحقات للمورد (${totalSupplierOwed.toFixed(2)}). خفّض المبلغ أو فعّل خيار «تسجيل الفائض كرصيد لدى المورد».`
        );
      }

      const settings = (await db.settings.get(1)) ?? createDefaultSettings();
      const refNumber = settings.storeInfo.supplierPaymentNextRef;

      let targetPurchases =
        input.purchaseIds.length > 0
          ? (await db.purchaseInvoices.bulkGet(input.purchaseIds)).filter(
              (x): x is PurchaseInvoice => !!x && x.status !== 'cancelled' && x.remainingAmount > 0.005
            )
          : allSupInvsBefore;

      targetPurchases = targetPurchases.sort((a, b) => a.date.localeCompare(b.date));

      let remainingToAllocate = round2(input.amount);
      let openingBalancePaid = 0;
      const touchedIds: number[] = [];
      const touchedNumbers: string[] = [];

      if (input.purchaseIds.length === 0 && openingOwed > 0.005 && remainingToAllocate > 0.005) {
        openingBalancePaid = round2(Math.min(remainingToAllocate, openingOwed));
        remainingToAllocate = round2(remainingToAllocate - openingBalancePaid);
      }

      for (const inv of targetPurchases) {
        if (remainingToAllocate <= 0.005) break;
        const apply = round2(Math.min(remainingToAllocate, inv.remainingAmount));
        const newPaid = round2(inv.paidAmount + apply);
        const newRem = round2(Math.max(0, inv.remainingAmount - apply));
        const newStatus = newRem <= 0.005 ? 'paid' : 'partial';

        await db.purchaseInvoices.update(inv.id!, {
          paidAmount: newPaid,
          remainingAmount: newRem,
          status: newStatus,
        });
        touchedIds.push(inv.id!);
        touchedNumbers.push(inv.invoiceNumber);
        remainingToAllocate = round2(remainingToAllocate - apply);
      }

      if (remainingToAllocate > 0.005 && openingOwed - openingBalancePaid > 0.005) {
        const extraOpening = round2(
          Math.min(remainingToAllocate, round2(openingOwed - openingBalancePaid))
        );
        openingBalancePaid = round2(openingBalancePaid + extraOpening);
        remainingToAllocate = round2(remainingToAllocate - extraOpening);
      }

      if (input.purchaseIds.length > 0 && remainingToAllocate > 0.005) {
        const otherOpen = allSupInvsBefore
          .filter((i) => !touchedIds.includes(i.id!))
          .sort((a, b) => a.date.localeCompare(b.date));
        for (const inv of otherOpen) {
          if (remainingToAllocate <= 0.005) break;
          const apply = round2(Math.min(remainingToAllocate, inv.remainingAmount));
          const newPaid = round2(inv.paidAmount + apply);
          const newRem = round2(Math.max(0, inv.remainingAmount - apply));
          await db.purchaseInvoices.update(inv.id!, {
            paidAmount: newPaid,
            remainingAmount: newRem,
            status: newRem <= 0.005 ? 'paid' : 'partial',
          });
          touchedIds.push(inv.id!);
          touchedNumbers.push(inv.invoiceNumber);
          remainingToAllocate = round2(remainingToAllocate - apply);
        }
      }

      const newOpeningBalance = round2(Math.max(0, openingOwed - openingBalancePaid));
      let creditAdded = 0;
      if (remainingToAllocate > 0.005 && input.allowOverpaymentAsCredit) {
        creditAdded = remainingToAllocate;
      }

      if (openingBalancePaid > 0.005 || creditAdded > 0.005) {
        await db.suppliers.update(input.supplierId, {
          openingBalance: newOpeningBalance,
          creditBalance: round2((supplier.creditBalance ?? 0) + creditAdded),
        });
      }

      const allSupInvs = await db.purchaseInvoices
        .where('supplierId')
        .equals(input.supplierId)
        .toArray();
      const remainingInvoicesAfter = allSupInvs
        .filter((i) => i.status !== 'cancelled')
        .reduce((s, i) => s + i.remainingAmount, 0);
      const remainingAfter = round2(remainingInvoicesAfter + newOpeningBalance);

      if (openingBalancePaid > 0.005) {
        touchedNumbers.unshift('رصيد افتتاحي');
      }

      const payment: SupplierPayment = {
        refNumber,
        date: input.date || new Date().toISOString(),
        supplierId: input.supplierId,
        supplierName: input.supplierName,
        purchaseIds: touchedIds,
        purchaseNumbers: touchedNumbers,
        amount: round2(input.amount),
        openingBalancePaid: openingBalancePaid > 0 ? openingBalancePaid : undefined,
        creditAdded: creditAdded > 0 ? creditAdded : undefined,
        remainingAfter,
        paymentMethod: input.paymentMethod,
        userId: user.id ?? 1,
        userName: user.fullName,
        notes: input.notes,
        idempotencyKey: input.idempotencyKey,
      };

      const id = await db.supplierPayments.add(payment);
      payment.id = id;

      await db.settings.update(1, {
        storeInfo: {
          ...settings.storeInfo,
          supplierPaymentNextRef: refNumber + 1,
        },
      });

      await db.auditLogs.add({
        date: new Date().toISOString(),
        userId: user.id ?? 1,
        userName: user.fullName,
        action: 'SUPPLIER_PAYMENT',
        entityType: 'supplierPayment',
        entityId: String(id),
        details: `تسديد دفعة مورد رقم #${refNumber} لـ ${input.supplierName} بمبلغ ${input.amount.toFixed(2)}${openingBalancePaid > 0 ? ` (منها ${openingBalancePaid.toFixed(2)} للرصيد الافتتاحي)` : ''}${creditAdded > 0 ? ` (فائض ${creditAdded.toFixed(2)} كرصيد لدى المورد)` : ''}`,
      });

      return payment;
    }
  );
}

// ============================================================
// INVENTORY ADJUSTMENT / STOCKTAKE / DAMAGE / LOSS
// ============================================================
export async function adjustProductStock(
  productId: number,
  type: Extract<StockMovementType, 'adjustment' | 'damage' | 'loss'>,
  newQuantityOrDelta: number,
  isAbsoluteCount: boolean,
  note: string,
  user: AppUser
): Promise<void> {
  assertPermission(user, 'canManageProducts', 'ليس لديك صلاحية تعديل المخزون أو الجرد');
  await db.transaction('rw', [db.products, db.stockMovements, db.auditLogs], async () => {
    const prod = await db.products.get(productId);
    if (!prod) throw new Error('المنتج غير موجود');

    const beforeQty = prod.quantity;
    const afterQty = isAbsoluteCount
      ? round2(Math.max(0, newQuantityOrDelta))
      : round2(Math.max(0, beforeQty + newQuantityOrDelta));
    const delta = round2(afterQty - beforeQty);
    if (Math.abs(delta) < 0.0001) return;

    const nowIso = new Date().toISOString();
    await db.products.update(productId, { quantity: afterQty, updatedAt: nowIso });

    const refNum = `${type.toUpperCase().slice(0, 3)}-${Date.now().toString().slice(-5)}`;
    await db.stockMovements.add({
      date: nowIso,
      productId,
      productName: prod.name,
      barcode: prod.barcode,
      type,
      quantityDelta: delta,
      beforeQty,
      afterQty,
      unitCost: prod.purchasePrice,
      unitPrice: prod.salePrice,
      referenceNumber: refNum,
      userId: user.id ?? 1,
      userName: user.fullName,
      note,
    });

    await db.auditLogs.add({
      date: nowIso,
      userId: user.id ?? 1,
      userName: user.fullName,
      action: `STOCK_${type.toUpperCase()}`,
      entityType: 'product',
      entityId: String(productId),
      details: `${prod.name}: من ${beforeQty} إلى ${afterQty} (${delta > 0 ? '+' : ''}${delta}) — ${note}`,
    });
  });
}

// ============================================================
// EXPENSES
// ============================================================
export async function addExpenseRecord(
  expense: Omit<Expense, 'id' | 'userId' | 'userName'>,
  user: AppUser
): Promise<number> {
  const id = await db.expenses.add({
    ...expense,
    userId: user.id ?? 1,
    userName: user.fullName,
  });
  await logAudit(
    user,
    'EXPENSE_CREATED',
    'expense',
    id,
    `تسجيل مصروف: ${expense.name} بمبلغ ${expense.amount.toFixed(2)}`
  );
  return id;
}

// ============================================================
// CASH SESSIONS / SHIFTS & DRAWER COUNT
// ============================================================
export interface CashSessionSummary {
  openingBalance: number;
  cashSales: number;
  cashCollections: number;
  cashRefunds: number;
  cashExpenses: number;
  cashSupplierPayments: number;
  expectedCash: number;
}

export async function computeCashSessionSummary(
  openedAt: string,
  closedAt: string,
  openingBalance: number
): Promise<CashSessionSummary> {
  const [allSales, allCustPays, allSaleReturns, allExpenses, allSupPays] = await Promise.all([
    db.saleInvoices.toArray(),
    db.customerPayments.toArray(),
    db.saleReturns.toArray(),
    db.expenses.toArray(),
    db.supplierPayments.toArray(),
  ]);

  const inWindow = (iso: string) => iso >= openedAt && iso <= closedAt;

  // Build map of sale invoices & immediate POS payment idempotency keys to avoid double-counting
  const saleById = new Map<number, SaleInvoice>();
  const immediatePosPayKeys = new Set<string>();
  for (const s of allSales) {
    if (s.id != null) saleById.set(s.id, s);
    if (s.idempotencyKey) immediatePosPayKeys.add(`${s.idempotencyKey}-pay`);
  }

  // 1. Cash sales (immutable cash entered into drawer at sale time — never reduced by later returns which are counted in cashRefunds)
  const cashSales = round2(
    allSales
      .filter((s) => s.status !== 'cancelled' && inWindow(s.date))
      .reduce((sum, s) => {
        const cashSplits = s.paymentSplits
          .filter((p) => p.method === 'cash' && p.amount > 0)
          .reduce((a, p) => a + p.amount, 0);
        if (cashSplits <= 0) return sum;
        const nonCashSplits = s.paymentSplits
          .filter((p) => p.method !== 'cash' && p.amount > 0)
          .reduce((a, p) => a + p.amount, 0);
        const maxCashDue = Math.max(0, round2(s.total - (s.creditApplied ?? 0) - nonCashSplits));
        const netCashReceived = Math.min(cashSplits, maxCashDue);
        return sum + Math.max(0, netCashReceived);
      }, 0)
  );

  // 2. Cash collections (non-cancelled cash customerPayments excluding immediate POS sale payments)
  const cashCollections = round2(
    allCustPays
      .filter(
        (p) =>
          !p.isCancelled &&
          p.paymentMethod === 'cash' &&
          inWindow(p.date) &&
          !(p.idempotencyKey && immediatePosPayKeys.has(p.idempotencyKey)) &&
          !(p.notes && p.notes.startsWith('أداء فوري عند البيع'))
      )
      .reduce((sum, p) => sum + p.amount, 0)
  );

  // 3. Cash refunds (saleReturns with cash refund on non-cancelled invoices)
  const cashRefunds = round2(
    allSaleReturns
      .filter((r) => {
        if (r.refundMethod !== 'cash' || !inWindow(r.date)) return false;
        const orig = saleById.get(r.saleInvoiceId);
        return !orig || orig.status !== 'cancelled';
      })
      .reduce((sum, r) => sum + (r.cashRefund !== undefined ? r.cashRefund : r.totalAmount), 0)
  );

  // 4. Cash expenses
  const cashExpenses = round2(
    allExpenses
      .filter((e) => !e.isCancelled && e.paymentMethod === 'cash' && inWindow(e.date))
      .reduce((sum, e) => sum + e.amount, 0)
  );

  // 5. Cash supplier payments
  const cashSupplierPayments = round2(
    allSupPays
      .filter((p) => !p.isCancelled && p.paymentMethod === 'cash' && inWindow(p.date))
      .reduce((sum, p) => sum + p.amount, 0)
  );

  const expectedCash = round2(
    openingBalance +
      cashSales +
      cashCollections -
      cashRefunds -
      cashExpenses -
      cashSupplierPayments
  );

  return {
    openingBalance: round2(openingBalance),
    cashSales,
    cashCollections,
    cashRefunds,
    cashExpenses,
    cashSupplierPayments,
    expectedCash,
  };
}

export async function getActiveCashSession(): Promise<CashSession | undefined> {
  return db.cashSessions.where('status').equals('open').first();
}

export async function openCashSession(
  openingBalance: number,
  user: AppUser,
  notes?: string
): Promise<CashSession> {
  assertPermission(user, 'canSell', 'ليس لديك صلاحية فتح وردية الصندوق');
  if (openingBalance < 0 || Number.isNaN(openingBalance)) {
    throw new Error('رصيد الافتتاح يجب أن يكون صفراً أو أكبر');
  }

  return db.transaction('rw', [db.cashSessions, db.auditLogs], async () => {
    const active = await db.cashSessions.where('status').equals('open').first();
    if (active) {
      throw new Error('توجد وردية صندوق مفتوحة بالفعل — يرجى إغلاقها أولاً');
    }
    const nowIso = new Date().toISOString();
    const cleanOpening = round2(openingBalance);
    const session: CashSession = {
      status: 'open',
      openedAt: nowIso,
      openedByUserId: user.id ?? 1,
      openedByUserName: user.fullName,
      openingBalance: cleanOpening,
      cashSales: 0,
      cashCollections: 0,
      cashRefunds: 0,
      cashExpenses: 0,
      cashSupplierPayments: 0,
      expectedCash: cleanOpening,
      notes: notes?.trim() || undefined,
    };
    const id = await db.cashSessions.add(session);
    session.id = id;

    await db.auditLogs.add({
      date: nowIso,
      userId: user.id ?? 1,
      userName: user.fullName,
      action: 'CASH_SESSION_OPENED',
      entityType: 'cashSession',
      entityId: String(id),
      details: `فتح وردية صندوق #${id} برصيد افتتاحي ${cleanOpening.toFixed(2)}`,
    });

    return session;
  });
}

export async function closeCashSession(
  sessionId: number,
  countedCash: number,
  user: AppUser,
  notes?: string
): Promise<CashSession> {
  assertPermission(user, 'canSell', 'ليس لديك صلاحية إغلاق وردية الصندوق');
  if (countedCash < 0 || Number.isNaN(countedCash)) {
    throw new Error('النقد المعدود يجب أن يكون صفراً أو أكبر');
  }

  const session = await db.cashSessions.get(sessionId);
  if (!session) throw new Error('الوردية غير موجودة');
  if (session.status !== 'open') throw new Error('الوردية مغلقة مسبقاً');

  const closedAt = new Date().toISOString();
  const summary = await computeCashSessionSummary(
    session.openedAt,
    closedAt,
    session.openingBalance
  );
  const cleanCounted = round2(countedCash);
  const variance = round2(cleanCounted - summary.expectedCash);

  const updatedFields: Partial<CashSession> = {
    status: 'closed',
    closedAt,
    closedByUserId: user.id ?? 1,
    closedByUserName: user.fullName,
    cashSales: summary.cashSales,
    cashCollections: summary.cashCollections,
    cashRefunds: summary.cashRefunds,
    cashExpenses: summary.cashExpenses,
    cashSupplierPayments: summary.cashSupplierPayments,
    expectedCash: summary.expectedCash,
    countedCash: cleanCounted,
    variance,
    notes: notes?.trim() || session.notes,
  };

  await db.cashSessions.update(sessionId, updatedFields);
  await logAudit(
    user,
    'CASH_SESSION_CLOSED',
    'cashSession',
    sessionId,
    `إغلاق وردية #${sessionId} — المتوقع: ${summary.expectedCash.toFixed(2)} — المعدود: ${cleanCounted.toFixed(2)} — الفارق: ${variance >= 0 ? '+' : ''}${variance.toFixed(2)}`
  );

  return { ...session, ...updatedFields };
}

// ============================================================
// FULL DATABASE BACKUP, ENCRYPTION & RESTORE (External Folder + Daily Download Fallback)
// ============================================================
export async function exportDatabaseSnapshot(): Promise<{
  rawJson: string;
  checksum: string;
  sizeBytes: number;
}> {
  const data = {
    version: 2,
    exportedAt: new Date().toISOString(),
    tables: {
      users: await db.users.toArray(),
      categories: await db.categories.toArray(),
      products: await db.products.toArray(),
      priceHistory: await db.priceHistory.toArray(),
      customers: await db.customers.toArray(),
      suppliers: await db.suppliers.toArray(),
      saleInvoices: await db.saleInvoices.toArray(),
      saleReturns: await db.saleReturns.toArray(),
      installments: await db.installments.toArray(),
      heldCarts: await db.heldCarts.toArray(),
      purchaseInvoices: await db.purchaseInvoices.toArray(),
      supplierReturns: await db.supplierReturns.toArray(),
      stockMovements: await db.stockMovements.toArray(),
      customerPayments: await db.customerPayments.toArray(),
      supplierPayments: await db.supplierPayments.toArray(),
      expenses: await db.expenses.toArray(),
      cashSessions: await db.cashSessions.toArray(),
      auditLogs: await db.auditLogs.toArray(),
      loginLogs: await db.loginLogs.toArray(),
      settings: await db.settings.toArray(),
    },
  };
  const rawJson = JSON.stringify(data);
  const checksum = await computeSha256(rawJson);
  const sizeBytes = new Blob([rawJson]).size;
  return { rawJson, checksum, sizeBytes };
}

export interface CreateBackupOptions {
  skipExternalWrite?: boolean;
  forceDownload?: boolean;
  allowUnencryptedFallback?: boolean;
}

export async function createBackupRecord(
  type: 'manual' | 'auto',
  label: string,
  passphrase: string | null,
  user: AppUser,
  options?: CreateBackupOptions
) {
  const settings = (await db.settings.get(1)) ?? createDefaultSettings();
  const cleanPass = passphrase?.trim() ?? '';
  if (
    settings.backupConfig.encryptBackupsDefault &&
    !cleanPass &&
    !options?.allowUnencryptedFallback
  ) {
    throw new Error(
      'التشفير مفعّل افتراضياً — يرجى إدخال كلمة مرور للتشفير / Le chiffrement est activé par défaut — veuillez saisir un mot de passe'
    );
  }

  const { rawJson, checksum } = await exportDatabaseSnapshot();
  const encrypted = cleanPass.length > 0;
  const payload = encrypted
    ? await encryptBackupPayload(rawJson, cleanPass)
    : rawJson;

  const nowIso = new Date().toISOString();
  const envelope = JSON.stringify({
    app: 'MatjarProRetailDB',
    version: 2,
    createdAt: nowIso,
    encrypted,
    checksum,
    payload,
  });

  const stamp = nowIso.replace(/[:.]/g, '-');
  const fileName = `RM_POS_GC_${type}_${stamp}.${encrypted ? 'enc.json' : 'json'}`;

  let storageLocation: 'directory' | 'download' | 'metadata_only' = 'metadata_only';
  let folderName: string | undefined;

  if (!options?.skipExternalWrite) {
    const ext = await saveBackupExternally(fileName, envelope, {
      forceDownload: options?.forceDownload,
    });
    storageLocation = ext.storageLocation;
    folderName = ext.folderName;
  }

  // Store ONLY lightweight metadata in IndexedDB — never store full payloadJson inside IndexedDB
  const sizeBytes = new Blob([envelope]).size;
  const id = await db.backups.add({
    date: nowIso,
    type,
    sizeBytes,
    encrypted,
    checksum,
    label,
    fileName,
    storageLocation,
    folderName,
  });

  // Enforce max retained backup metadata rows
  const maxKeep = settings.backupConfig.maxRetainedBackups ?? 10;
  const all = await db.backups.orderBy('date').toArray();
  if (all.length > maxKeep) {
    const toDelete = all.slice(0, all.length - maxKeep).map((b) => b.id!);
    await db.backups.bulkDelete(toDelete);
  }

  const nextBackupConfig = {
    ...settings.backupConfig,
    ...(type === 'auto' ? { lastAutoBackupAt: nowIso } : {}),
    ...(storageLocation === 'directory' || storageLocation === 'download'
      ? { lastExternalExportAt: nowIso }
      : {}),
    ...(folderName ? { externalFolderName: folderName } : {}),
  };
  await db.settings.update(1, { backupConfig: nextBackupConfig });

  await logAudit(
    user,
    'BACKUP_CREATED',
    'backup',
    id,
    `إنشاء نسخة احتياطية (${type === 'manual' ? 'يدوية' : 'تلقائية'}${encrypted ? ' مشفرة' : ''}): ${label} [${storageLocation === 'directory' ? `مجلد: ${folderName || 'خارجي'}` : storageLocation === 'download' ? 'تنزيل ملف' : 'سجل'}]`,
    false
  );

  return { id, envelope, sizeBytes, checksum, encrypted, fileName, storageLocation, folderName };
}

export async function restoreDatabaseFromEnvelope(
  envelopeText: string,
  passphrase: string | null,
  user: AppUser,
  options?: { preBackupPassphrase?: string | null; skipExternalWrite?: boolean }
): Promise<void> {
  assertPermission(user, 'canManageSettings', 'ليس لديك صلاحية استعادة النسخ الاحتياطية');
  const parsedEnvelope = JSON.parse(envelopeText);
  if (parsedEnvelope.app !== 'MatjarProRetailDB' || !parsedEnvelope.payload) {
    throw new Error('ملف النسخة الاحتياطية غير صالح / Fichier de sauvegarde invalide');
  }

  let rawJson: string;
  if (parsedEnvelope.encrypted) {
    if (!passphrase) {
      throw new Error('هذه النسخة مشفرة — يرجى إدخال كلمة فك التشفير');
    }
    try {
      rawJson = await decryptBackupPayload(parsedEnvelope.payload, passphrase);
    } catch {
      throw new Error('كلمة فك التشفير غير صحيحة / Mot de passe de déchiffrement incorrect');
    }
  } else {
    rawJson = parsedEnvelope.payload;
  }

  // Verify SHA-256 integrity before touching DB
  const actualChecksum = await computeSha256(rawJson);
  if (parsedEnvelope.checksum && actualChecksum !== parsedEnvelope.checksum) {
    throw new Error('فشل التحقق من سلامة النسخة (Checksum غير مطابق)');
  }

  const snapshot = JSON.parse(rawJson);
  const t = snapshot.tables;
  if (!t || !Array.isArray(t.products) || !Array.isArray(t.settings)) {
    throw new Error('بنية النسخة الاحتياطية غير مكتملة');
  }

  // Automatic safety backup BEFORE overwriting the database
  await createBackupRecord(
    'auto',
    'نسخة أمان تلقائية قبل الاستعادة',
    options?.preBackupPassphrase ?? passphrase ?? null,
    user,
    {
      allowUnencryptedFallback: true,
      skipExternalWrite: options?.skipExternalWrite,
      forceDownload: !options?.skipExternalWrite,
    }
  );

  await db.transaction(
    'rw',
    [
      db.users,
      db.categories,
      db.products,
      db.priceHistory,
      db.customers,
      db.suppliers,
      db.saleInvoices,
      db.saleReturns,
      db.installments,
      db.heldCarts,
      db.purchaseInvoices,
      db.supplierReturns,
      db.stockMovements,
      db.customerPayments,
      db.supplierPayments,
      db.expenses,
      db.cashSessions,
      db.auditLogs,
      db.loginLogs,
      db.settings,
    ],
    async () => {
      await Promise.all([
        db.users.clear(),
        db.categories.clear(),
        db.products.clear(),
        db.priceHistory.clear(),
        db.customers.clear(),
        db.suppliers.clear(),
        db.saleInvoices.clear(),
        db.saleReturns.clear(),
        db.installments.clear(),
        db.heldCarts.clear(),
        db.purchaseInvoices.clear(),
        db.supplierReturns.clear(),
        db.stockMovements.clear(),
        db.customerPayments.clear(),
        db.supplierPayments.clear(),
        db.expenses.clear(),
        db.cashSessions.clear(),
        db.auditLogs.clear(),
        db.loginLogs.clear(),
        db.settings.clear(),
      ]);

      if (t.users?.length) await db.users.bulkAdd(t.users);
      if (t.categories?.length) await db.categories.bulkAdd(t.categories);
      if (t.products?.length) await db.products.bulkAdd(t.products);
      if (t.priceHistory?.length) await db.priceHistory.bulkAdd(t.priceHistory);
      if (t.customers?.length) await db.customers.bulkAdd(t.customers);
      if (t.suppliers?.length) await db.suppliers.bulkAdd(t.suppliers);
      if (t.saleInvoices?.length) await db.saleInvoices.bulkAdd(t.saleInvoices);
      if (t.saleReturns?.length) await db.saleReturns.bulkAdd(t.saleReturns);
      if (t.installments?.length) await db.installments.bulkAdd(t.installments);
      if (t.heldCarts?.length) await db.heldCarts.bulkAdd(t.heldCarts);
      if (t.purchaseInvoices?.length) await db.purchaseInvoices.bulkAdd(t.purchaseInvoices);
      if (t.supplierReturns?.length) await db.supplierReturns.bulkAdd(t.supplierReturns);
      if (t.stockMovements?.length) await db.stockMovements.bulkAdd(t.stockMovements);
      if (t.customerPayments?.length) await db.customerPayments.bulkAdd(t.customerPayments);
      if (t.supplierPayments?.length) await db.supplierPayments.bulkAdd(t.supplierPayments);
      if (t.expenses?.length) await db.expenses.bulkAdd(t.expenses);
      if (t.cashSessions?.length) await db.cashSessions.bulkAdd(t.cashSessions);
      if (t.auditLogs?.length) await db.auditLogs.bulkAdd(t.auditLogs);
      if (t.loginLogs?.length) await db.loginLogs.bulkAdd(t.loginLogs);
      if (t.settings?.length) await db.settings.bulkPut(t.settings);

      await db.auditLogs.add({
        date: new Date().toISOString(),
        userId: user.id ?? 1,
        userName: user.fullName,
        action: 'BACKUP_RESTORED',
        entityType: 'database',
        entityId: '1',
        details: 'استعادة كاملة لقاعدة البيانات بعد إنشاء نسخة أمان والتحقق من السلامة',
      });
    }
  );
}

export async function clearBusinessDataForFreshStart(
  user: AppUser,
  options?: { backupPassphrase?: string | null; skipExternalWrite?: boolean }
): Promise<void> {
  assertPermission(user, 'canManageSettings', 'ليس لديك صلاحية تصفير قاعدة البيانات');

  // Automatic safety backup BEFORE wiping business data & audit logs
  await createBackupRecord(
    'auto',
    'نسخة أمان تلقائية قبل تصفير البيانات',
    options?.backupPassphrase ?? null,
    user,
    {
      allowUnencryptedFallback: true,
      skipExternalWrite: options?.skipExternalWrite,
      forceDownload: !options?.skipExternalWrite,
    }
  );

  await db.transaction(
    'rw',
    [
      db.categories,
      db.products,
      db.priceHistory,
      db.customers,
      db.suppliers,
      db.saleInvoices,
      db.saleReturns,
      db.installments,
      db.heldCarts,
      db.purchaseInvoices,
      db.supplierReturns,
      db.stockMovements,
      db.customerPayments,
      db.supplierPayments,
      db.expenses,
      db.cashSessions,
      db.auditLogs,
      db.settings,
    ],
    async () => {
      await Promise.all([
        db.categories.clear(),
        db.products.clear(),
        db.priceHistory.clear(),
        db.customers.clear(),
        db.suppliers.clear(),
        db.saleInvoices.clear(),
        db.saleReturns.clear(),
        db.installments.clear(),
        db.heldCarts.clear(),
        db.purchaseInvoices.clear(),
        db.supplierReturns.clear(),
        db.stockMovements.clear(),
        db.customerPayments.clear(),
        db.supplierPayments.clear(),
        db.expenses.clear(),
        db.cashSessions.clear(),
        db.auditLogs.clear(),
      ]);

      // Keep walk-in cash customer #1
      await db.customers.add({
        id: 1,
        fullName: 'زبون عابر (نقدي)',
        phone: '0000-000000',
        address: 'البيع المباشر',
        creditLimit: 0,
        openingBalance: 0,
        creditBalance: 0,
        createdAt: new Date().toISOString(),
      });

      const settings = (await db.settings.get(1)) ?? createDefaultSettings();
      await db.settings.update(1, {
        storeInfo: {
          ...settings.storeInfo,
          saleNextNumber: 1,
          purchaseNextNumber: 1,
          returnNextNumber: 1,
          customerPaymentNextRef: 1,
          supplierPaymentNextRef: 1,
        },
      });
    }
  );
}

// ============================================================
// PRODUCTS (Opening Balance Stock Movement + Read-Only Qty on Edit)
// ============================================================
export async function createProductWithOpeningStock(
  data: Omit<Product, 'id' | 'createdAt' | 'updatedAt'>,
  user: AppUser
): Promise<number> {
  assertPermission(user, 'canManageProducts', 'ليس لديك صلاحية إضافة المنتجات');
  return db.transaction('rw', [db.products, db.stockMovements, db.auditLogs], async () => {
    const nowIso = new Date().toISOString();
    const initialQty = round2(Math.max(0, Number(data.quantity) || 0));

    const productId = await db.products.add({
      ...data,
      quantity: initialQty,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    if (initialQty > 0) {
      await db.stockMovements.add({
        date: nowIso,
        productId,
        productName: data.name,
        barcode: data.barcode,
        type: 'opening_balance',
        quantityDelta: initialQty,
        beforeQty: 0,
        afterQty: initialQty,
        unitCost: data.purchasePrice,
        unitPrice: data.salePrice,
        referenceNumber: `OPEN-${productId}`,
        userId: user.id ?? 1,
        userName: user.fullName,
        note: 'رصيد افتتاحي عند إنشاء المنتج',
      });
    }

    await db.auditLogs.add({
      date: nowIso,
      userId: user.id ?? 1,
      userName: user.fullName,
      action: 'PRODUCT_CREATED',
      entityType: 'product',
      entityId: String(productId),
      details: `إضافة منتج جديد: ${data.name}${initialQty > 0 ? ` (رصيد افتتاحي: ${initialQty})` : ''}`,
    });

    return productId;
  });
}

export async function importProductsWithOpeningStock(
  items: Omit<Product, 'id' | 'createdAt' | 'updatedAt'>[],
  user: AppUser
): Promise<number> {
  assertPermission(user, 'canManageProducts', 'ليس لديك صلاحية استيراد المنتجات');
  if (!items.length) return 0;

  return db.transaction('rw', [db.products, db.stockMovements, db.auditLogs], async () => {
    const nowIso = new Date().toISOString();
    let count = 0;

    for (const data of items) {
      const initialQty = round2(Math.max(0, Number(data.quantity) || 0));
      const productId = await db.products.add({
        ...data,
        quantity: initialQty,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      if (initialQty > 0) {
        await db.stockMovements.add({
          date: nowIso,
          productId,
          productName: data.name,
          barcode: data.barcode,
          type: 'opening_balance',
          quantityDelta: initialQty,
          beforeQty: 0,
          afterQty: initialQty,
          unitCost: data.purchasePrice,
          unitPrice: data.salePrice,
          referenceNumber: `IMP-${productId}`,
          userId: user.id ?? 1,
          userName: user.fullName,
          note: 'رصيد افتتاحي عبر استيراد Excel',
        });
      }
      count += 1;
    }

    await db.auditLogs.add({
      date: nowIso,
      userId: user.id ?? 1,
      userName: user.fullName,
      action: 'PRODUCTS_IMPORTED',
      entityType: 'product',
      entityId: String(count),
      details: `استيراد ${count} منتجاً مع تسجيل حركات الرصيد الافتتاحي`,
    });

    return count;
  });
}

export async function updateProductWithPriceHistory(
  productId: number,
  updates: Partial<Product>,
  user: AppUser
): Promise<void> {
  assertPermission(user, 'canManageProducts', 'ليس لديك صلاحية تعديل المنتجات');
  await db.transaction('rw', [db.products, db.priceHistory, db.auditLogs], async () => {
    const existing = await db.products.get(productId);
    if (!existing) throw new Error('المنتج غير موجود');
    const nowIso = new Date().toISOString();

    // Strip quantity — stock can only change via stock movements (adjustProductStock / invoices / returns)
    const { quantity: _ignoredQuantity, ...safeUpdates } = updates;
    void _ignoredQuantity;

    const newPurchase = safeUpdates.purchasePrice ?? existing.purchasePrice;
    const newSale = safeUpdates.salePrice ?? existing.salePrice;

    if (
      Math.abs(newPurchase - existing.purchasePrice) > 0.005 ||
      Math.abs(newSale - existing.salePrice) > 0.005
    ) {
      await db.priceHistory.add({
        productId,
        productName: safeUpdates.name ?? existing.name,
        oldPurchasePrice: existing.purchasePrice,
        newPurchasePrice: newPurchase,
        oldSalePrice: existing.salePrice,
        newSalePrice: newSale,
        changedBy: user.fullName,
        changedAt: nowIso,
        note: 'تعديل يدوي للسعر',
      });
    }

    await db.products.update(productId, { ...safeUpdates, updatedAt: nowIso });
    await db.auditLogs.add({
      date: nowIso,
      userId: user.id ?? 1,
      userName: user.fullName,
      action: 'PRODUCT_UPDATED',
      entityType: 'product',
      entityId: String(productId),
      details: `تعديل المنتج: ${safeUpdates.name ?? existing.name}`,
    });
  });
}

export async function updateSettingsSection(
  updater: (current: AppSettings) => AppSettings,
  user: AppUser,
  detail: string
): Promise<void> {
  assertPermission(user, 'canManageSettings', 'ليس لديك صلاحية تعديل إعدادات التطبيق');
  const current = (await db.settings.get(1)) ?? createDefaultSettings();
  const next = updater(current);
  await db.settings.put({ ...next, id: 1 });
  await logAudit(user, 'SETTINGS_UPDATED', 'settings', '1', detail);
}
