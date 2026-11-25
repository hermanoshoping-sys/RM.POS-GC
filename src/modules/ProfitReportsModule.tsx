import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Download, Info, Printer, RotateCcw, Search } from 'lucide-react';
import { db } from '../db/database';
import { useApp } from '../context/AppContext';
import { formatMoney, t } from '../i18n/translations';
import { exportRowsToExcel } from '../utils/export';
import {
  QUICK_PERIODS,
  QuickPeriodId,
  getQuickPeriodRange,
} from '../utils/datePeriods';

const MIN_SHEET_ROWS = 12;

export const ProfitReportsModule: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const { lang, settings, openPrint } = useApp();
  const cur = settings.storeInfo.currency || 'MAD';

  const [search, setSearch] = useState('');
  const [activePeriod, setActivePeriod] = useState<QuickPeriodId | null>('this_month');
  const [dateFrom, setDateFrom] = useState(() => getQuickPeriodRange('this_month').from);
  const [dateTo, setDateTo] = useState(() => getQuickPeriodRange('this_month').to);
  const [granularity, setGranularity] = useState<'daily' | 'weekly' | 'monthly' | 'yearly'>('daily');
  const [breakdownTab, setBreakdownTab] = useState<'product' | 'category' | 'invoice' | 'seller' | 'margin'>('product');

  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const categories = useLiveQuery(() => db.categories.toArray(), []) ?? [];
  const saleInvoices = useLiveQuery(() => db.saleInvoices.toArray(), []) ?? [];
  const saleReturns = useLiveQuery(() => db.saleReturns.toArray(), []) ?? [];
  const expenses = useLiveQuery(() => db.expenses.toArray(), []) ?? [];

  const handleSelectPeriod = (id: Exclude<QuickPeriodId, 'all' | 'custom'>) => {
    const range = getQuickPeriodRange(id);
    setActivePeriod(id);
    setDateFrom(range.from);
    setDateTo(range.to);
  };

  const handleResetFilters = () => {
    setSearch('');
    setActivePeriod(null);
    setDateFrom('');
    setDateTo('');
  };

  const analytics = useMemo(() => {
    const inRange = (iso: string) => {
      const d = iso.slice(0, 10);
      return (!dateFrom || d >= dateFrom) && (!dateTo || d <= dateTo);
    };

    const validSales = saleInvoices.filter((s) => s.status !== 'cancelled' && inRange(s.date));
    const validReturns = saleReturns.filter((r) => inRange(r.date));
    const validExpenses = expenses.filter((e) => !e.isCancelled && inRange(e.date));

    // Exact Accrual Accounting (Strictly distinct from Cash Collected)
    const grossSalesBeforeDiscount = validSales.reduce((s, i) => s + i.subtotal, 0);
    const discountsGranted = validSales.reduce((s, i) => s + i.discountAmount, 0);
    const totalSalesNetOfDiscount = validSales.reduce((s, i) => s + i.total, 0);
    const totalReturnsAmount = validReturns.reduce((s, r) => s + r.totalAmount, 0);
    const netRevenue = totalSalesNetOfDiscount - totalReturnsAmount;

    const grossCogs = validSales.reduce(
      (s, inv) => s + inv.items.reduce((is, it) => is + it.quantity * it.costPrice, 0),
      0
    );
    const returnedCogs = validReturns.reduce((s, r) => s + r.totalCost, 0);
    const totalCogs = Math.max(0, grossCogs - returnedCogs);

    const grossProfit = netRevenue - totalCogs;
    const operatingExpenses = validExpenses.reduce((s, e) => s + e.amount, 0);
    const netProfit = grossProfit - operatingExpenses;
    const profitMarginPct = netRevenue > 0 ? (netProfit / netRevenue) * 100 : 0;

    // Cash collected (for explicit contrast with accrual profit!)
    const cashCollected = validSales.reduce((s, i) => s + i.paidAmount, 0);

    // Chart grouped by daily/weekly/monthly/yearly
    const periodKey = (iso: string) => {
      if (granularity === 'yearly') return iso.slice(0, 4);
      if (granularity === 'monthly') return iso.slice(0, 7);
      if (granularity === 'weekly') {
        const d = new Date(iso);
        const start = new Date(d.getFullYear(), 0, 1);
        const week = Math.ceil(((d.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7);
        return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
      }
      return iso.slice(0, 10);
    };

    const chartMap = new Map<string, { period: string; revenue: number; cogs: number; netProfit: number }>();
    validSales.forEach((inv) => {
      const k = periodKey(inv.date);
      const entry = chartMap.get(k) ?? { period: k, revenue: 0, cogs: 0, netProfit: 0 };
      const invCogs = inv.items.reduce((s, it) => s + it.quantity * it.costPrice, 0);
      entry.revenue += inv.total;
      entry.cogs += invCogs;
      entry.netProfit += inv.total - invCogs;
      chartMap.set(k, entry);
    });
    validExpenses.forEach((exp) => {
      const k = periodKey(exp.date);
      const entry = chartMap.get(k) ?? { period: k, revenue: 0, cogs: 0, netProfit: 0 };
      entry.netProfit -= exp.amount;
      chartMap.set(k, entry);
    });
    const chartData = Array.from(chartMap.values())
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((x) => ({
        ...x,
        revenue: Math.round(x.revenue * 100) / 100,
        netProfit: Math.round(x.netProfit * 100) / 100,
      }));

    // Profit by product
    const catMap = new Map<number, string>();
    categories.forEach((c) => catMap.set(c.id!, lang === 'ar' ? c.nameAr : c.nameFr));
    const prodToCat = new Map<number, string>();
    products.forEach((p) => prodToCat.set(p.id!, p.categoryId ? catMap.get(p.categoryId) ?? '—' : '—'));

    const byProductMap = new Map<
      number,
      { name: string; category: string; qty: number; sales: number; cost: number; profit: number; marginPct: number }
    >();
    validSales.forEach((inv) => {
      inv.items.forEach((it) => {
        const netQty = Math.max(0, it.quantity - (it.returnedQty ?? 0));
        if (netQty <= 0) return;
        const curr = byProductMap.get(it.productId) ?? {
          name: it.productName,
          category: prodToCat.get(it.productId) ?? '—',
          qty: 0,
          sales: 0,
          cost: 0,
          profit: 0,
          marginPct: 0,
        };
        curr.qty += netQty;
        curr.sales += netQty * it.unitPrice;
        curr.cost += netQty * it.costPrice;
        curr.profit = curr.sales - curr.cost;
        curr.marginPct = curr.sales > 0 ? (curr.profit / curr.sales) * 100 : 0;
        byProductMap.set(it.productId, curr);
      });
    });

    const q = search.trim().toLowerCase();
    const byProduct = Array.from(byProductMap.values())
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q))
      .sort((a, b) => b.profit - a.profit);

    // Profit by category
    const byCatMap = new Map<string, { category: string; sales: number; cost: number; profit: number }>();
    byProduct.forEach((p) => {
      const c = byCatMap.get(p.category) ?? { category: p.category, sales: 0, cost: 0, profit: 0 };
      c.sales += p.sales;
      c.cost += p.cost;
      c.profit += p.profit;
      byCatMap.set(p.category, c);
    });
    const byCategory = Array.from(byCatMap.values())
      .filter((c) => !q || c.category.toLowerCase().includes(q))
      .sort((a, b) => b.profit - a.profit);

    // Profit by invoice
    const byInvoice = validSales
      .map((inv) => {
        const cost = inv.items.reduce((s, it) => s + it.quantity * it.costPrice, 0);
        const profit = inv.total - cost;
        return {
          invoiceNumber: inv.invoiceNumber,
          date: inv.date.slice(0, 10),
          customer: inv.customerName,
          sales: inv.total,
          cost,
          profit,
          marginPct: inv.total > 0 ? (profit / inv.total) * 100 : 0,
        };
      })
      .filter(
        (inv) =>
          !q ||
          inv.invoiceNumber.toLowerCase().includes(q) ||
          inv.customer.toLowerCase().includes(q)
      );

    // Profit by seller
    const bySellerMap = new Map<string, { seller: string; invoices: number; sales: number; profit: number }>();
    validSales.forEach((inv) => {
      const cost = inv.items.reduce((s, it) => s + it.quantity * it.costPrice, 0);
      const curr = bySellerMap.get(inv.sellerName) ?? { seller: inv.sellerName, invoices: 0, sales: 0, profit: 0 };
      curr.invoices += 1;
      curr.sales += inv.total;
      curr.profit += inv.total - cost;
      bySellerMap.set(inv.sellerName, curr);
    });
    const bySeller = Array.from(bySellerMap.values())
      .filter((s) => !q || s.seller.toLowerCase().includes(q))
      .sort((a, b) => b.profit - a.profit);

    // Highest margin & Loss-making products
    const highestMargin = [...products]
      .filter((p) => p.salePrice > 0 && (!q || p.name.toLowerCase().includes(q)))
      .map((p) => ({
        name: p.name,
        purchasePrice: p.purchasePrice,
        salePrice: p.salePrice,
        unitProfit: p.salePrice - p.purchasePrice,
        marginPct: p.salePrice > 0 ? ((p.salePrice - p.purchasePrice) / p.salePrice) * 100 : 0,
      }))
      .sort((a, b) => b.marginPct - a.marginPct);

    const lossMaking = highestMargin.filter((p) => p.unitProfit < 0);

    return {
      grossSalesBeforeDiscount,
      discountsGranted,
      totalSalesNetOfDiscount,
      totalReturnsAmount,
      netRevenue,
      totalCogs,
      grossProfit,
      operatingExpenses,
      netProfit,
      profitMarginPct,
      cashCollected,
      chartData,
      byProduct,
      byCategory,
      byInvoice,
      bySeller,
      highestMargin,
      lossMaking,
    };
  }, [saleInvoices, saleReturns, expenses, products, categories, dateFrom, dateTo, granularity, lang, search]);

  const handlePrintProfit = () => {
    openPrint({
      type: 'generic_report',
      title: t(lang, 'تقرير الأرباح المحاسبي المفصل', 'Rapport détaillé des bénéfices'),
      subtitle: dateFrom || dateTo ? `${dateFrom || '—'} → ${dateTo || '—'}` : t(lang, 'كل الفترات', 'Toutes périodes'),
      summaryItems: [
        { label: t(lang, 'صافي المبيعات', 'Ventes nettes'), value: formatMoney(analytics.netRevenue, cur) },
        { label: t(lang, 'تكلفة البضاعة المباعة', 'COGS'), value: formatMoney(analytics.totalCogs, cur) },
        { label: t(lang, 'الربح الإجمالي', 'Marge brute'), value: formatMoney(analytics.grossProfit, cur) },
        { label: t(lang, 'الربح الصافي', 'Bénéfice net'), value: formatMoney(analytics.netProfit, cur) },
      ],
      columns: [
        t(lang, 'المنتج', 'Produit'),
        t(lang, 'الكمية', 'Qté'),
        t(lang, 'المبيعات', 'Ventes'),
        t(lang, 'التكلفة', 'Coût'),
        t(lang, 'الربح', 'Profit'),
        t(lang, 'الهامش %', 'Marge %'),
      ],
      rows: analytics.byProduct.map((p) => [
        p.name,
        p.qty,
        p.sales.toFixed(2),
        p.cost.toFixed(2),
        p.profit.toFixed(2),
        `${p.marginPct.toFixed(1)}%`,
      ]),
    });
  };

  const handleExportExcel = () => {
    exportRowsToExcel(
      analytics.byProduct.map((p) => ({
        [t(lang, 'المنتج', 'Produit')]: p.name,
        [t(lang, 'العائلة', 'Famille')]: p.category,
        [t(lang, 'الكمية', 'Qté')]: p.qty,
        [t(lang, 'المبيعات', 'Ventes')]: Number(p.sales.toFixed(2)),
        [t(lang, 'التكلفة (COGS)', 'Coût (COGS)')]: Number(p.cost.toFixed(2)),
        [t(lang, 'الربح', 'Profit')]: Number(p.profit.toFixed(2)),
        [t(lang, 'الهامش %', 'Marge %')]: `${p.marginPct.toFixed(1)}%`,
      })),
      'ProfitReport',
      `profit_report_${dateFrom || 'all'}_${dateTo || 'all'}.xlsx`
    );
  };

  const thClass =
    'bg-[#FCE08B] border border-slate-900 px-2.5 py-2 text-center text-[13px] font-bold text-slate-900 whitespace-nowrap select-none';
  const tdClass =
    'border border-slate-900 px-2.5 py-1 text-[13px] text-slate-900 h-[31px] whitespace-nowrap';

  const currentRowCount =
    breakdownTab === 'product'
      ? analytics.byProduct.length
      : breakdownTab === 'category'
        ? analytics.byCategory.length
        : breakdownTab === 'invoice'
          ? analytics.byInvoice.length
          : breakdownTab === 'seller'
            ? analytics.bySeller.length
            : analytics.highestMargin.length;

  const currentColCount =
    breakdownTab === 'product' || breakdownTab === 'invoice'
      ? 6
      : breakdownTab === 'margin'
        ? 5
        : 4;

  const blankRowsCount = Math.max(0, MIN_SHEET_ROWS - currentRowCount);

  return (
    <div className="space-y-3">
      {/* Unified Crisp Toolbar: Search + 6 Quick Date Period Buttons + Date Range */}
      <div className="flex flex-wrap items-center gap-2 bg-white px-2.5 py-2 border-[1.5px] border-slate-900 rounded-lg shadow-xs">
        {/* Search Input */}
        <div className="relative w-full sm:flex-1 sm:min-w-[200px]">
          <Search className="pointer-events-none absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t(
              lang,
              'بحث بالمنتج أو العائلة أو الفاتورة أو البائع...',
              'Rechercher produit, famille, facture, vendeur...'
            )}
            className="w-full h-10 rounded-lg border-[1.5px] border-slate-900 bg-white ps-9 pe-3 text-xs sm:text-sm font-medium text-slate-900 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-400"
          />
        </div>

        {/* 6 Quick Date Period Buttons */}
        <div className="flex flex-nowrap sm:flex-wrap items-center gap-1.5 overflow-x-auto no-scrollbar w-full sm:w-auto pb-0.5 sm:pb-0">
          {QUICK_PERIODS.map((p) => {
            const isActive = activePeriod === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => handleSelectPeriod(p.id)}
                className={`h-9 sm:h-10 px-3 rounded-lg border-[1.5px] text-xs sm:text-sm font-bold transition-colors whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                    : 'border-slate-900 bg-white text-slate-900 hover:bg-amber-50'
                }`}
              >
                {lang === 'ar' ? p.ar : p.fr}
              </button>
            );
          })}
        </div>

        {/* Date Pickers + Reset */}
        <div className="grid grid-cols-2 sm:flex sm:items-center gap-1.5 w-full sm:w-auto">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setActivePeriod(null);
            }}
            aria-label={t(lang, 'من تاريخ', 'Date début')}
            className="w-full sm:w-auto h-10 rounded-lg border-[1.5px] border-slate-300 bg-white px-2.5 font-mono text-xs font-medium text-slate-800 focus:border-slate-900 focus:outline-none"
          />
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setActivePeriod(null);
              }}
              aria-label={t(lang, 'إلى تاريخ', 'Date fin')}
              className="w-full sm:w-auto flex-1 h-10 rounded-lg border-[1.5px] border-slate-300 bg-white px-2.5 font-mono text-xs font-medium text-slate-800 focus:border-slate-900 focus:outline-none"
            />
            {(dateFrom || dateTo || search) && (
              <button
                type="button"
                onClick={handleResetFilters}
                title={t(lang, 'إعادة ضبط الفلتر', 'Réinitialiser les filtres')}
                className="h-10 w-10 inline-flex items-center justify-center rounded-lg border-[1.5px] border-slate-300 bg-white text-slate-700 hover:border-slate-900 hover:bg-slate-50 shrink-0"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Accounting Principle Strip */}
      <div className="flex items-start gap-2.5 border-[1.5px] border-slate-900 bg-[#FFFDF5] px-3.5 py-2.5 text-xs text-slate-800 rounded-lg">
        <Info className="h-4 w-4 text-[#0B274D] shrink-0 mt-0.5" />
        <div>
          <strong className="text-slate-900">{t(lang, 'قاعدة محاسبية (COGS):', 'Principe comptable (COGS) :')}</strong>{' '}
          {t(
            lang,
            `الربح الصافي المحقق (${formatMoney(analytics.netProfit, cur)}) يختلف عن المبلغ المحصل نقداً (${formatMoney(analytics.cashCollected, cur)}) لأن الربح يُحسب بطرح تكلفة البضاعة المباعة والمرتجعات والخصومات والمصاريف من إجمالي المبيعات (بما فيها الآجلة).`,
            `Le bénéfice net (${formatMoney(analytics.netProfit, cur)}) est distinct des encaissements (${formatMoney(analytics.cashCollected, cur)}) car il est calculé à partir du COGS, retours, remises et charges.`
          )}
        </div>
      </div>

      {/* Profit Waterfall KPI Cards (Golden-Header Bordered Style) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="bg-[#FCE08B] border-b border-slate-900 px-3 py-1.5 text-xs font-bold text-slate-900">
            {t(lang, 'إجمالي المبيعات (قبل الخصم)', 'Ventes brutes')}
          </div>
          <div className="p-3">
            <div className="font-mono text-lg font-extrabold text-slate-900 tabular-nums">
              {formatMoney(analytics.grossSalesBeforeDiscount, cur)}
            </div>
            <div className="mt-1 text-[11px] text-slate-600 font-mono">
              {t(lang, 'الخصومات:', 'Remises :')} -{formatMoney(analytics.discountsGranted, cur)}
            </div>
          </div>
        </div>

        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="bg-[#FCE08B] border-b border-slate-900 px-3 py-1.5 text-xs font-bold text-slate-900">
            {t(lang, 'تكلفة البضاعة المباعة (COGS)', 'Coût marchandises (COGS)')}
          </div>
          <div className="p-3">
            <div className="font-mono text-lg font-extrabold text-slate-900 tabular-nums">
              {formatMoney(analytics.totalCogs, cur)}
            </div>
            <div className="mt-1 text-[11px] text-slate-600 font-mono">
              {t(lang, 'المرتجعات:', 'Retours :')} -{formatMoney(analytics.totalReturnsAmount, cur)}
            </div>
          </div>
        </div>

        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="bg-[#FCE08B] border-b border-slate-900 px-3 py-1.5 text-xs font-bold text-slate-900">
            {t(lang, 'الربح الإجمالي', 'Marge brute')}
          </div>
          <div className="p-3">
            <div className="font-mono text-lg font-extrabold text-emerald-800 tabular-nums">
              {formatMoney(analytics.grossProfit, cur)}
            </div>
            <div className="mt-1 text-[11px] text-slate-600 font-mono">
              {t(lang, 'المصاريف التشغيلية:', 'Charges :')} -{formatMoney(analytics.operatingExpenses, cur)}
            </div>
          </div>
        </div>

        <div className="border-[1.5px] border-slate-900 bg-[#0B274D] text-white overflow-hidden">
          <div className="bg-[#FCE08B] border-b border-slate-900 px-3 py-1.5 text-xs font-bold text-slate-900">
            {t(lang, 'الربح الصافي وهامش الربح', 'Bénéfice net & Marge %')}
          </div>
          <div className="p-3">
            <div
              className={`font-mono text-lg font-extrabold tabular-nums ${
                analytics.netProfit >= 0 ? 'text-[#FDE68A]' : 'text-red-300'
              }`}
            >
              {formatMoney(analytics.netProfit, cur)}
            </div>
            <div className="mt-1 text-[11px] text-slate-200 font-mono">
              {t(lang, 'نسبة الهامش الصافي:', 'Marge nette :')} {analytics.profitMarginPct.toFixed(1)}%
            </div>
          </div>
        </div>
      </div>

      {/* Profit Evolution Chart (Golden-Header Bordered Container) */}
      <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 bg-[#FCE08B] border-b border-slate-900 px-3 py-2">
          <h3 className="text-sm font-bold text-slate-900">
            {embedded
              ? t(lang, 'تطور الأرباح والمبيعات (COGS)', 'Évolution des bénéfices (COGS)')
              : t(lang, 'تطور الأرباح والمبيعات', 'Évolution des bénéfices')}
          </h3>
          <div className="flex items-center gap-1">
            {(
              [
                { id: 'daily', ar: 'يومي', fr: 'Jour' },
                { id: 'weekly', ar: 'أسبوعي', fr: 'Semaine' },
                { id: 'monthly', ar: 'شهري', fr: 'Mois' },
                { id: 'yearly', ar: 'سنوي', fr: 'Année' },
              ] as const
            ).map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => setGranularity(g.id)}
                className={`rounded-md border px-2.5 py-1 text-xs font-bold transition-colors ${
                  granularity === g.id
                    ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                    : 'border-slate-900 bg-white text-slate-900 hover:bg-amber-50'
                }`}
              >
                {lang === 'ar' ? g.ar : g.fr}
              </button>
            ))}
          </div>
        </div>
        <div className="p-4">
          <div className="h-56 w-full" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analytics.chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="period" tick={{ fontSize: 11, fill: '#334155' }} />
                <YAxis tick={{ fontSize: 11, fill: '#334155' }} />
                <Tooltip />
                <Bar dataKey="revenue" name={t(lang, 'المبيعات', 'Ventes')} fill="#94a3b8" radius={[3, 3, 0, 0]} />
                <Bar dataKey="netProfit" name={t(lang, 'الربح الصافي', 'Bénéfice net')} fill="#0B274D" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Profit Breakdown Sub-Tabs + Golden-Header Spreadsheet Table */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { id: 'product', ar: 'الأرباح حسب المنتج', fr: 'Par produit' },
              { id: 'category', ar: 'حسب العائلة', fr: 'Par famille' },
              { id: 'invoice', ar: 'حسب الفاتورة', fr: 'Par facture' },
              { id: 'seller', ar: 'حسب البائع', fr: 'Par vendeur' },
              { id: 'margin', ar: 'أعلى هامش / الخسارة', fr: 'Meilleures marges / Pertes' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setBreakdownTab(tab.id)}
              className={`h-9 px-3.5 rounded-lg border-[1.5px] text-xs font-bold transition-colors ${
                breakdownTab === tab.id
                  ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A]'
                  : 'border-slate-900 bg-white text-slate-900 hover:bg-amber-50'
              }`}
            >
              {lang === 'ar' ? tab.ar : tab.fr}
            </button>
          ))}
        </div>

        {breakdownTab === 'margin' && analytics.lossMaking.length > 0 && (
          <div className="rounded-lg border-[1.5px] border-red-700 bg-red-50 px-3.5 py-2 text-xs text-red-900">
            <strong>{t(lang, 'تنبيه — منتجات تحقق خسارة (سعر البيع أقل من سعر الشراء):', 'Alerte — Produits à perte :')}</strong>{' '}
            {analytics.lossMaking.map((p) => p.name).join(' · ')}
          </div>
        )}

        <div className="bg-white border-[1.5px] border-slate-900 overflow-x-auto shadow-xs">
          {breakdownTab === 'product' && (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thClass}>{t(lang, 'المنتج', 'Produit')}</th>
                  <th className={thClass}>{t(lang, 'الكمية', 'Qté')}</th>
                  <th className={thClass}>{t(lang, 'المبيعات', 'Ventes')}</th>
                  <th className={thClass}>{t(lang, 'التكلفة', 'Coût')}</th>
                  <th className={thClass}>{t(lang, 'الربح', 'Profit')}</th>
                  <th className={thClass}>{t(lang, 'الهامش %', 'Marge %')}</th>
                </tr>
              </thead>
              <tbody>
                {analytics.byProduct.map((p, i) => (
                  <tr key={i} className="hover:bg-amber-50/60">
                    <td className={`${tdClass} font-semibold`}>{p.name}</td>
                    <td className={`${tdClass} text-center font-mono tabular-nums`}>{p.qty}</td>
                    <td className={`${tdClass} text-center font-mono tabular-nums`}>{formatMoney(p.sales, cur)}</td>
                    <td className={`${tdClass} text-center font-mono tabular-nums text-slate-600`}>{formatMoney(p.cost, cur)}</td>
                    <td
                      className={`${tdClass} text-center font-mono tabular-nums font-bold ${
                        p.profit >= 0 ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {formatMoney(p.profit, cur)}
                    </td>
                    <td className={`${tdClass} text-center font-mono tabular-nums font-semibold`}>{p.marginPct.toFixed(1)}%</td>
                  </tr>
                ))}
                {Array.from({ length: blankRowsCount }).map((_, idx) => (
                  <tr key={`blank-p-${idx}`}>
                    {Array.from({ length: currentColCount }).map((__, cIdx) => (
                      <td key={cIdx} className={tdClass}>&nbsp;</td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-[#FEF3C7] font-bold">
                  <td className={`${tdClass} text-center font-extrabold`}>
                    {t(lang, 'المجموع', 'Total')} ({analytics.byProduct.length})
                  </td>
                  <td className={`${tdClass} text-center font-mono tabular-nums`}>
                    {analytics.byProduct.reduce((s, p) => s + p.qty, 0)}
                  </td>
                  <td className={`${tdClass} text-center font-mono tabular-nums`}>
                    {formatMoney(analytics.byProduct.reduce((s, p) => s + p.sales, 0), cur)}
                  </td>
                  <td className={`${tdClass} text-center font-mono tabular-nums`}>
                    {formatMoney(analytics.byProduct.reduce((s, p) => s + p.cost, 0), cur)}
                  </td>
                  <td className={`${tdClass} text-center font-mono tabular-nums text-emerald-800`}>
                    {formatMoney(analytics.byProduct.reduce((s, p) => s + p.profit, 0), cur)}
                  </td>
                  <td className={`${tdClass} text-center font-mono tabular-nums`}>
                    {analytics.profitMarginPct.toFixed(1)}%
                  </td>
                </tr>
              </tfoot>
            </table>
          )}

          {breakdownTab === 'category' && (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thClass}>{t(lang, 'العائلة', 'Famille')}</th>
                  <th className={thClass}>{t(lang, 'المبيعات', 'Ventes')}</th>
                  <th className={thClass}>{t(lang, 'التكلفة', 'Coût')}</th>
                  <th className={thClass}>{t(lang, 'الربح', 'Profit')}</th>
                </tr>
              </thead>
              <tbody>
                {analytics.byCategory.map((c, i) => (
                  <tr key={i} className="hover:bg-amber-50/60">
                    <td className={`${tdClass} font-semibold`}>{c.category}</td>
                    <td className={`${tdClass} text-center font-mono tabular-nums`}>{formatMoney(c.sales, cur)}</td>
                    <td className={`${tdClass} text-center font-mono tabular-nums text-slate-600`}>{formatMoney(c.cost, cur)}</td>
                    <td className={`${tdClass} text-center font-mono tabular-nums font-bold text-emerald-700`}>
                      {formatMoney(c.profit, cur)}
                    </td>
                  </tr>
                ))}
                {Array.from({ length: blankRowsCount }).map((_, idx) => (
                  <tr key={`blank-c-${idx}`}>
                    {Array.from({ length: currentColCount }).map((__, cIdx) => (
                      <td key={cIdx} className={tdClass}>&nbsp;</td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-[#FEF3C7] font-bold">
                  <td className={`${tdClass} text-center font-extrabold`}>
                    {t(lang, 'المجموع', 'Total')} ({analytics.byCategory.length})
                  </td>
                  <td className={`${tdClass} text-center font-mono tabular-nums`}>
                    {formatMoney(analytics.byCategory.reduce((s, c) => s + c.sales, 0), cur)}
                  </td>
                  <td className={`${tdClass} text-center font-mono tabular-nums`}>
                    {formatMoney(analytics.byCategory.reduce((s, c) => s + c.cost, 0), cur)}
                  </td>
                  <td className={`${tdClass} text-center font-mono tabular-nums text-emerald-800`}>
                    {formatMoney(analytics.byCategory.reduce((s, c) => s + c.profit, 0), cur)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}

          {breakdownTab === 'invoice' && (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thClass}>{t(lang, 'التاريخ', 'Date')}</th>
                  <th className={thClass}>{t(lang, 'الفاتورة', 'Facture')}</th>
                  <th className={thClass}>{t(lang, 'الزبون', 'Client')}</th>
                  <th className={thClass}>{t(lang, 'المبيعات', 'Ventes')}</th>
                  <th className={thClass}>{t(lang, 'التكلفة', 'Coût')}</th>
                  <th className={thClass}>{t(lang, 'الربح', 'Profit')}</th>
                </tr>
              </thead>
              <tbody>
                {analytics.byInvoice.map((inv, i) => (
                  <tr key={i} className="hover:bg-amber-50/60">
                    <td className={`${tdClass} text-center font-mono`}>{inv.date}</td>
                    <td className={`${tdClass} text-center font-mono font-semibold`}>{inv.invoiceNumber}</td>
                    <td className={tdClass}>{inv.customer}</td>
                    <td className={`${tdClass} text-center font-mono tabular-nums`}>{formatMoney(inv.sales, cur)}</td>
                    <td className={`${tdClass} text-center font-mono tabular-nums text-slate-600`}>{formatMoney(inv.cost, cur)}</td>
                    <td
                      className={`${tdClass} text-center font-mono tabular-nums font-bold ${
                        inv.profit >= 0 ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {formatMoney(inv.profit, cur)}
                    </td>
                  </tr>
                ))}
                {Array.from({ length: blankRowsCount }).map((_, idx) => (
                  <tr key={`blank-i-${idx}`}>
                    {Array.from({ length: currentColCount }).map((__, cIdx) => (
                      <td key={cIdx} className={tdClass}>&nbsp;</td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-[#FEF3C7] font-bold">
                  <td colSpan={3} className={`${tdClass} text-center font-extrabold`}>
                    {t(lang, 'المجموع', 'Total')} ({analytics.byInvoice.length})
                  </td>
                  <td className={`${tdClass} text-center font-mono tabular-nums`}>
                    {formatMoney(analytics.byInvoice.reduce((s, x) => s + x.sales, 0), cur)}
                  </td>
                  <td className={`${tdClass} text-center font-mono tabular-nums`}>
                    {formatMoney(analytics.byInvoice.reduce((s, x) => s + x.cost, 0), cur)}
                  </td>
                  <td className={`${tdClass} text-center font-mono tabular-nums text-emerald-800`}>
                    {formatMoney(analytics.byInvoice.reduce((s, x) => s + x.profit, 0), cur)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}

          {breakdownTab === 'seller' && (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thClass}>{t(lang, 'البائع', 'Vendeur')}</th>
                  <th className={thClass}>{t(lang, 'الفواتير', 'Factures')}</th>
                  <th className={thClass}>{t(lang, 'المبيعات', 'Ventes')}</th>
                  <th className={thClass}>{t(lang, 'الربح الإجمالي', 'Profit brut')}</th>
                </tr>
              </thead>
              <tbody>
                {analytics.bySeller.map((s, i) => (
                  <tr key={i} className="hover:bg-amber-50/60">
                    <td className={`${tdClass} font-semibold`}>{s.seller}</td>
                    <td className={`${tdClass} text-center font-mono tabular-nums`}>{s.invoices}</td>
                    <td className={`${tdClass} text-center font-mono tabular-nums`}>{formatMoney(s.sales, cur)}</td>
                    <td className={`${tdClass} text-center font-mono tabular-nums font-bold text-emerald-700`}>
                      {formatMoney(s.profit, cur)}
                    </td>
                  </tr>
                ))}
                {Array.from({ length: blankRowsCount }).map((_, idx) => (
                  <tr key={`blank-s-${idx}`}>
                    {Array.from({ length: currentColCount }).map((__, cIdx) => (
                      <td key={cIdx} className={tdClass}>&nbsp;</td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-[#FEF3C7] font-bold">
                  <td className={`${tdClass} text-center font-extrabold`}>
                    {t(lang, 'المجموع', 'Total')} ({analytics.bySeller.length})
                  </td>
                  <td className={`${tdClass} text-center font-mono tabular-nums`}>
                    {analytics.bySeller.reduce((acc, s) => acc + s.invoices, 0)}
                  </td>
                  <td className={`${tdClass} text-center font-mono tabular-nums`}>
                    {formatMoney(analytics.bySeller.reduce((acc, s) => acc + s.sales, 0), cur)}
                  </td>
                  <td className={`${tdClass} text-center font-mono tabular-nums text-emerald-800`}>
                    {formatMoney(analytics.bySeller.reduce((acc, s) => acc + s.profit, 0), cur)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}

          {breakdownTab === 'margin' && (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={thClass}>{t(lang, 'المنتج', 'Produit')}</th>
                  <th className={thClass}>{t(lang, 'ثمن الشراء', 'Achat')}</th>
                  <th className={thClass}>{t(lang, 'ثمن البيع', 'Vente')}</th>
                  <th className={thClass}>{t(lang, 'الربح للوحدة', 'Gain unitaire')}</th>
                  <th className={thClass}>{t(lang, 'هامش الربح %', 'Marge %')}</th>
                </tr>
              </thead>
              <tbody>
                {analytics.highestMargin.map((p, i) => (
                  <tr key={i} className="hover:bg-amber-50/60">
                    <td className={`${tdClass} font-semibold`}>{p.name}</td>
                    <td className={`${tdClass} text-center font-mono tabular-nums`}>{p.purchasePrice.toFixed(2)}</td>
                    <td className={`${tdClass} text-center font-mono tabular-nums`}>{p.salePrice.toFixed(2)}</td>
                    <td
                      className={`${tdClass} text-center font-mono tabular-nums font-bold ${
                        p.unitProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {p.unitProfit >= 0 ? '+' : ''}
                      {p.unitProfit.toFixed(2)}
                    </td>
                    <td className={`${tdClass} text-center font-mono tabular-nums font-semibold`}>{p.marginPct.toFixed(1)}%</td>
                  </tr>
                ))}
                {Array.from({ length: blankRowsCount }).map((_, idx) => (
                  <tr key={`blank-m-${idx}`}>
                    {Array.from({ length: currentColCount }).map((__, cIdx) => (
                      <td key={cIdx} className={tdClass}>&nbsp;</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Bottom Utility Bar: Excel + Print */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
        <div className="text-xs font-medium text-slate-600">
          {t(lang, 'عدد السجلات:', 'Lignes :')}{' '}
          <span className="font-mono font-bold text-slate-900">{currentRowCount}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExportExcel}
            className="inline-flex items-center gap-1.5 rounded-lg border-[1.5px] border-emerald-700 bg-emerald-600 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-emerald-700"
          >
            <Download className="h-3.5 w-3.5" />
            {t(lang, 'تصدير Excel', 'Exporter Excel')}
          </button>
          <button
            type="button"
            onClick={handlePrintProfit}
            className="inline-flex items-center gap-1.5 rounded-lg border-[1.5px] border-slate-900 bg-white px-3.5 py-1.5 text-xs font-bold text-slate-900 hover:bg-amber-50"
          >
            <Printer className="h-3.5 w-3.5" />
            {t(lang, 'طباعة التقرير', 'Imprimer le rapport')}
          </button>
        </div>
      </div>
    </div>
  );
};
