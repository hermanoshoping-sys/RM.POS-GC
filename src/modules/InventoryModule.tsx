import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ClipboardCheck, Download, Printer, RotateCcw, Search, Wrench, X } from 'lucide-react';
import { db } from '../db/database';
import { adjustProductStock } from '../db/operations';
import { useApp } from '../context/AppContext';
import { Product } from '../types';
import { formatDateTime, formatMoney, t } from '../i18n/translations';
import { exportRowsToExcel } from '../utils/export';

export type InventoryTabId = 'sold_log' | 'sold_stock' | 'remaining' | 'purchased_log';

type QuickPeriodId =
  | 'all'
  | 'today'
  | 'this_week'
  | 'this_month'
  | 'last_month'
  | 'this_year'
  | 'last_year'
  | 'custom';

interface InventoryModuleProps {
  activeTab?: InventoryTabId;
  onTabChange?: (tab: InventoryTabId) => void;
}

const MIN_SHEET_ROWS = 18;

const toLocalIsoDate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const getQuickPeriodRange = (period: Exclude<QuickPeriodId, 'all' | 'custom'>): { from: string; to: string } => {
  const now = new Date();
  const today = toLocalIsoDate(now);

  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'this_week': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const diffToMonday = (start.getDay() + 6) % 7;
      start.setDate(start.getDate() - diffToMonday);
      return { from: toLocalIsoDate(start), to: today };
    }
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: toLocalIsoDate(start), to: today };
    }
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: toLocalIsoDate(start), to: toLocalIsoDate(end) };
    }
    case 'this_year': {
      const start = new Date(now.getFullYear(), 0, 1);
      return { from: toLocalIsoDate(start), to: today };
    }
    case 'last_year': {
      const start = new Date(now.getFullYear() - 1, 0, 1);
      const end = new Date(now.getFullYear() - 1, 11, 31);
      return { from: toLocalIsoDate(start), to: toLocalIsoDate(end) };
    }
  }
};

const QUICK_PERIODS: { id: Exclude<QuickPeriodId, 'all' | 'custom'>; ar: string; fr: string }[] = [
  { id: 'today', ar: 'اليوم', fr: "Aujourd'hui" },
  { id: 'this_week', ar: 'هذا الاسبوع', fr: 'Cette semaine' },
  { id: 'this_month', ar: 'هذا الشهر', fr: 'Ce mois' },
  { id: 'last_month', ar: 'الشهر الماضي', fr: 'Mois dernier' },
  { id: 'this_year', ar: 'هذه السنة', fr: 'Cette année' },
  { id: 'last_year', ar: 'السنة الماضية', fr: 'Année dernière' },
];

