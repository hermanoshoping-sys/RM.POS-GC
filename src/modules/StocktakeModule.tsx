import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileDown,
  History,
  Printer,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { db } from '../db/database';
import { adjustProductStock } from '../db/operations';
import { useApp } from '../context/AppContext';
import { Product } from '../types';
import { formatDateTime, formatMoney, t } from '../i18n/translations';
import { exportRowsToExcel, exportTableToPdf } from '../utils/export';

export const StocktakeModule: React.FC = () => {
  const { lang, settings, currentUser, notify, openPrint } = useApp();
  const cur = settings.storeInfo.currency || 'MAD';

  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const categories = useLiveQuery(() => db.categories.toArray(), []) ?? [];
  const stockMovements =
    useLiveQuery(
      () =>
        db.stockMovements
          .orderBy('date')
          .reverse()
          .filter((m) => m.type === 'adjustment' || m.type === 'damage' || m.type === 'loss')
          .toArray(),
      []
    ) ?? [];

  const [viewTab, setViewTab] = useState<'count' | 'history'>('count');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'counted' | 'variance' | 'uncounted'>('all');
  const [sessionNote, setSessionNote] = useState('');
  const [countedMap, setCountedMap] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);

  // Quick Damage / Loss Modal
  const [damageProduct, setDamageProduct] = useState<Product | null>(null);
  const [damageMode, setDamageMode] = useState<'damage' | 'loss'>('damage');
  const [damageQty, setDamageQty] = useState<number>(1);
  const [damageNote, setDamageNote] = useState('');

  const catNameMap = useMemo(() => {
    const map = new Map<number, string>();
    categories.forEach((c) => map.set(c.id!, lang === 'ar' ? c.nameAr : c.nameFr));
    return map;
  }, [categories, lang]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products
      .filter((p) => {
        if (categoryFilter !== 'all' && String(p.categoryId ?? '') !== categoryFilter) return false;
        if (
          q &&
          !p.name.toLowerCase().includes(q) &&
          !p.barcode.toLowerCase().includes(q) &&
          !p.sku.toLowerCase().includes(q)
        ) {
          return false;
        }
        const rawVal = countedMap[p.id!];
        const hasCount = rawVal !== undefined && rawVal.trim() !== '';
        const parsed = hasCount ? Number(rawVal) : NaN;
        const variance = hasCount && Number.isFinite(parsed) ? parsed - p.quantity : 0;

        if (statusFilter === 'counted' && !hasCount) return false;
        if (statusFilter === 'uncounted' && hasCount) return false;
        if (statusFilter === 'variance' && (!hasCount || Math.abs(variance) < 0.0001)) return false;
        return true;
      })
      .map((p) => {
        const rawVal = countedMap[p.id!];
        const hasCount = rawVal !== undefined && rawVal.trim() !== '';
        const parsed = hasCount ? Number(rawVal) : NaN;
        const validCount = hasCount && Number.isFinite(parsed) && parsed >= 0;
        const variance = validCount ? parsed - p.quantity : 0;
        const varianceValue = variance * p.purchasePrice;
        return {
          product: p,
          categoryName: p.categoryId ? catNameMap.get(p.categoryId) ?? '—' : '—',
          rawVal: rawVal ?? '',
          hasCount: validCount,
          countedQty: validCount ? parsed : null,
          variance,
          varianceValue,
        };
      });
  }, [products, categoryFilter, search, statusFilter, countedMap, catNameMap]);

  const summary = useMemo(() => {
    let countedItems = 0;
    let changedItems = 0;
    let surplusValue = 0;
    let shortageValue = 0;

    products.forEach((p) => {
      const rawVal = countedMap[p.id!];
      if (rawVal === undefined || rawVal.trim() === '') return;
      const parsed = Number(rawVal);
      if (!Number.isFinite(parsed) || parsed < 0) return;
      countedItems += 1;
      const diff = parsed - p.quantity;
      if (Math.abs(diff) >= 0.0001) {
        changedItems += 1;
        const val = diff * p.purchasePrice;
        if (val > 0) surplusValue += val;
        else shortageValue += Math.abs(val);
      }
    });

    const netImpact = surplusValue - shortageValue;
    return { countedItems, changedItems, surplusValue, shortageValue, netImpact };
  }, [products, countedMap]);

  const handleCountChange = (productId: number, val: string) => {
    setCountedMap((prev) => ({ ...prev, [productId]: val }));
  };

  const handleMatchSystem = (p: Product) => {
    setCountedMap((prev) => ({ ...prev, [p.id!]: String(p.quantity) }));
  };

  const handleCommitStocktake = async () => {
    if (!currentUser) return;
    const toAdjust = products
      .map((p) => {
        const raw = countedMap[p.id!];
        if (raw === undefined || raw.trim() === '') return null;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) return null;
        if (Math.abs(parsed - p.quantity) < 0.0001) return null;
        return { product: p, newQty: parsed };
      })
      .filter((x): x is { product: Product; newQty: number } => x !== null);

    if (toAdjust.length === 0) {
      notify(
        t(lang, 'لا توجد فروقات مسجلة لاعتمادها حالياً', 'Aucun écart saisi à valider'),
        'warning'
      );
      return;
    }

    setSaving(true);
    try {
      const noteText =
        sessionNote.trim() ||
        t(lang, `جرد مخزون فعلي (${new Date().toISOString().slice(0, 10)})`, `Inventaire physique (${new Date().toISOString().slice(0, 10)})`);

      for (const item of toAdjust) {
        await adjustProductStock(
          item.product.id!,
          'adjustment',
          item.newQty,
          true,
          noteText,
          currentUser
        );
      }

      setCountedMap({});
      setSessionNote('');
      notify(
        t(
          lang,
          `تم اعتماد الجرد وتحديث مخزون ${toAdjust.length} منتج بنجاح`,
          `Inventaire validé : ${toAdjust.length} produit(s) ajusté(s)`
        )
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveDamage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!damageProduct || !currentUser) return;
    try {
      await adjustProductStock(
        damageProduct.id!,
        damageMode,
        -Math.abs(damageQty),
        false,
        damageNote.trim() || (damageMode === 'damage' ? 'منتج تالف' : 'منتج مفقود'),
        currentUser
      );
      notify(t(lang, 'تم تسجيل التالف/المفقود وتحديث المخزون', 'Avarie/perte enregistrée'));
      setDamageProduct(null);
      setDamageNote('');
      setDamageQty(1);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleExportExcel = () => {
    exportRowsToExcel(
      rows.map((r) => ({
        [t(lang, 'المنتج', 'Produit')]: r.product.name,
        [t(lang, 'الباركود', 'Code-barres')]: r.product.barcode,
        [t(lang, 'العائلة', 'Famille')]: r.categoryName,
        [t(lang, 'الكمية بالنظام', 'Stock système')]: r.product.quantity,
        [t(lang, 'الكمية الفعلية', 'Qté comptée')]: r.countedQty ?? '',
        [t(lang, 'الفرق', 'Écart')]: r.hasCount ? r.variance : '',
        [t(lang, 'قيمة الفرق', 'Valeur écart')]: r.hasCount ? r.varianceValue.toFixed(2) : '',
      })),
      'Stocktake',
      `stocktake_${new Date().toISOString().slice(0, 10)}.xlsx`
    );
  };

  const handleExportPdf = () => {
    exportTableToPdf(
      t(lang, 'ورقة جرد المخزون الفعلي', 'Fiche d’inventaire physique'),
      `${new Date().toISOString().slice(0, 10)} · ${rows.length} ${t(lang, 'منتج', 'produits')}`,
      [
        t(lang, 'المنتج', 'Produit'),
        t(lang, 'الباركود', 'Code-barres'),
        t(lang, 'بالنظام', 'Système'),
        t(lang, 'الفعلية', 'Réelle'),
        t(lang, 'الفرق', 'Écart'),
        t(lang, 'قيمة الفرق', 'Impact'),
      ],
      rows.map((r) => [
        r.product.name,
        r.product.barcode,
        r.product.quantity,
        r.countedQty ?? '____',
        r.hasCount ? (r.variance > 0 ? `+${r.variance}` : r.variance) : '—',
        r.hasCount ? r.varianceValue.toFixed(2) : '—',
      ]),
      `stocktake_${new Date().toISOString().slice(0, 10)}.pdf`
    );
  };

  const handlePrintSheet = () => {
    openPrint({
      type: 'generic_report',
      title: t(lang, 'ورقة جرد المخزون الفعلي', 'Fiche d’inventaire physique'),
      subtitle: `${new Date().toISOString().slice(0, 10)} · ${rows.length} ${t(lang, 'منتج', 'produits')}`,
      summaryItems: [
        { label: t(lang, 'إجمالي المنتجات', 'Total produits'), value: String(products.length) },
        { label: t(lang, 'المنتجات المجرودة', 'Produits comptés'), value: String(summary.countedItems) },
        { label: t(lang, 'عدد الفروقات', 'Écarts détectés'), value: String(summary.changedItems) },
        { label: t(lang, 'صافي قيمة الفروقات', 'Impact net'), value: formatMoney(summary.netImpact, cur) },
      ],
      columns: [
        t(lang, 'المنتج', 'Produit'),
        t(lang, 'الباركود', 'Code-barres'),
        t(lang, 'العائلة', 'Famille'),
        t(lang, 'الكمية بالنظام', 'Stock système'),
        t(lang, 'الكمية الفعلية', 'Qté comptée'),
        t(lang, 'الفرق', 'Écart'),
      ],
      rows: rows.map((r) => [
        r.product.name,
        r.product.barcode,
        r.categoryName,
        r.product.quantity,
        r.countedQty ?? '______',
        r.hasCount ? (r.variance > 0 ? `+${r.variance}` : r.variance) : '—',
      ]),
    });
  };

  return (
    <div className="space-y-4">
      {/* Header & Mode Switch */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900">
            {t(lang, 'جرد المخزون الفعلي وتسوية الفروقات', 'Inventaire physique & régularisation')}
          </h2>
          <p className="text-xs text-slate-500">
            {t(
              lang,
              'أدخل الكميات الفعلية الموجودة في المتجر لحساب الفروقات تلقائياً واعتماد التسوية بضغطة زر',
              'Saisissez les quantités physiques comptées pour calculer automatiquement les écarts et valider l’ajustement'
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg bg-slate-200/70 p-1">
            <button
              type="button"
              onClick={() => setViewTab('count')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap ${
                viewTab === 'count' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              {t(lang, 'جلسة الجرد', 'Session inventaire')}
            </button>
            <button
              type="button"
              onClick={() => setViewTab('history')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap ${
                viewTab === 'history' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              <History className="h-3.5 w-3.5" />
              {t(lang, 'سجل الجرد والتالف', 'Historique')} ({stockMovements.length})
            </button>
          </div>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">{t(lang, 'إجمالي المنتجات / المجرودة', 'Produits / Comptés')}</div>
          <div className="mt-1 font-mono text-lg font-bold text-slate-900 tabular-nums">
            {summary.countedItems} <span className="text-xs font-normal text-slate-400">/ {products.length}</span>
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">{t(lang, 'منتجات بها فروقات', 'Articles avec écart')}</div>
          <div className="mt-1 font-mono text-lg font-bold text-amber-700 tabular-nums">
            {summary.changedItems}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">{t(lang, 'قيمة الزيادة / العجز', 'Surplus / Manquant')}</div>
          <div className="mt-1 flex items-center gap-2 font-mono text-sm font-bold tabular-nums">
            <span className="text-emerald-700">+{formatMoney(summary.surplusValue, cur)}</span>
            <span className="text-slate-300">/</span>
            <span className="text-red-700">-{formatMoney(summary.shortageValue, cur)}</span>
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3.5">
          <div className="text-xs text-slate-500">{t(lang, 'صافي أثر الفروقات بالتكلفة', 'Impact net au coût')}</div>
          <div
            className={`mt-1 font-mono text-lg font-bold tabular-nums ${
              summary.netImpact > 0
                ? 'text-emerald-700'
                : summary.netImpact < 0
                  ? 'text-red-700'
                  : 'text-slate-900'
            }`}
          >
            {summary.netImpact > 0 ? '+' : ''}
            {formatMoney(summary.netImpact, cur)}
          </div>
        </div>
      </div>

      {viewTab === 'count' ? (
        <>
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="pointer-events-none absolute top-2.5 start-3 h-4 w-4 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t(lang, 'بحث بالاسم أو الباركود أو المرجع...', 'Produit, code-barres, SKU...')}
                className="w-full rounded-lg border border-slate-300 bg-slate-50 py-1.5 ps-9 pe-3 text-xs focus:border-blue-600 focus:bg-white focus:outline-none"
              />
            </div>

            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700"
            >
              <option value="all">{t(lang, 'جميع العائلات', 'Toutes les familles')}</option>
              {categories.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {lang === 'ar' ? c.nameAr : c.nameFr}
                </option>
              ))}
            </select>

            <div className="flex items-center rounded-lg bg-slate-100 p-0.5 text-xs">
              {(
                [
                  { id: 'all', ar: 'الكل', fr: 'Tout' },
                  { id: 'counted', ar: 'مجرود', fr: 'Comptés' },
                  { id: 'variance', ar: 'بها فروقات', fr: 'Écarts' },
                  { id: 'uncounted', ar: 'لم يُجرد', fr: 'Non comptés' },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setStatusFilter(f.id)}
                  className={`rounded-md px-2.5 py-1 font-semibold whitespace-nowrap ${
                    statusFilter === f.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                  }`}
                >
                  {lang === 'ar' ? f.ar : f.fr}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-1.5 ms-auto">
              <button
                type="button"
                onClick={handlePrintSheet}
                className="inline-flex items-center gap-1 rounded-lg bg-[#2E75B6] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1D548A]"
              >
                <Printer className="h-3.5 w-3.5" /> {t(lang, 'طباعة', 'Imprimer')}
              </button>
              <button
                type="button"
                onClick={handleExportPdf}
                className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400"
              >
                <FileDown className="h-3.5 w-3.5" /> PDF
              </button>
              <button
                type="button"
                onClick={handleExportExcel}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5" /> Excel
              </button>
            </div>
          </div>

          {/* Commit Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-2.5">
            <input
              value={sessionNote}
              onChange={(e) => setSessionNote(e.target.value)}
              placeholder={t(
                lang,
                'ملاحظة جلسة الجرد (مثال: جرد نهاية الشهر)...',
                'Note de session d’inventaire (ex: Inventaire fin de mois)...'
              )}
              className="flex-1 min-w-[220px] rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs focus:border-blue-600 focus:outline-none"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={Object.keys(countedMap).length === 0}
                onClick={() => setCountedMap({})}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t(lang, 'إعادة تعيين', 'Réinitialiser')}
              </button>
              <button
                type="button"
                disabled={saving || summary.changedItems === 0}
                onClick={handleCommitStocktake}
                className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-1.5 text-xs font-bold text-white hover:bg-teal-800 disabled:opacity-40"
              >
                <CheckCircle2 className="h-4 w-4" />
                {t(
                  lang,
                  `اعتماد وحفظ الجرد (${summary.changedItems})`,
                  `Valider l’inventaire (${summary.changedItems})`
                )}
              </button>
            </div>
          </div>

          {/* Main Stocktake Table */}
          <div className="rounded-xl border border-slate-300 bg-white overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-[#DCE6F2] text-slate-900">
                    <th className="border border-slate-300 px-3 py-2.5 text-start font-bold">
                      {t(lang, 'المنتج', 'Produit')}
                    </th>
                    <th className="border border-slate-300 px-3 py-2.5 text-center font-bold">
                      {t(lang, 'الباركود', 'Code-barres')}
                    </th>
                    <th className="border border-slate-300 px-3 py-2.5 text-center font-bold">
                      {t(lang, 'العائلة', 'Famille')}
                    </th>
                    <th className="border border-slate-300 px-3 py-2.5 text-center font-bold">
                      {t(lang, 'الكمية بالنظام', 'Stock système')}
                    </th>
                    <th className="border border-slate-300 px-3 py-2.5 text-center font-bold w-36">
                      {t(lang, 'الكمية الفعلية', 'Qté comptée')}
                    </th>
                    <th className="border border-slate-300 px-3 py-2.5 text-center font-bold">
                      {t(lang, 'الفرق (+/-)', 'Écart')}
                    </th>
                    <th className="border border-slate-300 px-3 py-2.5 text-end font-bold">
                      {t(lang, 'قيمة الفرق', 'Valeur écart')}
                    </th>
                    <th className="border border-slate-300 px-3 py-2.5 text-center font-bold">
                      {t(lang, 'إجراءات', 'Actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.product.id}
                      className={`hover:bg-slate-50 ${
                        r.hasCount && Math.abs(r.variance) >= 0.0001
                          ? r.variance > 0
                            ? 'bg-emerald-50/40'
                            : 'bg-red-50/40'
                          : ''
                      }`}
                    >
                      <td className="border border-slate-200 px-3 py-2 font-semibold text-slate-900">
                        {r.product.name}
                      </td>
                      <td className="border border-slate-200 px-3 py-2 text-center font-mono text-slate-600">
                        {r.product.barcode}
                      </td>
                      <td className="border border-slate-200 px-3 py-2 text-center text-slate-600">
                        {r.categoryName}
                      </td>
                      <td className="border border-slate-200 px-3 py-2 text-center font-mono font-bold tabular-nums text-slate-900">
                        {r.product.quantity} <span className="text-[11px] font-normal text-slate-500">{r.product.unit}</span>
                      </td>
                      <td className="border border-slate-200 px-2 py-1.5 text-center">
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          value={r.rawVal}
                          onChange={(e) => handleCountChange(r.product.id!, e.target.value)}
                          placeholder={String(r.product.quantity)}
                          className="w-24 rounded-md border border-slate-300 bg-white px-2 py-1 text-center font-mono text-xs font-bold text-slate-900 focus:border-blue-600 focus:outline-none tabular-nums"
                        />
                      </td>
                      <td
                        className={`border border-slate-200 px-3 py-2 text-center font-mono font-bold tabular-nums ${
                          !r.hasCount
                            ? 'text-slate-300'
                            : r.variance > 0
                              ? 'text-emerald-700'
                              : r.variance < 0
                                ? 'text-red-700'
                                : 'text-slate-500'
                        }`}
                      >
                        {!r.hasCount
                          ? '—'
                          : r.variance > 0
                            ? `+${r.variance}`
                            : String(r.variance)}
                      </td>
                      <td
                        className={`border border-slate-200 px-3 py-2 text-end font-mono font-semibold tabular-nums ${
                          !r.hasCount
                            ? 'text-slate-300'
                            : r.varianceValue > 0
                              ? 'text-emerald-700'
                              : r.varianceValue < 0
                                ? 'text-red-700'
                                : 'text-slate-500'
                        }`}
                      >
                        {r.hasCount ? formatMoney(r.varianceValue, cur) : '—'}
                      </td>
                      <td className="border border-slate-200 px-2 py-1.5 text-center">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleMatchSystem(r.product)}
                            title={t(lang, 'مطابق للنظام', 'Conforme au système')}
                            className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                          >
                            {t(lang, 'مطابق', 'OK')}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDamageProduct(r.product);
                              setDamageMode('damage');
                              setDamageQty(1);
                              setDamageNote('');
                            }}
                            title={t(lang, 'تسجيل تالف أو مفقود', 'Avarie / Perte')}
                            className="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-100"
                          >
                            <Trash2 className="h-3 w-3 inline" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="p-8 text-center text-slate-400">
                        {t(lang, 'لا توجد منتجات مطابقة للبحث', 'Aucun produit trouvé')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        /* History Tab */
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <th className="p-3 text-start">{t(lang, 'التاريخ', 'Date')}</th>
                  <th className="p-3 text-start">{t(lang, 'المنتج', 'Produit')}</th>
                  <th className="p-3 text-center">{t(lang, 'العملية', 'Type')}</th>
                  <th className="p-3 text-center">{t(lang, 'الفرق', 'Écart')}</th>
                  <th className="p-3 text-center">{t(lang, 'قبل ← بعد', 'Avant → Après')}</th>
                  <th className="p-3 text-start">{t(lang, 'المستخدم / الملاحظة', 'Utilisateur / Note')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {stockMovements.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-50">
                    <td className="p-3 text-slate-600 tabular-nums">{formatDateTime(m.date, lang)}</td>
                    <td className="p-3 font-semibold text-slate-900">{m.productName}</td>
                    <td className="p-3 text-center font-medium text-slate-700">
                      {m.type === 'adjustment'
                        ? t(lang, 'جرد وتسوية', 'Inventaire')
                        : m.type === 'damage'
                          ? t(lang, 'تالف', 'Avarie')
                          : t(lang, 'مفقود', 'Perte')}
                    </td>
                    <td
                      className={`p-3 text-center font-mono font-bold tabular-nums ${
                        m.quantityDelta >= 0 ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {m.quantityDelta > 0 ? '+' : ''}
                      {m.quantityDelta}
                    </td>
                    <td className="p-3 text-center font-mono text-slate-600 tabular-nums">
                      {m.beforeQty} → <strong>{m.afterQty}</strong>
                    </td>
                    <td className="p-3 text-slate-600">
                      {m.userName} {m.note ? `· ${m.note}` : ''}
                    </td>
                  </tr>
                ))}
                {stockMovements.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-400">
                      {t(lang, 'لا توجد عمليات جرد أو تسوية مسجلة بعد', 'Aucun inventaire enregistré')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Damage / Loss Modal */}
      {damageProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleSaveDamage}
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl space-y-4"
          >
            <h3 className="text-base font-bold text-slate-900">
              {t(lang, 'تسجيل تالف أو مفقود', 'Déclarer une avarie ou perte')}
            </h3>
            <p className="text-xs text-slate-600">
              <strong>{damageProduct.name}</strong> — {t(lang, 'الكمية الحالية:', 'Stock actuel :')}{' '}
              <span className="font-mono font-bold">{damageProduct.quantity}</span>
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'النوع', 'Motif')}
              </label>
              <select
                value={damageMode}
                onChange={(e) => setDamageMode(e.target.value as 'damage' | 'loss')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
              >
                <option value="damage">{t(lang, 'تالف / منتهي الصلاحية', 'Avarie / Périmé')}</option>
                <option value="loss">{t(lang, 'مفقود / ضياع', 'Perte')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'الكمية المخصومة', 'Quantité à déduire')}
              </label>
              <input
                type="number"
                step="0.1"
                min="0.1"
                required
                value={damageQty}
                onChange={(e) => setDamageQty(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'الملاحظة', 'Observation')}
              </label>
              <input
                required
                value={damageNote}
                onChange={(e) => setDamageNote(e.target.value)}
                placeholder={t(lang, 'سبب الخصم...', 'Raison...')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDamageProduct(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs"
              >
                {t(lang, 'إلغاء', 'Annuler')}
              </button>
              <button
                type="submit"
                className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700"
              >
                {t(lang, 'تأكيد الخصم', 'Valider')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
