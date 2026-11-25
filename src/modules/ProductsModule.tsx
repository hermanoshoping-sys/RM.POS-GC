import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowRight,
  Barcode,
  BookOpen,
  Download,
  Edit2,
  FileDown,
  History,
  Plus,
  Printer,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { db } from '../db/database';
import { logAudit, round2, updateProductWithPriceHistory } from '../db/operations';
import { useApp } from '../context/AppContext';
import { Product } from '../types';
import { formatDateTime, formatMoney, PRODUCT_UNITS, t } from '../i18n/translations';
import { exportRowsToExcel, exportTableToPdf, parseExcelFileToJson } from '../utils/export';

type LedgerEntryType = 'purchase' | 'sale' | 'sale_return' | 'supplier_return';

interface ProductLedgerRow {
  id: string;
  date: string;
  productId: number;
  productName: string;
  account: string;
  invoiceNumber: string;
  quantityDelta: number; // +purchase, -sale, +sale_return, -supplier_return
  purchasePrice: number;
  salePrice: number; // negative for sale_return, 0 for purchase/supplier_return
  profit: number;
  type: LedgerEntryType;
  linePurchaseTotal: number;
  lineSaleTotal: number;
}

export const ProductsModule: React.FC = () => {
  const { lang, settings, currentUser, notify, openPrint, requestGuardedAction } = useApp();
  const cur = settings.storeInfo.currency || 'MAD';

  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const categories = useLiveQuery(() => db.categories.toArray(), []) ?? [];
  const priceHistory = useLiveQuery(() => db.priceHistory.orderBy('changedAt').reverse().toArray(), []) ?? [];
  const purchaseInvoices = useLiveQuery(() => db.purchaseInvoices.toArray(), []) ?? [];
  const saleInvoices = useLiveQuery(() => db.saleInvoices.toArray(), []) ?? [];
  const saleReturns = useLiveQuery(() => db.saleReturns.toArray(), []) ?? [];
  const supplierReturns = useLiveQuery(() => db.supplierReturns.toArray(), []) ?? [];

  // View Mode: 'list' (Image 1) | 'ledger' (Image 2: سجل المنتج / سجل المنتجات)
  const [viewMode, setViewMode] = useState<'list' | 'ledger'>('list');
  const [ledgerProductId, setLedgerProductId] = useState<number | 'all'>('all');
  const [ledgerTypeFilter, setLedgerTypeFilter] = useState<'all' | LedgerEntryType>('all');
  const [ledgerDateFrom, setLedgerDateFrom] = useState('');
  const [ledgerDateTo, setLedgerDateTo] = useState('');

  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive' | 'weighted'>('all');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [historyProductId, setHistoryProductId] = useState<number | null>(null);
  const [barcodeModalProduct, setBarcodeModalProduct] = useState<Product | null>(null);
  const [barcodeCopies, setBarcodeCopies] = useState(6);

  const emptyForm = {
    name: '',
    sku: '',
    barcode: '',
    categoryId: '' as string,
    unit: 'قطعة',
    purchasePrice: 0,
    salePrice: 0,
    wholesalePrice: 0,
    secondSalePrice: 0,
    quantity: 0,
    minStock: 5,
    expiryDate: '',
    lotNumber: '',
    isActive: true,
    isWeighted: false,
    imageUrl: '',
  };

  const [form, setForm] = useState(emptyForm);

  const catMap = useMemo(() => {
    const m = new Map<number, string>();
    categories.forEach((c) => m.set(c.id!, lang === 'ar' ? c.nameAr : c.nameFr));
    return m;
  }, [categories, lang]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      const matchQ =
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.barcode.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.lotNumber ?? '').toLowerCase().includes(q);
      const matchCat =
        catFilter === 'all' ? true : String(p.categoryId ?? '') === catFilter;
      const matchStatus =
        statusFilter === 'all'
          ? true
          : statusFilter === 'active'
            ? p.isActive
            : statusFilter === 'inactive'
              ? !p.isActive
              : p.isWeighted;
      return matchQ && matchCat && matchStatus;
    });
  }, [products, search, catFilter, statusFilter]);

  // Build unified chronological Product Ledger rows (Purchases, Sales, Customer Returns, Supplier Returns)
  const allLedgerRows = useMemo<ProductLedgerRow[]>(() => {
    const rows: ProductLedgerRow[] = [];

    // 1. Supplier Purchases (Green, +qty)
    for (const inv of purchaseInvoices) {
      if (inv.status === 'cancelled') continue;
      for (let i = 0; i < inv.items.length; i++) {
        const it = inv.items[i];
        rows.push({
          id: `pur-${inv.id}-${i}`,
          date: inv.date,
          productId: it.productId,
          productName: it.productName,
          account: inv.supplierName,
          invoiceNumber: inv.invoiceNumber,
          quantityDelta: round2(it.quantity),
          purchasePrice: it.unitCost,
          salePrice: 0,
          profit: 0,
          type: 'purchase',
          linePurchaseTotal: round2(it.quantity * it.unitCost),
          lineSaleTotal: 0,
        });
      }
    }

    // 2. Customer Sales (Blue, -qty)
    for (const inv of saleInvoices) {
      if (inv.status === 'cancelled') continue;
      for (let i = 0; i < inv.items.length; i++) {
        const it = inv.items[i];
        const lineProfit = round2((it.unitPrice - it.costPrice) * it.quantity - (it.discount || 0));
        rows.push({
          id: `sale-${inv.id}-${i}`,
          date: inv.date,
          productId: it.productId,
          productName: it.productName,
          account: inv.customerName,
          invoiceNumber: inv.invoiceNumber,
          quantityDelta: -round2(it.quantity),
          purchasePrice: it.costPrice,
          salePrice: it.unitPrice,
          profit: lineProfit,
          type: 'sale',
          linePurchaseTotal: 0,
          lineSaleTotal: round2(it.total),
        });
      }
    }

    // 3. Customer Returns (Red on Qty & Sale Price, +qty returning to stock, negative profit)
    for (const ret of saleReturns) {
      for (let i = 0; i < ret.items.length; i++) {
        const it = ret.items[i];
        const revProfit = -round2((it.unitPrice - it.costPrice) * it.quantity);
        rows.push({
          id: `sret-${ret.id}-${i}`,
          date: ret.date,
          productId: it.productId,
          productName: it.productName,
          account: `${t(lang, 'مرتجع', 'Avoir')} ${ret.customerName}`,
          invoiceNumber: ret.returnNumber,
          quantityDelta: round2(it.quantity),
          purchasePrice: it.costPrice,
          salePrice: -it.unitPrice,
          profit: revProfit,
          type: 'sale_return',
          linePurchaseTotal: 0,
          lineSaleTotal: -round2(it.total),
        });
      }
    }

    // 4. Supplier Returns (Yellow on Qty, -qty leaving stock)
    for (const ret of supplierReturns) {
      for (let i = 0; i < ret.items.length; i++) {
        const it = ret.items[i];
        rows.push({
          id: `pret-${ret.id}-${i}`,
          date: ret.date,
          productId: it.productId,
          productName: it.productName,
          account: `${t(lang, 'مرتجع مورد', 'Avoir')} ${ret.supplierName}`,
          invoiceNumber: ret.returnNumber,
          quantityDelta: -round2(it.quantity),
          purchasePrice: it.unitCost,
          salePrice: 0,
          profit: 0,
          type: 'supplier_return',
          linePurchaseTotal: -round2(it.total),
          lineSaleTotal: 0,
        });
      }
    }

    // Sort chronologically (oldest -> newest like accounting ledger)
    rows.sort((a, b) => a.date.localeCompare(b.date));
    return rows;
  }, [purchaseInvoices, saleInvoices, saleReturns, supplierReturns, lang]);

  // Count movements per product for quick badge in products table
  const ledgerCountByProduct = useMemo(() => {
    const map = new Map<number, number>();
    for (const r of allLedgerRows) {
      map.set(r.productId, (map.get(r.productId) ?? 0) + 1);
    }
    return map;
  }, [allLedgerRows]);

  const filteredLedgerRows = useMemo(() => {
    return allLedgerRows.filter((r) => {
      const matchProduct = ledgerProductId === 'all' || r.productId === ledgerProductId;
      const matchType = ledgerTypeFilter === 'all' || r.type === ledgerTypeFilter;
      const d = r.date.slice(0, 10);
      const matchFrom = !ledgerDateFrom || d >= ledgerDateFrom;
      const matchTo = !ledgerDateTo || d <= ledgerDateTo;
      return matchProduct && matchType && matchFrom && matchTo;
    });
  }, [allLedgerRows, ledgerProductId, ledgerTypeFilter, ledgerDateFrom, ledgerDateTo]);

  const ledgerTotals = useMemo(() => {
    return filteredLedgerRows.reduce(
      (acc, r) => ({
        qtySum: round2(acc.qtySum + r.quantityDelta),
        purchaseTotal: round2(acc.purchaseTotal + r.linePurchaseTotal),
        saleTotal: round2(acc.saleTotal + r.lineSaleTotal),
        profitSum: round2(acc.profitSum + r.profit),
      }),
      { qtySum: 0, purchaseTotal: 0, saleTotal: 0, profitSum: 0 }
    );
  }, [filteredLedgerRows]);

  const selectedLedgerProduct =
    ledgerProductId === 'all' ? null : products.find((p) => p.id === ledgerProductId) ?? null;

  const openProductLedger = (productId: number | 'all') => {
    setLedgerProductId(productId);
    setLedgerTypeFilter('all');
    setLedgerDateFrom('');
    setLedgerDateTo('');
    setViewMode('ledger');
  };

  const openNew = () => {
    setEditing(null);
    const randomBarcode = `6111${Math.floor(100000000 + Math.random() * 899999999)}`;
    setForm({
      ...emptyForm,
      sku: `PRD-${products.length + 101}`,
      barcode: randomBarcode,
      categoryId: categories[0]?.id ? String(categories[0].id) : '',
    });
    setShowForm(true);
  };

  const openEdit = (p: Product) => {
    setEditing(p);
    setForm({
      name: p.name,
      sku: p.sku,
      barcode: p.barcode,
      categoryId: p.categoryId ? String(p.categoryId) : '',
      unit: p.unit,
      purchasePrice: p.purchasePrice,
      salePrice: p.salePrice,
      wholesalePrice: p.wholesalePrice,
      secondSalePrice: p.secondSalePrice,
      quantity: p.quantity,
      minStock: p.minStock,
      expiryDate: p.expiryDate ?? '',
      lotNumber: p.lotNumber ?? '',
      isActive: p.isActive,
      isWeighted: p.isWeighted,
      imageUrl: p.imageUrl ?? '',
    });
    setShowForm(true);
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
    if (!form.name.trim()) return;
    const payload = {
      name: form.name.trim(),
      sku: form.sku.trim(),
      barcode: form.barcode.trim(),
      categoryId: form.categoryId ? Number(form.categoryId) : null,
      unit: form.unit,
      purchasePrice: Number(form.purchasePrice) || 0,
      salePrice: Number(form.salePrice) || 0,
      wholesalePrice: Number(form.wholesalePrice) || Number(form.salePrice) || 0,
      secondSalePrice: Number(form.secondSalePrice) || Number(form.salePrice) || 0,
      quantity: Number(form.quantity) || 0,
      minStock: Number(form.minStock) || 0,
      expiryDate: form.expiryDate || undefined,
      lotNumber: form.lotNumber.trim() || undefined,
      isActive: form.isActive,
      isWeighted: form.isWeighted,
      imageUrl: form.imageUrl || undefined,
    };

    if (editing?.id && currentUser) {
      await updateProductWithPriceHistory(editing.id, payload, currentUser);
      notify(t(lang, 'تم تحديث المنتج بنجاح', 'Produit mis à jour'));
    } else {
      const now = new Date().toISOString();
      const id = await db.products.add({
        ...payload,
        createdAt: now,
        updatedAt: now,
      });
      if (currentUser) {
        await logAudit(currentUser, 'PRODUCT_CREATED', 'product', id, `إضافة منتج: ${payload.name}`);
      }
      notify(t(lang, 'تمت إضافة المنتج بنجاح', 'Produit ajouté'));
    }
    setShowForm(false);
  };

  const handleDelete = (p: Product) => {
    if (!currentUser?.permissions.canDeleteRecords) {
      notify(t(lang, 'ليس لديك صلاحية حذف المنتجات', 'Permission refusée'), 'error');
      return;
    }
    requestGuardedAction({
      title: t(lang, 'حذف المنتج', 'Supprimer le produit'),
      description: t(
        lang,
        `هل أنت متأكد من حذف المنتج "${p.name}"؟ (يفضل تعطيل المنتج بدلاً من حذفه إذا كانت له عمليات سابقة).`,
        `Supprimer "${p.name}" ?`
      ),
      isSensitiveDelete: true,
      onConfirm: async () => {
        await db.products.delete(p.id!);
        if (currentUser) {
          await logAudit(currentUser, 'PRODUCT_DELETED', 'product', p.id!, `حذف المنتج: ${p.name}`);
        }
        notify(t(lang, 'تم حذف المنتج', 'Produit supprimé'));
      },
    });
  };

  const handleExportExcel = () => {
    exportRowsToExcel(
      filtered.map((p) => ({
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        category: p.categoryId ? catMap.get(p.categoryId) ?? '' : '',
        unit: p.unit,
        purchasePrice: p.purchasePrice,
        salePrice: p.salePrice,
        wholesalePrice: p.wholesalePrice,
        secondSalePrice: p.secondSalePrice,
        quantity: p.quantity,
        minStock: p.minStock,
        expiryDate: p.expiryDate ?? '',
        lotNumber: p.lotNumber ?? '',
        isActive: p.isActive ? 'YES' : 'NO',
        isWeighted: p.isWeighted ? 'YES' : 'NO',
      })),
      'Products',
      'products_catalog.xlsx'
    );
  };

  const handleExportPdf = () => {
    exportTableToPdf(
      'Products Catalog',
      `Exported ${new Date().toISOString().slice(0, 10)} (${filtered.length} products)`,
      ['Product', 'Barcode', 'Category', 'Buy Price', 'Sale Price', 'Stock', 'Expiry'],
      filtered.map((p) => [
        p.name,
        p.barcode || p.sku,
        p.categoryId ? catMap.get(p.categoryId) ?? '-' : '-',
        p.purchasePrice.toFixed(2),
        p.salePrice.toFixed(2),
        `${p.quantity} ${p.unit}`,
        p.expiryDate || '-',
      ]),
      'products_catalog.pdf'
    );
  };

  const handlePrintCatalog = () => {
    openPrint({
      type: 'generic_report',
      title: t(lang, 'قائمة المنتجات والمخزون', 'Catalogue des produits & stock'),
      subtitle: `${t(lang, 'عدد المنتجات:', 'Nombre :')} ${filtered.length} — ${new Date().toLocaleDateString(
        lang === 'ar' ? 'ar-MA' : 'fr-FR'
      )}`,
      columns: [
        t(lang, 'المنتج', 'Produit'),
        t(lang, 'الباركود', 'Code-barres'),
        t(lang, 'العائلة', 'Famille'),
        t(lang, 'ثمن الشراء', 'P. Achat'),
        t(lang, 'ثمن البيع', 'P. Vente'),
        t(lang, 'المخزون', 'Stock'),
        t(lang, 'الصلاحية', 'Expiration'),
      ],
      rows: filtered.map((p) => [
        p.name,
        p.barcode || p.sku,
        p.categoryId ? catMap.get(p.categoryId) ?? '—' : '—',
        p.purchasePrice.toFixed(2),
        p.salePrice.toFixed(2),
        `${p.quantity}`,
        p.expiryDate || '—',
      ]),
      summaryItems: [
        {
          label: t(lang, 'إجمالي المخزون', 'Stock total'),
          value: String(round2(filtered.reduce((s, p) => s + p.quantity, 0))),
        },
        {
          label: t(lang, 'قيمة المخزون بالشراء', 'Valeur stock (achat)'),
          value: formatMoney(
            filtered.reduce((s, p) => s + p.quantity * p.purchasePrice, 0),
            cur
          ),
        },
      ],
    });
  };

  const handleExportLedgerExcel = () => {
    exportRowsToExcel(
      filteredLedgerRows.map((r) => ({
        [t(lang, 'التاريخ', 'Date')]: r.date.slice(0, 10).replace(/-/g, '/'),
        [t(lang, 'المنتج', 'Produit')]: r.productName,
        compte: r.account,
        [t(lang, 'رقم الفاتورة', 'N° Facture')]: r.invoiceNumber,
        [t(lang, 'الكمية', 'Quantité')]: r.quantityDelta,
        [t(lang, 'ثمن الشراء', 'Prix achat')]: r.purchasePrice,
        [t(lang, 'ثمن البيع', 'Prix vente')]: r.salePrice,
        [t(lang, 'الربح', 'Bénéfice')]: r.profit,
      })),
      'ProductLedger',
      'product_ledger.xlsx'
    );
  };

  const handleExportLedgerPdf = () => {
    exportTableToPdf(
      selectedLedgerProduct ? `Product Ledger: ${selectedLedgerProduct.name}` : 'Products Ledger',
      `Stock Sum: ${ledgerTotals.qtySum} | Net Profit: ${ledgerTotals.profitSum.toFixed(2)} ${cur}`,
      ['Date', 'Product', 'Compte', 'Invoice', 'Qty', 'Buy', 'Sale', 'Profit'],
      filteredLedgerRows.map((r) => [
        r.date.slice(0, 10).replace(/-/g, '/'),
        r.productName,
        r.account,
        r.invoiceNumber,
        String(r.quantityDelta),
        r.purchasePrice.toFixed(2),
        r.salePrice.toFixed(2),
        r.profit.toFixed(2),
      ]),
      'product_ledger.pdf'
    );
  };

  const handlePrintLedger = () => {
    openPrint({
      type: 'generic_report',
      title: selectedLedgerProduct
        ? `${t(lang, 'سجل المنتج:', 'Fiche produit :')} ${selectedLedgerProduct.name}`
        : t(lang, 'سجل المنتجات (المشتريات والمبيعات والمرتجعات)', 'Journal complet des produits'),
      subtitle: `${t(lang, 'عدد العمليات:', 'Opérations :')} ${filteredLedgerRows.length}`,
      columns: [
        t(lang, 'التاريخ', 'Date'),
        t(lang, 'المنتج', 'Produit'),
        'compte',
        t(lang, 'رقم الفاتورة', 'N° Facture'),
        t(lang, 'الكمية', 'Qté'),
        t(lang, 'ثمن الشراء', 'P. Achat'),
        t(lang, 'ثمن البيع', 'P. Vente'),
        t(lang, 'الربح', 'Profit'),
      ],
      rows: filteredLedgerRows.map((r) => [
        r.date.slice(0, 10).replace(/-/g, '/'),
        r.productName,
        r.account,
        r.invoiceNumber,
        r.quantityDelta,
        r.purchasePrice.toFixed(2),
        r.salePrice.toFixed(2),
        r.profit.toFixed(2),
      ]),
      summaryItems: [
        { label: t(lang, 'مجموع المخزون (السجل)', 'Total stock (journal)'), value: String(ledgerTotals.qtySum) },
        { label: t(lang, 'مجموع الربح', 'Total bénéfice'), value: formatMoney(ledgerTotals.profitSum, cur) },
      ],
    });
  };

  const handleImportExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const rows = await parseExcelFileToJson(file);
      const now = new Date().toISOString();
      let imported = 0;
      for (const r of rows) {
        const name = String(r.name ?? r['اسم المنتج'] ?? r['Produit'] ?? '').trim();
        if (!name) continue;
        await db.products.add({
          name,
          sku: String(r.sku ?? r.SKU ?? `IMP-${Date.now().toString().slice(-4)}-${imported}`),
          barcode: String(
            r.barcode ??
              r['الباركود'] ??
              `6111${Math.floor(100000000 + Math.random() * 899999999)}`
          ),
          categoryId: categories[0]?.id ?? null,
          unit: String(r.unit ?? r['الوحدة'] ?? 'قطعة'),
          purchasePrice: Number(r.purchasePrice ?? r['سعر الشراء'] ?? 0) || 0,
          salePrice: Number(r.salePrice ?? r['سعر البيع'] ?? 0) || 0,
          wholesalePrice: Number(r.wholesalePrice ?? r['سعر الجملة'] ?? r.salePrice ?? 0) || 0,
          secondSalePrice: Number(r.secondSalePrice ?? r.salePrice ?? 0) || 0,
          quantity: Number(r.quantity ?? r['الكمية'] ?? 0) || 0,
          minStock: Number(r.minStock ?? r['الحد الأدنى'] ?? 5) || 5,
          expiryDate: String(r.expiryDate ?? '') || undefined,
          lotNumber: String(r.lotNumber ?? '') || undefined,
          isActive: true,
          isWeighted: String(r.isWeighted ?? '').toUpperCase() === 'YES',
          createdAt: now,
          updatedAt: now,
        });
        imported += 1;
      }
      if (currentUser && imported > 0) {
        await logAudit(
          currentUser,
          'PRODUCTS_IMPORTED',
          'product',
          'batch',
          `استيراد ${imported} منتج من ملف Excel`
        );
      }
      notify(t(lang, `تم استيراد ${imported} منتج بنجاح`, `${imported} produits importés`));
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Excel import error', 'error');
    } finally {
      e.target.value = '';
    }
  };

  const marginPreview =
    form.purchasePrice > 0
      ? (((form.salePrice - form.purchasePrice) / form.purchasePrice) * 100).toFixed(1)
      : '0.0';

  const productHistoryRows = historyProductId
    ? priceHistory.filter((h) => h.productId === historyProductId)
    : [];

  const emptyProductRows = Math.max(0, 12 - filtered.length);
  const emptyLedgerRows = Math.max(0, 12 - filteredLedgerRows.length);

  const formatCommaNum = (val: number) => val.toFixed(2).replace('.', ',');

  return (
    <div className="space-y-4">
      {viewMode === 'list' ? (
        /* ==============================================================
           VIEW 1: PRODUCTS CATALOG (Matching Image 1)
           ============================================================== */
        <>
          {/* Top Title Row */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2">
            <h2 className="text-2xl font-black tracking-tight text-slate-950">
              {t(lang, 'المنتجات', 'Produits')}
            </h2>
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold text-slate-600 font-mono">
                {t(lang, `العدد: ${filtered.length}`, `Total : ${filtered.length}`)}
              </span>
              <button
                type="button"
                onClick={() => openProductLedger('all')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-green-600 bg-green-100 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-green-200 transition-colors"
              >
                <BookOpen className="h-3.5 w-3.5 text-green-800" />
                <span>{t(lang, 'سجل المنتجات الكامل', 'Journal de tous les produits')}</span>
              </button>
            </div>
          </div>

          {/* Single-Row Toolbar Matching Image 1 */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-2.5 shadow-sm">
            {/* Start (Right in RTL): Yellow Search Bar + Category Select + Status Filters */}
            <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[260px]">
              {/* Yellow/Cream Search Bar */}
              <div className="relative flex-1 min-w-[210px] max-w-xs">
                <Search className="pointer-events-none absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-amber-900" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t(
                    lang,
                    'بحث بالاسم الباركود reference',
                    'Rechercher nom, code-barres, référence'
                  )}
                  className="w-full rounded-md border border-amber-500 bg-[#FDE18E] py-2 ps-9 pe-3 text-xs font-extrabold text-slate-950 placeholder:text-slate-800 shadow-sm focus:border-amber-700 focus:outline-none"
                />
              </div>

              {/* Category Select */}
              <select
                value={catFilter}
                onChange={(e) => setCatFilter(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-800 focus:border-teal-600 focus:outline-none"
              >
                <option value="all">{t(lang, 'جميع العائلات', 'Toutes les familles')}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {lang === 'ar' ? c.nameAr : c.nameFr}
                  </option>
                ))}
              </select>

              {/* Status Segmented Tabs (الكل | نشط | غير نشط | موزون) */}
              <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 border border-slate-200">
                {(
                  [
                    { id: 'all', ar: 'الكل', fr: 'Tous' },
                    { id: 'active', ar: 'نشط', fr: 'Actifs' },
                    { id: 'inactive', ar: 'غير نشط', fr: 'Inactifs' },
                    { id: 'weighted', ar: 'موزون', fr: 'Pesés' },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setStatusFilter(f.id)}
                    className={`rounded-md px-2.5 py-1 text-xs font-bold whitespace-nowrap transition-colors ${
                      statusFilter === f.id
                        ? 'bg-white text-slate-950 shadow-sm border border-slate-200'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {lang === 'ar' ? f.ar : f.fr}
                  </button>
                ))}
              </div>
            </div>

            {/* End (Left in RTL): Pdf | طباعة | استيراد Excel | تصدير Excel | + إضافة منتج جديد */}
            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleExportPdf}
                className="inline-flex items-center gap-1 rounded-lg bg-amber-400 px-3.5 py-2 text-xs font-extrabold text-slate-950 shadow-md hover:bg-amber-300 active:scale-[0.98] whitespace-nowrap"
              >
                <FileDown className="h-3.5 w-3.5" />
                <span>Pdf</span>
              </button>

              <button
                type="button"
                onClick={handlePrintCatalog}
                className="inline-flex items-center gap-1 rounded-lg bg-sky-500 px-3.5 py-2 text-xs font-extrabold text-slate-950 shadow-md hover:bg-sky-400 active:scale-[0.98] whitespace-nowrap"
              >
                <Printer className="h-3.5 w-3.5" />
                <span>{t(lang, 'طباعة', 'Imprimer')}</span>
              </button>

              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 whitespace-nowrap">
                <Upload className="h-3.5 w-3.5" />
                <span>{t(lang, 'استيراد Excel', 'Importer Excel')}</span>
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={handleImportExcel}
                  className="hidden"
                />
              </label>

              <button
                type="button"
                onClick={handleExportExcel}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                <Download className="h-3.5 w-3.5" />
                <span>{t(lang, 'تصدير Excel', 'Exporter Excel')}</span>
              </button>

              <button
                type="button"
                onClick={openNew}
                className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-2 text-xs font-extrabold text-white shadow-sm hover:bg-teal-800 whitespace-nowrap"
              >
                <Plus className="h-4 w-4" />
                <span>{t(lang, 'إضافة منتج جديد', 'Nouveau produit')}</span>
              </button>
            </div>
          </div>

          {/* Full-Bordered Products Ledger Table (Yellow Header matching Image 1) */}
          <div className="rounded-lg border-2 border-slate-900 bg-white overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs sm:text-sm">
                <thead>
                  <tr className="bg-[#FCE08B] text-slate-950 text-xs">
                    <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold min-w-[200px]">
                      {t(lang, 'المنتج', 'Produit')}
                    </th>
                    <th className="border border-slate-900 px-2.5 py-2.5 text-center font-extrabold">
                      {t(lang, 'الباركود', 'Code-barres')}
                    </th>
                    <th className="border border-slate-900 px-2.5 py-2.5 text-center font-extrabold">
                      {t(lang, 'العائلة', 'Famille')}
                    </th>
                    <th className="border border-slate-900 px-2.5 py-2.5 text-center font-extrabold">
                      {t(lang, 'ثمن الشراء', 'Prix achat')}
                    </th>
                    <th className="border border-slate-900 px-2.5 py-2.5 text-center font-extrabold">
                      {t(lang, 'ثمن البيع', 'Prix vente')}
                    </th>
                    <th className="border border-slate-900 px-2.5 py-2.5 text-center font-extrabold">
                      {t(lang, 'المخزون', 'Stock')}
                    </th>
                    <th className="border border-slate-900 px-2.5 py-2.5 text-center font-extrabold">
                      {t(lang, 'الصلاحية', 'Expiration')}
                    </th>
                    <th className="border border-slate-900 px-2.5 py-2.5 text-center font-extrabold">
                      {t(lang, 'سجل المنتج', 'Journal produit')}
                    </th>
                    <th className="border border-slate-900 px-2.5 py-2.5 text-center font-extrabold">
                      {t(lang, 'إجراءات', 'Actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => {
                    const isLow = p.quantity <= p.minStock;
                    const movCount = ledgerCountByProduct.get(p.id!) ?? 0;
                    return (
                      <tr key={p.id} className="hover:bg-amber-50/40 transition-colors">
                        <td className="border border-slate-800/80 px-3 py-2">
                          <div className="flex items-center gap-2">
                            {p.imageUrl && (
                              <img
                                src={p.imageUrl}
                                alt={p.name}
                                referrerPolicy="no-referrer"
                                className="h-8 w-8 rounded object-cover border border-slate-300 shrink-0"
                              />
                            )}
                            <div className="min-w-0">
                              <div className="font-bold text-slate-950 truncate">{p.name}</div>
                              <div className="text-[10px] font-mono text-slate-500">
                                {p.sku} · {p.unit}
                                {p.isWeighted ? ` · ${t(lang, 'موزون', 'Pesé')}` : ''}
                                {!p.isActive ? ` · ${t(lang, 'غير نشط', 'Inactif')}` : ''}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="border border-slate-800/80 px-2.5 py-2 text-center font-mono text-xs text-slate-800">
                          {p.barcode || '—'}
                        </td>
                        <td className="border border-slate-800/80 px-2.5 py-2 text-center text-xs font-semibold text-slate-700">
                          {p.categoryId ? catMap.get(p.categoryId) ?? '—' : '—'}
                        </td>
                        <td className="border border-slate-800/80 px-2.5 py-2 text-center font-mono text-xs font-semibold tabular-nums text-slate-800">
                          {p.purchasePrice.toFixed(2)}
                        </td>
                        <td className="border border-slate-800/80 px-2.5 py-2 text-center font-mono text-xs font-bold tabular-nums text-slate-950">
                          <div>{p.salePrice.toFixed(2)}</div>
                          {p.wholesalePrice > 0 && p.wholesalePrice !== p.salePrice && (
                            <div className="text-[10px] font-normal text-slate-500">
                              {t(lang, 'جملة:', 'Gros:')} {p.wholesalePrice.toFixed(2)}
                            </div>
                          )}
                        </td>
                        <td className="border border-slate-800/80 px-2.5 py-2 text-center font-mono text-xs font-extrabold tabular-nums">
                          <span
                            className={
                              p.quantity <= 0
                                ? 'text-red-700'
                                : isLow
                                  ? 'text-amber-700'
                                  : 'text-slate-950'
                            }
                          >
                            {p.quantity}
                          </span>
                        </td>
                        <td className="border border-slate-800/80 px-2.5 py-2 text-center font-mono text-xs text-slate-700">
                          <div>{p.expiryDate || '—'}</div>
                          {p.lotNumber && (
                            <div className="text-[10px] text-slate-400">{p.lotNumber}</div>
                          )}
                        </td>
                        <td className="border border-slate-800/80 px-2 py-1.5 text-center">
                          <button
                            type="button"
                            onClick={() => openProductLedger(p.id!)}
                            className="inline-flex items-center justify-center gap-1 rounded border border-green-700 bg-[#C5E0B4] px-2.5 py-1 text-[11px] font-extrabold text-slate-950 hover:bg-green-300 transition-colors whitespace-nowrap"
                          >
                            <BookOpen className="h-3.5 w-3.5 text-green-900 shrink-0" />
                            <span>
                              {t(lang, 'سجل المنتج', 'Journal')} ({movCount})
                            </span>
                          </button>
                        </td>
                        <td className="border border-slate-800/80 px-2 py-1.5">
                          <div className="flex items-center justify-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => {
                                setBarcodeModalProduct(p);
                                setBarcodeCopies(6);
                              }}
                              title={t(lang, 'طباعة ملصق الباركود', 'Étiquette code-barres')}
                              className="rounded p-1.5 text-teal-700 hover:bg-teal-50"
                            >
                              <Barcode className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setHistoryProductId(p.id!)}
                              title={t(lang, 'سجل تغير الأسعار', 'Historique prix')}
                              className="rounded p-1.5 text-slate-600 hover:bg-slate-100"
                            >
                              <History className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => openEdit(p)}
                              title={t(lang, 'تعديل', 'Modifier')}
                              className="rounded p-1.5 text-amber-700 hover:bg-amber-50"
                            >
                              <Edit2 className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDelete(p)}
                              title={t(lang, 'حذف', 'Supprimer')}
                              className="rounded p-1.5 text-red-600 hover:bg-red-50"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}

                  {filtered.length === 0 && (
                    <tr>
                      <td
                        colSpan={9}
                        className="border border-slate-800/80 px-4 py-8 text-center text-sm font-semibold text-slate-500"
                      >
                        {t(lang, 'لا توجد منتجات مطابقة', 'Aucun produit trouvé')}
                      </td>
                    </tr>
                  )}

                  {/* Crisp empty ledger rows matching Image 1 */}
                  {Array.from({ length: emptyProductRows }).map((_, idx) => (
                    <tr key={`empty-prd-${idx}`} className="h-8">
                      <td className="border border-slate-800/60" />
                      <td className="border border-slate-800/60" />
                      <td className="border border-slate-800/60" />
                      <td className="border border-slate-800/60" />
                      <td className="border border-slate-800/60" />
                      <td className="border border-slate-800/60" />
                      <td className="border border-slate-800/60" />
                      <td className="border border-slate-800/60" />
                      <td className="border border-slate-800/60" />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        /* ==============================================================
           VIEW 2: PRODUCT MOVEMENT LEDGER (Matching Image 2: سجل المنتجات)
           ============================================================== */
        <div className="space-y-3">
          {/* Header Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-2">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className="inline-flex items-center gap-1.5 rounded-lg border-2 border-slate-800 bg-amber-300 px-3.5 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-200"
              >
                <ArrowRight className={`h-4 w-4 ${lang === 'fr' ? 'rotate-180' : ''}`} />
                <span>{t(lang, 'الرجوع للمنتجات', 'Retour aux produits')}</span>
              </button>
              <div>
                <h2 className="text-2xl font-black tracking-tight text-slate-950">
                  {selectedLedgerProduct
                    ? `${t(lang, 'سجل المنتج:', 'Journal produit :')} ${selectedLedgerProduct.name}`
                    : t(lang, 'سجل المنتجات', 'Journal des produits')}
                </h2>
                {selectedLedgerProduct && (
                  <p className="text-xs font-semibold text-slate-600 font-mono">
                    {selectedLedgerProduct.barcode} · {t(lang, 'المخزون الفعلي الحالي:', 'Stock réel actuel :')}{' '}
                    <strong className="text-slate-950">
                      {selectedLedgerProduct.quantity} {selectedLedgerProduct.unit}
                    </strong>
                  </p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={handlePrintLedger}
                className="inline-flex items-center gap-1 rounded-lg bg-sky-500 px-3.5 py-2 text-xs font-extrabold text-slate-950 shadow-sm hover:bg-sky-400"
              >
                <Printer className="h-3.5 w-3.5" />
                <span>{t(lang, 'طباعة', 'Imprimer')}</span>
              </button>
              <button
                type="button"
                onClick={handleExportLedgerPdf}
                className="inline-flex items-center gap-1 rounded-lg bg-amber-400 px-3.5 py-2 text-xs font-extrabold text-slate-950 shadow-sm hover:bg-amber-300"
              >
                <FileDown className="h-3.5 w-3.5" />
                <span>Pdf</span>
              </button>
              <button
                type="button"
                onClick={handleExportLedgerExcel}
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-extrabold text-white shadow-sm hover:bg-emerald-700"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Excel</span>
              </button>
            </div>
          </div>

          {/* Filter & Color Legend Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={ledgerProductId === 'all' ? 'all' : String(ledgerProductId)}
                onChange={(e) =>
                  setLedgerProductId(e.target.value === 'all' ? 'all' : Number(e.target.value))
                }
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-900 max-w-[240px]"
              >
                <option value="all">{t(lang, 'جميع المنتجات', 'Tous les produits')}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>

              <select
                value={ledgerTypeFilter}
                onChange={(e) => setLedgerTypeFilter(e.target.value as 'all' | LedgerEntryType)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-900"
              >
                <option value="all">{t(lang, 'كل العمليات', 'Toutes opérations')}</option>
                <option value="purchase">{t(lang, 'مشتريات المورد (أخضر)', 'Achats fournisseur (Vert)')}</option>
                <option value="sale">{t(lang, 'مبيعات الزبون (أزرق)', 'Ventes client (Bleu)')}</option>
                <option value="sale_return">{t(lang, 'مسترجعات الزبناء (أحمر)', 'Retours clients (Rouge)')}</option>
                <option value="supplier_return">{t(lang, 'مسترجعات الموردين (أصفر)', 'Retours fournisseurs (Jaune)')}</option>
              </select>

              <input
                type="date"
                value={ledgerDateFrom}
                onChange={(e) => setLedgerDateFrom(e.target.value)}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-mono"
              />
              <input
                type="date"
                value={ledgerDateTo}
                onChange={(e) => setLedgerDateTo(e.target.value)}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-mono"
              />
            </div>

            {/* Color Key Legend (Exact 4 colors specified by user) */}
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-extrabold">
              <span className="inline-flex items-center gap-1.5 rounded border border-slate-800 bg-[#76C846] px-2 py-0.5 text-slate-950">
                {t(lang, 'مشتريات المورد (+)', 'Achat fournisseur (+)')}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded border border-slate-800 bg-[#00AEEF] px-2 py-0.5 text-slate-950">
                {t(lang, 'مبيعات الزبون (-)', 'Vente client (-)')}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded border border-slate-800 bg-red-600 px-2 py-0.5 text-white">
                {t(lang, 'مسترجعات الزبناء (+)', 'Retour client (+)')}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded border border-slate-800 bg-yellow-300 px-2 py-0.5 text-slate-950">
                {t(lang, 'مسترجعات الموردين (-)', 'Retour fournisseur (-)')}
              </span>
            </div>
          </div>

          {/* Product Ledger Table (Pastel Green Header + Exact 4-Color Quantity/Return Cells + Yellow Bottom Totals matching Image 2) */}
          <div className="rounded-lg border-2 border-slate-900 bg-white overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs sm:text-sm">
                <thead>
                  <tr className="bg-[#C5E0B4] text-slate-950 text-xs">
                    <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold whitespace-nowrap">
                      {t(lang, 'التاريخ', 'Date')}
                    </th>
                    <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold min-w-[200px]">
                      {t(lang, 'المنتج', 'Produit')}
                    </th>
                    <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold min-w-[140px]">
                      compte
                    </th>
                    <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold whitespace-nowrap">
                      {t(lang, 'رقم الفاتورة', 'N° Facture')}
                    </th>
                    <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold w-24">
                      {t(lang, 'الكمية', 'Quantité')}
                    </th>
                    <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold whitespace-nowrap">
                      {t(lang, 'ثمن الشراء', 'Prix achat')}
                    </th>
                    <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold whitespace-nowrap">
                      {t(lang, 'ثمن البيع', 'Prix vente')}
                    </th>
                    <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold whitespace-nowrap">
                      {t(lang, 'الربح', 'Bénéfice')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLedgerRows.map((row) => {
                    const qtyBgClass =
                      row.type === 'purchase'
                        ? 'bg-[#76C846] text-slate-950'
                        : row.type === 'sale'
                          ? 'bg-[#00AEEF] text-slate-950'
                          : row.type === 'sale_return'
                            ? 'bg-red-600 text-white'
                            : 'bg-yellow-300 text-slate-950';

                    const salePriceBgClass =
                      row.type === 'sale_return' ? 'bg-red-600 text-white font-bold' : 'text-slate-900';

                    return (
                      <tr key={row.id} className="hover:bg-slate-50/70">
                        <td className="border border-slate-900 px-3 py-1.5 text-center font-mono text-xs text-slate-900 whitespace-nowrap">
                          {row.date.slice(0, 10).replace(/-/g, '/')}
                        </td>
                        <td className="border border-slate-900 px-3 py-1.5 text-start font-semibold text-slate-950">
                          {row.productName}
                        </td>
                        <td className="border border-slate-900 px-3 py-1.5 text-center font-semibold text-slate-900">
                          {row.account}
                        </td>
                        <td className="border border-slate-900 px-3 py-1.5 text-center font-mono text-xs text-slate-900 whitespace-nowrap">
                          {row.invoiceNumber}
                        </td>
                        <td
                          dir="ltr"
                          className={`border border-slate-900 px-3 py-1.5 text-center font-mono text-xs font-extrabold tabular-nums ${qtyBgClass}`}
                        >
                          {row.quantityDelta}
                        </td>
                        <td
                          dir="ltr"
                          className="border border-slate-900 px-3 py-1.5 text-center font-mono text-xs tabular-nums text-slate-900"
                        >
                          {formatCommaNum(row.purchasePrice)}
                        </td>
                        <td
                          dir="ltr"
                          className={`border border-slate-900 px-3 py-1.5 text-center font-mono text-xs tabular-nums ${salePriceBgClass}`}
                        >
                          {formatCommaNum(row.salePrice)}
                        </td>
                        <td
                          dir="ltr"
                          className={`border border-slate-900 px-3 py-1.5 text-center font-mono text-xs font-bold tabular-nums ${
                            row.profit < 0
                              ? 'text-red-700'
                              : row.profit > 0
                                ? 'text-emerald-800'
                                : 'text-slate-800'
                          }`}
                        >
                          {formatCommaNum(row.profit)}
                        </td>
                      </tr>
                    );
                  })}

                  {filteredLedgerRows.length === 0 && (
                    <tr>
                      <td
                        colSpan={8}
                        className="border border-slate-900 px-4 py-8 text-center text-sm font-semibold text-slate-500"
                      >
                        {t(
                          lang,
                          'لا توجد عمليات شراء أو بيع أو مرتجعات مسجلة لهذا المنتج حتى الآن',
                          'Aucun mouvement enregistré pour ce produit'
                        )}
                      </td>
                    </tr>
                  )}

                  {/* Crisp empty ledger rows matching Image 2 */}
                  {Array.from({ length: emptyLedgerRows }).map((_, idx) => (
                    <tr key={`empty-led-${idx}`} className="h-8">
                      <td className="border border-slate-800/70" />
                      <td className="border border-slate-800/70" />
                      <td className="border border-slate-800/70" />
                      <td className="border border-slate-800/70" />
                      <td className="border border-slate-800/70" />
                      <td className="border border-slate-800/70" />
                      <td className="border border-slate-800/70" />
                      <td className="border border-slate-800/70" />
                    </tr>
                  ))}
                </tbody>

                {/* Bottom Yellow Totals Row (مجموع المخزون & الأرباح matching Image 2!) */}
                <tfoot>
                  <tr className="h-2 bg-white">
                    <td colSpan={8} />
                  </tr>
                  <tr className="text-xs sm:text-sm font-black text-slate-950">
                    <td
                      colSpan={2}
                      className="border-2 border-slate-900 bg-yellow-300 px-3 py-2 text-start"
                    >
                      {t(lang, 'المجموع (مجموع المخزون)', 'Total (Stock net)')}
                    </td>
                    <td colSpan={2} className="bg-white px-2 py-2 text-center text-[11px] font-semibold text-slate-500">
                      {selectedLedgerProduct &&
                      Math.abs(selectedLedgerProduct.quantity - ledgerTotals.qtySum) > 0.001
                        ? `${t(lang, 'المخزون الحالي:', 'Stock actuel :')} ${selectedLedgerProduct.quantity}`
                        : ''}
                    </td>
                    <td
                      dir="ltr"
                      title={t(lang, 'مجموع المخزون من الحركات', 'Somme nette du stock')}
                      className="border-2 border-slate-900 bg-yellow-300 px-3 py-2 text-center font-mono text-sm font-black tabular-nums"
                    >
                      {ledgerTotals.qtySum}
                    </td>
                    <td
                      dir="ltr"
                      title={t(lang, 'صافي قيمة المشتريات', 'Total achats')}
                      className="border-2 border-slate-900 bg-yellow-300 px-3 py-2 text-center font-mono text-xs font-extrabold tabular-nums"
                    >
                      {formatCommaNum(ledgerTotals.purchaseTotal)}
                    </td>
                    <td
                      dir="ltr"
                      title={t(lang, 'صافي قيمة المبيعات', 'Total ventes')}
                      className="border-2 border-slate-900 bg-yellow-300 px-3 py-2 text-center font-mono text-xs font-extrabold tabular-nums"
                    >
                      {formatCommaNum(ledgerTotals.saleTotal)}
                    </td>
                    <td
                      dir="ltr"
                      title={t(lang, 'صافي هامش الربح', 'Total bénéfice')}
                      className="border-2 border-slate-900 bg-yellow-300 px-3 py-2 text-center font-mono text-sm font-black tabular-nums"
                    >
                      {formatCommaNum(ledgerTotals.profitSum)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit Product Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 overflow-y-auto">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-6 shadow-xl my-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900">
                {editing
                  ? t(lang, 'تعديل بيانات المنتج', 'Modifier le produit')
                  : t(lang, 'إضافة منتج جديد', 'Nouveau produit')}
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
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'اسم المنتج *', 'Nom du produit *')}
                  </label>
                  <input
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    SKU / Reference
                  </label>
                  <input
                    value={form.sku}
                    onChange={(e) => setForm({ ...form, sku: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-teal-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'الباركود (Barcode)', 'Code-barres')}
                  </label>
                  <div className="flex gap-1.5">
                    <input
                      value={form.barcode}
                      onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-teal-600 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setForm({
                          ...form,
                          barcode: `6111${Math.floor(100000000 + Math.random() * 899999999)}`,
                        })
                      }
                      className="rounded-lg border border-slate-300 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                    >
                      {t(lang, 'توليد', 'Générer')}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'عائلة المنتج', 'Famille')}
                  </label>
                  <select
                    value={form.categoryId}
                    onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                  >
                    <option value="">{t(lang, '— بدون عائلة —', '— Sans famille —')}</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {lang === 'ar' ? c.nameAr : c.nameFr}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'الوحدة', 'Unité')}
                  </label>
                  <select
                    value={form.unit}
                    onChange={(e) => setForm({ ...form, unit: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                  >
                    {PRODUCT_UNITS.map((u) => (
                      <option key={u.value} value={u.value}>
                        {lang === 'ar' ? u.ar : u.fr}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Pricing Row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'سعر الشراء', 'Prix achat')}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.purchasePrice}
                    onChange={(e) => setForm({ ...form, purchasePrice: Number(e.target.value) })}
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'سعر البيع', 'Prix vente')}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.salePrice}
                    onChange={(e) => setForm({ ...form, salePrice: Number(e.target.value) })}
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'سعر الجملة', 'Prix gros')}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.wholesalePrice}
                    onChange={(e) => setForm({ ...form, wholesalePrice: Number(e.target.value) })}
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'سعر البيع الثاني', 'Prix vente 2')}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.secondSalePrice}
                    onChange={(e) => setForm({ ...form, secondSalePrice: Number(e.target.value) })}
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-mono"
                  />
                </div>
                <div className="col-span-2 sm:col-span-4 text-xs text-slate-600">
                  {t(lang, 'هامش الربح المتوقع:', 'Marge bénéficiaire estimée :')}{' '}
                  <span className="font-mono font-bold text-emerald-700">
                    {marginPreview}% ({(form.salePrice - form.purchasePrice).toFixed(2)} {cur})
                  </span>
                </div>
              </div>

              {/* Stock & Lot */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'الكمية الحالية', 'Qté actuelle')}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={form.quantity}
                    onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'الحد الأدنى للمخزون', 'Stock min')}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.minStock}
                    onChange={(e) => setForm({ ...form, minStock: Number(e.target.value) })}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'تاريخ الصلاحية', 'Date expiration')}
                  </label>
                  <input
                    type="date"
                    value={form.expiryDate}
                    onChange={(e) => setForm({ ...form, expiryDate: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'رقم الدفعة (Lot)', 'N° Lot')}
                  </label>
                  <input
                    value={form.lotNumber}
                    onChange={(e) => setForm({ ...form, lotNumber: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-mono"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
                <div className="flex items-center gap-4">
                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.isActive}
                      onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                      className="rounded border-slate-300 text-teal-700"
                    />
                    {t(lang, 'منتج نشط', 'Produit actif')}
                  </label>
                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.isWeighted}
                      onChange={(e) => setForm({ ...form, isWeighted: e.target.checked })}
                      className="rounded border-slate-300 text-teal-700"
                    />
                    {t(lang, 'منتج موزون (كسور عشرية)', 'Article pesé (décimal)')}
                  </label>
                </div>

                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                  <Upload className="h-3.5 w-3.5" />
                  {t(lang, 'صورة المنتج', 'Photo')}
                  <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
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
                  {t(lang, 'حفظ المنتج', 'Enregistrer')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Price History Modal */}
      {historyProductId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900">
                {t(lang, 'سجل تغير أسعار الشراء والبيع', 'Historique des prix d’achat et de vente')}
              </h3>
              <button
                type="button"
                onClick={() => setHistoryProductId(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {productHistoryRows.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">
                {t(lang, 'لم يتم تسجيل تغييرات في السعر لهذا المنتج بعد', 'Aucun changement de prix enregistré')}
              </p>
            ) : (
              <div className="overflow-x-auto max-h-80">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                      <th className="p-2 text-start">{t(lang, 'التاريخ', 'Date')}</th>
                      <th className="p-2 text-end">{t(lang, 'الشراء (قديم ← جديد)', 'Achat (Ancien → Nouv.)')}</th>
                      <th className="p-2 text-end">{t(lang, 'البيع (قديم ← جديد)', 'Vente (Ancien → Nouv.)')}</th>
                      <th className="p-2 text-start">{t(lang, 'بواسطة / ملاحظة', 'Par / Note')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {productHistoryRows.map((h) => (
                      <tr key={h.id}>
                        <td className="p-2">{formatDateTime(h.changedAt, lang)}</td>
                        <td className="p-2 text-end font-mono">
                          {h.oldPurchasePrice.toFixed(2)} → <strong>{h.newPurchasePrice.toFixed(2)}</strong>
                        </td>
                        <td className="p-2 text-end font-mono">
                          {h.oldSalePrice.toFixed(2)} → <strong>{h.newSalePrice.toFixed(2)}</strong>
                        </td>
                        <td className="p-2 text-slate-600">
                          {h.changedBy} · {h.note || ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Barcode Print Quantity Modal */}
      {barcodeModalProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <h3 className="text-base font-bold text-slate-900">
              {t(lang, 'طباعة ملصقات الباركود', 'Imprimer étiquettes code-barres')}
            </h3>
            <p className="mt-1 text-xs text-slate-500">{barcodeModalProduct.name}</p>
            <div className="mt-4">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'عدد الملصقات المطلوب طباعتها', 'Nombre d’étiquettes')}
              </label>
              <input
                type="number"
                min="1"
                max="30"
                value={barcodeCopies}
                onChange={(e) => setBarcodeCopies(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
              />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setBarcodeModalProduct(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700"
              >
                {t(lang, 'إلغاء', 'Annuler')}
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = barcodeModalProduct;
                  setBarcodeModalProduct(null);
                  openPrint({
                    type: 'barcode_labels',
                    products: [{ product: target, copies: barcodeCopies }],
                  });
                }}
                className="rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800"
              >
                {t(lang, 'معاينة وطباعة', 'Aperçu & Imprimer')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
