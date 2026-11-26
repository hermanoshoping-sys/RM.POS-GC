import { Expense, SaleInvoice, SaleReturn } from '../types';

export interface DashboardFinancialSummary {
  totalSalesGross: number;
  totalTax: number;
  totalSalesNetOfTax: number;
  totalReturnsGross: number;
  totalReturnsNetOfTax: number;
  netRevenue: number;
  netCogs: number;
  totalExpenses: number;
  netProfit: number;
}

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Computes dashboard revenue, returns, COGS, and net profit for a date range.
 * - Excludes cancelled sale invoices AND any returns linked to cancelled invoices.
 * - Subtracts sales tax (TVA) from gross sales and proportional tax from returns so revenue & profit are strictly net of tax.
 */
export function computeDashboardFinancials(
  saleInvoices: SaleInvoice[],
  saleReturns: SaleReturn[],
  expenses: Expense[],
  inRange: (iso: string) => boolean = () => true
): DashboardFinancialSummary {
  const allValidSales = saleInvoices.filter((s) => s.status !== 'cancelled');
  const validSaleById = new Map<number, SaleInvoice>();
  for (const s of allValidSales) {
    if (s.id !== undefined) validSaleById.set(s.id, s);
  }
  const allValidExpenses = expenses.filter((e) => !e.isCancelled);

  const validSales = allValidSales.filter((s) => inRange(s.date));
  const validExpenses = allValidExpenses.filter((e) => inRange(e.date));
  // Exclude returns belonging to cancelled invoices
  const validReturns = saleReturns.filter(
    (r) => inRange(r.date) && validSaleById.has(r.saleInvoiceId)
  );

  const totalSalesGross = r2(validSales.reduce((sum, s) => sum + s.total, 0));
  const totalTax = r2(validSales.reduce((sum, s) => sum + (s.taxAmount || 0), 0));
  const totalSalesNetOfTax = r2(Math.max(0, totalSalesGross - totalTax));
  const totalExpenses = r2(validExpenses.reduce((sum, e) => sum + e.amount, 0));

  const grossCogs = r2(
    validSales.reduce(
      (sum, inv) => sum + inv.items.reduce((is, it) => is + it.quantity * it.costPrice, 0),
      0
    )
  );
  const totalReturnsGross = r2(validReturns.reduce((s, r) => s + r.totalAmount, 0));
  const totalReturnsNetOfTax = r2(
    validReturns.reduce((sum, r) => {
      const parent = validSaleById.get(r.saleInvoiceId);
      const rate = Math.max(0, parent?.taxRate ?? 0);
      const net = rate > 0 ? r.totalAmount / (1 + rate / 100) : r.totalAmount;
      return sum + net;
    }, 0)
  );
  const totalReturnsCost = r2(validReturns.reduce((s, r) => s + r.totalCost, 0));
  const netCogs = r2(Math.max(0, grossCogs - totalReturnsCost));
  const netRevenue = r2(totalSalesNetOfTax - totalReturnsNetOfTax);
  const netProfit = r2(netRevenue - netCogs - totalExpenses);

  return {
    totalSalesGross,
    totalTax,
    totalSalesNetOfTax,
    totalReturnsGross,
    totalReturnsNetOfTax,
    netRevenue,
    netCogs,
    totalExpenses,
    netProfit,
  };
}
