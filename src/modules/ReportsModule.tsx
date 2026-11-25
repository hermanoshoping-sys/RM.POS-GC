import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Download, FileDown, Printer, RotateCcw, Search, X } from 'lucide-react';
import { db } from '../db/database';
import { useApp } from '../context/AppContext';
import { formatMoney, getExpenseCategoryLabel, getPaymentMethodLabel, t } from '../i18n/translations';
import { exportRowsToExcel, exportTableToPdf } from '../utils/export';
import { getQuickPeriodRange, QUICK_PERIODS, QuickPeriodId, toLocalIsoDate } from '../utils/datePeriods';
import { hasPermission } from '../utils/permissions';
import { ProfitReportsModule } from './ProfitReportsModule';

export type ReportTabId = 'sales' | 'stock' | 'finance' | 'profits';

type ReportKey =
  | 'sales_daily'
  | 'sales_monthly'
  | 'sales_yearly'
  | 'purchases'
  | 'sales_by_product'
  | 'sales_by_category'
  | 'sales_by_seller'
  | 'sales_by_customer'
  | 'purchases_by_supplier'
  | 'best_selling'
  | 'least_selling'
  | 'stock_movements'
  | 'current_stock'
  | 'out_of_stock'
  | 'near_expiry'
  | 'customer_debts'
  | 'supplier_payables'
  | 'payments_collections'
  | 'expenses'
  | 'cash_register'
  | 'period_comparison';

interface ReportDef {
  key: ReportKey;
  group: Exclude<ReportTabId, 'profits'>;
  ar: string;
  fr: string;
}

const REPORT_LIST: ReportDef[] = [
  // Sales group
  { key: 'sales_daily', group: 'sales', ar: 'المبيعات اليومية', fr: 'Ventes quotidiennes' },
  { key: 'sales_monthly', group: 'sales', ar: 'المبيعات الشهرية', fr: 'Ventes mensuelles' },
  { key: 'sales_yearly', group: 'sales', ar: 'المبيعات السنوية', fr: 'Ventes annuelles' },
  { key: 'sales_by_product', group: 'sales', ar: 'حسب المنتجات', fr: 'Par produit' },
  { key: 'sales_by_category', group: 'sales', ar: 'حسب العائلات', fr: 'Par famille' },
  { key: 'sales_by_seller', group: 'sales', ar: 'حسب البائع', fr: 'Par vendeur' },
  { key: 'sales_by_customer', group: 'sales', ar: 'حسب الزبون', fr: 'Par client' },
  { key: 'best_selling', group: 'sales', ar: 'الأكثر مبيعاً', fr: 'Meilleures ventes' },
  { key: 'least_selling', group: 'sales', ar: 'الأقل مبيعاً', fr: 'Moins vendus' },
  { key: 'period_comparison', group: 'sales', ar: 'مقارنة الفترات', fr: 'Comparaison' },
  // Purchases & Stock group
  { key: 'purchases', group: 'stock', ar: 'تقرير المشتريات', fr: 'Achats' },
  { key: 'purchases_by_supplier', group: 'stock', ar: 'المشتريات حسب المورد', fr: 'Achats / Fournisseur' },
  { key: 'stock_movements', group: 'stock', ar: 'حركة المخزون', fr: 'Mouvements stock' },
  { key: 'current_stock', group: 'stock', ar: 'المخزون الحالي', fr: 'Stock actuel' },
  { key: 'out_of_stock', group: 'stock', ar: 'المنتجات النافدة', fr: 'En rupture' },
  { key: 'near_expiry', group: 'stock', ar: 'قريبة الصلاحية', fr: 'Proche péremption' },
  // Debts & Finance group
  { key: 'customer_debts', group: 'finance', ar: 'ديون الزبناء', fr: 'Créances clients' },
  { key: 'supplier_payables', group: 'finance', ar: 'مستحقات الموردين', fr: 'Dettes fournisseurs' },
  { key: 'payments_collections', group: 'finance', ar: 'الدفعات والتحصيلات', fr: 'Paiements' },
  { key: 'expenses', group: 'finance', ar: 'تقرير المصاريف', fr: 'Dépenses' },
  { key: 'cash_register', group: 'finance', ar: 'تقرير الصندوق', fr: 'Caisse' },
];

