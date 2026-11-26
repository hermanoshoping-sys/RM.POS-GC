import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarClock,
  Printer,
  RotateCcw,
  ShoppingCart,
  Truck,
} from 'lucide-react';
import { db } from '../db/database';
import { useApp } from '../context/AppContext';
import { formatDateTime, formatMoney, getStatusLabel, t } from '../i18n/translations';
import { getQuickPeriodRange, QUICK_PERIODS, QuickPeriodId, toLocalIsoDate } from '../utils/datePeriods';
import { hasPermission } from '../utils/permissions';
import { computeDashboardFinancials } from '../utils/dashboardMetrics';

export type DashboardTabId = 'overview' | 'products' | 'invoices' | 'balances';

interface DashboardModuleProps {
  activeTab?: DashboardTabId;
  onTabChange?: (tab: DashboardTabId) => void;
}

const MIN_SHEET_ROWS = 12;

export const DashboardModule: React.FC<DashboardModuleProps> = ({
  activeTab: controlledTab,
  onTabChange,
}) => {
  const { lang, settings, currentUser, setActiveSection, openPrint } = useApp();
  const canViewProfits = hasPermission(currentUser, 'canViewProfits');
  const [internalTab, setInternalTab] = useState<DashboardTabId>('overview');
  const activeTab = controlledTab ?? internalTab;
  const setActiveTab = (tab: DashboardTabId) => {
    if (onTabChange) onTabChange(tab);
    else setInternalTab(tab);
  };

  const [periodCompare, setPeriodCompare] = useState<'week' | 'month'>('week');
  const [activePeriod, setActivePeriod] = useState<QuickPeriodId>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const customers = useLiveQuery(() => db.customers.toArray(), []) ?? [];
  const suppliers = useLiveQuery(() => db.suppliers.toArray(), []) ?? [];
  const saleInvoices = useLiveQuery(() => db.saleInvoices.toArray(), []) ?? [];
  const saleReturns = useLiveQuery(() => db.saleReturns.toArray(), []) ?? [];
  const purchaseInvoices = useLiveQuery(() => db.purchaseInvoices.toArray(), []) ?? [];
  const expenses = useLiveQuery(() => db.expenses.toArray(), []) ?? [];
  const installments = useLiveQuery(() => db.installments.toArray(), []) ?? [];

  const cur = settings.storeInfo.currency || 'MAD';
  const todayStr = toLocalIsoDate(new Date());
  const overdueInstallments = useMemo(
    () =>
      installments.filter(
        (inst) => inst.remainingAmount > 0.005 && inst.dueDate < todayStr
      ),
    [installments, todayStr]
  );
  const overdueTotal = useMemo(
    () => overdueInstallments.reduce((s, inst) => s + inst.remainingAmount, 0),
    [overdueInstallments]
  );

  const handleSelectQuickPeriod = (period: Exclude<QuickPeriodId, 'all' | 'custom'>) => {
    if (activePeriod === period) {
      setActivePeriod('all');
      setDateFrom('');
      setDateTo('');
      return;
    }
    const range = getQuickPeriodRange(period);
    setActivePeriod(period);
    setDateFrom(range.from);
    setDateTo(range.to);
  };

  const handleManualDateFrom = (val: string) => {
    setDateFrom(val);
    setActivePeriod(val || dateTo ? 'custom' : 'all');
  };

  const handleManualDateTo = (val: string) => {
    setDateTo(val);
    setActivePeriod(dateFrom || val ? 'custom' : 'all');
  };

  const clearDateFilter = () => {
    setActivePeriod('all');
    setDateFrom('');
    setDateTo('');
  };

  const metrics = useMemo(() => {
    const now = new Date();
    const todayStr = toLocalIsoDate(now);
    const monthStr = todayStr.slice(0, 7);
    const yearStr = todayStr.slice(0, 4);

    const inRange = (iso: string) => {
      const d = iso.slice(0, 10);
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
      return true;
    };

    const allValidSales = saleInvoices.filter((s) => s.status !== 'cancelled');
    const allValidPurchases = purchaseInvoices.filter((p) => p.status !== 'cancelled');

    const validSales = allValidSales.filter((s) => inRange(s.date));
    const validPurchases = allValidPurchases.filter((p) => inRange(p.date));

    const fin = computeDashboardFinancials(saleInvoices, saleReturns, expenses, inRange);
    const dailyFin = computeDashboardFinancials(
      saleInvoices,
      saleReturns,
      expenses,
      (iso) => iso.slice(0, 10) === todayStr
    );
    const monthlyFin = computeDashboardFinancials(
      saleInvoices,
      saleReturns,
      expenses,
      (iso) => iso.slice(0, 7) === monthStr
    );
    const yearlyFin = computeDashboardFinancials(
      saleInvoices,
      saleReturns,
      expenses,
      (iso) => iso.slice(0, 4) === yearStr
    );

    const dailySales = dailyFin.netRevenue;
    const monthlySales = monthlyFin.netRevenue;
    const yearlySales = yearlyFin.netRevenue;

    const totalSales = fin.netRevenue;
    const totalPurchases = validPurchases.reduce((sum, p) => sum + p.total, 0);
    const totalExpenses = fin.totalExpenses;
    const netProfit = fin.netProfit;

    const totalCollected = validSales.reduce((s, inv) => s + inv.paidAmount, 0);
    const totalRemainingSales = validSales.reduce((s, inv) => s + inv.remainingAmount, 0);

    // Debts & Payables lists
    const customerDebtList = customers
      .map((c) => {
        const invoicesRem = allValidSales
          .filter((s) => s.customerId === c.id)
          .reduce((sum, s) => sum + s.remainingAmount, 0);
        const totalBought = allValidSales
          .filter((s) => s.customerId === c.id)
          .reduce((sum, s) => sum + s.total, 0);
        const debt = invoicesRem + (c.openingBalance || 0);
        return { ...c, totalBought, debt };
      })
      .filter((c) => c.debt > 0.01)
      .sort((a, b) => b.debt - a.debt);

    const supplierPayableList = suppliers
      .map((sup) => {
        const purchasesRem = allValidPurchases
          .filter((p) => p.supplierId === sup.id)
          .reduce((sum, p) => sum + p.remainingAmount, 0);
        const totalBought = allValidPurchases
          .filter((p) => p.supplierId === sup.id)
          .reduce((sum, p) => sum + p.total, 0);
        const rem = purchasesRem + (sup.openingBalance || 0);
        return { ...sup, totalBought, rem };
      })
      .filter((s) => s.rem > 0.01)
      .sort((a, b) => b.rem - a.rem);

    const customerDebts = customerDebtList.reduce((s, c) => s + c.debt, 0);
    const supplierPayables = supplierPayableList.reduce((s, x) => s + x.rem, 0);

    const inventoryValue = products.reduce(
      (sum, p) => sum + Math.max(0, p.quantity) * p.purchasePrice,
      0
    );

    // Top selling products
    const soldByProd = new Map<
      number,
      { name: string; barcode: string; qty: number; revenue: number; cost: number; profit: number }
    >();
    validSales.forEach((inv) => {
      inv.items.forEach((it) => {
        const netQty = Math.max(0, it.quantity - (it.returnedQty ?? 0));
        if (netQty <= 0) return;
        const curr = soldByProd.get(it.productId) ?? {
          name: it.productName,
          barcode: it.barcode,
          qty: 0,
          revenue: 0,
          cost: 0,
          profit: 0,
        };
        curr.qty += netQty;
        curr.revenue += netQty * it.unitPrice;
        curr.cost += netQty * it.costPrice;
        curr.profit += netQty * (it.unitPrice - it.costPrice);
        soldByProd.set(it.productId, curr);
      });
    });
    const topProducts = Array.from(soldByProd.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 15);

    const lowStockProducts = products
      .filter((p) => p.isActive && p.quantity <= p.minStock)
      .sort((a, b) => a.quantity - b.quantity);

    // 7-day sales & profit chart (excludes tax and returns of cancelled invoices)
    const dailyChart: { day: string; sales: number; profit: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = toLocalIsoDate(d);
      const label = key.slice(5);
      const dayFin = computeDashboardFinancials(
        saleInvoices,
        saleReturns,
        expenses,
        (iso) => iso.slice(0, 10) === key
      );
      dailyChart.push({
        day: label,
        sales: dayFin.netRevenue,
        profit: dayFin.netProfit,
      });
    }

    // Period comparison
    const spanDays = periodCompare === 'week' ? 7 : 30;
    const msPerDay = 86400000;
    const nowMs = now.getTime();
    let currentPeriodSales = 0;
    let prevPeriodSales = 0;
    allValidSales.forEach((s) => {
      const diffDays = (nowMs - new Date(s.date).getTime()) / msPerDay;
      if (diffDays >= 0 && diffDays < spanDays) currentPeriodSales += s.total;
      else if (diffDays >= spanDays && diffDays < spanDays * 2) prevPeriodSales += s.total;
    });
    const compareChart = [
      {
        name:
          periodCompare === 'week'
            ? t(lang, 'الأسبوع السابق', 'Semaine préc.')
            : t(lang, 'الشهر السابق', 'Mois préc.'),
        amount: Math.round(prevPeriodSales * 100) / 100,
      },
      {
        name:
          periodCompare === 'week'
            ? t(lang, 'الأسبوع الحالي', 'Semaine act.')
            : t(lang, 'الشهر الحالي', 'Mois act.'),
        amount: Math.round(currentPeriodSales * 100) / 100,
      },
    ];

    const recentSales = [...validSales].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15);
    const recentPurchases = [...validPurchases].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15);

    return {
      dailySales,
      monthlySales,
      yearlySales,
      totalSales,
      totalPurchases,
      netProfit,
      totalExpenses,
      totalCollected,
      totalRemainingSales,
      customerDebts,
      supplierPayables,
      customerDebtList,
      supplierPayableList,
      inventoryValue,
      topProducts,
      lowStockProducts,
      dailyChart,
      compareChart,
      currentPeriodSales,
      prevPeriodSales,
      recentSales,
      recentPurchases,
    };
  }, [
    products,
    customers,
    suppliers,
    saleInvoices,
    saleReturns,
    purchaseInvoices,
    expenses,
    periodCompare,
    dateFrom,
    dateTo,
    lang,
  ]);

  const growthPct =
    metrics.prevPeriodSales > 0
      ? ((metrics.currentPeriodSales - metrics.prevPeriodSales) / metrics.prevPeriodSales) * 100
      : metrics.currentPeriodSales > 0
        ? 100
        : 0;

  const renderBlankRows = (currentCount: number, colCount: number, minRows = MIN_SHEET_ROWS) => {
    const emptyCount = Math.max(0, minRows - currentCount);
    return Array.from({ length: emptyCount }).map((_, idx) => (
      <tr key={`blank-${idx}`} className={`h-[30px] bg-white ${idx >= 3 ? 'hidden sm:table-row' : ''}`}>
        {Array.from({ length: colCount }).map((__, colIdx) => (
          <td key={colIdx} className="border border-slate-800/80 px-2 py-1" />
        ))}
      </tr>
    ));
  };

  return (
    <div className="space-y-2.5">
      {/* Standalone fallback tabs */}
      {!controlledTab && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {(
            [
              { id: 'overview', ar: 'نظرة عامة والرسوم', fr: 'Vue générale' },
              { id: 'products', ar: 'المنتجات والمخزون', fr: 'Produits & Stock' },
              { id: 'invoices', ar: 'آخر الفواتير', fr: 'Dernières factures' },
              { id: 'balances', ar: 'الذمم والسيولة', fr: 'Créances & Dettes' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-lg border-[1.5px] px-3.5 py-1.5 text-xs sm:text-[13px] font-bold transition-all whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A] shadow-sm'
                  : 'border-slate-900 bg-white text-slate-900 hover:bg-amber-50'
              }`}
            >
              {lang === 'ar' ? tab.ar : tab.fr}
            </button>
          ))}
        </div>
      )}

      {/* Unified Filter & Quick Shortcuts Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white px-2 py-2 rounded-lg border border-slate-200 shadow-xs">
        <div className="flex flex-wrap items-center gap-1.5 w-full lg:w-auto">
          <div className="flex flex-nowrap sm:flex-wrap items-center gap-1.5 overflow-x-auto no-scrollbar w-full sm:w-auto pb-0.5 sm:pb-0">
            {QUICK_PERIODS.map((p) => {
              const isActive = activePeriod === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleSelectQuickPeriod(p.id)}
                  className={`min-h-[36px] rounded-lg border-[1.5px] px-2.5 sm:px-3.5 py-1.5 sm:py-2 text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${
                    isActive
                      ? 'border-[#0B274D] bg-[#FCE08B] text-slate-950 shadow-xs'
                      : 'border-slate-900 bg-white text-slate-900 hover:bg-slate-100'
                  }`}
                >
                  {lang === 'ar' ? p.ar : p.fr}
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-2 sm:flex sm:items-center gap-1.5 w-full sm:w-auto">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => handleManualDateFrom(e.target.value)}
              className="w-full sm:w-auto rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs font-mono tabular-nums text-slate-800 focus:border-slate-900 focus:outline-none"
            />
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={dateTo}
                onChange={(e) => handleManualDateTo(e.target.value)}
                className="w-full sm:w-auto flex-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs font-mono tabular-nums text-slate-800 focus:border-slate-900 focus:outline-none"
              />
              {(dateFrom || dateTo) && (
                <button
                  type="button"
                  onClick={clearDateFilter}
                  title={t(lang, 'عرض كل الفترات', 'Toutes les dates')}
                  className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-slate-50 p-2 text-slate-700 hover:bg-slate-200 shrink-0"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:flex sm:items-center gap-1.5 w-full sm:w-auto shrink-0">
          <button
            type="button"
            onClick={() => setActiveSection('pos')}
            className="inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border-[1.5px] border-teal-900 bg-teal-700 px-3 py-2 text-xs font-extrabold text-white hover:bg-teal-800 whitespace-nowrap"
          >
            <ShoppingCart className="h-3.5 w-3.5" />
            {t(lang, 'نقطة البيع', 'POS')}
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('purchases')}
            className="inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border-[1.5px] border-slate-900 bg-white px-3 py-2 text-xs font-extrabold text-slate-900 hover:bg-amber-50 whitespace-nowrap"
          >
            <Truck className="h-3.5 w-3.5 text-[#0B274D]" />
            {t(lang, 'فاتورة مشتريات', 'Nouvel achat')}
          </button>
        </div>
      </div>

      {/* Overdue Installments Reminder Strip */}
      {overdueInstallments.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border-[1.5px] border-red-500 bg-red-50 px-3 py-2 text-xs">
          <div className="flex items-center gap-2 font-extrabold text-red-900">
            <CalendarClock className="h-4 w-4 text-red-700 shrink-0" />
            <span>
              {t(
                lang,
                `تنبيه أقساط متأخرة: يوجد ${overdueInstallments.length} قسط متجاوز لتاريخ الاستحقاق بإجمالي ${formatMoney(overdueTotal, cur)}`,
                `Alerte échéances : ${overdueInstallments.length} échéance(s) en retard pour un total de ${formatMoney(overdueTotal, cur)}`
              )}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setActiveSection('payments')}
              className="rounded-md bg-red-600 px-3 py-1 text-[11px] font-bold text-white hover:bg-red-700"
            >
              {t(lang, 'تحصيل الأقساط ←', 'Encaisser →')}
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('customers')}
              className="rounded-md border border-red-300 bg-white px-2.5 py-1 text-[11px] font-bold text-red-800 hover:bg-red-100"
            >
              {t(lang, 'الزبناء', 'Clients')}
            </button>
          </div>
        </div>
      )}

      {/* KPI Summary Grid (Crisp Golden-Header Table-Style Metric Cells) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="bg-[#FCE08B] border-b border-slate-900 px-3 py-1.5 text-xs font-extrabold text-slate-950">
            {dateFrom || dateTo
              ? t(lang, 'مبيعات الفترة المختارة', 'Ventes période')
              : t(lang, 'مبيعات اليوم / الشهر / السنة', 'Ventes Jour / Mois / An')}
          </div>
          <div className="p-3">
            <div className="font-mono text-lg sm:text-xl font-black text-slate-950 tabular-nums">
              {formatMoney(dateFrom || dateTo ? metrics.totalSales : metrics.dailySales, cur)}
            </div>
            <div className="mt-1 text-[11px] font-mono tabular-nums text-slate-600">
              {t(lang, 'الشهر:', 'Mois:')} {formatMoney(metrics.monthlySales, cur)} · {t(lang, 'السنة:', 'An:')}{' '}
              {formatMoney(metrics.yearlySales, cur)}
            </div>
          </div>
        </div>

        {canViewProfits ? (
          <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
            <div className="bg-[#FCE08B] border-b border-slate-900 px-3 py-1.5 text-xs font-extrabold text-slate-950">
              {t(lang, 'صافي الأرباح المحققة', 'Bénéfice Net Réalisé')}
            </div>
            <div className="p-3">
              <div
                className={`font-mono text-lg sm:text-xl font-black tabular-nums ${
                  metrics.netProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {formatMoney(metrics.netProfit, cur)}
              </div>
              <div className="mt-1 text-[11px] text-slate-600">
                {t(lang, 'بعد خصم التكلفة والمرتجعات والمصاريف', 'Après COGS, retours et charges')}
              </div>
            </div>
          </div>
        ) : (
          <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
            <div className="bg-[#FCE08B] border-b border-slate-900 px-3 py-1.5 text-xs font-extrabold text-slate-950">
              {t(lang, 'الأقساط المتأخرة', 'Échéances en retard')}
            </div>
            <div className="p-3">
              <div className="font-mono text-lg sm:text-xl font-black text-red-700 tabular-nums">
                {formatMoney(overdueTotal, cur)}
              </div>
              <div className="mt-1 text-[11px] text-slate-600">
                {overdueInstallments.length} {t(lang, 'قسط متأخر عن الاستحقاق', 'échéance(s) en retard')}
              </div>
            </div>
          </div>
        )}

        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="bg-[#FCE08B] border-b border-slate-900 px-3 py-1.5 text-xs font-extrabold text-slate-950">
            {t(lang, 'إجمالي المشتريات والمصاريف', 'Achats & Dépenses')}
          </div>
          <div className="p-3">
            <div className="font-mono text-lg sm:text-xl font-black text-slate-950 tabular-nums">
              {formatMoney(metrics.totalPurchases, cur)}
            </div>
            <div className="mt-1 text-[11px] font-mono tabular-nums text-red-700 font-bold">
              {t(lang, 'المصاريف:', 'Dépenses:')} {formatMoney(metrics.totalExpenses, cur)}
            </div>
          </div>
        </div>

        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="bg-[#FCE08B] border-b border-slate-900 px-3 py-1.5 text-xs font-extrabold text-slate-950">
            {t(lang, 'قيمة المخزون الحالي', 'Valeur Stock Actuel')}
          </div>
          <div className="p-3">
            <div className="font-mono text-lg sm:text-xl font-black text-teal-800 tabular-nums">
              {formatMoney(metrics.inventoryValue, cur)}
            </div>
            <div className="mt-1 text-[11px] text-slate-600">
              {products.length} {t(lang, 'منتج', 'produits')} · {customers.length} {t(lang, 'زبون', 'clients')} ·{' '}
              {suppliers.length} {t(lang, 'مورد', 'fourn.')}
            </div>
          </div>
        </div>

        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="bg-[#FEF3C7] border-b border-slate-900 px-3 py-1 text-[11px] font-extrabold text-slate-900">
            {t(lang, 'المبالغ المحصلة', 'Encaissements')}
          </div>
          <div className="px-3 py-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-base font-black text-emerald-700 tabular-nums">
              {formatMoney(metrics.totalCollected, cur)}
            </span>
            <span className="font-mono text-[11px] text-slate-500 tabular-nums">
              {t(lang, 'المتبقي:', 'Reste:')} {formatMoney(metrics.totalRemainingSales, cur)}
            </span>
          </div>
        </div>

        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="bg-[#FEF3C7] border-b border-slate-900 px-3 py-1 text-[11px] font-extrabold text-slate-900">
            {t(lang, 'ديون الزبناء (لنا)', 'Créances Clients')}
          </div>
          <div className="px-3 py-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-base font-black text-amber-700 tabular-nums">
              {formatMoney(metrics.customerDebts, cur)}
            </span>
            <button
              type="button"
              onClick={() => setActiveSection('customers')}
              className="text-[11px] font-bold text-[#0B274D] hover:underline"
            >
              {t(lang, 'الزبناء ←', 'Clients →')}
            </button>
          </div>
        </div>

        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="bg-[#FEF3C7] border-b border-slate-900 px-3 py-1 text-[11px] font-extrabold text-slate-900">
            {t(lang, 'مستحقات الموردين (علينا)', 'Dettes Fournisseurs')}
          </div>
          <div className="px-3 py-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-base font-black text-red-700 tabular-nums">
              {formatMoney(metrics.supplierPayables, cur)}
            </span>
            <button
              type="button"
              onClick={() => setActiveSection('suppliers')}
              className="text-[11px] font-bold text-[#0B274D] hover:underline"
            >
              {t(lang, 'الموردون ←', 'Fourn. →')}
            </button>
          </div>
        </div>

        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="bg-[#FEF3C7] border-b border-slate-900 px-3 py-1 text-[11px] font-extrabold text-slate-900">
            {t(lang, 'تنبيهات المخزون المنخفض', 'Alertes Stock Faible')}
          </div>
          <div className="px-3 py-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-base font-black text-red-700 tabular-nums">
              {metrics.lowStockProducts.length} {t(lang, 'منتج', 'articles')}
            </span>
            <button
              type="button"
              onClick={() => setActiveSection('inventory')}
              className="text-[11px] font-bold text-[#0B274D] hover:underline"
            >
              {t(lang, 'المخزون ←', 'Stock →')}
            </button>
          </div>
        </div>
      </div>

      {/* TAB 1: Overview Charts + Compact Top/Low Tables */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2 border-[1.5px] border-slate-900 bg-white overflow-hidden">
            <div className="bg-[#FCE08B] border-b border-slate-900 px-3 py-2 flex items-center justify-between">
              <h3 className="text-xs font-extrabold text-slate-950">
                {canViewProfits
                  ? t(lang, 'تطور المبيعات والأرباح (آخر 7 أيام)', 'Évolution ventes & profits (7 jours)')
                  : t(lang, 'تطور المبيعات (آخر 7 أيام)', 'Évolution des ventes (7 jours)')}
              </h3>
              <span className="text-[11px] font-semibold text-slate-800">
                {canViewProfits
                  ? t(lang, 'رقم المعاملات مقابل الربح الصافي', 'CA vs Bénéfice net')
                  : t(lang, 'رقم المعاملات اليومي', 'Chiffre d’affaires quotidien')}
              </span>
            </div>
            <div className="p-4 h-72 w-full" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={metrics.dailyChart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#334155' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#334155' }} />
                  <Tooltip />
                  <Area
                    type="monotone"
                    dataKey="sales"
                    name={t(lang, 'المبيعات', 'Ventes')}
                    stroke="#0B274D"
                    fill="#dbeafe"
                    strokeWidth={2}
                  />
                  {canViewProfits && (
                    <Area
                      type="monotone"
                      dataKey="profit"
                      name={t(lang, 'الربح الصافي', 'Bénéfice')}
                      stroke="#15803d"
                      fill="#dcfce7"
                      strokeWidth={2}
                    />
                  )}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden flex flex-col justify-between">
            <div className="bg-[#FCE08B] border-b border-slate-900 px-3 py-1.5 flex items-center justify-between">
              <h3 className="text-xs font-extrabold text-slate-950">
                {t(lang, 'مقارنة الفترات', 'Comparaison')}
              </h3>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPeriodCompare('week')}
                  className={`rounded border px-2 py-0.5 text-[11px] font-bold ${
                    periodCompare === 'week'
                      ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                      : 'border-slate-700 bg-white text-slate-900'
                  }`}
                >
                  {t(lang, 'أسبوعي', '7j')}
                </button>
                <button
                  type="button"
                  onClick={() => setPeriodCompare('month')}
                  className={`rounded border px-2 py-0.5 text-[11px] font-bold ${
                    periodCompare === 'month'
                      ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                      : 'border-slate-700 bg-white text-slate-900'
                  }`}
                >
                  {t(lang, 'شهري', '30j')}
                </button>
              </div>
            </div>

            <div className="p-4 flex-1 flex flex-col justify-between">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800 mb-3">
                {growthPct >= 0 ? (
                  <ArrowUpRight className="h-4 w-4 text-emerald-700" />
                ) : (
                  <ArrowDownLeft className="h-4 w-4 text-red-700" />
                )}
                <span className={`font-mono tabular-nums ${growthPct >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                  {growthPct >= 0 ? '+' : ''}
                  {growthPct.toFixed(1)}%
                </span>
                <span className="text-slate-600 font-normal">
                  {t(lang, 'مقارنة بالفترة السابقة', 'vs période précédente')}
                </span>
              </div>
              <div className="h-52 w-full" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={metrics.compareChart}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#334155' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#334155' }} />
                    <Tooltip />
                    <Bar
                      dataKey="amount"
                      name={t(lang, 'المبيعات', 'Ventes')}
                      fill="#0B274D"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: Top Selling Products & Low Stock Products Spreadsheet Grids */}
      {activeTab === 'products' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
            <div className="bg-[#0B274D] text-[#FDE68A] px-3 py-2 text-xs font-extrabold">
              {t(lang, 'المنتجات الأكثر مبيعاً', 'Produits les plus vendus')}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-[#FCE08B] text-slate-950">
                    <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold">{t(lang, 'المنتج', 'Produit')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold w-[75px]">{t(lang, 'الكمية', 'Qté')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold w-[110px]">{t(lang, 'المبيعات', 'CA')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold w-[110px]">{t(lang, 'الربح', 'Profit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.topProducts.map((p, i) => (
                    <tr key={i} className="h-[30px] hover:bg-amber-50/50">
                      <td className="border border-slate-800/80 px-2.5 py-1 font-bold text-slate-950">{p.name}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold tabular-nums">{p.qty}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-semibold tabular-nums">{formatMoney(p.revenue, cur)}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums text-emerald-700">{formatMoney(p.profit, cur)}</td>
                    </tr>
                  ))}
                  {renderBlankRows(metrics.topProducts.length, 4)}
                </tbody>
              </table>
            </div>
          </div>

          <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
            <div className="bg-[#0B274D] text-[#FDE68A] px-3 py-2 text-xs font-extrabold">
              {t(lang, 'المنتجات منخفضة المخزون والنافدة', 'Produits en stock faible / rupture')}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-[#FCE08B] text-slate-950">
                    <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold">{t(lang, 'المنتج', 'Produit')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold w-[85px]">{t(lang, 'المتوفر', 'Dispo')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold w-[85px]">{t(lang, 'الحد الأدنى', 'Min')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold w-[95px]">{t(lang, 'الحالة', 'Statut')}</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.lowStockProducts.map((p) => (
                    <tr key={p.id} className="h-[30px] hover:bg-amber-50/50">
                      <td className="border border-slate-800/80 px-2.5 py-1 font-bold text-slate-950">{p.name}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums text-red-700">{p.quantity}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono tabular-nums text-slate-600">{p.minStock}</td>
                      <td className={`border border-slate-800/80 px-2 py-1 text-center font-bold ${p.quantity <= 0 ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}>
                        {p.quantity <= 0 ? t(lang, 'نافد', 'Rupture') : t(lang, 'منخفض', 'Faible')}
                      </td>
                    </tr>
                  ))}
                  {renderBlankRows(metrics.lowStockProducts.length, 4)}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: Recent Sales & Purchases Spreadsheet Grids */}
      {activeTab === 'invoices' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
            <div className="bg-[#0B274D] text-[#FDE68A] px-3 py-2 flex items-center justify-between text-xs font-extrabold">
              <span>{t(lang, 'آخر فواتير المبيعات', 'Dernières factures de vente')}</span>
              <button type="button" onClick={() => setActiveSection('pos')} className="underline text-white font-bold">
                {t(lang, 'نقطة البيع', 'POS')}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-[#FCE08B] text-slate-950">
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold">{t(lang, 'رقم الفاتورة', 'N°')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold">{t(lang, 'التاريخ', 'Date')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold">{t(lang, 'الزبون', 'Client')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold">{t(lang, 'الإجمالي', 'Total')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold">{t(lang, 'الحالة', 'Statut')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold w-[60px]">{t(lang, 'طباعة', 'Imp.')}</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.recentSales.map((inv) => (
                    <tr key={inv.id} className="h-[30px] hover:bg-amber-50/50">
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold text-slate-900">{inv.invoiceNumber}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-slate-600 whitespace-nowrap">{formatDateTime(inv.date, lang)}</td>
                      <td className="border border-slate-800/80 px-2 py-1 font-bold text-slate-900">{inv.customerName}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold tabular-nums">{formatMoney(inv.total, cur)}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-semibold text-slate-700">{getStatusLabel(inv.status, lang)}</td>
                      <td className="border border-slate-800/80 px-1 py-0.5 text-center">
                        <button
                          type="button"
                          onClick={() => openPrint({ type: 'sale_invoice', invoice: inv })}
                          className="rounded border border-slate-700 bg-white p-1 text-slate-900 hover:bg-[#FCE08B]"
                        >
                          <Printer className="h-3 w-3" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {renderBlankRows(metrics.recentSales.length, 6)}
                </tbody>
              </table>
            </div>
          </div>

          <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
            <div className="bg-[#0B274D] text-[#FDE68A] px-3 py-2 flex items-center justify-between text-xs font-extrabold">
              <span>{t(lang, 'آخر فواتير المشتريات', 'Dernières factures d’achat')}</span>
              <button type="button" onClick={() => setActiveSection('purchases')} className="underline text-white font-bold">
                {t(lang, 'المشتريات', 'Achats')}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-[#FCE08B] text-slate-950">
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold">{t(lang, 'رقم الفاتورة', 'N°')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold">{t(lang, 'التاريخ', 'Date')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold">{t(lang, 'المورد', 'Fournisseur')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold">{t(lang, 'الإجمالي', 'Total')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold">{t(lang, 'المتبقي', 'Reste')}</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.recentPurchases.map((p) => (
                    <tr key={p.id} className="h-[30px] hover:bg-amber-50/50">
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold text-slate-900">{p.invoiceNumber}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-slate-600 whitespace-nowrap">{formatDateTime(p.date, lang)}</td>
                      <td className="border border-slate-800/80 px-2 py-1 font-bold text-slate-900">{p.supplierName}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold tabular-nums">{formatMoney(p.total, cur)}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold tabular-nums text-amber-800">{formatMoney(p.remainingAmount, cur)}</td>
                    </tr>
                  ))}
                  {renderBlankRows(metrics.recentPurchases.length, 5)}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: Customer Debts & Supplier Payables Spreadsheet Grids */}
      {activeTab === 'balances' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
            <div className="bg-[#0B274D] text-[#FDE68A] px-3 py-2 flex items-center justify-between text-xs font-extrabold">
              <span>{t(lang, 'ديون الزبناء المستحقة لنا', 'Créances clients')}</span>
              <button type="button" onClick={() => setActiveSection('customers')} className="underline text-white font-bold">
                {t(lang, 'سجل الزبناء', 'Clients')}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-[#FCE08B] text-slate-950">
                    <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold">{t(lang, 'الزبون', 'Client')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold">{t(lang, 'الهاتف', 'Tél')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold">{t(lang, 'إجمالي المشتريات', 'Total achats')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold">{t(lang, 'الدين المتبقي', 'Solde dû')}</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.customerDebtList.map((c) => (
                    <tr key={c.id} className="h-[30px] hover:bg-amber-50/50">
                      <td className="border border-slate-800/80 px-2.5 py-1 font-bold text-slate-950">{c.fullName}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] text-slate-700">{c.phone || '—'}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono tabular-nums">{formatMoney(c.totalBought, cur)}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums text-red-700 bg-red-50/50">{formatMoney(c.debt, cur)}</td>
                    </tr>
                  ))}
                  {renderBlankRows(metrics.customerDebtList.length, 4)}
                </tbody>
                <tfoot>
                  <tr className="bg-[#FEF3C7] text-slate-950 font-extrabold text-xs">
                    <td colSpan={3} className="border border-slate-900 px-3 py-2 text-start">
                      {t(lang, `إجمالي ديون الزبناء (${metrics.customerDebtList.length})`, `Total créances (${metrics.customerDebtList.length})`)}
                    </td>
                    <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums text-red-800">
                      {formatMoney(metrics.customerDebts, cur)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
            <div className="bg-[#0B274D] text-[#FDE68A] px-3 py-2 flex items-center justify-between text-xs font-extrabold">
              <span>{t(lang, 'مستحقات الموردين علينا', 'Dettes fournisseurs')}</span>
              <button type="button" onClick={() => setActiveSection('suppliers')} className="underline text-white font-bold">
                {t(lang, 'سجل الموردين', 'Fournisseurs')}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-[#FCE08B] text-slate-950">
                    <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold">{t(lang, 'المورد', 'Fournisseur')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold">{t(lang, 'الهاتف', 'Tél')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold">{t(lang, 'إجمالي المشتريات', 'Total achats')}</th>
                    <th className="border border-slate-900 px-2 py-2 text-center font-extrabold">{t(lang, 'المستحق للمورد', 'Solde dû')}</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.supplierPayableList.map((s) => (
                    <tr key={s.id} className="h-[30px] hover:bg-amber-50/50">
                      <td className="border border-slate-800/80 px-2.5 py-1 font-bold text-slate-950">{s.businessName}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] text-slate-700">{s.phone || '—'}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono tabular-nums">{formatMoney(s.totalBought, cur)}</td>
                      <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums text-amber-800 bg-amber-50/50">{formatMoney(s.rem, cur)}</td>
                    </tr>
                  ))}
                  {renderBlankRows(metrics.supplierPayableList.length, 4)}
                </tbody>
                <tfoot>
                  <tr className="bg-[#FEF3C7] text-slate-950 font-extrabold text-xs">
                    <td colSpan={3} className="border border-slate-900 px-3 py-2 text-start">
                      {t(lang, `إجمالي مستحقات الموردين (${metrics.supplierPayableList.length})`, `Total dettes (${metrics.supplierPayableList.length})`)}
                    </td>
                    <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums text-amber-900">
                      {formatMoney(metrics.supplierPayables, cur)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
