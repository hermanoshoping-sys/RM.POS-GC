import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Download,
  Edit2,
  Eye,
  FolderTree,
  Plus,
  Printer,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { db } from '../db/database';
import { logAudit } from '../db/operations';
import { useApp } from '../context/AppContext';
import { Category } from '../types';
import { formatMoney, t } from '../i18n/translations';
import { exportRowsToExcel } from '../utils/export';

export type CategoryTabId = 'list' | 'sales_stats' | 'stock_summary' | 'category_products';

type QuickPeriodId =
  | 'all'
  | 'today'
  | 'this_week'
  | 'this_month'
  | 'last_month'
  | 'this_year'
  | 'last_year'
  | 'custom';

interface CategoriesModuleProps {
  activeTab?: CategoryTabId;
  onTabChange?: (tab: CategoryTabId) => void;
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

export const CategoriesModule: React.FC<CategoriesModuleProps> = ({
  activeTab: controlledTab,
  onTabChange,
}) => {
  const { lang, settings, currentUser, notify, openPrint, requestGuardedAction } = useApp();
  const cur = settings.storeInfo.currency || 'MAD';

  const [internalTab, setInternalTab] = useState<CategoryTabId>('list');
  const activeTab = controlledTab ?? internalTab;
  const setActiveTab = (tab: CategoryTabId) => {
    if (onTabChange) onTabChange(tab);
    else setInternalTab(tab);
  };

  const categories = useLiveQuery(() => db.categories.orderBy('sortOrder').toArray(), []) ?? [];
  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const saleInvoices = useLiveQuery(() => db.saleInvoices.toArray(), []) ?? [];

  // Shared & Tab-specific filters
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'root' | 'sub' | 'with_products' | 'empty'>('all');
  const [sortBy, setSortBy] = useState<'order' | 'name' | 'count' | 'stock_value'>('order');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('all');

  // Period filters for Sales & Profit tab
  const [activePeriod, setActivePeriod] = useState<QuickPeriodId>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Modal state
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [form, setForm] = useState({
    nameAr: '',
    nameFr: '',
    parentId: '' as string,
    icon: 'package',
    imageUrl: '',
    description: '',
    sortOrder: 1,
  });

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

  // Enriched categories with stock stats
  const enrichedCategories = useMemo(() => {
    return categories.map((cat) => {
      const catProducts = products.filter((p) => p.categoryId === cat.id);
      const parent = categories.find((c) => c.id === cat.parentId) ?? null;
      const childrenCount = categories.filter((c) => c.parentId === cat.id).length;
      const totalStockQty = catProducts.reduce((s, p) => s + Math.max(0, p.quantity), 0);
      const stockCostValue = catProducts.reduce((s, p) => s + Math.max(0, p.quantity) * p.purchasePrice, 0);
      const stockRetailValue = catProducts.reduce((s, p) => s + Math.max(0, p.quantity) * p.salePrice, 0);
      const outOfStockCount = catProducts.filter((p) => p.quantity <= 0).length;
      const lowStockCount = catProducts.filter((p) => p.quantity > 0 && p.quantity <= p.minStock).length;

      return {
        ...cat,
        parent,
        childrenCount,
        productCount: catProducts.length,
        totalStockQty,
        stockCostValue,
        stockRetailValue,
        expectedProfit: stockRetailValue - stockCostValue,
        outOfStockCount,
        lowStockCount,
      };
    });
  }, [categories, products]);

  // Tab 1 & 3 filtered categories
  const filteredCategories = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = enrichedCategories.filter((c) => {
      const matchQ =
        !q ||
        c.nameAr.toLowerCase().includes(q) ||
        c.nameFr.toLowerCase().includes(q) ||
        (c.description ?? '').toLowerCase().includes(q);
      const matchType =
        filterType === 'all'
          ? true
          : filterType === 'root'
            ? c.parentId === null
            : filterType === 'sub'
              ? c.parentId !== null
              : filterType === 'with_products'
                ? c.productCount > 0
                : c.productCount === 0;
      return matchQ && matchType;
    });

    return [...list].sort((a, b) => {
      if (sortBy === 'name') {
        return lang === 'ar' ? a.nameAr.localeCompare(b.nameAr) : a.nameFr.localeCompare(b.nameFr);
      }
      if (sortBy === 'count') return b.productCount - a.productCount;
      if (sortBy === 'stock_value') return b.stockCostValue - a.stockCostValue;
      return a.sortOrder - b.sortOrder;
    });
  }, [enrichedCategories, search, filterType, sortBy, lang]);

  const listTotals = useMemo(
    () =>
      filteredCategories.reduce(
        (acc, c) => ({
          products: acc.products + c.productCount,
          qty: acc.qty + c.totalStockQty,
          costValue: acc.costValue + c.stockCostValue,
          retailValue: acc.retailValue + c.stockRetailValue,
          expectedProfit: acc.expectedProfit + c.expectedProfit,
          outOfStock: acc.outOfStock + c.outOfStockCount,
          lowStock: acc.lowStock + c.lowStockCount,
        }),
        { products: 0, qty: 0, costValue: 0, retailValue: 0, expectedProfit: 0, outOfStock: 0, lowStock: 0 }
      ),
    [filteredCategories]
  );

  // Tab 2: Sales & Profit performance per category (with date period filtering)
  const categorySalesRows = useMemo(() => {
    const prodCategoryMap = new Map<number, number | null>();
    products.forEach((p) => prodCategoryMap.set(p.id!, p.categoryId ?? null));

    const statsMap = new Map<
      number | 'uncategorized',
      {
        key: number | 'uncategorized';
        nameAr: string;
        nameFr: string;
        productCount: number;
        qtySold: number;
        salesValue: number;
        costValue: number;
        profit: number;
      }
    >();

    categories.forEach((c) => {
      statsMap.set(c.id!, {
        key: c.id!,
        nameAr: c.nameAr,
        nameFr: c.nameFr,
        productCount: products.filter((p) => p.categoryId === c.id).length,
        qtySold: 0,
        salesValue: 0,
        costValue: 0,
        profit: 0,
      });
    });

    saleInvoices
      .filter((inv) => inv.status !== 'cancelled')
      .forEach((inv) => {
        const d = inv.date.slice(0, 10);
        if (dateFrom && d < dateFrom) return;
        if (dateTo && d > dateTo) return;
        inv.items.forEach((it) => {
          const netQty = Math.max(0, it.quantity - (it.returnedQty ?? 0));
          if (netQty <= 0) return;
          const catId = prodCategoryMap.get(it.productId) ?? null;
          const key: number | 'uncategorized' = catId !== null && statsMap.has(catId) ? catId : 'uncategorized';
          let entry = statsMap.get(key);
          if (!entry) {
            entry = {
              key: 'uncategorized',
              nameAr: 'بدون عائلة',
              nameFr: 'Sans famille',
              productCount: products.filter((p) => !p.categoryId).length,
              qtySold: 0,
              salesValue: 0,
              costValue: 0,
              profit: 0,
            };
            statsMap.set('uncategorized', entry);
          }
          entry.qtySold += netQty;
          entry.salesValue += netQty * it.unitPrice - (it.discount || 0);
          entry.costValue += netQty * it.costPrice;
          entry.profit += netQty * (it.unitPrice - it.costPrice) - (it.discount || 0);
        });
      });

    const q = search.trim().toLowerCase();
    const list = Array.from(statsMap.values()).filter(
      (r) => !q || r.nameAr.toLowerCase().includes(q) || r.nameFr.toLowerCase().includes(q)
    );
    const totalSalesAll = list.reduce((s, r) => s + r.salesValue, 0);

    return list
      .map((r) => ({
        ...r,
        marginPct: r.salesValue > 0 ? (r.profit / r.salesValue) * 100 : 0,
        sharePct: totalSalesAll > 0 ? (r.salesValue / totalSalesAll) * 100 : 0,
      }))
      .sort((a, b) => b.salesValue - a.salesValue || b.qtySold - a.qtySold);
  }, [categories, products, saleInvoices, dateFrom, dateTo, search]);

  const categorySalesTotals = useMemo(
    () =>
      categorySalesRows.reduce(
        (acc, r) => ({
          products: acc.products + r.productCount,
          qty: acc.qty + r.qtySold,
          sales: acc.sales + r.salesValue,
          cost: acc.cost + r.costValue,
          profit: acc.profit + r.profit,
        }),
        { products: 0, qty: 0, sales: 0, cost: 0, profit: 0 }
      ),
    [categorySalesRows]
  );

  // Tab 4: Products belonging to selected category (or all)
  const categoryNameMap = useMemo(() => {
    const m = new Map<number, string>();
    categories.forEach((c) => m.set(c.id!, lang === 'ar' ? c.nameAr : c.nameFr));
    return m;
  }, [categories, lang]);

  const categoryProductsRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products
      .filter((p) => {
        const matchCat =
          selectedCategoryId === 'all'
            ? true
            : selectedCategoryId === 'none'
              ? !p.categoryId
              : String(p.categoryId ?? '') === selectedCategoryId;
        const catName = p.categoryId ? (categoryNameMap.get(p.categoryId) ?? '').toLowerCase() : '';
        const matchQ =
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.barcode.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q) ||
          catName.includes(q);
        return matchCat && matchQ;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products, selectedCategoryId, search, categoryNameMap]);

  const categoryProductsTotals = useMemo(
    () =>
      categoryProductsRows.reduce(
        (acc, p) => ({
          qty: acc.qty + Math.max(0, p.quantity),
          value: acc.value + Math.max(0, p.quantity) * p.purchasePrice,
        }),
        { qty: 0, value: 0 }
      ),
    [categoryProductsRows]
  );

  // CRUD handlers
  const openNew = () => {
    setEditing(null);
    setForm({
      nameAr: '',
      nameFr: '',
      parentId: '',
      icon: 'package',
      imageUrl: '',
      description: '',
      sortOrder: categories.length + 1,
    });
    setShowForm(true);
  };

  const openEdit = (cat: Category) => {
    setEditing(cat);
    setForm({
      nameAr: cat.nameAr,
      nameFr: cat.nameFr,
      parentId: cat.parentId ? String(cat.parentId) : '',
      icon: cat.icon || 'package',
      imageUrl: cat.imageUrl || '',
      description: cat.description || '',
      sortOrder: cat.sortOrder,
    });
    setShowForm(true);
  };

  const openCategoryProducts = (catId: number) => {
    setSelectedCategoryId(String(catId));
    setSearch('');
    setActiveTab('category_products');
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setForm((prev) => ({ ...prev, imageUrl: reader.result as string }));
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.nameAr.trim()) return;
    const parentIdNum = form.parentId ? Number(form.parentId) : null;
    if (editing?.id && parentIdNum === editing.id) {
      notify(t(lang, 'لا يمكن ربط العائلة بنفسها كعائلة رئيسية', 'Parent invalide'), 'error');
      return;
    }

    if (editing?.id) {
      await db.categories.update(editing.id, {
        nameAr: form.nameAr.trim(),
        nameFr: form.nameFr.trim() || form.nameAr.trim(),
        parentId: parentIdNum,
        icon: form.icon,
        imageUrl: form.imageUrl,
        description: form.description.trim(),
        sortOrder: Number(form.sortOrder) || 1,
      });
      if (currentUser) {
        await logAudit(currentUser, 'CATEGORY_UPDATED', 'category', editing.id, `تعديل عائلة: ${form.nameAr}`);
      }
      notify(t(lang, 'تم تحديث العائلة بنجاح', 'Famille mise à jour'));
    } else {
      const id = await db.categories.add({
        nameAr: form.nameAr.trim(),
        nameFr: form.nameFr.trim() || form.nameAr.trim(),
        parentId: parentIdNum,
        icon: form.icon,
        imageUrl: form.imageUrl,
        description: form.description.trim(),
        sortOrder: Number(form.sortOrder) || categories.length + 1,
        createdAt: new Date().toISOString(),
      });
      if (currentUser) {
        await logAudit(currentUser, 'CATEGORY_CREATED', 'category', id, `إضافة عائلة جديدة: ${form.nameAr}`);
      }
      notify(t(lang, 'تمت إضافة العائلة بنجاح', 'Famille ajoutée'));
    }
    setShowForm(false);
  };

  const handleDelete = (cat: (typeof enrichedCategories)[number]) => {
    if (cat.productCount > 0 || cat.childrenCount > 0) {
      notify(
        t(
          lang,
          'لا يمكن حذف عائلة تحتوي على منتجات أو عائلات فرعية (حذف العائلات غير المستخدمة فقط)',
          'Impossible de supprimer une famille utilisée'
        ),
        'error'
      );
      return;
    }
    requestGuardedAction({
      title: t(lang, 'تأكيد حذف العائلة', 'Supprimer la famille'),
      description: t(lang, `هل تريد حذف العائلة "${cat.nameAr}"؟`, `Supprimer "${cat.nameFr}" ?`),
      isSensitiveDelete: true,
      onConfirm: async () => {
        await db.categories.delete(cat.id!);
        if (currentUser) {
          await logAudit(currentUser, 'CATEGORY_DELETED', 'category', cat.id!, `حذف عائلة: ${cat.nameAr}`);
        }
        notify(t(lang, 'تم حذف العائلة', 'Famille supprimée'));
      },
    });
  };

  // Print & Excel Export for all 4 tabs
  const handlePrintCurrentView = () => {
    const periodSubtitle =
      dateFrom || dateTo
        ? `${dateFrom || '...'} ← ${dateTo || '...'}`
        : t(lang, 'كل الفترات', 'Toutes périodes');

    if (activeTab === 'list') {
      openPrint({
        type: 'generic_report',
        title: t(lang, 'لائحة عائلات المنتجات', 'Liste des familles de produits'),
        subtitle: `${toLocalIsoDate(new Date())} · ${filteredCategories.length} ${t(lang, 'عائلة', 'familles')}`,
        summaryItems: [
          { label: t(lang, 'عدد العائلات', 'Familles'), value: String(filteredCategories.length) },
          { label: t(lang, 'إجمالي المنتجات', 'Produits'), value: String(listTotals.products) },
          { label: t(lang, 'إجمالي المخزون', 'Stock total'), value: String(Number(listTotals.qty.toFixed(2))) },
          { label: t(lang, 'قيمة المخزون', 'Valeur stock'), value: formatMoney(listTotals.costValue, cur) },
        ],
        columns: [
          '#',
          t(lang, 'العائلة (عربي)', 'Famille (AR)'),
          t(lang, 'العائلة (فرنسي)', 'Famille (FR)'),
          t(lang, 'النوع', 'Type'),
          t(lang, 'المنتجات', 'Produits'),
          t(lang, 'المخزون', 'Stock'),
          t(lang, 'قيمة المخزون', 'Valeur'),
          t(lang, 'الوصف', 'Description'),
        ],
        rows: filteredCategories.map((c) => [
          c.sortOrder,
          c.nameAr,
          c.nameFr,
          c.parent ? (lang === 'ar' ? c.parent.nameAr : c.parent.nameFr) : t(lang, 'رئيسية', 'Principale'),
          c.productCount,
          Number(c.totalStockQty.toFixed(2)),
          c.stockCostValue.toFixed(2),
          c.description || '—',
        ]),
      });
      return;
    }

    if (activeTab === 'sales_stats') {
      openPrint({
        type: 'generic_report',
        title: t(lang, 'تقرير مبيعات وأرباح عائلات المنتجات', 'Ventes & Profits par famille'),
        subtitle: `${periodSubtitle} · ${categorySalesRows.length} ${t(lang, 'عائلة', 'familles')}`,
        summaryItems: [
          { label: t(lang, 'الكمية المباعة', 'Qté vendue'), value: String(Number(categorySalesTotals.qty.toFixed(2))) },
          { label: t(lang, 'إجمالي المبيعات', 'Total Ventes'), value: formatMoney(categorySalesTotals.sales, cur) },
          { label: t(lang, 'إجمالي التكلفة', 'Coût total'), value: formatMoney(categorySalesTotals.cost, cur) },
          { label: t(lang, 'الربح الصافي', 'Profit net'), value: formatMoney(categorySalesTotals.profit, cur) },
        ],
        columns: [
          t(lang, 'العائلة', 'Famille'),
          t(lang, 'عدد المنتجات', 'Produits'),
          t(lang, 'الكمية المباعة', 'Qté vendue'),
          t(lang, 'إجمالي المبيعات', 'Ventes'),
          t(lang, 'إجمالي التكلفة', 'Coût'),
          t(lang, 'الربح الصافي', 'Profit'),
          t(lang, 'الهامش %', 'Marge %'),
          t(lang, 'النسبة %', 'Part %'),
        ],
        rows: categorySalesRows.map((r) => [
          lang === 'ar' ? r.nameAr : r.nameFr,
          r.productCount,
          Number(r.qtySold.toFixed(2)),
          r.salesValue.toFixed(2),
          r.costValue.toFixed(2),
          r.profit.toFixed(2),
          `${r.marginPct.toFixed(1)}%`,
          `${r.sharePct.toFixed(1)}%`,
        ]),
      });
      return;
    }

    if (activeTab === 'stock_summary') {
      openPrint({
        type: 'generic_report',
        title: t(lang, 'تقرير مخزون عائلات المنتجات', 'Stock par famille de produits'),
        subtitle: `${toLocalIsoDate(new Date())} · ${filteredCategories.length} ${t(lang, 'عائلة', 'familles')}`,
        summaryItems: [
          { label: t(lang, 'قيمة الشراء', 'Valeur achat'), value: formatMoney(listTotals.costValue, cur) },
          { label: t(lang, 'قيمة البيع', 'Valeur vente'), value: formatMoney(listTotals.retailValue, cur) },
          { label: t(lang, 'الربح المتوقع', 'Profit estimé'), value: formatMoney(listTotals.expectedProfit, cur) },
          { label: t(lang, 'نواقص', 'Alertes'), value: `${listTotals.outOfStock} / ${listTotals.lowStock}` },
        ],
        columns: [
          t(lang, 'العائلة', 'Famille'),
          t(lang, 'المنتجات', 'Produits'),
          t(lang, 'الكمية', 'Qté'),
          t(lang, 'نافدة', 'Rupture'),
          t(lang, 'منخفضة', 'Faible'),
          t(lang, 'قيمة الشراء', 'Val. achat'),
          t(lang, 'قيمة البيع', 'Val. vente'),
          t(lang, 'الربح المتوقع', 'Profit est.'),
        ],
        rows: filteredCategories.map((c) => [
          lang === 'ar' ? c.nameAr : c.nameFr,
          c.productCount,
          Number(c.totalStockQty.toFixed(2)),
          c.outOfStockCount,
          c.lowStockCount,
          c.stockCostValue.toFixed(2),
          c.stockRetailValue.toFixed(2),
          c.expectedProfit.toFixed(2),
        ]),
      });
      return;
    }

    openPrint({
      type: 'generic_report',
      title: t(lang, 'منتجات العائلة', 'Produits de la famille'),
      subtitle: `${toLocalIsoDate(new Date())} · ${categoryProductsRows.length} ${t(lang, 'منتج', 'produits')}`,
      summaryItems: [
        { label: t(lang, 'عدد المنتجات', 'Produits'), value: String(categoryProductsRows.length) },
        { label: t(lang, 'إجمالي الكمية', 'Qté totale'), value: String(Number(categoryProductsTotals.qty.toFixed(2))) },
        { label: t(lang, 'قيمة المخزون', 'Valeur stock'), value: formatMoney(categoryProductsTotals.value, cur) },
      ],
      columns: [
        t(lang, 'العائلة', 'Famille'),
        t(lang, 'المنتج', 'Produit'),
        t(lang, 'الباركود', 'Code-barres'),
        t(lang, 'المتوفر', 'Stock'),
        t(lang, 'ثمن الشراء', 'Prix achat'),
        t(lang, 'ثمن البيع', 'Prix vente'),
        t(lang, 'قيمة المخزون', 'Valeur'),
      ],
      rows: categoryProductsRows.map((p) => [
        p.categoryId ? categoryNameMap.get(p.categoryId) ?? '—' : t(lang, 'بدون عائلة', 'Sans famille'),
        p.name,
        p.barcode || '—',
        p.quantity,
        p.purchasePrice.toFixed(2),
        p.salePrice.toFixed(2),
        (Math.max(0, p.quantity) * p.purchasePrice).toFixed(2),
      ]),
    });
  };

  const handleExportCurrentExcel = () => {
    if (activeTab === 'list') {
      if (!filteredCategories.length) {
        notify(t(lang, 'لا توجد بيانات للتصدير', 'Aucune donnée à exporter'), 'warning');
        return;
      }
      exportRowsToExcel(
        filteredCategories.map((c) => ({
          [t(lang, 'الترتيب', 'Ordre')]: c.sortOrder,
          [t(lang, 'الاسم بالعربية', 'Nom AR')]: c.nameAr,
          [t(lang, 'الاسم بالفرنسية', 'Nom FR')]: c.nameFr,
          [t(lang, 'النوع', 'Type')]: c.parent
            ? `${t(lang, 'فرعية من', 'Sous')} ${lang === 'ar' ? c.parent.nameAr : c.parent.nameFr}`
            : t(lang, 'رئيسية', 'Principale'),
          [t(lang, 'عدد المنتجات', 'Produits')]: c.productCount,
          [t(lang, 'إجمالي المخزون', 'Stock total')]: Number(c.totalStockQty.toFixed(2)),
          [t(lang, 'قيمة المخزون', 'Valeur stock')]: Number(c.stockCostValue.toFixed(2)),
          [t(lang, 'الوصف', 'Description')]: c.description || '',
        })),
        'Categories',
        'categories_list.xlsx'
      );
    } else if (activeTab === 'sales_stats') {
      if (!categorySalesRows.length) {
        notify(t(lang, 'لا توجد بيانات للتصدير', 'Aucune donnée à exporter'), 'warning');
        return;
      }
      exportRowsToExcel(
        categorySalesRows.map((r) => ({
          [t(lang, 'العائلة', 'Famille')]: lang === 'ar' ? r.nameAr : r.nameFr,
          [t(lang, 'عدد المنتجات', 'Produits')]: r.productCount,
          [t(lang, 'الكمية المباعة', 'Qté vendue')]: Number(r.qtySold.toFixed(2)),
          [t(lang, 'إجمالي المبيعات', 'Ventes')]: Number(r.salesValue.toFixed(2)),
          [t(lang, 'إجمالي التكلفة', 'Coût')]: Number(r.costValue.toFixed(2)),
          [t(lang, 'الربح الصافي', 'Profit')]: Number(r.profit.toFixed(2)),
          [t(lang, 'الهامش %', 'Marge %')]: Number(r.marginPct.toFixed(1)),
          [t(lang, 'النسبة %', 'Part %')]: Number(r.sharePct.toFixed(1)),
        })),
        'CategorySales',
        'categories_sales.xlsx'
      );
    } else if (activeTab === 'stock_summary') {
      if (!filteredCategories.length) {
        notify(t(lang, 'لا توجد بيانات للتصدير', 'Aucune donnée à exporter'), 'warning');
        return;
      }
      exportRowsToExcel(
        filteredCategories.map((c) => ({
          [t(lang, 'العائلة', 'Famille')]: lang === 'ar' ? c.nameAr : c.nameFr,
          [t(lang, 'عدد المنتجات', 'Produits')]: c.productCount,
          [t(lang, 'الكمية المتوفرة', 'Stock dispo')]: Number(c.totalStockQty.toFixed(2)),
          [t(lang, 'نافدة', 'Rupture')]: c.outOfStockCount,
          [t(lang, 'منخفضة', 'Faible')]: c.lowStockCount,
          [t(lang, 'قيمة الشراء', 'Valeur achat')]: Number(c.stockCostValue.toFixed(2)),
          [t(lang, 'قيمة البيع المتوقعة', 'Valeur vente')]: Number(c.stockRetailValue.toFixed(2)),
          [t(lang, 'الربح المتوقع', 'Profit estimé')]: Number(c.expectedProfit.toFixed(2)),
        })),
        'CategoryStock',
        'categories_stock.xlsx'
      );
    } else {
      if (!categoryProductsRows.length) {
        notify(t(lang, 'لا توجد بيانات للتصدير', 'Aucune donnée à exporter'), 'warning');
        return;
      }
      exportRowsToExcel(
        categoryProductsRows.map((p) => ({
          [t(lang, 'العائلة', 'Famille')]: p.categoryId
            ? categoryNameMap.get(p.categoryId) ?? ''
            : t(lang, 'بدون عائلة', 'Sans famille'),
          [t(lang, 'المنتج', 'Produit')]: p.name,
          [t(lang, 'الباركود', 'Code-barres')]: p.barcode,
          [t(lang, 'الوحدة', 'Unité')]: p.unit,
          [t(lang, 'المتوفر', 'Stock')]: p.quantity,
          [t(lang, 'ثمن الشراء', 'Prix achat')]: p.purchasePrice,
          [t(lang, 'ثمن البيع', 'Prix vente')]: p.salePrice,
          [t(lang, 'قيمة المخزون', 'Valeur')]: Number((Math.max(0, p.quantity) * p.purchasePrice).toFixed(2)),
          [t(lang, 'الصلاحية', 'Expiration')]: p.expiryDate || '',
        })),
        'CategoryProducts',
        'category_products.xlsx'
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

  const rootCount = enrichedCategories.filter((c) => c.parentId === null).length;
  const subCount = enrichedCategories.filter((c) => c.parentId !== null).length;
  const withProductsCount = enrichedCategories.filter((c) => c.productCount > 0).length;
  const emptyCount = enrichedCategories.filter((c) => c.productCount === 0).length;

  return (
    <div className="space-y-2.5">
      {/* Fallback sub-tabs if mounted standalone */}
      {!controlledTab && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {(
            [
              { id: 'list', ar: 'لائحة العائلات', fr: 'Liste des familles' },
              { id: 'sales_stats', ar: 'مبيعات وأرباح العائلات', fr: 'Ventes & Profits' },
              { id: 'stock_summary', ar: 'مخزون العائلات', fr: 'Stock par famille' },
              { id: 'category_products', ar: 'منتجات العائلة', fr: 'Produits de la famille' },
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

      {/* Search + Contextual Filter/Period Bar */}
      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 bg-white px-2 py-2 rounded-lg border border-slate-200 shadow-xs">
        {/* Search Input */}
        <div className="relative w-full sm:flex-1 sm:min-w-[200px]">
          <Search className="pointer-events-none absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={
              activeTab === 'category_products'
                ? t(lang, 'بحث باسم المنتج أو الباركود أو العائلة', 'Rechercher par produit, code-barres ou famille')
                : t(lang, 'بحث باسم العائلة بالعربية أو الفرنسية', 'Rechercher par nom de famille (AR / FR)')
            }
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

        {/* Filter buttons for List & Stock Summary tabs */}
        {(activeTab === 'list' || activeTab === 'stock_summary') && (
          <>
            <div className="flex flex-nowrap sm:flex-wrap items-center gap-1.5 overflow-x-auto no-scrollbar w-full sm:w-auto pb-0.5 sm:pb-0">
              {(
                [
                  { id: 'all', ar: `الكل (${categories.length})`, fr: `Toutes (${categories.length})` },
                  { id: 'root', ar: `رئيسية (${rootCount})`, fr: `Principales (${rootCount})` },
                  { id: 'sub', ar: `فرعية (${subCount})`, fr: `Sous-familles (${subCount})` },
                  { id: 'with_products', ar: `بها منتجات (${withProductsCount})`, fr: `Actives (${withProductsCount})` },
                  { id: 'empty', ar: `فارغة (${emptyCount})`, fr: `Vides (${emptyCount})` },
                ] as const
              ).map((f) => {
                const isActive = filterType === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFilterType(f.id)}
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

            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'order' | 'name' | 'count' | 'stock_value')}
              className="flex-1 sm:flex-initial rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-bold text-slate-800 focus:border-slate-900 focus:outline-none"
            >
              <option value="order">{t(lang, 'الترتيب الافتراضي', 'Ordre par défaut')}</option>
              <option value="name">{t(lang, 'حسب الاسم', 'Par nom')}</option>
              <option value="count">{t(lang, 'حسب عدد المنتجات', 'Par nb produits')}</option>
              <option value="stock_value">{t(lang, 'حسب قيمة المخزون', 'Par valeur stock')}</option>
            </select>

            <button
              type="button"
              onClick={openNew}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border-[1.5px] border-teal-900 bg-teal-700 px-3.5 py-2 text-xs font-extrabold text-white hover:bg-teal-800 transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="h-4 w-4" />
              {t(lang, 'إضافة عائلة جديدة', 'Nouvelle famille')}
            </button>
          </>
        )}

        {/* 6 Quick Date Period Buttons + Date Range for Sales & Profit tab */}
        {activeTab === 'sales_stats' && (
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
        )}

        {/* Category selector for Category Products tab */}
        {activeTab === 'category_products' && (
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={selectedCategoryId}
              onChange={(e) => setSelectedCategoryId(e.target.value)}
              className="rounded-lg border-[1.5px] border-slate-900 bg-[#FCE08B]/60 px-3 py-2 text-xs font-extrabold text-slate-950 focus:border-[#0B274D] focus:outline-none"
            >
              <option value="all">{t(lang, `جميع العائلات (${products.length})`, `Toutes les familles (${products.length})`)}</option>
              {enrichedCategories.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {lang === 'ar' ? c.nameAr : c.nameFr} ({c.productCount})
                </option>
              ))}
              <option value="none">{t(lang, 'بدون عائلة', 'Sans famille')}</option>
            </select>

            <button
              type="button"
              onClick={openNew}
              className="inline-flex items-center gap-1.5 rounded-lg border-[1.5px] border-teal-900 bg-teal-700 px-3.5 py-2 text-xs font-extrabold text-white hover:bg-teal-800 transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="h-4 w-4" />
              {t(lang, 'إضافة عائلة جديدة', 'Nouvelle famille')}
            </button>
          </div>
        )}
      </div>

      {/* TAB 1: Categories Ledger Table */}
      {activeTab === 'list' && (
        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-[#FCE08B] text-slate-950">
                  <th className="border border-slate-900 px-2 py-2 text-center font-extrabold whitespace-nowrap w-[65px]">
                    {t(lang, 'الترتيب', 'Ordre')}
                  </th>
                  <th className="border border-slate-900 px-3 py-2 text-center font-extrabold min-w-[200px]">
                    {t(lang, 'العائلة (عربي)', 'Famille (AR)')}
                  </th>
                  <th className="border border-slate-900 px-3 py-2 text-center font-extrabold min-w-[170px]">
                    {t(lang, 'العائلة (فرنسي)', 'Famille (FR)')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap min-w-[130px]">
                    {t(lang, 'النوع / الرئيسية', 'Type / Parent')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[110px]">
                    {t(lang, 'عدد المنتجات', 'Produits')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[110px]">
                    {t(lang, 'إجمالي المخزون', 'Stock total')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[130px]">
                    {t(lang, 'قيمة المخزون', 'Valeur stock')}
                  </th>
                  <th className="border border-slate-900 px-3 py-2 text-center font-extrabold min-w-[180px]">
                    {t(lang, 'الوصف', 'Description')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[125px]">
                    {t(lang, 'إجراءات', 'Actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredCategories.map((cat) => (
                  <tr key={cat.id} className="h-[34px] hover:bg-amber-50/50 transition-colors">
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold tabular-nums text-slate-700">
                      {cat.sortOrder}
                    </td>
                    <td className="border border-slate-800/80 px-2.5 py-1">
                      <div className="flex items-center gap-2">
                        {cat.imageUrl ? (
                          <img
                            src={cat.imageUrl}
                            alt={cat.nameAr}
                            referrerPolicy="no-referrer"
                            className="h-6 w-6 rounded object-cover border border-slate-300 shrink-0"
                          />
                        ) : (
                          <FolderTree className="h-4 w-4 text-[#2563A6] shrink-0" />
                        )}
                        <span className="font-bold text-slate-950">{cat.nameAr}</span>
                      </div>
                    </td>
                    <td className="border border-slate-800/80 px-2.5 py-1 text-slate-800 font-medium">
                      {cat.nameFr}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center text-slate-700">
                      {cat.parent ? (
                        <span className="font-semibold text-indigo-800">
                          {t(lang, 'فرعية:', 'Sous:')} {lang === 'ar' ? cat.parent.nameAr : cat.parent.nameFr}
                        </span>
                      ) : (
                        <span className="font-semibold text-slate-700">
                          {t(lang, 'رئيسية', 'Principale')}
                        </span>
                      )}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center">
                      <button
                        type="button"
                        onClick={() => openCategoryProducts(cat.id!)}
                        title={t(lang, 'عرض منتجات هذه العائلة', 'Voir les produits')}
                        className="inline-flex items-center gap-1 rounded border border-slate-400 bg-slate-50 px-2 py-0.5 font-mono text-xs font-extrabold tabular-nums text-[#0B274D] hover:bg-[#FCE08B] hover:border-slate-900 transition-colors"
                      >
                        <Eye className="h-3 w-3" />
                        {cat.productCount}
                      </button>
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold tabular-nums text-slate-900">
                      {Number(cat.totalStockQty.toFixed(2))}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums text-teal-800">
                      {formatMoney(cat.stockCostValue, cur)}
                    </td>
                    <td className="border border-slate-800/80 px-2.5 py-1 text-slate-600 truncate max-w-[240px]">
                      {cat.description || '—'}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-0.5 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          type="button"
                          onClick={() => openEdit(cat)}
                          title={t(lang, 'تعديل', 'Modifier')}
                          className="inline-flex items-center gap-1 rounded border border-slate-400 bg-white px-2 py-0.5 text-[11px] font-bold text-slate-800 hover:bg-amber-100 hover:border-slate-900 transition-colors"
                        >
                          <Edit2 className="h-3 w-3" />
                          {t(lang, 'تعديل', 'Éditer')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(cat)}
                          title={t(lang, 'حذف', 'Supprimer')}
                          className="rounded border border-red-300 bg-red-50 p-1 text-red-700 hover:bg-red-600 hover:text-white transition-colors"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {renderBlankRows(filteredCategories.length, 9)}
              </tbody>
              <tfoot>
                <tr className="bg-[#FEF3C7] text-slate-950 font-extrabold text-xs">
                  <td colSpan={4} className="border border-slate-900 px-3 py-2 text-start">
                    {t(lang, `المجموع (${filteredCategories.length} عائلة)`, `Total (${filteredCategories.length} familles)`)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {listTotals.products}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {Number(listTotals.qty.toFixed(2))}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums text-teal-900">
                    {formatMoney(listTotals.costValue, cur)}
                  </td>
                  <td colSpan={2} className="border border-slate-900 px-2 py-2" />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: Sales & Profit per Category (with 6 Quick Date Period Filters) */}
      {activeTab === 'sales_stats' && (
        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-[#FCE08B] text-slate-950">
                  <th className="border border-slate-900 px-3 py-2 text-center font-extrabold min-w-[210px]">
                    {t(lang, 'العائلة', 'Famille')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[105px]">
                    {t(lang, 'عدد المنتجات', 'Produits')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[115px]">
                    {t(lang, 'الكمية المباعة', 'Qté vendue')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[135px]">
                    {t(lang, 'إجمالي المبيعات', 'Total Ventes')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[135px]">
                    {t(lang, 'إجمالي التكلفة', 'Coût total')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[135px]">
                    {t(lang, 'الربح الصافي', 'Profit net')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[105px]">
                    {t(lang, 'هامش الربح %', 'Marge %')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[115px]">
                    {t(lang, 'نسبة المساهمة', 'Part ventes')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {categorySalesRows.map((r) => (
                  <tr key={String(r.key)} className="h-[31px] hover:bg-amber-50/50 transition-colors">
                    <td className="border border-slate-800/80 px-2.5 py-1 font-bold text-slate-950">
                      {lang === 'ar' ? r.nameAr : r.nameFr}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono tabular-nums text-slate-700">
                      {r.productCount}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold tabular-nums text-slate-950">
                      {Number(r.qtySold.toFixed(2))}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-semibold tabular-nums text-slate-900">
                      {formatMoney(r.salesValue, cur)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono tabular-nums text-slate-700">
                      {formatMoney(r.costValue, cur)}
                    </td>
                    <td
                      className={`border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums ${
                        r.profit >= 0 ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {formatMoney(r.profit, cur)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold tabular-nums text-slate-800">
                      {r.marginPct.toFixed(1)}%
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-semibold tabular-nums text-[#0B274D]">
                      {r.sharePct.toFixed(1)}%
                    </td>
                  </tr>
                ))}
                {renderBlankRows(categorySalesRows.length, 8)}
              </tbody>
              <tfoot>
                <tr className="bg-[#FEF3C7] text-slate-950 font-extrabold text-xs">
                  <td className="border border-slate-900 px-3 py-2 text-start">
                    {t(lang, `المجموع (${categorySalesRows.length} عائلة)`, `Total (${categorySalesRows.length} familles)`)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {categorySalesTotals.products}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {Number(categorySalesTotals.qty.toFixed(2))}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {formatMoney(categorySalesTotals.sales, cur)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {formatMoney(categorySalesTotals.cost, cur)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums text-emerald-800">
                    {formatMoney(categorySalesTotals.profit, cur)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {categorySalesTotals.sales > 0
                      ? `${((categorySalesTotals.profit / categorySalesTotals.sales) * 100).toFixed(1)}%`
                      : '0.0%'}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {categorySalesTotals.sales > 0 ? '100.0%' : '0.0%'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: Stock Health & Valuation by Category */}
      {activeTab === 'stock_summary' && (
        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-[#FCE08B] text-slate-950">
                  <th className="border border-slate-900 px-3 py-2 text-center font-extrabold min-w-[210px]">
                    {t(lang, 'العائلة', 'Famille')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[100px]">
                    {t(lang, 'عدد المنتجات', 'Produits')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[110px]">
                    {t(lang, 'الكمية المتوفرة', 'Stock dispo')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[90px]">
                    {t(lang, 'نافدة', 'Rupture')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[90px]">
                    {t(lang, 'منخفضة', 'Faible')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[135px]">
                    {t(lang, 'قيمة الشراء', 'Valeur achat')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[140px]">
                    {t(lang, 'قيمة البيع المتوقعة', 'Valeur vente est.')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[135px]">
                    {t(lang, 'الربح المتوقع', 'Profit estimé')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredCategories.map((c) => (
                  <tr key={c.id} className="h-[31px] hover:bg-amber-50/50 transition-colors">
                    <td className="border border-slate-800/80 px-2.5 py-1 font-bold text-slate-950">
                      <button
                        type="button"
                        onClick={() => openCategoryProducts(c.id!)}
                        className="hover:underline text-start"
                      >
                        {lang === 'ar' ? c.nameAr : c.nameFr}
                      </button>
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold tabular-nums text-slate-900">
                      {c.productCount}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold tabular-nums text-slate-950">
                      {Number(c.totalStockQty.toFixed(2))}
                    </td>
                    <td
                      className={`border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums ${
                        c.outOfStockCount > 0 ? 'bg-red-50 text-red-700' : 'text-slate-500'
                      }`}
                    >
                      {c.outOfStockCount}
                    </td>
                    <td
                      className={`border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums ${
                        c.lowStockCount > 0 ? 'bg-amber-50 text-amber-800' : 'text-slate-500'
                      }`}
                    >
                      {c.lowStockCount}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-semibold tabular-nums text-slate-800">
                      {formatMoney(c.stockCostValue, cur)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-semibold tabular-nums text-slate-950">
                      {formatMoney(c.stockRetailValue, cur)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums text-emerald-700">
                      {formatMoney(c.expectedProfit, cur)}
                    </td>
                  </tr>
                ))}
                {renderBlankRows(filteredCategories.length, 8)}
              </tbody>
              <tfoot>
                <tr className="bg-[#FEF3C7] text-slate-950 font-extrabold text-xs">
                  <td className="border border-slate-900 px-3 py-2 text-start">
                    {t(lang, `المجموع (${filteredCategories.length} عائلة)`, `Total (${filteredCategories.length} familles)`)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {listTotals.products}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {Number(listTotals.qty.toFixed(2))}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums text-red-800">
                    {listTotals.outOfStock}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums text-amber-800">
                    {listTotals.lowStock}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {formatMoney(listTotals.costValue, cur)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {formatMoney(listTotals.retailValue, cur)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums text-emerald-800">
                    {formatMoney(listTotals.expectedProfit, cur)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: Products Inside Selected Category */}
      {activeTab === 'category_products' && (
        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-[#FCE08B] text-slate-950">
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap min-w-[140px]">
                    {t(lang, 'العائلة', 'Famille')}
                  </th>
                  <th className="border border-slate-900 px-3 py-2 text-center font-extrabold min-w-[220px]">
                    {t(lang, 'المنتج', 'Produit')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[135px]">
                    {t(lang, 'الباركود', 'Code-barres')}
                  </th>
                  <th className="border border-slate-900 px-2 py-2 text-center font-extrabold whitespace-nowrap w-[85px]">
                    {t(lang, 'الوحدة', 'Unité')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[100px]">
                    {t(lang, 'المتوفر', 'Stock dispo')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[100px]">
                    {t(lang, 'ثمن الشراء', 'Prix achat')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[100px]">
                    {t(lang, 'ثمن البيع', 'Prix vente')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[125px]">
                    {t(lang, 'قيمة المخزون', 'Valeur stock')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[110px]">
                    {t(lang, 'الصلاحية', 'Expiration')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {categoryProductsRows.map((p) => (
                  <tr key={p.id} className="h-[31px] hover:bg-amber-50/50 transition-colors">
                    <td className="border border-slate-800/80 px-2.5 py-1 text-center font-semibold text-slate-700">
                      {p.categoryId ? categoryNameMap.get(p.categoryId) ?? '—' : t(lang, 'بدون عائلة', 'Sans famille')}
                    </td>
                    <td className="border border-slate-800/80 px-2.5 py-1 font-bold text-slate-950">
                      {p.name}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-slate-700">
                      {p.barcode || '—'}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center text-slate-600">
                      {p.unit}
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
                      {p.quantity}
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
                  </tr>
                ))}
                {renderBlankRows(categoryProductsRows.length, 9)}
              </tbody>
              <tfoot>
                <tr className="bg-[#FEF3C7] text-slate-950 font-extrabold text-xs">
                  <td colSpan={4} className="border border-slate-900 px-3 py-2 text-start">
                    {t(lang, `المجموع (${categoryProductsRows.length} منتج)`, `Total (${categoryProductsRows.length} produits)`)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums">
                    {Number(categoryProductsTotals.qty.toFixed(2))}
                  </td>
                  <td colSpan={2} className="border border-slate-900 px-2 py-2" />
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums text-teal-900">
                    {formatMoney(categoryProductsTotals.value, cur)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2" />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Compact Utility Footer Bar (Matching InventoryModule) */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-0.5 text-xs text-slate-600">
        <div>
          {activeTab === 'sales_stats' && (dateFrom || dateTo) ? (
            <span className="font-mono tabular-nums">
              {t(lang, 'الفترة المحددة:', 'Période :')} {dateFrom || '...'} — {dateTo || '...'}
            </span>
          ) : (
            <span>
              {t(
                lang,
                `إجمالي العائلات: ${categories.length} (${rootCount} رئيسية · ${subCount} فرعية) · إجمالي المنتجات: ${products.length}`,
                `Total familles : ${categories.length} (${rootCount} principales · ${subCount} sous-familles) · Produits : ${products.length}`
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

      {/* Add / Edit Category Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900">
                {editing
                  ? t(lang, 'تعديل عائلة المنتجات', 'Modifier la famille')
                  : t(lang, 'إضافة عائلة جديدة', 'Nouvelle famille')}
              </h3>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleSave} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'اسم العائلة بالعربية *', 'Nom en arabe *')}
                  </label>
                  <input
                    required
                    value={form.nameAr}
                    onChange={(e) => setForm({ ...form, nameAr: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'اسم العائلة بالفرنسية', 'Nom en français')}
                  </label>
                  <input
                    value={form.nameFr}
                    onChange={(e) => setForm({ ...form, nameFr: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'العائلة الرئيسية (اختياري)', 'Famille parente (optionnel)')}
                  </label>
                  <select
                    value={form.parentId}
                    onChange={(e) => setForm({ ...form, parentId: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                  >
                    <option value="">{t(lang, '— عائلة رئيسية —', '— Famille principale —')}</option>
                    {categories
                      .filter((c) => c.id !== editing?.id)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {lang === 'ar' ? c.nameAr : c.nameFr}
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'ترتيب العرض', 'Ordre d’affichage')}
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={form.sortOrder}
                    onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-teal-600 focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'وصف العائلة', 'Description')}
                </label>
                <textarea
                  rows={2}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'صورة العائلة (اختياري)', 'Image de famille (optionnel)')}
                </label>
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
                  <Upload className="h-3.5 w-3.5" />
                  {t(lang, 'رفع صورة', 'Importer une image')}
                  <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
                </label>
                {form.imageUrl && (
                  <img
                    src={form.imageUrl}
                    alt="preview"
                    referrerPolicy="no-referrer"
                    className="mt-2 h-14 w-14 rounded-lg object-cover border border-slate-200"
                  />
                )}
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  {t(lang, 'إلغاء', 'Annuler')}
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800"
                >
                  {t(lang, 'حفظ', 'Enregistrer')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