const MIN_SHEET_ROWS = 16;

interface ReportsModuleProps {
  initialTab?: 'general' | 'profits';
  activeTab?: ReportTabId;
  onTabChange?: (tab: ReportTabId) => void;
}

export const ReportsModule: React.FC<ReportsModuleProps> = ({
  initialTab = 'general',
  activeTab: controlledTab,
  onTabChange,
}) => {
  const { lang, settings, currentUser, notify, openPrint } = useApp();
  const cur = settings.storeInfo.currency || 'MAD';
  const canViewProfits = hasPermission(currentUser, 'canViewProfits');

  const [internalTab, setInternalTab] = useState<ReportTabId>(
    initialTab === 'profits' && canViewProfits ? 'profits' : 'sales'
  );
  const activeTab = controlledTab ?? internalTab;
  const setActiveTab = (tab: ReportTabId) => {
    if (tab === 'profits' && !canViewProfits) return;
    if (onTabChange) onTabChange(tab);
    else setInternalTab(tab);
  };

  const [selectedReport, setSelectedReport] = useState<ReportKey>('sales_daily');
  const [search, setSearch] = useState('');
  const [activePeriod, setActivePeriod] = useState<QuickPeriodId>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Auto-select first report of active group when switching tab
  useEffect(() => {
    if (activeTab === 'profits') return;
    const currentDef = REPORT_LIST.find((r) => r.key === selectedReport);
    if (!currentDef || currentDef.group !== activeTab) {
      const firstInGroup = REPORT_LIST.find((r) => r.group === activeTab);
      if (firstInGroup) setSelectedReport(firstInGroup.key);
    }
  }, [activeTab, selectedReport]);

  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const categories = useLiveQuery(() => db.categories.toArray(), []) ?? [];
  const customers = useLiveQuery(() => db.customers.toArray(), []) ?? [];
  const suppliers = useLiveQuery(() => db.suppliers.toArray(), []) ?? [];
  const sales = useLiveQuery(() => db.saleInvoices.toArray(), []) ?? [];
  const saleReturns = useLiveQuery(() => db.saleReturns.toArray(), []) ?? [];
  const purchases = useLiveQuery(() => db.purchaseInvoices.toArray(), []) ?? [];
  const custPayments = useLiveQuery(() => db.customerPayments.toArray(), []) ?? [];
  const supPayments = useLiveQuery(() => db.supplierPayments.toArray(), []) ?? [];
  const expenses = useLiveQuery(() => db.expenses.toArray(), []) ?? [];
  const movements = useLiveQuery(() => db.stockMovements.toArray(), []) ?? [];

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

  const inRange = (iso: string) => {
    const d = iso.slice(0, 10);
    return (!dateFrom || d >= dateFrom) && (!dateTo || d <= dateTo);
  };

  const reportData = useMemo(() => {
    const validSales = sales.filter((s) => s.status !== 'cancelled' && inRange(s.date));
    const validPurchases = purchases.filter((p) => p.status !== 'cancelled' && inRange(p.date));
    const validExpenses = expenses.filter((e) => !e.isCancelled && inRange(e.date));
    const validCustPays = custPayments.filter((p) => !p.isCancelled && inRange(p.date));
    const validSupPays = supPayments.filter((p) => !p.isCancelled && inRange(p.date));

    const prodCatMap = new Map<number, string>();
    const catMap = new Map<number, string>();
    categories.forEach((c) => catMap.set(c.id!, lang === 'ar' ? c.nameAr : c.nameFr));
    products.forEach((p) => prodCatMap.set(p.id!, p.categoryId ? catMap.get(p.categoryId) ?? '—' : '—'));

    let columns: string[] = [];
    let rows: (string | number)[][] = [];
    let summary: { label: string; value: string }[] = [];

    const groupSalesByDateSlice = (sliceLen: number) => {
      const m = new Map<string, { count: number; total: number; paid: number; rem: number }>();
      validSales.forEach((s) => {
        const k = s.date.slice(0, sliceLen);
        const e = m.get(k) ?? { count: 0, total: 0, paid: 0, rem: 0 };
        e.count += 1;
        e.total += s.total;
        e.paid += s.paidAmount;
        e.rem += s.remainingAmount;
        m.set(k, e);
      });
      columns = [
        t(lang, 'الفترة', 'Période'),
        t(lang, 'عدد الفواتير', 'Nb Factures'),
        t(lang, 'إجمالي المبيعات', 'Total Ventes'),
        t(lang, 'المحصل', 'Encaissé'),
        t(lang, 'المتبقي', 'Reste'),
      ];
      rows = Array.from(m.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([k, v]) => [k, v.count, v.total.toFixed(2), v.paid.toFixed(2), v.rem.toFixed(2)]);
      const sumTotal = validSales.reduce((s, x) => s + x.total, 0);
      const sumPaid = validSales.reduce((s, x) => s + x.paidAmount, 0);
      summary = [
        { label: t(lang, 'إجمالي المبيعات', 'Total Ventes'), value: formatMoney(sumTotal, cur) },
        { label: t(lang, 'المحصل', 'Encaissé'), value: formatMoney(sumPaid, cur) },
        { label: t(lang, 'المتبقي', 'Reste'), value: formatMoney(sumTotal - sumPaid, cur) },
        { label: t(lang, 'عدد الفواتير', 'Factures'), value: String(validSales.length) },
      ];
    };

    switch (selectedReport) {
      case 'sales_daily':
        groupSalesByDateSlice(10);
        break;
      case 'sales_monthly':
        groupSalesByDateSlice(7);
        break;
      case 'sales_yearly':
        groupSalesByDateSlice(4);
        break;
      case 'purchases':
        columns = [
          t(lang, 'الرقم', 'N°'),
          t(lang, 'التاريخ', 'Date'),
          t(lang, 'المورد', 'Fournisseur'),
          t(lang, 'الإجمالي', 'Total'),
          t(lang, 'المدفوع', 'Payé'),
          t(lang, 'المتبقي', 'Reste'),
        ];
        rows = validPurchases.map((p) => [
          p.invoiceNumber,
          p.date.slice(0, 10),
          p.supplierName,
          p.total.toFixed(2),
          p.paidAmount.toFixed(2),
          p.remainingAmount.toFixed(2),
        ]);
        summary = [
          { label: t(lang, 'إجمالي المشتريات', 'Total Achats'), value: formatMoney(validPurchases.reduce((s, p) => s + p.total, 0), cur) },
          { label: t(lang, 'المدفوع', 'Payé'), value: formatMoney(validPurchases.reduce((s, p) => s + p.paidAmount, 0), cur) },
        ];
        break;

      case 'sales_by_product':
      case 'best_selling':
      case 'least_selling': {
        const map = new Map<number, { name: string; qty: number; rev: number; profit: number }>();
        products.forEach((p) => map.set(p.id!, { name: p.name, qty: 0, rev: 0, profit: 0 }));
        validSales.forEach((s) =>
          s.items.forEach((it) => {
            const net = Math.max(0, it.quantity - (it.returnedQty ?? 0));
            const e = map.get(it.productId) ?? { name: it.productName, qty: 0, rev: 0, profit: 0 };
            e.qty += net;
            e.rev += net * it.unitPrice;
            e.profit += net * (it.unitPrice - it.costPrice);
            map.set(it.productId, e);
          })
        );
        const list = Array.from(map.values()).filter((x) =>
          selectedReport === 'least_selling' ? true : x.qty > 0
        );
        list.sort((a, b) =>
          selectedReport === 'least_selling' ? a.qty - b.qty : b.qty - a.qty
        );
        columns = [
          t(lang, 'المنتج', 'Produit'),
          t(lang, 'الكمية المباعة', 'Qté vendue'),
          t(lang, 'إجمالي المبيعات', 'CA'),
          t(lang, 'الربح', 'Profit'),
        ];
        rows = list.map((x) => [x.name, x.qty, x.rev.toFixed(2), x.profit.toFixed(2)]);
        break;
      }

      case 'sales_by_category': {
        const m = new Map<string, { qty: number; rev: number }>();
        validSales.forEach((s) =>
          s.items.forEach((it) => {
            const cat = prodCatMap.get(it.productId) ?? '—';
            const e = m.get(cat) ?? { qty: 0, rev: 0 };
            e.qty += it.quantity;
            e.rev += it.total;
            m.set(cat, e);
          })
        );
        columns = [t(lang, 'العائلة', 'Famille'), t(lang, 'الكمية', 'Qté'), t(lang, 'المبيعات', 'CA')];
        rows = Array.from(m.entries())
          .sort((a, b) => b[1].rev - a[1].rev)
          .map(([k, v]) => [k, v.qty, v.rev.toFixed(2)]);
        break;
      }

      case 'sales_by_seller': {
        const m = new Map<string, { count: number; rev: number }>();
        validSales.forEach((s) => {
          const e = m.get(s.sellerName) ?? { count: 0, rev: 0 };
          e.count += 1;
          e.rev += s.total;
          m.set(s.sellerName, e);
        });
        columns = [t(lang, 'البائع', 'Vendeur'), t(lang, 'الفواتير', 'Factures'), t(lang, 'المبيعات', 'CA')];
        rows = Array.from(m.entries()).map(([k, v]) => [k, v.count, v.rev.toFixed(2)]);
        break;
      }

      case 'sales_by_customer': {
        const m = new Map<string, { count: number; rev: number; rem: number }>();
        validSales.forEach((s) => {
          const e = m.get(s.customerName) ?? { count: 0, rev: 0, rem: 0 };
          e.count += 1;
          e.rev += s.total;
          e.rem += s.remainingAmount;
          m.set(s.customerName, e);
        });
        columns = [t(lang, 'الزبون', 'Client'), t(lang, 'الفواتير', 'Factures'), t(lang, 'المبيعات', 'Total'), t(lang, 'المتبقي', 'Reste')];
        rows = Array.from(m.entries()).map(([k, v]) => [k, v.count, v.rev.toFixed(2), v.rem.toFixed(2)]);
        break;
      }

      case 'purchases_by_supplier': {
        const m = new Map<string, { count: number; total: number; rem: number }>();
        validPurchases.forEach((p) => {
          const e = m.get(p.supplierName) ?? { count: 0, total: 0, rem: 0 };
          e.count += 1;
          e.total += p.total;
          e.rem += p.remainingAmount;
          m.set(p.supplierName, e);
        });
        columns = [t(lang, 'المورد', 'Fournisseur'), t(lang, 'الفواتير', 'Factures'), t(lang, 'الإجمالي', 'Total'), t(lang, 'المتبقي', 'Reste')];
        rows = Array.from(m.entries()).map(([k, v]) => [k, v.count, v.total.toFixed(2), v.rem.toFixed(2)]);
        break;
      }

      case 'stock_movements': {
        const list = movements.filter((m) => inRange(m.date)).slice(0, 150);
        columns = [t(lang, 'التاريخ', 'Date'), t(lang, 'المنتج', 'Produit'), t(lang, 'النوع', 'Type'), t(lang, 'التغير', 'Delta'), t(lang, 'بعد', 'Après'), t(lang, 'المرجع', 'Réf')];
        rows = list.map((m) => [m.date.slice(0, 10), m.productName, m.type, m.quantityDelta, m.afterQty, m.referenceNumber]);
        break;
      }

      case 'current_stock':
      case 'out_of_stock':
      case 'near_expiry': {
        const plus30 = toLocalIsoDate(new Date(Date.now() + 30 * 86400000));
        const list = products.filter((p) => {
          if (selectedReport === 'out_of_stock') return p.quantity <= 0;
          if (selectedReport === 'near_expiry') return Boolean(p.expiryDate && p.expiryDate <= plus30);
          return true;
        });
        columns = [t(lang, 'المنتج', 'Produit'), t(lang, 'المتوفر', 'Stock'), t(lang, 'التكلفة', 'Coût'), t(lang, 'القيمة', 'Valeur'), t(lang, 'الصلاحية', 'Expiration')];
        rows = list.map((p) => [
          p.name,
          p.quantity,
          p.purchasePrice.toFixed(2),
          (Math.max(0, p.quantity) * p.purchasePrice).toFixed(2),
          p.expiryDate || '—',
        ]);
        summary = [
          {
            label: t(lang, 'إجمالي قيمة المخزون', 'Valeur totale'),
            value: formatMoney(list.reduce((s, p) => s + Math.max(0, p.quantity) * p.purchasePrice, 0), cur),
          },
        ];
        break;
      }

      case 'customer_debts': {
        columns = [t(lang, 'الزبون', 'Client'), t(lang, 'الهاتف', 'Tél'), t(lang, 'الحد الائتماني', 'Plafond'), t(lang, 'الدين المتبقي', 'Solde dû')];
        const list = customers
          .map((c) => {
            const debt =
              sales
                .filter((s) => s.customerId === c.id && s.status !== 'cancelled')
                .reduce((sum, s) => sum + s.remainingAmount, 0) + (c.openingBalance || 0);
            return { ...c, debt };
          })
          .filter((c) => c.debt > 0.01);
        rows = list.map((c) => [c.fullName, c.phone || '—', c.creditLimit.toFixed(2), c.debt.toFixed(2)]);
        summary = [{ label: t(lang, 'إجمالي ديون الزبناء', 'Total créances'), value: formatMoney(list.reduce((s, c) => s + c.debt, 0), cur) }];
        break;
      }

      case 'supplier_payables': {
        columns = [t(lang, 'المورد', 'Fournisseur'), t(lang, 'الهاتف', 'Tél'), t(lang, 'المستحقات المتبقية', 'Solde dû')];
        const list = suppliers
          .map((s) => {
            const rem =
              purchases
                .filter((p) => p.supplierId === s.id && p.status !== 'cancelled')
                .reduce((sum, p) => sum + p.remainingAmount, 0) + (s.openingBalance || 0);
            return { ...s, rem };
          })
          .filter((s) => s.rem > 0.01);
        rows = list.map((s) => [s.businessName, s.phone || '—', s.rem.toFixed(2)]);
        summary = [{ label: t(lang, 'إجمالي مستحقات الموردين', 'Total dettes'), value: formatMoney(list.reduce((s, x) => s + x.rem, 0), cur) }];
        break;
      }

      case 'payments_collections': {
        columns = [t(lang, 'النوع', 'Type'), t(lang, 'المرجع', 'Réf'), t(lang, 'التاريخ', 'Date'), t(lang, 'الطرف', 'Tiers'), t(lang, 'الطريقة', 'Mode'), t(lang, 'المبلغ', 'Montant')];
        rows = [
          ...validCustPays.map((p) => [t(lang, 'تحصيل زبون', 'Encaissement'), `#${p.refNumber}`, p.date.slice(0, 10), p.customerName, getPaymentMethodLabel(p.paymentMethod, lang), `+${p.amount.toFixed(2)}`]),
          ...validSupPays.map((p) => [t(lang, 'أداء مورد', 'Décaissement'), `#${p.refNumber}`, p.date.slice(0, 10), p.supplierName, getPaymentMethodLabel(p.paymentMethod, lang), `-${p.amount.toFixed(2)}`]),
        ];
        break;
      }

      case 'expenses': {
        columns = [t(lang, 'التاريخ', 'Date'), t(lang, 'المصروف', 'Libellé'), t(lang, 'التصنيف', 'Catégorie'), t(lang, 'المسؤول', 'Par'), t(lang, 'المبلغ', 'Montant')];
        rows = validExpenses.map((e) => [e.date.slice(0, 10), e.name, getExpenseCategoryLabel(e.category, lang), e.userName, e.amount.toFixed(2)]);
        summary = [{ label: t(lang, 'إجمالي المصاريف', 'Total dépenses'), value: formatMoney(validExpenses.reduce((s, e) => s + e.amount, 0), cur) }];
        break;
      }

      case 'cash_register': {
        const cashInSales = validCustPays.reduce((s, p) => s + p.amount, 0);
        const cashOutPurchases = validSupPays.reduce((s, p) => s + p.amount, 0);
        const cashOutExpenses = validExpenses.reduce((s, e) => s + e.amount, 0);
        const cashOutReturnRefunds = saleReturns
          .filter((r) => inRange(r.date))
          .reduce(
            (s, r) =>
              s +
              (r.cashRefund !== undefined
                ? r.cashRefund
                : r.refundMethod === 'cash'
                  ? r.totalAmount
                  : 0),
            0
          );
        const netCash = cashInSales - cashOutPurchases - cashOutExpenses - cashOutReturnRefunds;
        columns = [t(lang, 'البند المالي', 'Flux de caisse'), t(lang, 'المبلغ', 'Montant')];
        rows = [
          [t(lang, 'المقبوضات من المبيعات والزبناء', 'Encaissements ventes & clients'), `+${cashInSales.toFixed(2)}`],
          [t(lang, 'استردادات نقدية للمرتجعات', 'Remboursements espèces retours'), `-${cashOutReturnRefunds.toFixed(2)}`],
          [t(lang, 'المدفوعات للمشتريات والموردين', 'Décaissements achats & fournisseurs'), `-${cashOutPurchases.toFixed(2)}`],
          [t(lang, 'المصاريف التشغيلية المدفوعة', 'Dépenses opérationnelles'), `-${cashOutExpenses.toFixed(2)}`],
          [t(lang, 'صافي رصيد الصندوق للفترة', 'Solde net de caisse'), netCash.toFixed(2)],
        ];
        summary = [{ label: t(lang, 'صافي الصندوق', 'Solde Caisse'), value: formatMoney(netCash, cur) }];
        break;
      }

      case 'period_comparison': {
        const effectiveTo = dateTo || toLocalIsoDate(new Date());
        const effectiveFrom =
          dateFrom ||
          toLocalIsoDate(new Date(new Date(effectiveTo).getTime() - 30 * 86400000));
        const startMs = new Date(effectiveFrom).getTime();
        const endMs = new Date(effectiveTo).getTime();
        const span = Math.max(86400000, endMs - startMs);
        const prevStart = toLocalIsoDate(new Date(startMs - span));
        const prevEnd = effectiveFrom;
        const curSalesList = sales.filter(
          (s) => s.status !== 'cancelled' && s.date.slice(0, 10) >= effectiveFrom && s.date.slice(0, 10) <= effectiveTo
        );
        const prevSales = sales.filter(
          (s) => s.status !== 'cancelled' && s.date.slice(0, 10) >= prevStart && s.date.slice(0, 10) < prevEnd
        );
        const curRev = curSalesList.reduce((s, x) => s + x.total, 0);
        const prevRev = prevSales.reduce((s, x) => s + x.total, 0);
        columns = [t(lang, 'المؤشر', 'Indicateur'), t(lang, 'الفترة السابقة', 'Période préc.'), t(lang, 'الفترة المختارة', 'Période choisie'), t(lang, 'الفرق', 'Écart')];
        rows = [
          [t(lang, 'إجمالي المبيعات', 'Chiffre d’affaires'), prevRev.toFixed(2), curRev.toFixed(2), (curRev - prevRev).toFixed(2)],
          [t(lang, 'عدد الفواتير', 'Nb Factures'), prevSales.length, curSalesList.length, curSalesList.length - prevSales.length],
        ];
        break;
      }
    }

    const q = search.trim().toLowerCase();
    const filteredRows = q
      ? rows.filter((row) => row.some((cell) => String(cell).toLowerCase().includes(q)))
      : rows;

    return { columns, rows: filteredRows, summary };
  }, [
    selectedReport,
    sales,
    saleReturns,
    purchases,
    expenses,
    custPayments,
    supPayments,
    products,
    categories,
    customers,
    suppliers,
    movements,
    dateFrom,
    dateTo,
    search,
    lang,
    cur,
  ]);

  const activeTitle = REPORT_LIST.find((r) => r.key === selectedReport);
  const reportLabel = activeTitle ? (lang === 'ar' ? activeTitle.ar : activeTitle.fr) : '';
  const groupReports = REPORT_LIST.filter((r) => r.group === activeTab);

  const handleExportExcel = () => {
    if (!reportData.rows.length) {
      notify(t(lang, 'لا توجد بيانات للتصدير', 'Aucune donnée à exporter'), 'warning');
      return;
    }
    exportRowsToExcel(
      reportData.rows.map((r) => {
        const obj: Record<string, string | number> = {};
        reportData.columns.forEach((col, i) => {
          obj[col] = r[i] ?? '';
        });
        return obj;
      }),
      selectedReport,
      `${selectedReport}_${dateFrom || 'all'}_${dateTo || 'all'}.xlsx`
    );
    notify(t(lang, 'تم تصدير ملف Excel بنجاح', 'Fichier Excel exporté avec succès'));
  };

  const handleExportPdf = () => {
    exportTableToPdf(
      reportLabel,
      dateFrom || dateTo ? `${dateFrom || '...'} → ${dateTo || '...'}` : t(lang, 'كل الفترات', 'Toutes périodes'),
      reportData.columns,
      reportData.rows,
      `${selectedReport}.pdf`
    );
  };

  const renderBlankRows = (currentCount: number, colCount: number) => {
    const emptyCount = Math.max(0, MIN_SHEET_ROWS - currentCount);
    return Array.from({ length: emptyCount }).map((_, idx) => (
      <tr key={`blank-${idx}`} className="h-[31px] bg-white">
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
              { id: 'sales', ar: 'تقارير المبيعات', fr: 'Rapports ventes' },
              { id: 'stock', ar: 'المشتريات والمخزون', fr: 'Achats & Stock' },
              { id: 'finance', ar: 'الديون والصندوق', fr: 'Dettes & Caisse' },
              ...(canViewProfits
                ? ([{ id: 'profits', ar: 'تقارير الأرباح (COGS)', fr: 'Profits (COGS)' }] as const)
                : []),
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

      {activeTab === 'profits' ? (
        canViewProfits ? (
          <ProfitReportsModule embedded />
        ) : (
          <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center text-sm font-bold text-red-800">
            {t(lang, 'ليس لديك صلاحية الاطلاع على تقارير الأرباح والهوامش', 'Accès refusé aux rapports de bénéfices')}
          </div>
        )
      ) : (
        <>
          {/* Search + 6 Quick Period Buttons + Date Range (Exact Inventory Style) */}
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 bg-white px-2 py-2 rounded-lg border border-slate-200 shadow-xs">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="pointer-events-none absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-slate-500" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t(lang, 'بحث داخل التقرير...', 'Rechercher dans le rapport...')}
                className="w-full rounded-lg border-[1.5px] border-slate-900 bg-white py-2 ps-9 pe-8 text-xs sm:text-sm font-bold text-slate-950 placeholder:text-slate-600 focus:border-[#0B274D] focus:outline-none"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute top-1/2 -translate-y-1/2 end-2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-800"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {QUICK_PERIODS.map((p) => {
                const isActive = activePeriod === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleSelectQuickPeriod(p.id)}
                    className={`rounded-lg border-[1.5px] px-2.5 sm:px-3.5 py-2 text-xs sm:text-[13px] font-bold transition-colors whitespace-nowrap shrink-0 ${
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

            <div className="flex items-center gap-1.5 shrink-0">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => handleManualDateFrom(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-mono tabular-nums text-slate-800 focus:border-slate-900 focus:outline-none"
              />
              <input
                type="date"
                value={dateTo}
                onChange={(e) => handleManualDateTo(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-mono tabular-nums text-slate-800 focus:border-slate-900 focus:outline-none"
              />
              {(dateFrom || dateTo) && (
                <button
                  type="button"
                  onClick={clearDateFilter}
                  title={t(lang, 'عرض كل الفترات', 'Toutes les dates')}
                  className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-slate-50 p-2 text-slate-700 hover:bg-slate-200"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Specific Report Selector Strip */}
          <div className="flex flex-wrap items-center gap-1.5 bg-white px-2 py-1.5 rounded-lg border border-slate-200">
            {groupReports.map((r) => {
              const isSelected = selectedReport === r.key;
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setSelectedReport(r.key)}
                  className={`rounded-lg border-[1.5px] px-3 py-1.5 text-xs font-bold transition-colors whitespace-nowrap ${
                    isSelected
                      ? 'border-[#0B274D] bg-[#FCE08B] text-slate-950 shadow-xs'
                      : 'border-slate-300 bg-slate-50 text-slate-800 hover:border-slate-900 hover:bg-white'
                  }`}
                >
                  {lang === 'ar' ? r.ar : r.fr}
                </button>
              );
            })}
          </div>

          {/* Summary KPI Strip (if report has summary metrics) */}
          {reportData.summary.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {reportData.summary.map((s, i) => (
                <div key={i} className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
                  <div className="bg-[#FEF3C7] border-b border-slate-900 px-3 py-1 text-[11px] font-extrabold text-slate-900">
                    {s.label}
                  </div>
                  <div className="px-3 py-2 font-mono text-base font-black text-slate-950 tabular-nums">
                    {s.value}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Full-Width Golden-Header Spreadsheet Report Table */}
          <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
            <div className="bg-[#0B274D] text-[#FDE68A] px-3 py-2 flex items-center justify-between text-xs font-extrabold">
              <span>{reportLabel}</span>
              <span className="font-mono tabular-nums text-white">
                {reportData.rows.length} {t(lang, 'سطر', 'lignes')}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-[#FCE08B] text-slate-950">
                    {reportData.columns.map((c, i) => (
                      <th key={i} className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reportData.rows.map((row, idx) => (
                    <tr key={idx} className="h-[31px] hover:bg-amber-50/50 transition-colors">
                      {row.map((cell, cIdx) => (
                        <td
                          key={cIdx}
                          className={`border border-slate-800/80 px-2.5 py-1 font-mono tabular-nums ${
                            cIdx === 0 ? 'font-bold text-slate-950 text-start' : 'text-center text-slate-800'
                          }`}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {renderBlankRows(reportData.rows.length, Math.max(1, reportData.columns.length))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Utility Footer Bar (Excel / PDF / Print) */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-0.5 text-xs text-slate-600">
            <span className="font-mono tabular-nums">
              {dateFrom || dateTo
                ? `${t(lang, 'الفترة المحددة:', 'Période :')} ${dateFrom || '...'} — ${dateTo || '...'}`
                : t(lang, 'عرض جميع الفترات المسجلة', 'Toutes les périodes enregistrées')}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleExportExcel}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-800 hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5 text-emerald-700" />
                Excel
              </button>
              <button
                type="button"
                onClick={handleExportPdf}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-800 hover:bg-slate-50"
              >
                <FileDown className="h-3.5 w-3.5 text-amber-700" />
                PDF
              </button>
              <button
                type="button"
                onClick={() =>
                  openPrint({
                    type: 'generic_report',
                    title: reportLabel,
                    subtitle:
                      dateFrom || dateTo
                        ? `${dateFrom || '...'} → ${dateTo || '...'}`
                        : t(lang, 'كل الفترات', 'Toutes périodes'),
                    columns: reportData.columns,
                    rows: reportData.rows,
                    summaryItems: reportData.summary,
                  })
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B274D] px-3.5 py-1.5 text-xs font-bold text-white hover:bg-[#133A6E]"
              >
                <Printer className="h-3.5 w-3.5 text-[#F4BE42]" />
                {t(lang, 'طباعة التقرير', 'Imprimer')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
