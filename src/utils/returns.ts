import { SaleInvoice, SaleInvoiceItem, SaleReturnItem } from '../types';

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface ReturnLineCalculation {
  productId: number;
  productName: string;
  barcode: string;
  quantity: number;
  grossUnitPrice: number;
  effectiveUnitPrice: number; // After line discount, prorated invoice discount, and invoice tax
  costPrice: number;
  total: number;
}

export interface ReturnBreakdown {
  items: ReturnLineCalculation[];
  grossBeforeDiscounts: number;
  lineDiscountShare: number;
  invoiceDiscountShare: number;
  taxShare: number;
  totalReturnAmount: number;
  totalCost: number;
  debtReduction: number; // Applied first against unpaid invoice remainingAmount
  cashRefund: number; // Refunded in cash/bank/card or added to customer creditBalance
  newInvoiceRemaining: number;
  newInvoicePaid: number;
}

/**
 * Computes exact effective unit price for a line item on a SaleInvoice,
 * accounting for:
 * 1) Line-level discount: lineNetUnit = line.total / line.quantity
 * 2) Invoice-level discount: prorated by (subtotal - discountAmount) / subtotal
 * 3) Invoice-level tax: multiplied by (1 + taxRate / 100), equivalently (inv.total / inv.subtotal)
 */
export function getEffectiveReturnUnitPrice(
  invoice: SaleInvoice,
  line: SaleInvoiceItem
): number {
  if (line.quantity <= 0) return 0;
  const lineNetUnit = line.total / line.quantity;
  const invoiceFactor =
    invoice.subtotal > 0 ? Math.max(0, invoice.total / invoice.subtotal) : 1;
  return lineNetUnit * invoiceFactor;
}

/**
 * Computes full financial breakdown for returning specific quantities from a SaleInvoice.
 * Guarantees that cumulative returns can never refund more than the customer actually was billed (`inv.total`),
 * and cleanly separates debt reduction from actual cash/credit refund.
 */
export function calculateSaleReturnBreakdown(
  invoice: SaleInvoice,
  requestedQtys: Record<number, number>,
  previousReturnedTotal = 0
): ReturnBreakdown {
  const discountFactor =
    invoice.subtotal > 0
      ? Math.max(0, (invoice.subtotal - invoice.discountAmount) / invoice.subtotal)
      : 1;
  const taxMultiplier = 1 + Math.max(0, invoice.taxRate) / 100;

  const calculatedItems: ReturnLineCalculation[] = [];
  let grossBeforeDiscounts = 0;
  let lineDiscountShare = 0;
  let invoiceDiscountShare = 0;
  let taxShare = 0;
  let rawTotal = 0;
  let totalCost = 0;

  let isFullRemainingReturn = true;

  for (const line of invoice.items) {
    const available = r2(line.quantity - (line.returnedQty ?? 0));
    const reqQty = r2(Math.max(0, requestedQtys[line.productId] ?? 0));
    if (available > 0.0001 && Math.abs(reqQty - available) > 0.0001) {
      isFullRemainingReturn = false;
    }
    if (reqQty <= 0) continue;

    const lineGross = reqQty * line.unitPrice;
    const lineDiscUnit = line.quantity > 0 ? line.discount / line.quantity : 0;
    const lineDisc = reqQty * lineDiscUnit;
    const lineAfterLineDisc = Math.max(0, lineGross - lineDisc);
    const lineAfterInvDisc = lineAfterLineDisc * discountFactor;
    const lineInvDisc = lineAfterLineDisc - lineAfterInvDisc;
    const lineTax = lineAfterInvDisc * (taxMultiplier - 1);
    const effectiveUnit = getEffectiveReturnUnitPrice(invoice, line);
    const lineTotal = r2(reqQty * effectiveUnit);

    grossBeforeDiscounts += lineGross;
    lineDiscountShare += lineDisc;
    invoiceDiscountShare += lineInvDisc;
    taxShare += lineTax;
    rawTotal += lineTotal;
    totalCost += reqQty * line.costPrice;

    calculatedItems.push({
      productId: line.productId,
      productName: line.productName,
      barcode: line.barcode,
      quantity: reqQty,
      grossUnitPrice: line.unitPrice,
      effectiveUnitPrice: r2(effectiveUnit),
      costPrice: line.costPrice,
      total: lineTotal,
    });
  }

  // Cap total return so cumulative returns never exceed invoice.total (handles rounding on full returns)
  const maxAllowedTotal = r2(Math.max(0, invoice.total - previousReturnedTotal));
  let totalReturnAmount = r2(rawTotal);
  if (calculatedItems.length > 0 && isFullRemainingReturn && Math.abs(maxAllowedTotal - totalReturnAmount) <= 0.05) {
    totalReturnAmount = maxAllowedTotal;
  } else if (totalReturnAmount > maxAllowedTotal) {
    totalReturnAmount = maxAllowedTotal;
  }

  // Separate debt reduction vs cash/credit refund
  const debtReduction = r2(Math.min(Math.max(0, invoice.remainingAmount), totalReturnAmount));
  const cashRefund = r2(Math.max(0, totalReturnAmount - debtReduction));
  const newInvoiceRemaining = r2(Math.max(0, invoice.remainingAmount - debtReduction));
  const newInvoicePaid = r2(Math.max(0, invoice.paidAmount - cashRefund));

  return {
    items: calculatedItems,
    grossBeforeDiscounts: r2(grossBeforeDiscounts),
    lineDiscountShare: r2(lineDiscountShare),
    invoiceDiscountShare: r2(invoiceDiscountShare),
    taxShare: r2(taxShare),
    totalReturnAmount,
    totalCost: r2(totalCost),
    debtReduction,
    cashRefund,
    newInvoiceRemaining,
    newInvoicePaid,
  };
}

export function toSaleReturnItems(calcItems: ReturnLineCalculation[]): SaleReturnItem[] {
  return calcItems.map((it) => ({
    productId: it.productId,
    productName: it.productName,
    barcode: it.barcode,
    quantity: it.quantity,
    unitPrice: it.effectiveUnitPrice,
    costPrice: it.costPrice,
    total: it.total,
  }));
}