export const InventoryModule: React.FC<InventoryModuleProps> = ({
  activeTab: controlledTab,
  onTabChange,
}) => {
  const { lang, settings, currentUser, notify, openPrint } = useApp();
  const cur = settings.storeInfo.currency || 'MAD';

  const [internalTab, setInternalTab] = useState<InventoryTabId>('sold_log');
  const activeTab = controlledTab ?? internalTab;
  const setActiveTab = (tab: InventoryTabId) => {
    if (onTabChange) onTabChange(tab);
    else setInternalTab(tab);
  };

  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const saleInvoices = useLiveQuery(() => db.saleInvoices.toArray(), []) ?? [];
  const purchaseInvoices = useLiveQuery(() => db.purchaseInvoices.toArray(), []) ?? [];
  const stockMovements = useLiveQuery(() => db.stockMovements.orderBy('date').reverse().toArray(), []) ?? [];

  // Shared filters
  const [search, setSearch] = useState('');
  const [activePeriod, setActivePeriod] = useState<QuickPeriodId>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [stockFilter, setStockFilter] = useState<'all' | 'out' | 'low' | 'near_expiry' | 'expired' | 'movements'>('all');

  // Stocktake / Adjustment / Damage Modal
  const [adjustProduct, setAdjustProduct] = useState<Product | null>(null);
  const [adjustMode, setAdjustMode] = useState<'stocktake' | 'damage' | 'loss'>('stocktake');
  const [adjustVal, setAdjustVal] = useState<number>(0);
  const [adjustNote, setAdjustNote] = useState('');

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

  // 8.1 Sold items log
  const soldLogRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows: {
      date: string;
      productName: string;
      barcode: string;
      invoiceNumber: string;
      customerName: string;
      quantity: number;
      unitPrice: number;
      costPrice: number;
      profit: number;
      sellerName: string;
    }[] = [];

    saleInvoices
      .filter((s) => s.status !== 'cancelled')
      .forEach((inv) => {
        const d = inv.date.slice(0, 10);
        if (dateFrom && d < dateFrom) return;
        if (dateTo && d > dateTo) return;
        inv.items.forEach((it) => {
          const netQty = Math.max(0, it.quantity - (it.returnedQty ?? 0));
          if (netQty <= 0) return;
          if (
            q &&
            !it.productName.toLowerCase().includes(q) &&
            !it.barcode.toLowerCase().includes(q) &&
            !inv.invoiceNumber.toLowerCase().includes(q) &&
            !inv.customerName.toLowerCase().includes(q)
          ) {
            return;
          }
          rows.push({
            date: inv.date,
            productName: it.productName,
            barcode: it.barcode,
            invoiceNumber: inv.invoiceNumber,
            customerName: inv.customerName,
            quantity: netQty,
            unitPrice: it.unitPrice,
            costPrice: it.costPrice,
            profit: netQty * (it.unitPrice - it.costPrice) - (it.discount || 0),
            sellerName: inv.sellerName,
          });
        });
      });

    return rows.sort((a, b) => b.date.localeCompare(a.date));
  }, [saleInvoices, search, dateFrom, dateTo]);

  const soldLogTotals = useMemo(
    () =>
      soldLogRows.reduce(
        (acc, r) => ({
          qty: acc.qty + r.quantity,
          sales: acc.sales + r.quantity * r.unitPrice,
          cost: acc.cost + r.quantity * r.costPrice,
          profit: acc.profit + r.profit,
        }),
        { qty: 0, sales: 0, cost: 0, profit: 0 }
      ),
    [soldLogRows]
  );

  // 8.2 Aggregated Sold Products
  const soldStockRows = useMemo(() => {
    const map = new Map<
      number,
      {
        productId: number;
        productName: string;
        barcode: string;
        qtySold: number;
        salesValue: number;
        costValue: number;
        grossProfit: number;
      }
    >();

    saleInvoices
      .filter((s) => s.status !== 'cancelled')
      .forEach((inv) => {
        const d = inv.date.slice(0, 10);
        if (dateFrom && d < dateFrom) return;
        if (dateTo && d > dateTo) return;
        inv.items.forEach((it) => {
          const netQty = Math.max(0, it.quantity - (it.returnedQty ?? 0));
          if (netQty <= 0) return;
          const curEntry = map.get(it.productId) ?? {
            productId: it.productId,
            productName: it.productName,
            barcode: it.barcode,
            qtySold: 0,
            salesValue: 0,
            costValue: 0,
            grossProfit: 0,
          };
          curEntry.qtySold += netQty;
          curEntry.salesValue += netQty * it.unitPrice;
          curEntry.costValue += netQty * it.costPrice;
          curEntry.grossProfit += netQty * (it.unitPrice - it.costPrice) - (it.discount || 0);
          map.set(it.productId, curEntry);
        });
      });

    const q = search.trim().toLowerCase();
    return Array.from(map.values())
      .filter((r) => !q || r.productName.toLowerCase().includes(q) || r.barcode.toLowerCase().includes(q))
      .sort((a, b) => b.qtySold - a.qtySold);
  }, [saleInvoices, search, dateFrom, dateTo]);

  const soldStockTotals = useMemo(
    () =>
      soldStockRows.reduce(
        (acc, r) => ({
          qty: acc.qty + r.qtySold,
          sales: acc.sales + r.salesValue,
          cost: acc.cost + r.costValue,
          profit: acc.profit + r.grossProfit,
        }),
        { qty: 0, sales: 0, cost: 0, profit: 0 }
      ),
    [soldStockRows]
  );

  // 8.3 Remaining stock analysis
  const remainingStats = useMemo(() => {
    const today = toLocalIsoDate(new Date());
    const plus30 = toLocalIsoDate(new Date(Date.now() + 30 * 86400000));

    const outOfStock = products.filter((p) => p.quantity <= 0);
    const lowStock = products.filter((p) => p.quantity > 0 && p.quantity <= p.minStock);
    const expired = products.filter((p) => p.expiryDate && p.expiryDate < today);
    const nearExpiry = products.filter(
      (p) => p.expiryDate && p.expiryDate >= today && p.expiryDate <= plus30
    );

    const q = search.trim().toLowerCase();
    const list = products.filter((p) => {
      if (q && !p.name.toLowerCase().includes(q) && !p.barcode.toLowerCase().includes(q)) return false;
      if (stockFilter === 'out') return p.quantity <= 0;
      if (stockFilter === 'low') return p.quantity > 0 && p.quantity <= p.minStock;
      if (stockFilter === 'expired') return Boolean(p.expiryDate && p.expiryDate < today);
      if (stockFilter === 'near_expiry')
        return Boolean(p.expiryDate && p.expiryDate >= today && p.expiryDate <= plus30);
      return true;
    });

    const filteredQty = list.reduce((s, p) => s + Math.max(0, p.quantity), 0);
    const filteredValue = list.reduce((s, p) => s + Math.max(0, p.quantity) * p.purchasePrice, 0);
    const totalValue = products.reduce((s, p) => s + Math.max(0, p.quantity) * p.purchasePrice, 0);

    return { outOfStock, lowStock, expired, nearExpiry, totalValue, filteredQty, filteredValue, list };
  }, [products, search, stockFilter]);

  const filteredMovements = useMemo(() => {
    const q = search.trim().toLowerCase();
    return stockMovements
      .filter((m) => {
        const d = m.date.slice(0, 10);
        if (dateFrom && d < dateFrom) return false;
        if (dateTo && d > dateTo) return false;
        if (
          q &&
          !m.productName.toLowerCase().includes(q) &&
          !m.referenceNumber.toLowerCase().includes(q) &&
          !(m.note ?? '').toLowerCase().includes(q)
        ) {
          return false;
        }
        return true;
      })
      .slice(0, 200);
  }, [stockMovements, search, dateFrom, dateTo]);

  // 8.4 Purchased items log
  const purchasedLogRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows: {
      date: string;
      productName: string;
      barcode: string;
      invoiceNumber: string;
      supplierName: string;
      quantity: number;
      unitCost: number;
      total: number;
      userName: string;
    }[] = [];

    purchaseInvoices
      .filter((p) => p.status !== 'cancelled')
      .forEach((inv) => {
        const d = inv.date.slice(0, 10);
        if (dateFrom && d < dateFrom) return;
        if (dateTo && d > dateTo) return;
        inv.items.forEach((it) => {
          if (
            q &&
            !it.productName.toLowerCase().includes(q) &&
            !it.barcode.toLowerCase().includes(q) &&
            !inv.invoiceNumber.toLowerCase().includes(q) &&
            !inv.supplierName.toLowerCase().includes(q)
          ) {
            return;
          }
          rows.push({
            date: inv.date,
            productName: it.productName,
            barcode: it.barcode,
            invoiceNumber: inv.invoiceNumber,
            supplierName: inv.supplierName,
            quantity: it.quantity,
            unitCost: it.unitCost,
            total: it.total,
            userName: inv.userName,
          });
        });
      });

    return rows.sort((a, b) => b.date.localeCompare(a.date));
  }, [purchaseInvoices, search, dateFrom, dateTo]);

  const purchasedLogTotals = useMemo(
    () =>
      purchasedLogRows.reduce(
        (acc, r) => ({
          qty: acc.qty + r.quantity,
          total: acc.total + r.total,
        }),
        { qty: 0, total: 0 }
      ),
    [purchasedLogRows]
  );

  const handleSaveAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustProduct || !currentUser) return;
    try {
      if (adjustMode === 'stocktake') {
        await adjustProductStock(
          adjustProduct.id!,
          'adjustment',
          adjustVal,
          true,
          adjustNote || 'جرد وتسوية فروقات المخزون',
          currentUser
        );
      } else {
        await adjustProductStock(
          adjustProduct.id!,
          adjustMode,
          -Math.abs(adjustVal),
          false,
          adjustNote || (adjustMode === 'damage' ? 'منتج تالف' : 'منتج مفقود'),
          currentUser
        );
      }
      notify(t(lang, 'تم تحديث المخزون وتسجيل الحركة بنجاح', 'Stock ajusté avec succès'));
      setAdjustProduct(null);
      setAdjustNote('');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handlePrintCurrentView = () => {
    const periodSubtitle =
      dateFrom || dateTo
        ? `${dateFrom || '...'} ← ${dateTo || '...'}`
        : t(lang, 'كل الفترات', 'Toutes périodes');

    if (activeTab === 'sold_log') {
      openPrint({
        type: 'generic_report',
        title: t(lang, 'سجل المنتجات المباعة', 'Journal des produits vendus'),
        subtitle: `${periodSubtitle} · ${soldLogRows.length} ${t(lang, 'سطر', 'lignes')}`,
        summaryItems: [
          { label: t(lang, 'إجمالي الكمية', 'Total Qté'), value: String(Number(soldLogTotals.qty.toFixed(2))) },
          { label: t(lang, 'إجمالي المبيعات', 'Total Ventes'), value: formatMoney(soldLogTotals.sales, cur) },
          { label: t(lang, 'إجمالي الشراء', 'Total Coût'), value: formatMoney(soldLogTotals.cost, cur) },
          { label: t(lang, 'إجمالي الربح', 'Total Profit'), value: formatMoney(soldLogTotals.profit, cur) },
        ],
        columns: [
          t(lang, 'التاريخ', 'Date'),
          t(lang, 'المنتج', 'Produit'),
          t(lang, 'الباركود', 'Code-barres'),
          t(lang, 'الزبون', 'Client'),
          t(lang, 'رقم الفاتورة', 'Facture'),
          t(lang, 'الكمية', 'Qté'),
          t(lang, 'ثمن البيع', 'Prix vente'),
          t(lang, 'ثمن الشراء', 'Prix achat'),
          t(lang, 'الربح', 'Profit'),
          t(lang, 'البائع', 'Vendeur'),
        ],
        rows: soldLogRows.map((r) => [
          formatDateTime(r.date, lang),
          r.productName,
          r.barcode || '—',
          r.customerName,
          r.invoiceNumber,
          r.quantity,
          r.unitPrice.toFixed(2),
          r.costPrice.toFixed(2),
          r.profit.toFixed(2),
          r.sellerName,
        ]),
      });
      return;
    }

    if (activeTab === 'sold_stock') {
      openPrint({
        type: 'generic_report',
        title: t(lang, 'مخزون المنتجات المباعة', 'Stock des produits vendus'),
        subtitle: `${periodSubtitle} · ${soldStockRows.length} ${t(lang, 'منتج', 'produits')}`,
        summaryItems: [
          { label: t(lang, 'الكمية المباعة', 'Qté vendue'), value: String(Number(soldStockTotals.qty.toFixed(2))) },
          { label: t(lang, 'قيمة المبيعات', 'CA Ventes'), value: formatMoney(soldStockTotals.sales, cur) },
          { label: t(lang, 'إجمالي التكلفة', 'Coût total'), value: formatMoney(soldStockTotals.cost, cur) },
          { label: t(lang, 'الربح الإجمالي', 'Profit brut'), value: formatMoney(soldStockTotals.profit, cur) },
        ],
        columns: [
          t(lang, 'المنتج', 'Produit'),
          t(lang, 'الباركود', 'Code-barres'),
          t(lang, 'الكمية المباعة', 'Qté vendue'),
          t(lang, 'قيمة المبيعات', 'CA Ventes'),
          t(lang, 'إجمالي التكلفة', 'Coût total'),
          t(lang, 'الربح الإجمالي', 'Profit brut'),
        ],
        rows: soldStockRows.map((r) => [
          r.productName,
          r.barcode || '—',
          r.qtySold,
          r.salesValue.toFixed(2),
          r.costValue.toFixed(2),
          r.grossProfit.toFixed(2),
        ]),
      });
      return;
    }

    if (activeTab === 'purchased_log') {
      openPrint({
        type: 'generic_report',
        title: t(lang, 'سجل المنتجات المشتراة', 'Journal des produits achetés'),
        subtitle: `${periodSubtitle} · ${purchasedLogRows.length} ${t(lang, 'سطر', 'lignes')}`,
        summaryItems: [
          { label: t(lang, 'إجمالي الكمية', 'Total Qté'), value: String(Number(purchasedLogTotals.qty.toFixed(2))) },
          { label: t(lang, 'إجمالي المشتريات', 'Total Achats'), value: formatMoney(purchasedLogTotals.total, cur) },
        ],
        columns: [
          t(lang, 'التاريخ', 'Date'),
          t(lang, 'المنتج', 'Produit'),
          t(lang, 'الباركود', 'Code-barres'),
          t(lang, 'المورد', 'Fournisseur'),
          t(lang, 'رقم الفاتورة', 'Facture'),
          t(lang, 'الكمية', 'Qté'),
          t(lang, 'ثمن الشراء', 'Prix achat'),
          t(lang, 'الإجمالي', 'Total'),
          t(lang, 'المستخدم', 'Utilisateur'),
        ],
        rows: purchasedLogRows.map((r) => [
          formatDateTime(r.date, lang),
          r.productName,
          r.barcode || '—',
          r.supplierName,
          r.invoiceNumber,
          r.quantity,
          r.unitCost.toFixed(2),
          r.total.toFixed(2),
          r.userName,
        ]),
      });
      return;
    }

    openPrint({
      type: 'generic_report',
      title: t(lang, 'تقرير مخزون المنتجات المتبقية', 'Rapport du stock restant'),
      subtitle: `${toLocalIsoDate(new Date())} · ${remainingStats.list.length} ${t(lang, 'منتج', 'produits')}`,
      summaryItems: [
        { label: t(lang, 'قيمة المخزون', 'Valeur stock'), value: formatMoney(remainingStats.filteredValue, cur) },
        { label: t(lang, 'منتجات نافدة', 'Ruptures'), value: String(remainingStats.outOfStock.length) },
        { label: t(lang, 'منخفضة المخزون', 'Stock faible'), value: String(remainingStats.lowStock.length) },
        { label: t(lang, 'قريبة الصلاحية', 'Proche exp.'), value: String(remainingStats.nearExpiry.length) },
      ],
      columns: [
        t(lang, 'المنتج', 'Produit'),
        t(lang, 'الباركود', 'Code-barres'),
        t(lang, 'المتوفر', 'Stock'),
        t(lang, 'الحد الأدنى', 'Min'),
        t(lang, 'ثمن الشراء', 'Coût'),
        t(lang, 'ثمن البيع', 'Vente'),
        t(lang, 'قيمة المخزون', 'Valeur'),
        t(lang, 'الصلاحية', 'Expiration'),
      ],
      rows: remainingStats.list.map((p) => [
        p.name,
        p.barcode || '—',
        p.quantity,
        p.minStock,
        p.purchasePrice.toFixed(2),
        p.salePrice.toFixed(2),
        (Math.max(0, p.quantity) * p.purchasePrice).toFixed(2),
        p.expiryDate || '—',
      ]),
    });
  };

  const handleExportCurrentExcel = () => {
    if (activeTab === 'sold_log') {
      if (!soldLogRows.length) {
        notify(t(lang, 'لا توجد بيانات للتصدير', 'Aucune donnée à exporter'), 'warning');
        return;
      }
      exportRowsToExcel(
        soldLogRows.map((r) => ({
          [t(lang, 'التاريخ', 'Date')]: formatDateTime(r.date, lang),
          [t(lang, 'المنتج', 'Produit')]: r.productName,
          [t(lang, 'الباركود', 'Code-barres')]: r.barcode,
          [t(lang, 'الزبون', 'Client')]: r.customerName,
          [t(lang, 'رقم الفاتورة', 'N° Facture')]: r.invoiceNumber,
          [t(lang, 'الكمية', 'Qté')]: r.quantity,
          [t(lang, 'ثمن البيع', 'Prix vente')]: r.unitPrice,
          [t(lang, 'ثمن الشراء', 'Prix achat')]: r.costPrice,
          [t(lang, 'الربح', 'Profit')]: Number(r.profit.toFixed(2)),
          [t(lang, 'البائع', 'Vendeur')]: r.sellerName,
        })),
        'SoldLog',
        'sold_products_log.xlsx'
      );
    } else if (activeTab === 'sold_stock') {
      if (!soldStockRows.length) {
        notify(t(lang, 'لا توجد بيانات للتصدير', 'Aucune donnée à exporter'), 'warning');
        return;
      }
      exportRowsToExcel(
        soldStockRows.map((r) => ({
          [t(lang, 'المنتج', 'Produit')]: r.productName,
          [t(lang, 'الباركود', 'Code-barres')]: r.barcode,
          [t(lang, 'الكمية المباعة', 'Qté vendue')]: r.qtySold,
          [t(lang, 'قيمة المبيعات', 'CA Ventes')]: Number(r.salesValue.toFixed(2)),
          [t(lang, 'إجمالي التكلفة', 'Coût total')]: Number(r.costValue.toFixed(2)),
          [t(lang, 'الربح الإجمالي', 'Profit brut')]: Number(r.grossProfit.toFixed(2)),
        })),
        'SoldStock',
        'sold_products_stock.xlsx'
      );
    } else if (activeTab === 'purchased_log') {
      if (!purchasedLogRows.length) {
        notify(t(lang, 'لا توجد بيانات للتصدير', 'Aucune donnée à exporter'), 'warning');
        return;
      }
      exportRowsToExcel(
        purchasedLogRows.map((r) => ({
          [t(lang, 'التاريخ', 'Date')]: formatDateTime(r.date, lang),
          [t(lang, 'المنتج', 'Produit')]: r.productName,
          [t(lang, 'الباركود', 'Code-barres')]: r.barcode,
          [t(lang, 'المورد', 'Fournisseur')]: r.supplierName,
          [t(lang, 'رقم الفاتورة', 'N° Facture')]: r.invoiceNumber,
          [t(lang, 'الكمية', 'Qté')]: r.quantity,
          [t(lang, 'ثمن الشراء', 'Prix achat')]: r.unitCost,
          [t(lang, 'الإجمالي', 'Total')]: Number(r.total.toFixed(2)),
          [t(lang, 'المستخدم', 'Utilisateur')]: r.userName,
        })),
        'PurchasedLog',
        'purchased_products_log.xlsx'
      );
    } else {
      if (!remainingStats.list.length) {
        notify(t(lang, 'لا توجد بيانات للتصدير', 'Aucune donnée à exporter'), 'warning');
        return;
      }
      exportRowsToExcel(
        remainingStats.list.map((p) => ({
          [t(lang, 'المنتج', 'Produit')]: p.name,
          [t(lang, 'الباركود', 'Code-barres')]: p.barcode,
          [t(lang, 'المتوفر', 'Stock')]: p.quantity,
          [t(lang, 'الحد الأدنى', 'Min')]: p.minStock,
          [t(lang, 'ثمن الشراء', 'Prix achat')]: p.purchasePrice,
          [t(lang, 'ثمن البيع', 'Prix vente')]: p.salePrice,
          [t(lang, 'قيمة المخزون', 'Valeur')]: Number((Math.max(0, p.quantity) * p.purchasePrice).toFixed(2)),
          [t(lang, 'الصلاحية', 'Expiration')]: p.expiryDate || '',
        })),
        'RemainingStock',
        'remaining_stock.xlsx'
      );
    }
    notify(t(lang, 'تم تصدير ملف Excel بنجاح', 'Fichier Excel exporté avec succès'));
  };

  const renderBlankRows = (currentCount: number, colCount: number) => {
    const emptyCount = Math.max(0, MIN_SHEET_ROWS - currentCount);
    return Array.from({ length: emptyCount }).map((_, idx) => (
      <tr key={`blank-${idx}`} className={`h-[31px] bg-white ${idx >= 3 ? 'hidden sm:table-row' : ''}`}>
        {Array.from({ length: colCount }).map((__, colIdx) => (
          <td key={colIdx} className="border border-slate-800/80 px-2 py-1" />
        ))}
      </tr>
    ));
  };

  const showDatePeriodControls = activeTab !== 'remaining' || stockFilter === 'movements';

  return (
    <div className="space-y-2.5">
      {/* Fallback sub-tab switcher when InventoryModule is mounted standalone without App.tsx props */}
      {!controlledTab && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {(
            [
              { id: 'sold_log', ar: 'سجل المنتجات المباعة', fr: 'Journal vendus' },
              { id: 'sold_stock', ar: 'مخزون المنتجات المباعة', fr: 'Stock vendus' },
              { id: 'remaining', ar: 'مخزون المنتجات المتبقية', fr: 'Stock restant' },
              { id: 'purchased_log', ar: 'سجل المنتجات المشتراة', fr: 'Journal achetés' },
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

      {/* Search + Quick Date Period Buttons + Date Range Row */}
      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 bg-white px-2 py-2 rounded-lg border border-slate-200 shadow-xs">
        {/* Search Input (Right in RTL) */}
        <div className="relative w-full sm:flex-1 sm:min-w-[200px]">
          <Search className="pointer-events-none absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t(lang, 'بحث باسم المنتج أو الباركود', 'Rechercher par produit ou code-barres')}
            className="w-full rounded-lg border-[1.5px] border-slate-900 bg-white py-2 ps-9 pe-8 text-xs sm:text-sm font-bold text-slate-950 placeholder:text-slate-600 focus:border-[#0B274D] focus:outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label={t(lang, 'مسح البحث', 'Effacer')}
              className="absolute top-1/2 -translate-y-1/2 end-2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-800"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Period Filter Buttons & Date Pickers (for sold_log, sold_stock, purchased_log, movements) */}
        {showDatePeriodControls ? (
          <>
            <div className="flex flex-nowrap sm:flex-wrap items-center gap-1.5 overflow-x-auto no-scrollbar w-full sm:w-auto pb-0.5 sm:pb-0">
              {QUICK_PERIODS.map((p) => {
                const isActive = activePeriod === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleSelectQuickPeriod(p.id)}
                    className={`min-h-[36px] rounded-lg border-[1.5px] px-2.5 sm:px-3.5 py-1.5 sm:py-2 text-xs sm:text-[13px] font-bold transition-colors whitespace-nowrap shrink-0 ${
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

            <div className="grid grid-cols-2 sm:flex sm:items-center gap-1.5 w-full sm:w-auto shrink-0">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => handleManualDateFrom(e.target.value)}
                title={t(lang, 'من تاريخ', 'Du')}
                className="w-full sm:w-auto rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-mono tabular-nums text-slate-800 focus:border-slate-900 focus:outline-none"
              />
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => handleManualDateTo(e.target.value)}
                  title={t(lang, 'إلى تاريخ', 'Au')}
                  className="w-full sm:w-auto flex-1 rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-mono tabular-nums text-slate-800 focus:border-slate-900 focus:outline-none"
                />
                {(dateFrom || dateTo) && (
                  <button
                    type="button"
                    onClick={clearDateFilter}
                    title={t(lang, 'عرض كل الفترات', 'Toutes les dates')}
                    className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-slate-50 p-2 text-slate-700 hover:bg-slate-200 transition-colors shrink-0"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          </>
        ) : null}

        {/* Remaining Stock Status Filter Buttons */}
        {activeTab === 'remaining' && (
          <div className="flex flex-nowrap sm:flex-wrap items-center gap-1.5 overflow-x-auto no-scrollbar w-full sm:w-auto pb-0.5 sm:pb-0">
            {(
              [
                { id: 'all', ar: `الكل (${products.length})`, fr: `Tout (${products.length})` },
                { id: 'out', ar: `نافدة (${remainingStats.outOfStock.length})`, fr: `Rupture (${remainingStats.outOfStock.length})` },
                { id: 'low', ar: `منخفضة (${remainingStats.lowStock.length})`, fr: `Faible (${remainingStats.lowStock.length})` },
                { id: 'near_expiry', ar: `قريبة الصلاحية (${remainingStats.nearExpiry.length})`, fr: `Proche exp. (${remainingStats.nearExpiry.length})` },
                { id: 'expired', ar: `منتهية (${remainingStats.expired.length})`, fr: `Expirés (${remainingStats.expired.length})` },
                { id: 'movements', ar: 'سجل الدخول والخروج', fr: 'Mouvements' },
              ] as const
            ).map((f) => {
              const isActive = stockFilter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setStockFilter(f.id)}
                  className={`min-h-[36px] rounded-lg border-[1.5px] px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${
                    isActive
                      ? 'border-[#0B274D] bg-[#FCE08B] text-slate-950 shadow-xs'
                      : 'border-slate-900 bg-white text-slate-900 hover:bg-slate-100'
                  }`}
                >
                  {lang === 'ar' ? f.ar : f.fr}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 8.1 Sold Products Log — Exact 10-Column Spreadsheet Table Matching Mockup */}
      {activeTab === 'sold_log' && (
        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-[#FCE08B] text-slate-950">
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[125px]">
                    {t(lang, 'التاريخ', 'Date')}
                  </th>
                  <th className="border border-slate-900 px-3 py-2 text-center font-extrabold min-w-[220px]">
                    {t(lang, 'المنتج', 'Produit')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[130px]">
                    {t(lang, 'الباركود', 'Code-barres')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap min-w-[130px]">
                    {t(lang, 'الزبون', 'Client')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[115px]">
                    {t(lang, 'رقم الفاتورة', 'N° Facture')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[85px]">
                    {t(lang, 'الكمية', 'Qté')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[95px]">
                    {t(lang, 'ثمن البيع', 'Prix vente')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[95px]">
                    {t(lang, 'ثمن الشراء', 'Prix achat')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[105px]">
                    {t(lang, 'الربح', 'Profit')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap min-w-[115px]">
                    {t(lang, 'البائع', 'Vendeur')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {soldLogRows.map((r, i) => (
                  <tr key={`${r.invoiceNumber}-${r.barcode}-${i}`} className="h-[31px] hover:bg-amber-50/50 transition-colors">
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-slate-700 whitespace-nowrap">
                      {formatDateTime(r.date, lang)}
                    </td>
                    <td className="border border-slate-800/80 px-2.5 py-1 font-bold text-slate-950">
                      {r.productName}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-slate-700">
                      {r.barcode || '—'}
                    </td>
                    <td className="border border-slate-800/80 px-2.5 py-1 text-center text-slate-800 font-medium">
                      {r.customerName}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-slate-900 font-semibold">
                      {r.invoiceNumber}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold tabular-nums text-slate-950">
                      {r.quantity}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-semibold tabular-nums text-slate-900">
                      {r.unitPrice.toFixed(2)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono tabular-nums text-slate-700">
                      {r.costPrice.toFixed(2)}
                    </td>
                    <td
                      className={`border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums ${
                        r.profit >= 0 ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {r.profit.toFixed(2)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center text-slate-700">
                      {r.sellerName}
                    </td>
                  </tr>
                ))}
                {renderBlankRows(soldLogRows.length, 10)}
              </tbody>
              <tfoot>
                <tr className="bg-[#FEF3C7] text-slate-950 font-extrabold text-xs">
                  <td colSpan={5} className="border border-slate-900 px-3 py-2 text-start">
                    {t(lang, `المجموع (${soldLogRows.length} سجل)`, `Total (${soldLogRows.length} lignes)`)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {Number(soldLogTotals.qty.toFixed(2))}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {soldLogTotals.sales.toFixed(2)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {soldLogTotals.cost.toFixed(2)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums text-emerald-800">
                    {formatMoney(soldLogTotals.profit, cur)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2" />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* 8.2 Sold Products Stock Summary — Matching Spreadsheet Style */}
      {activeTab === 'sold_stock' && (
        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-[#FCE08B] text-slate-950">
                  <th className="border border-slate-900 px-3 py-2 text-center font-extrabold min-w-[230px]">
                    {t(lang, 'المنتج', 'Produit')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[140px]">
                    {t(lang, 'الباركود', 'Code-barres')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[110px]">
                    {t(lang, 'الكمية المباعة', 'Qté vendue')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[125px]">
                    {t(lang, 'قيمة المبيعات', 'CA Ventes')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[125px]">
                    {t(lang, 'إجمالي التكلفة', 'Coût total')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[130px]">
                    {t(lang, 'الربح الإجمالي', 'Profit brut')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[130px]">
                    {t(lang, 'معدل الحركة', 'Rotation')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {soldStockRows.map((r) => (
                  <tr key={r.productId} className="h-[31px] hover:bg-amber-50/50 transition-colors">
                    <td className="border border-slate-800/80 px-2.5 py-1 font-bold text-slate-950">
                      {r.productName}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-slate-700">
                      {r.barcode || '—'}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums text-slate-950">
                      {Number(r.qtySold.toFixed(2))}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-semibold tabular-nums text-slate-900">
                      {r.salesValue.toFixed(2)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono tabular-nums text-slate-700">
                      {r.costValue.toFixed(2)}
                    </td>
                    <td
                      className={`border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums ${
                        r.grossProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {formatMoney(r.grossProfit, cur)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-semibold">
                      {r.qtySold >= 10 ? (
                        <span className="text-emerald-700">{t(lang, 'سريع الحركة', 'Rapide')}</span>
                      ) : (
                        <span className="text-slate-600">{t(lang, 'متوسط / بطيء', 'Normale')}</span>
                      )}
                    </td>
                  </tr>
                ))}
                {renderBlankRows(soldStockRows.length, 7)}
              </tbody>
              <tfoot>
                <tr className="bg-[#FEF3C7] text-slate-950 font-extrabold text-xs">
                  <td colSpan={2} className="border border-slate-900 px-3 py-2 text-start">
                    {t(lang, `المجموع (${soldStockRows.length} منتج)`, `Total (${soldStockRows.length} produits)`)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {Number(soldStockTotals.qty.toFixed(2))}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {formatMoney(soldStockTotals.sales, cur)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {formatMoney(soldStockTotals.cost, cur)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums text-emerald-800">
                    {formatMoney(soldStockTotals.profit, cur)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2" />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* 8.3 Remaining Stock — Matching Spreadsheet Style */}
      {activeTab === 'remaining' && stockFilter !== 'movements' && (
        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-[#FCE08B] text-slate-950">
                  <th className="border border-slate-900 px-3 py-2 text-center font-extrabold min-w-[220px]">
                    {t(lang, 'المنتج', 'Produit')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[135px]">
                    {t(lang, 'الباركود', 'Code-barres')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[105px]">
                    {t(lang, 'المتوفر', 'Stock dispo')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[85px]">
                    {t(lang, 'الحد الأدنى', 'Seuil min')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[95px]">
                    {t(lang, 'ثمن الشراء', 'Prix achat')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[95px]">
                    {t(lang, 'ثمن البيع', 'Prix vente')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[120px]">
                    {t(lang, 'قيمة المخزون', 'Valeur stock')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[110px]">
                    {t(lang, 'الصلاحية', 'Expiration')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[110px]">
                    {t(lang, 'جرد / تسوية', 'Ajuster')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {remainingStats.list.map((p) => (
                  <tr key={p.id} className="h-[31px] hover:bg-amber-50/50 transition-colors">
                    <td className="border border-slate-800/80 px-2.5 py-1 font-bold text-slate-950">
                      {p.name}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-slate-700">
                      {p.barcode || '—'}
                    </td>
                    <td
                      className={`border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums ${
                        p.quantity <= 0
                          ? 'bg-red-50 text-red-700'
                          : p.quantity <= p.minStock
                            ? 'bg-amber-50 text-amber-800'
                            : 'text-slate-950'
                      }`}
                    >
                      {p.quantity} {p.unit}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono tabular-nums text-slate-600">
                      {p.minStock}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono tabular-nums text-slate-800">
                      {p.purchasePrice.toFixed(2)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-semibold tabular-nums text-slate-950">
                      {p.salePrice.toFixed(2)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold tabular-nums text-teal-800">
                      {formatMoney(Math.max(0, p.quantity) * p.purchasePrice, cur)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-slate-700">
                      {p.expiryDate || '—'}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-0.5 text-center">
                      <button
                        type="button"
                        onClick={() => {
                          setAdjustProduct(p);
                          setAdjustMode('stocktake');
                          setAdjustVal(p.quantity);
                          setAdjustNote('');
                        }}
                        className="inline-flex items-center gap-1 rounded border border-slate-800 bg-white px-2 py-0.5 text-[11px] font-bold text-slate-900 hover:bg-[#FCE08B] transition-colors whitespace-nowrap"
                      >
                        <ClipboardCheck className="h-3 w-3 text-teal-800" />
                        {t(lang, 'جرد / تالف', 'Ajuster')}
                      </button>
                    </td>
                  </tr>
                ))}
                {renderBlankRows(remainingStats.list.length, 9)}
              </tbody>
              <tfoot>
                <tr className="bg-[#FEF3C7] text-slate-950 font-extrabold text-xs">
                  <td colSpan={2} className="border border-slate-900 px-3 py-2 text-start">
                    {t(lang, `المجموع (${remainingStats.list.length} منتج)`, `Total (${remainingStats.list.length} produits)`)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {Number(remainingStats.filteredQty.toFixed(2))}
                  </td>
                  <td colSpan={3} className="border border-slate-900 px-2 py-2 text-center text-[11px] text-slate-700">
                    {t(
                      lang,
                      `نافدة: ${remainingStats.outOfStock.length} · منخفضة: ${remainingStats.lowStock.length} · قريبة الصلاحية: ${remainingStats.nearExpiry.length}`,
                      `Ruptures: ${remainingStats.outOfStock.length} · Faibles: ${remainingStats.lowStock.length} · Proche exp.: ${remainingStats.nearExpiry.length}`
                    )}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums text-teal-900">
                    {formatMoney(remainingStats.filteredValue, cur)}
                  </td>
                  <td colSpan={2} className="border border-slate-900 px-2 py-2" />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* 8.3 Movements Ledger Sub-view — Matching Spreadsheet Style */}
      {activeTab === 'remaining' && stockFilter === 'movements' && (
        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-[#FCE08B] text-slate-950">
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[130px]">
                    {t(lang, 'التاريخ', 'Date')}
                  </th>
                  <th className="border border-slate-900 px-3 py-2 text-center font-extrabold min-w-[210px]">
                    {t(lang, 'المنتج', 'Produit')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[150px]">
                    {t(lang, 'النوع / المرجع', 'Type / Réf')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[90px]">
                    {t(lang, 'التغيير', 'Delta')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[115px]">
                    {t(lang, 'قبل ← بعد', 'Avant → Après')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold min-w-[180px]">
                    {t(lang, 'المستخدم / ملاحظة', 'Utilisateur / Note')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredMovements.map((m) => (
                  <tr key={m.id} className="h-[31px] hover:bg-amber-50/50 transition-colors">
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-slate-700 whitespace-nowrap">
                      {formatDateTime(m.date, lang)}
                    </td>
                    <td className="border border-slate-800/80 px-2.5 py-1 font-bold text-slate-950">
                      {m.productName}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] text-slate-700">
                      {m.type} · {m.referenceNumber}
                    </td>
                    <td
                      className={`border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums ${
                        m.quantityDelta >= 0 ? 'text-emerald-700 bg-emerald-50/60' : 'text-red-700 bg-red-50/60'
                      }`}
                    >
                      {m.quantityDelta > 0 ? '+' : ''}
                      {m.quantityDelta}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono tabular-nums text-slate-700">
                      {m.beforeQty} → <strong className="text-slate-950">{m.afterQty}</strong>
                    </td>
                    <td className="border border-slate-800/80 px-2.5 py-1 text-slate-700">
                      {m.userName} {m.note ? `· ${m.note}` : ''}
                    </td>
                  </tr>
                ))}
                {renderBlankRows(filteredMovements.length, 6)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 8.4 Purchased Products Log — Matching Spreadsheet Style */}
      {activeTab === 'purchased_log' && (
        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-[#FCE08B] text-slate-950">
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[125px]">
                    {t(lang, 'التاريخ', 'Date')}
                  </th>
                  <th className="border border-slate-900 px-3 py-2 text-center font-extrabold min-w-[220px]">
                    {t(lang, 'المنتج', 'Produit')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[130px]">
                    {t(lang, 'الباركود', 'Code-barres')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap min-w-[140px]">
                    {t(lang, 'المورد', 'Fournisseur')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[120px]">
                    {t(lang, 'رقم الفاتورة', 'N° Facture')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[90px]">
                    {t(lang, 'الكمية', 'Qté')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[105px]">
                    {t(lang, 'ثمن الشراء', 'Prix achat')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[120px]">
                    {t(lang, 'الإجمالي', 'Total')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap min-w-[115px]">
                    {t(lang, 'المستخدم', 'Utilisateur')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {purchasedLogRows.map((r, i) => (
                  <tr key={`${r.invoiceNumber}-${r.barcode}-${i}`} className="h-[31px] hover:bg-amber-50/50 transition-colors">
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-slate-700 whitespace-nowrap">
                      {formatDateTime(r.date, lang)}
                    </td>
                    <td className="border border-slate-800/80 px-2.5 py-1 font-bold text-slate-950">
                      {r.productName}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-slate-700">
                      {r.barcode || '—'}
                    </td>
                    <td className="border border-slate-800/80 px-2.5 py-1 text-center font-medium text-slate-800">
                      {r.supplierName}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] font-semibold tabular-nums text-slate-900">
                      {r.invoiceNumber}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold tabular-nums text-emerald-800">
                      {r.quantity}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono tabular-nums text-slate-800">
                      {r.unitCost.toFixed(2)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums text-slate-950">
                      {formatMoney(r.total, cur)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center text-slate-700">
                      {r.userName}
                    </td>
                  </tr>
                ))}
                {renderBlankRows(purchasedLogRows.length, 9)}
              </tbody>
              <tfoot>
                <tr className="bg-[#FEF3C7] text-slate-950 font-extrabold text-xs">
                  <td colSpan={5} className="border border-slate-900 px-3 py-2 text-start">
                    {t(lang, `المجموع (${purchasedLogRows.length} سجل)`, `Total (${purchasedLogRows.length} lignes)`)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {Number(purchasedLogTotals.qty.toFixed(2))}
                  </td>
                  <td className="border border-slate-900 px-2 py-2" />
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {formatMoney(purchasedLogTotals.total, cur)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2" />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Compact Utility Footer Bar (Print & Excel Export) */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-0.5 text-xs text-slate-600">
        <div>
          {dateFrom || dateTo ? (
            <span className="font-mono tabular-nums">
              {t(lang, 'الفترة المحددة:', 'Période :')} {dateFrom || '...'} — {dateTo || '...'}
            </span>
          ) : (
            <span>
              {t(
                lang,
                `إجمالي قيمة المخزون الحالي: ${formatMoney(remainingStats.totalValue, cur)}`,
                `Valeur totale du stock actuel : ${formatMoney(remainingStats.totalValue, cur)}`
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExportCurrentExcel}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-800 hover:bg-slate-50 transition-colors"
          >
            <Download className="h-3.5 w-3.5 text-emerald-700" />
            {t(lang, 'تصدير Excel', 'Exporter Excel')}
          </button>
          <button
            type="button"
            onClick={handlePrintCurrentView}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B274D] px-3.5 py-1.5 text-xs font-bold text-white hover:bg-[#133A6E] transition-colors"
          >
            <Printer className="h-3.5 w-3.5 text-[#F4BE42]" />
            {t(lang, 'طباعة الجدول', 'Imprimer')}
          </button>
        </div>
      </div>

      {/* Stocktake / Variance / Damage / Loss Modal */}
      {adjustProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleSaveAdjustment}
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl space-y-4"
          >
            <div className="flex items-center gap-2">
              <Wrench className="h-4 w-4 text-teal-700" />
              <h3 className="text-base font-bold text-slate-900">
                {t(lang, 'جرد وتسوية المخزون / تالف ومفقود', 'Inventaire / Perte / Avarie')}
              </h3>
            </div>
            <p className="text-xs text-slate-600">
              <strong>{adjustProduct.name}</strong> — {t(lang, 'الكمية المسجلة حالياً:', 'Stock actuel :')}{' '}
              <span className="font-mono font-bold">{adjustProduct.quantity}</span>
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'نوع العملية', 'Type d’opération')}
              </label>
              <select
                value={adjustMode}
                onChange={(e) => {
                  const m = e.target.value as 'stocktake' | 'damage' | 'loss';
                  setAdjustMode(m);
                  setAdjustVal(m === 'stocktake' ? adjustProduct.quantity : 1);
                }}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
              >
                <option value="stocktake">{t(lang, 'جرد فعلي وتسوية فروقات المخزون', 'Inventaire physique (nouvelle qté)')}</option>
                <option value="damage">{t(lang, 'تسجيل كمية تالفة / منتهية الصلاحية', 'Enregistrer une avarie / périmé')}</option>
                <option value="loss">{t(lang, 'تسجيل كمية مفقودة', 'Enregistrer une perte')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {adjustMode === 'stocktake'
                  ? t(lang, 'الكمية الفعلية الجديدة بعد الجرد', 'Quantité réelle comptée')
                  : t(lang, 'الكمية التالفة أو المفقودة (تخصم من المخزون)', 'Quantité à déduire')}
              </label>
              <input
                type="number"
                step="0.1"
                min="0"
                required
                value={adjustVal}
                onChange={(e) => setAdjustVal(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'الملاحظة / السبب', 'Motif / Note')}
              </label>
              <input
                required
                value={adjustNote}
                onChange={(e) => setAdjustNote(e.target.value)}
                placeholder={t(lang, 'مثال: جرد شهري أو علبة تالفة', 'Ex: Inventaire mensuel')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAdjustProduct(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs"
              >
                {t(lang, 'إلغاء', 'Annuler')}
              </button>
              <button
                type="submit"
                className="rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800"
              >
                {t(lang, 'حفظ التسوية', 'Valider')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
