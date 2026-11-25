import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowRight,
  Ban,
  Calculator,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Layers,
  Package,
  Percent,
  Printer,
  RotateCcw,
  Save,
  ScanBarcode,
  Search,
  Trash2,
  Truck,
  X,
} from 'lucide-react';
import { db } from '../db/database';
import {
  cancelPurchaseInvoice,
  createPurchaseInvoice,
  createSupplierReturn,
  makeIdempotencyKey,
  round2,
} from '../db/operations';
import { useApp } from '../context/AppContext';
import { PaymentMethod, Product, PurchaseInvoice, PurchaseInvoiceItem } from '../types';
import {
  formatDateTime,
  formatMoney,
  getPaymentMethodLabel,
  getStatusLabel,
  t,
} from '../i18n/translations';
import { exportRowsToExcel } from '../utils/export';
import { CameraBarcodeScannerModal } from '../components/CameraBarcodeScannerModal';
import { CalculatorModal } from '../components/CalculatorModal';

type PurchaseKeypadTarget = 'qty' | 'cost' | 'paid' | 'discount';

export const PurchasesModule: React.FC = () => {
  const { lang, settings, currentUser, notify, openPrint, setActiveSection } = useApp();
  const cur = settings.storeInfo.currency || 'MAD';

  const [activeTab, setActiveTab] = useState<'new' | 'log' | 'returns'>('new');
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const suppliers = useLiveQuery(() => db.suppliers.toArray(), []) ?? [];
  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const categories = useLiveQuery(() => db.categories.toArray(), []) ?? [];
  const purchases = useLiveQuery(() => db.purchaseInvoices.orderBy('date').reverse().toArray(), []) ?? [];
  const supplierReturns = useLiveQuery(() => db.supplierReturns.orderBy('date').reverse().toArray(), []) ?? [];

  // New Purchase Terminal State
  const [supplierId, setSupplierId] = useState<number>(1);
  const [barcodeInput, setBarcodeInput] = useState('');
  const [nameSearch, setNameSearch] = useState('');
  const [selectedCat, setSelectedCat] = useState<string>('all');
  const [catPage, setCatPage] = useState<number>(0);

  const [items, setItems] = useState<PurchaseInvoiceItem[]>([]);
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);
  const [keypadTarget, setKeypadTarget] = useState<PurchaseKeypadTarget>('qty');
  const [keypadBuffer, setKeypadBuffer] = useState<string>('');

  const [discountAmount, setDiscountAmount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [paidAmount, setPaidAmount] = useState<string>('');
  const [costingMethod, setCostingMethod] = useState<'weighted_avg' | 'last_cost'>(
    settings.posConfig.defaultCostingMethod || 'weighted_avg'
  );
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastPurchase, setLastPurchase] = useState<PurchaseInvoice | null>(null);

  // Modals
  const [showCameraScanner, setShowCameraScanner] = useState(false);
  const [showCalculator, setShowCalculator] = useState(false);
  const [showNameSearchModal, setShowNameSearchModal] = useState(false);
  const [showExtrasModal, setShowExtrasModal] = useState(false);

  // Log filters (7.1)
  const [logSearch, setLogSearch] = useState('');
  const [logStatus, setLogStatus] = useState('all');

  // Supplier Return Builder (7.2)
  const [retPurchaseId, setRetPurchaseId] = useState<number | ''>('');
  const [retQtys, setRetQtys] = useState<Record<number, number>>({});
  const [retSettlement, setRetSettlement] = useState<'cash' | 'credit_note' | 'bank_transfer'>('credit_note');
  const [retReason, setRetReason] = useState('');

  const barcodeInputRef = useRef<HTMLInputElement | null>(null);
  const nameSearchInputRef = useRef<HTMLInputElement | null>(null);

  const filteredProducts = useMemo(() => {
    const q = nameSearch.trim().toLowerCase();
    return products.filter((p) => {
      const matchCat = selectedCat === 'all' || String(p.categoryId ?? '') === selectedCat;
      const matchQ =
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.barcode.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q);
      return matchCat && matchQ;
    });
  }, [products, nameSearch, selectedCat]);

  // Categories 12-slot pagination (2 rows × 6 cols matching blueprint)
  const allCategorySlots = useMemo(() => {
    return [
      { id: 'all', label: t(lang, 'الكل', 'Tous') },
      ...categories.map((c) => ({
        id: String(c.id),
        label: lang === 'ar' ? c.nameAr : c.nameFr,
      })),
    ];
  }, [categories, lang]);

  const CATS_PER_PAGE = 12;
  const totalCatPages = Math.max(1, Math.ceil(allCategorySlots.length / CATS_PER_PAGE));
  const safeCatPage = Math.min(catPage, totalCatPages - 1);
  const visibleCategories = useMemo(() => {
    const start = safeCatPage * CATS_PER_PAGE;
    return allCategorySlots.slice(start, start + CATS_PER_PAGE);
  }, [allCategorySlots, safeCatPage]);

  const addProductLine = (p: Product): boolean => {
    const exists = items.find((i) => i.productId === p.id);
    const step = p.isWeighted ? 1 : 1;
    if (exists) {
      const nextQty = round2(exists.quantity + step);
      setItems((prev) =>
        prev.map((i) =>
          i.productId === p.id
            ? {
                ...i,
                quantity: nextQty,
                total: round2(nextQty * i.unitCost - i.discount),
              }
            : i
        )
      );
    } else {
      const initialQty = 1;
      setItems((prev) => [
        ...prev,
        {
          productId: p.id!,
          productName: p.name,
          barcode: p.barcode,
          unit: p.unit,
          quantity: initialQty,
          unitCost: p.purchasePrice,
          discount: 0,
          total: round2(initialQty * p.purchasePrice),
        },
      ]);
    }
    setSelectedProductId(p.id!);
    setKeypadTarget('qty');
    setKeypadBuffer('');
    return true;
  };

  const lookupAndAddBarcode = (rawCode: string): { found: boolean; label?: string } => {
    const q = rawCode.trim().toLowerCase();
    if (!q) return { found: false };
    const exact = products.find(
      (p) => p.barcode.toLowerCase() === q || p.sku.toLowerCase() === q
    );
    if (!exact) {
      notify(
        t(lang, `لم يتم العثور على منتج بالباركود: ${rawCode}`, `Code-barres introuvable : ${rawCode}`),
        'warning'
      );
      return { found: false };
    }
    addProductLine(exact);
    return { found: true, label: exact.name };
  };

  const handleBarcodeEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const q = barcodeInput.trim();
    if (!q) return;
    e.preventDefault();
    const res = lookupAndAddBarcode(q);
    if (res.found) {
      setBarcodeInput('');
    } else {
      setNameSearch(q);
    }
  };

  const updatePurchaseItem = (productId: number, patch: Partial<PurchaseInvoiceItem>) => {
    setItems((prev) =>
      prev
        .map((x) => {
          if (x.productId !== productId) return x;
          const nextQty = patch.quantity !== undefined ? Math.max(0, patch.quantity) : x.quantity;
          const nextCost = patch.unitCost !== undefined ? Math.max(0, patch.unitCost) : x.unitCost;
          const nextDisc = patch.discount !== undefined ? Math.max(0, patch.discount) : x.discount;
          return {
            ...x,
            quantity: nextQty,
            unitCost: nextCost,
            discount: nextDisc,
            total: round2(Math.max(0, nextQty * nextCost - nextDisc)),
          };
        })
        .filter((x) => x.quantity > 0)
    );
  };

  const handleDeleteSelectedLine = () => {
    if (items.length === 0) {
      notify(t(lang, 'فاتورة الشراء فارغة', 'Le bon d’achat est vide'), 'warning');
      return;
    }
    const targetId = selectedProductId ?? items[items.length - 1]?.productId;
    if (!targetId) return;
    const idx = items.findIndex((i) => i.productId === targetId);
    const nextItems = items.filter((i) => i.productId !== targetId);
    setItems(nextItems);
    const fallback = nextItems[Math.max(0, idx - 1)] ?? nextItems[0] ?? null;
    setSelectedProductId(fallback?.productId ?? null);
    setKeypadBuffer('');
  };

  // Numeric Keypad Handler (tailored for Purchases: Qty, Unit Cost, Paid, Discount)
  const handleKeypadPress = (key: string) => {
    if (key === 'CL') {
      setKeypadBuffer('');
      if (keypadTarget === 'paid') {
        setPaidAmount('');
      } else if (keypadTarget === 'discount') {
        setDiscountAmount(0);
      } else if (keypadTarget === 'qty' && selectedProductId) {
        updatePurchaseItem(selectedProductId, { quantity: 1 });
      }
      return;
    }

    const normalizedKey = key === ',' ? '.' : key;
    if (normalizedKey === '.' && keypadBuffer.includes('.')) return;
    const nextBuf =
      keypadBuffer === '' && normalizedKey === '.' ? '0.' : keypadBuffer + normalizedKey;
    setKeypadBuffer(nextBuf);

    const parsed = parseFloat(nextBuf);
    if (Number.isNaN(parsed)) return;

    if (keypadTarget === 'paid') {
      if (paymentMethod === 'credit') setPaymentMethod('cash');
      setPaidAmount(nextBuf);
    } else if (keypadTarget === 'discount') {
      setDiscountAmount(Math.max(0, parsed));
    } else {
      const targetId = selectedProductId ?? items[items.length - 1]?.productId;
      if (!targetId) {
        notify(t(lang, 'اختر منتجاً من فاتورة الشراء أولاً', 'Sélectionnez une ligne d’abord'), 'warning');
        return;
      }
      setSelectedProductId(targetId);
      if (keypadTarget === 'qty') {
        if (parsed > 0) updatePurchaseItem(targetId, { quantity: parsed });
      } else if (keypadTarget === 'cost') {
        updatePurchaseItem(targetId, { unitCost: parsed });
      }
    }
  };

  const subtotal = round2(items.reduce((s, i) => s + i.total, 0));
  const total = round2(Math.max(0, subtotal - discountAmount));
  const effectivePaid =
    paymentMethod === 'credit'
      ? 0
      : paidAmount === ''
        ? total
        : Math.min(total, Math.max(0, Number(paidAmount) || 0));
  const remaining = round2(Math.max(0, total - effectivePaid));

  const selectQuickPaymentMethod = (method: PaymentMethod) => {
    setPaymentMethod(method);
    if (method === 'credit') {
      setPaidAmount('0');
    } else if (paidAmount === '0') {
      setPaidAmount('');
    }
  };

  const handleSavePurchase = async (shouldPrint: boolean) => {
    if (!currentUser?.permissions.canPurchase) {
      notify(t(lang, 'ليس لديك صلاحية تسجيل المشتريات', 'Permission achats refusée'), 'error');
      return;
    }
    const sup = suppliers.find((s) => s.id === supplierId);
    if (!sup) {
      notify(t(lang, 'اختر مورداً أولاً', 'Sélectionnez un fournisseur'), 'warning');
      return;
    }
    if (!items.length) {
      notify(t(lang, 'أضف منتجات لفاتورة الشراء', 'Ajoutez des produits'), 'warning');
      return;
    }
    setSaving(true);
    try {
      const inv = await createPurchaseInvoice(
        {
          supplierId: sup.id!,
          supplierName: sup.businessName,
          items,
          discountAmount,
          paidAmount: effectivePaid,
          paymentMethod,
          costingMethod,
          notes: notes.trim() || undefined,
          idempotencyKey: makeIdempotencyKey('ach'),
        },
        currentUser
      );
      setLastPurchase(inv);
      setItems([]);
      setSelectedProductId(null);
      setKeypadBuffer('');
      setDiscountAmount(0);
      setPaidAmount('');
      setPaymentMethod('cash');
      setNotes('');
      notify(
        t(
          lang,
          `تم تسجيل فاتورة المشتريات ${inv.invoiceNumber} وتحديث المخزون والتكلفة`,
          `Achat ${inv.invoiceNumber} enregistré et stock mis à jour`
        )
      );
      if (shouldPrint) openPrint({ type: 'purchase_invoice', invoice: inv });
      barcodeInputRef.current?.focus();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const filteredLog = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    return purchases.filter((p) => {
      const matchQ =
        !q ||
        p.invoiceNumber.toLowerCase().includes(q) ||
        p.supplierName.toLowerCase().includes(q);
      const matchStatus = logStatus === 'all' || p.status === logStatus;
      return matchQ && matchStatus;
    });
  }, [purchases, logSearch, logStatus]);

  const handleCancelPurchase = async (inv: PurchaseInvoice) => {
    if (!currentUser) return;
    try {
      await cancelPurchaseInvoice(inv.id!, 'إلغاء فاتورة شراء من السجل', currentUser);
      notify(t(lang, 'تم إلغاء فاتورة الشراء وتصحيح المخزون', 'Facture d’achat annulée'));
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const selectedRetPurchase = purchases.find((p) => p.id === retPurchaseId) ?? null;

  const handleCreateSupplierReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRetPurchase || !currentUser) return;
    const rItems = selectedRetPurchase.items
      .filter((it) => (retQtys[it.productId] ?? 0) > 0)
      .map((it) => {
        const qty = Number(retQtys[it.productId]) || 0;
        return {
          productId: it.productId,
          productName: it.productName,
          barcode: it.barcode,
          quantity: qty,
          unitCost: it.unitCost,
          total: round2(qty * it.unitCost),
        };
      });
    try {
      const ret = await createSupplierReturn(
        selectedRetPurchase.id!,
        rItems,
        retSettlement,
        retReason || 'بضاعة غير مطابقة / مرتجع للمورد',
        currentUser
      );
      notify(t(lang, `تم تسجيل مرتجع المورد ${ret.returnNumber}`, `Retour ${ret.returnNumber} enregistré`));
      setRetPurchaseId('');
      setRetQtys({});
      setRetReason('');
      openPrint({ type: 'supplier_return', ret });
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const liveDateStr = now.toLocaleDateString(lang === 'ar' ? 'ar-MA' : 'fr-FR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const liveTimeStr = now.toLocaleTimeString(lang === 'ar' ? 'ar-MA' : 'fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  return (
    <div className="space-y-3">
      {/* TOP AMBER/GOLD BAR (Matching blueprint image, tailored for Purchases) */}
      <div className="rounded-xl border-2 border-amber-400 bg-amber-300 px-3 py-2 shadow-sm text-slate-950">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          {/* Start (Right in RTL): Back Button + Supplier Selector */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveSection('home')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-600/40 bg-amber-200/80 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-white transition-colors"
            >
              <ArrowRight className={`h-4 w-4 ${lang === 'fr' ? 'rotate-180' : ''}`} />
              <span>{t(lang, 'الرجوع', 'Retour')}</span>
            </button>

            <div className="flex items-center gap-1.5 rounded-lg border border-amber-600/40 bg-white/90 px-2.5 py-1">
              <Truck className="h-4 w-4 text-amber-800 shrink-0" />
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(Number(e.target.value))}
                aria-label={t(lang, 'اختيار المورد', 'Choisir le fournisseur')}
                className="bg-transparent text-xs font-bold text-slate-900 focus:outline-none max-w-[180px] sm:max-w-[230px]"
              >
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.businessName}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Center: Logo + Program Name + Sub-tabs (7. / 7.1 / 7.2) */}
          <div className="flex flex-wrap items-center justify-center gap-2.5">
            <div className="flex items-center gap-2">
              <img
                src="/assets/aistudio/image_39bba8ff.png"
                alt="RM.POS GC"
                className="h-9 w-9 rounded-lg object-contain shadow-sm shrink-0"
              />
              <div className="leading-tight">
                <div className="flex items-center gap-1.5 text-sm font-black tracking-tight text-slate-950">
                  <span dir="ltr">RM.POS GC</span>
                  <span className="text-amber-900/50">·</span>
                  <span className="truncate max-w-[160px]">{settings.storeInfo.storeName}</span>
                </div>
                <div className="text-[10px] font-bold text-amber-950/75">
                  {t(lang, 'نقطة المشتريات والاستلام — Achats', 'Réception & Achats Fournisseurs')}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1 rounded-lg bg-amber-400/70 p-0.5 border border-amber-500/50">
              <button
                type="button"
                onClick={() => setActiveTab('new')}
                className={`rounded-md px-2.5 py-1 text-[11px] font-bold whitespace-nowrap ${
                  activeTab === 'new'
                    ? 'bg-slate-950 text-amber-300 shadow-sm'
                    : 'text-slate-900 hover:bg-amber-200/70'
                }`}
              >
                {t(lang, '7. فاتورة شراء', '7. Nouvel achat')}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('log')}
                className={`rounded-md px-2.5 py-1 text-[11px] font-bold whitespace-nowrap ${
                  activeTab === 'log'
                    ? 'bg-slate-950 text-amber-300 shadow-sm'
                    : 'text-slate-900 hover:bg-amber-200/70'
                }`}
              >
                {t(lang, `7.1 السجل (${purchases.length})`, `7.1 Achats (${purchases.length})`)}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('returns')}
                className={`rounded-md px-2.5 py-1 text-[11px] font-bold whitespace-nowrap ${
                  activeTab === 'returns'
                    ? 'bg-slate-950 text-amber-300 shadow-sm'
                    : 'text-slate-900 hover:bg-amber-200/70'
                }`}
              >
                {t(lang, `7.2 مسترجعات (${supplierReturns.length})`, `7.2 Retours (${supplierReturns.length})`)}
              </button>
            </div>
          </div>

          {/* End (Left in RTL): Live Date & Time */}
          <div className="rounded-lg border border-amber-600/40 bg-amber-200/75 px-3 py-1 text-center font-mono leading-tight tabular-nums">
            <div className="text-xs font-extrabold text-slate-950">{liveTimeStr}</div>
            <div className="text-[10px] font-semibold text-slate-800">{liveDateStr}</div>
          </div>
        </div>
      </div>

      {/* TAB 7: NEW PURCHASE TERMINAL (Matching blueprint tailored for Purchases) */}
      {activeTab === 'new' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5 items-stretch">
          {/* RIGHT PANEL IN RTL (5 cols): Purchase Lines Table + Barcode/Camera + TOTALE + Keypad & Purchase Actions */}
          <div className="lg:col-span-5 flex flex-col gap-2">
            {/* 1. Purchase Cart Table (Qte | article | P.A | total) */}
            <div className="rounded-xl border-2 border-slate-800 bg-white overflow-hidden shadow-sm">
              <div className="h-[250px] lg:h-[295px] overflow-y-auto">
                <table className="w-full border-collapse text-xs">
                  <thead className="sticky top-0 z-10 bg-slate-100 text-slate-900">
                    <tr className="border-b-2 border-slate-800">
                      <th className="w-16 border-e border-slate-400 px-2 py-2 text-center font-extrabold">
                        Qte
                      </th>
                      <th className="border-e border-slate-400 px-2 py-2 text-start font-extrabold">
                        article
                      </th>
                      <th className="w-20 border-e border-slate-400 px-2 py-2 text-end font-extrabold">
                        {t(lang, 'سعر الشراء', 'P.A')}
                      </th>
                      <th className="w-20 px-2 py-2 text-end font-extrabold">
                        total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => {
                      const isSelected = selectedProductId === it.productId;
                      return (
                        <tr
                          key={it.productId}
                          onClick={() => {
                            setSelectedProductId(it.productId);
                            setKeypadBuffer('');
                          }}
                          className={`cursor-pointer border-b border-slate-300 transition-colors ${
                            isSelected
                              ? 'bg-sky-100 text-slate-950 font-semibold'
                              : 'hover:bg-slate-50 text-slate-800'
                          }`}
                        >
                          <td className="border-e border-slate-300 px-1.5 py-1.5 text-center font-mono font-bold tabular-nums">
                            {it.quantity}
                          </td>
                          <td className="border-e border-slate-300 px-2 py-1.5">
                            <div className="truncate font-semibold max-w-[165px] sm:max-w-[200px]">
                              {it.productName}
                            </div>
                          </td>
                          <td className="border-e border-slate-300 px-2 py-1.5 text-end font-mono tabular-nums text-teal-900">
                            {it.unitCost.toFixed(2)}
                          </td>
                          <td className="px-2 py-1.5 text-end font-mono font-bold tabular-nums">
                            {it.total.toFixed(2)}
                          </td>
                        </tr>
                      );
                    })}
                    {Array.from({ length: Math.max(0, 8 - items.length) }).map((_, i) => (
                      <tr key={`empty-p-${i}`} className="h-8 border-b border-slate-200/90">
                        <td className="border-e border-slate-200/90" />
                        <td className="border-e border-slate-200/90" />
                        <td className="border-e border-slate-200/90" />
                        <td />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Compact Footer Bar for Purchase Specifics */}
              <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-slate-300 bg-slate-50 px-2.5 py-1.5 text-[11px]">
                <div className="flex items-center gap-1.5 text-slate-700">
                  <span className="font-bold">
                    {t(lang, `الأصناف: ${items.length}`, `Lignes : ${items.length}`)}
                  </span>
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono font-bold text-amber-900">
                    {costingMethod === 'weighted_avg' ? 'CMUP' : t(lang, 'آخر سعر', 'Dernier coût')}
                  </span>
                  {discountAmount > 0 && (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono font-bold text-emerald-900">
                      -{discountAmount.toFixed(2)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setShowExtrasModal(true)}
                    className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    <Percent className="h-3 w-3 text-amber-600" />
                    {t(lang, 'خصم وملاحظات', 'Remise / Notes')}
                  </button>
                  {(lastPurchase || purchases[0]) && (
                    <button
                      type="button"
                      onClick={() =>
                        openPrint({
                          type: 'purchase_invoice',
                          invoice: lastPurchase ?? purchases[0],
                        })
                      }
                      className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 font-semibold text-teal-800 hover:bg-teal-50"
                    >
                      <Printer className="h-3 w-3" />
                      {t(lang, 'آخر شراء', 'Dernier')}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* 2. Barcode Input Bar + Camera Barcode Scanner Button */}
            <div className="flex items-stretch gap-1.5">
              <div className="relative flex-1">
                <ScanBarcode className="pointer-events-none absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-slate-500" />
                <input
                  ref={barcodeInputRef}
                  type="text"
                  value={barcodeInput}
                  onChange={(e) => setBarcodeInput(e.target.value)}
                  onKeyDown={handleBarcodeEnter}
                  placeholder={t(
                    lang,
                    'البحث ب كود بار لاستلام البضاعة (Enter)...',
                    'Scanner code-barres fournisseur (Entrée)...'
                  )}
                  className="w-full rounded-lg border-2 border-slate-800 bg-white py-2.5 ps-9 pe-3 text-center text-xs font-bold text-slate-900 placeholder:text-slate-500 focus:border-teal-700 focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={() => setShowCameraScanner(true)}
                title={t(lang, 'مسح باركود المشتريات بالكاميرا', 'Scanner achat par caméra')}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border-2 border-slate-900 bg-teal-700 px-3.5 py-2 text-xs font-bold text-white hover:bg-teal-800 active:scale-[0.98] shrink-0"
              >
                <Camera className="h-4 w-4" />
                <span className="hidden sm:inline">{t(lang, 'كاميرا', 'Caméra')}</span>
              </button>
            </div>

            {/* 3. Green TOTALE Banner */}
            <div className="rounded-lg border-2 border-slate-900 bg-lime-500 text-slate-950 shadow-sm overflow-hidden">
              <div className="flex items-center justify-between px-3.5 py-2" dir="ltr">
                <span className="text-base font-black tracking-wide border-r-2 border-slate-900/40 pr-3">
                  TOTALE
                </span>
                <span className="font-mono text-2xl font-black tabular-nums">
                  {total.toFixed(2)} <span className="text-sm font-extrabold">{cur}</span>
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-900/25 bg-lime-400/75 px-3 py-1 text-[11px] font-bold">
                <span>
                  {t(lang, 'المدفوع للمورد:', 'Payé fournisseur :')}{' '}
                  <span className="font-mono tabular-nums">{effectivePaid.toFixed(2)}</span>
                </span>
                <span className={remaining > 0 ? 'text-red-900' : 'text-slate-900'}>
                  {t(lang, 'المتبقي للمورد:', 'Reste dû :')}{' '}
                  <span className="font-mono tabular-nums">{remaining.toFixed(2)}</span>
                </span>
              </div>
            </div>

            {/* 4. Bottom Split: Purchase Action Stack (Right in RTL) + Numeric Keypad (Left in RTL) */}
            <div className="grid grid-cols-12 gap-1.5 items-stretch">
              {/* Purchase-Specific Action Stack */}
              <div className="col-span-6 flex flex-col gap-1">
                {/* Yellow: Toggle Costing Method (CMUP / Last Cost) */}
                <button
                  type="button"
                  onClick={() => {
                    const next = costingMethod === 'weighted_avg' ? 'last_cost' : 'weighted_avg';
                    setCostingMethod(next);
                    notify(
                      next === 'weighted_avg'
                        ? t(lang, 'طريقة التكلفة: المتوسط المرجح (CMUP)', 'Méthode : Coût moyen pondéré (CMUP)')
                        : t(lang, 'طريقة التكلفة: آخر سعر شراء', 'Méthode : Dernier prix d’achat'),
                      'info'
                    );
                  }}
                  className="flex items-center justify-between rounded-md border border-slate-900 bg-amber-400 px-2.5 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-300 active:scale-[0.99]"
                >
                  <span className="inline-flex items-center gap-1 truncate">
                    <Layers className="h-3.5 w-3.5 shrink-0" />
                    <span>{t(lang, 'التكلفة:', 'Coût :')}</span>
                  </span>
                  <span className="rounded bg-slate-950 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
                    {costingMethod === 'weighted_avg' ? 'CMUP' : t(lang, 'آخر سعر', 'Dernier')}
                  </span>
                </button>

                {/* Red: Supprimer la ligne */}
                <button
                  type="button"
                  onClick={handleDeleteSelectedLine}
                  className="flex items-center justify-center gap-1 rounded-md border border-slate-900 bg-red-600 px-2 py-2 text-xs font-extrabold text-white hover:bg-red-700 active:scale-[0.99]"
                >
                  <Trash2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">
                    {t(lang, 'Supprimer la ligne', 'Supprimer la ligne')}
                  </span>
                </button>

                {/* Sky Blue: Calculatrices */}
                <button
                  type="button"
                  onClick={() => setShowCalculator(true)}
                  className="flex items-center justify-center gap-1 rounded-md border border-slate-900 bg-sky-500 px-2 py-2 text-xs font-extrabold text-slate-950 hover:bg-sky-400 active:scale-[0.99]"
                >
                  <Calculator className="h-3.5 w-3.5 shrink-0" />
                  <span>{t(lang, 'Calculatrices', 'Calculatrice')}</span>
                </button>

                {/* 2x2 Supplier Payment Methods Grid */}
                <div className="grid grid-cols-2 gap-1" dir="ltr">
                  <button
                    type="button"
                    onClick={() => selectQuickPaymentMethod('check')}
                    className={`flex items-center justify-center gap-1 rounded-md border px-1.5 py-2 text-[11px] font-extrabold transition-all ${
                      paymentMethod === 'check'
                        ? 'border-2 border-slate-950 bg-amber-200 text-slate-950 ring-2 ring-slate-950/30'
                        : 'border-slate-800 bg-amber-100 text-slate-900 hover:bg-amber-200'
                    }`}
                  >
                    {paymentMethod === 'check' && <Check className="h-3 w-3 shrink-0" />}
                    <span>cheque</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => selectQuickPaymentMethod('cash')}
                    className={`flex items-center justify-center gap-1 rounded-md border px-1.5 py-2 text-[11px] font-extrabold transition-all ${
                      paymentMethod === 'cash'
                        ? 'border-2 border-slate-950 bg-lime-400 text-slate-950 ring-2 ring-slate-950/30'
                        : 'border-slate-800 bg-lime-300 text-slate-900 hover:bg-lime-400'
                    }`}
                  >
                    {paymentMethod === 'cash' && <Check className="h-3 w-3 shrink-0" />}
                    <span>espèce</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => selectQuickPaymentMethod('credit')}
                    className={`flex items-center justify-center gap-1 rounded-md border px-1.5 py-2 text-[11px] font-extrabold transition-all ${
                      paymentMethod === 'credit'
                        ? 'border-2 border-slate-950 bg-red-600 text-white ring-2 ring-red-900/40'
                        : 'border-slate-800 bg-red-600/90 text-white hover:bg-red-600'
                    }`}
                  >
                    {paymentMethod === 'credit' && <Check className="h-3 w-3 shrink-0" />}
                    <span>crédit</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => selectQuickPaymentMethod('bank_transfer')}
                    className={`flex items-center justify-center gap-1 rounded-md border px-1.5 py-2 text-[11px] font-extrabold transition-all ${
                      paymentMethod === 'bank_transfer' || paymentMethod === 'card'
                        ? 'border-2 border-slate-950 bg-sky-300 text-slate-950 ring-2 ring-slate-950/30'
                        : 'border-slate-800 bg-sky-200 text-slate-900 hover:bg-sky-300'
                    }`}
                  >
                    {(paymentMethod === 'bank_transfer' || paymentMethod === 'card') && (
                      <Check className="h-3 w-3 shrink-0" />
                    )}
                    <span>banque</span>
                  </button>
                </div>

                {/* Green: حفظ وطباعة + Save-only */}
                <div className="flex items-stretch gap-1">
                  <button
                    type="button"
                    disabled={saving || items.length === 0}
                    onClick={() => handleSavePurchase(true)}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-md border border-slate-900 bg-lime-500 px-2 py-2 text-xs font-extrabold text-slate-950 hover:bg-lime-400 disabled:opacity-50"
                  >
                    <Printer className="h-3.5 w-3.5 shrink-0" />
                    <span>{t(lang, 'حفظ وطباعة', 'Valider & Imprimer')}</span>
                  </button>
                  <button
                    type="button"
                    disabled={saving || items.length === 0}
                    onClick={() => handleSavePurchase(false)}
                    title={t(lang, 'حفظ دون طباعة', 'Enregistrer sans imprimer')}
                    className="rounded-md border border-slate-900 bg-emerald-600 px-2.5 text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    <Save className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* Green: البحث بإسم المنتج */}
                <button
                  type="button"
                  onClick={() => {
                    setShowNameSearchModal(true);
                    window.setTimeout(() => nameSearchInputRef.current?.focus(), 80);
                  }}
                  className="flex items-center justify-center gap-1.5 rounded-md border border-slate-900 bg-lime-500 px-2 py-2 text-xs font-extrabold text-slate-950 hover:bg-lime-400"
                >
                  <Search className="h-3.5 w-3.5 shrink-0" />
                  <span>{t(lang, 'البحث بإسم المنتج', 'Chercher par nom')}</span>
                </button>
              </div>

              {/* Numeric Keypad with Purchase-Specific Modes (Qte | P.A | Payé | Rem) */}
              <div className="col-span-6 flex flex-col gap-1">
                <div className="grid grid-cols-4 gap-0.5 rounded-md border border-slate-800 bg-slate-100 p-0.5 text-[10px] font-bold">
                  <button
                    type="button"
                    onClick={() => {
                      setKeypadTarget('qty');
                      setKeypadBuffer('');
                    }}
                    className={`rounded py-1 ${
                      keypadTarget === 'qty'
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    {t(lang, 'كمية', 'Qté')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setKeypadTarget('cost');
                      setKeypadBuffer('');
                    }}
                    className={`rounded py-1 ${
                      keypadTarget === 'cost'
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    {t(lang, 'الشراء', 'P.A')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setKeypadTarget('paid');
                      setKeypadBuffer('');
                    }}
                    className={`rounded py-1 ${
                      keypadTarget === 'paid'
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    {t(lang, 'مدفوع', 'Payé')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setKeypadTarget('discount');
                      setKeypadBuffer('');
                    }}
                    className={`rounded py-1 ${
                      keypadTarget === 'discount'
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    {t(lang, 'خصم', 'Rem')}
                  </button>
                </div>

                <div
                  dir="ltr"
                  className="grid flex-1 grid-cols-3 grid-rows-4 border-2 border-slate-900 rounded-md overflow-hidden bg-white"
                >
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'CL', '0', ','].map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleKeypadPress(key)}
                      className={`flex items-center justify-center border border-slate-300 py-2.5 text-lg font-extrabold font-mono transition-colors active:bg-slate-200 ${
                        key === 'CL'
                          ? 'bg-red-50 text-red-700 hover:bg-red-100 text-base'
                          : 'bg-white text-slate-950 hover:bg-slate-100'
                      }`}
                    >
                      {key}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* LEFT PANEL IN RTL (7 cols): Product Purchase Grid + 2x6 Light Blue Categories Bar */}
          <div className="lg:col-span-7 flex flex-col gap-2">
            {nameSearch && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-teal-300 bg-teal-50 px-3 py-1.5 text-xs">
                <div className="flex items-center gap-2 font-semibold text-teal-900">
                  <Search className="h-3.5 w-3.5" />
                  <span>
                    {t(lang, 'نتائج البحث عن:', 'Filtre actif :')} "{nameSearch}" (
                    {filteredProducts.length})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setNameSearch('')}
                  className="inline-flex items-center gap-1 rounded bg-white px-2 py-0.5 text-[11px] font-bold text-slate-700 border border-teal-200 hover:bg-slate-50"
                >
                  <X className="h-3 w-3" /> {t(lang, 'مسح', 'Effacer')}
                </button>
              </div>
            )}

            {/* Dense Peach Product Cards (Showing Purchase Price & Low Stock Alert) */}
            <div className="flex-1 rounded-xl border-2 border-slate-800 bg-orange-50/40 p-1.5 overflow-y-auto max-h-[54vh] lg:max-h-[540px]">
              {filteredProducts.length === 0 ? (
                <div className="flex h-64 flex-col items-center justify-center gap-2 text-slate-500 text-xs">
                  <Package className="h-8 w-8 text-slate-400" />
                  <span>{t(lang, 'لا توجد منتجات في هذه المجموعة', 'Aucun produit dans cette catégorie')}</span>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-1.5">
                  {filteredProducts.map((p) => {
                    const inCartQty = items.find((i) => i.productId === p.id)?.quantity ?? 0;
                    const isLowStock = p.quantity <= p.minStock;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => addProductLine(p)}
                        className={`relative flex flex-col items-center justify-between rounded-md border p-2 text-center transition-all min-h-[118px] ${
                          isLowStock
                            ? 'border-red-500 bg-orange-100/95 hover:bg-orange-200 active:scale-[0.98]'
                            : 'border-slate-800/70 bg-orange-100/75 hover:bg-orange-200/80 hover:border-slate-950 active:scale-[0.98]'
                        }`}
                      >
                        {inCartQty > 0 && (
                          <span className="absolute top-1 end-1 rounded bg-slate-950 px-1.5 py-0.5 font-mono text-[10px] font-bold text-lime-300">
                            +{inCartQty}
                          </span>
                        )}
                        {isLowStock && (
                          <span className="absolute top-1 start-1 rounded bg-red-600 px-1 py-0.5 text-[9px] font-extrabold text-white">
                            {t(lang, 'منخفض', 'Bas')}
                          </span>
                        )}

                        <div className="flex h-11 w-11 items-center justify-center rounded-md bg-white/80 border border-orange-200 overflow-hidden shrink-0">
                          {p.imageUrl ? (
                            <img
                              src={p.imageUrl}
                              alt={p.name}
                              referrerPolicy="no-referrer"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <Package className="h-5 w-5 text-orange-700/60" />
                          )}
                        </div>

                        <div className="mt-1.5 text-[11px] font-bold text-slate-950 line-clamp-2 leading-tight">
                          {p.name}
                        </div>

                        <div className="mt-1 w-full flex items-center justify-between gap-1 border-t border-orange-300/70 pt-1">
                          <span
                            title={t(lang, 'سعر الشراء الحالي', 'Coût d’achat actuel')}
                            className="font-mono text-xs font-black text-teal-900 tabular-nums"
                          >
                            {p.purchasePrice.toFixed(2)}
                          </span>
                          <span
                            title={t(lang, 'المخزون الحالي', 'Stock actuel')}
                            className={`font-mono text-[10px] tabular-nums ${
                              isLowStock ? 'text-red-700 font-extrabold' : 'text-slate-600 font-semibold'
                            }`}
                          >
                            {p.quantity}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Bottom Categories Bar: Amber Arrows + 2x6 Light Blue Category Cells */}
            <div className="flex items-stretch gap-2 rounded-xl border-2 border-slate-300 bg-white p-1.5 shadow-sm">
              <div className="flex items-center gap-1 shrink-0" dir="ltr">
                <button
                  type="button"
                  disabled={safeCatPage === 0}
                  onClick={() => setCatPage((p) => Math.max(0, p - 1))}
                  title={t(lang, 'المجموعات السابقة', 'Catégories précédentes')}
                  className="flex h-full min-h-[72px] w-10 items-center justify-center rounded-lg border-2 border-amber-500 bg-amber-400 text-slate-950 shadow-sm hover:bg-amber-300 disabled:opacity-40"
                >
                  <ChevronLeft className="h-6 w-6 stroke-[2.75]" />
                </button>
                <button
                  type="button"
                  disabled={safeCatPage >= totalCatPages - 1}
                  onClick={() => setCatPage((p) => Math.min(totalCatPages - 1, p + 1))}
                  title={t(lang, 'المجموعات التالية', 'Catégories suivantes')}
                  className="flex h-full min-h-[72px] w-10 items-center justify-center rounded-lg border-2 border-amber-500 bg-amber-400 text-slate-950 shadow-sm hover:bg-amber-300 disabled:opacity-40"
                >
                  <ChevronRight className="h-6 w-6 stroke-[2.75]" />
                </button>
              </div>

              <div className="flex-1 grid grid-cols-3 sm:grid-cols-6 grid-rows-2 border-2 border-slate-800 rounded-md overflow-hidden bg-sky-100">
                {Array.from({ length: CATS_PER_PAGE }).map((_, idx) => {
                  const slot = visibleCategories[idx];
                  if (!slot) {
                    return (
                      <div
                        key={`empty-pcat-${idx}`}
                        className="border border-slate-500/60 bg-sky-100/60 min-h-[38px]"
                      />
                    );
                  }
                  const active = selectedCat === slot.id;
                  return (
                    <button
                      key={slot.id}
                      type="button"
                      onClick={() => setSelectedCat(slot.id)}
                      className={`border border-slate-700/75 px-1.5 py-2 text-[11px] font-extrabold truncate transition-colors min-h-[38px] ${
                        active
                          ? 'bg-slate-900 text-amber-300'
                          : 'bg-sky-200/85 text-slate-950 hover:bg-sky-300'
                      }`}
                      title={slot.label}
                    >
                      {slot.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 7.1: PURCHASE INVOICES LOG (Preserved 100%) */}
      {activeTab === 'log' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3">
            <div className="flex flex-wrap items-center gap-2 flex-1">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="pointer-events-none absolute top-2.5 start-3 h-4 w-4 text-slate-400" />
                <input
                  value={logSearch}
                  onChange={(e) => setLogSearch(e.target.value)}
                  placeholder={t(lang, 'بحث برقم فاتورة الشراء أو المورد...', 'N° achat ou fournisseur...')}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 ps-9 pe-3 text-xs"
                />
              </div>
              <select
                value={logStatus}
                onChange={(e) => setLogStatus(e.target.value)}
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              >
                <option value="all">{t(lang, 'كل الحالات', 'Tous statuts')}</option>
                <option value="paid">{t(lang, 'مؤداة', 'Payée')}</option>
                <option value="partial">{t(lang, 'جزئية', 'Partielle')}</option>
                <option value="unpaid">{t(lang, 'بالدين', 'Crédit')}</option>
                <option value="cancelled">{t(lang, 'ملغاة', 'Annulée')}</option>
              </select>
            </div>
            <button
              type="button"
              onClick={() =>
                exportRowsToExcel(
                  filteredLog.map((p) => ({
                    Invoice: p.invoiceNumber,
                    Supplier: p.supplierName,
                    Date: formatDateTime(p.date, lang),
                    Total: p.total,
                    Paid: p.paidAmount,
                    Remaining: p.remainingAmount,
                    Status: p.status,
                  })),
                  'Purchases',
                  'purchase_invoices.xlsx'
                )
              }
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5" /> {t(lang, 'تصدير Excel', 'Exporter Excel')}
            </button>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <th className="px-3 py-3 text-start font-semibold">{t(lang, 'الرقم', 'N°')}</th>
                    <th className="px-3 py-3 text-start font-semibold">{t(lang, 'المورد', 'Fournisseur')}</th>
                    <th className="px-3 py-3 text-start font-semibold">{t(lang, 'التاريخ', 'Date')}</th>
                    <th className="px-3 py-3 text-end font-semibold">{t(lang, 'الإجمالي', 'Total')}</th>
                    <th className="px-3 py-3 text-end font-semibold">{t(lang, 'المدفوع', 'Payé')}</th>
                    <th className="px-3 py-3 text-end font-semibold">{t(lang, 'المتبقي', 'Reste')}</th>
                    <th className="px-3 py-3 text-start font-semibold">{t(lang, 'الحالة', 'Statut')}</th>
                    <th className="px-3 py-3 text-end font-semibold">{t(lang, 'إجراءات', 'Actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredLog.map((p) => (
                    <tr key={p.id} className={`hover:bg-slate-50 ${p.status === 'cancelled' ? 'opacity-60' : ''}`}>
                      <td className="px-3 py-3 font-mono font-semibold text-slate-900">{p.invoiceNumber}</td>
                      <td className="px-3 py-3 font-medium text-slate-800">{p.supplierName}</td>
                      <td className="px-3 py-3 text-slate-600">{formatDateTime(p.date, lang)}</td>
                      <td className="px-3 py-3 text-end font-mono font-semibold">{formatMoney(p.total, cur)}</td>
                      <td className="px-3 py-3 text-end font-mono text-emerald-700">{formatMoney(p.paidAmount, cur)}</td>
                      <td className="px-3 py-3 text-end font-mono text-red-700">{formatMoney(p.remainingAmount, cur)}</td>
                      <td className="px-3 py-3">{getStatusLabel(p.status, lang)}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => openPrint({ type: 'purchase_invoice', invoice: p })}
                            title={t(lang, 'طباعة', 'Imprimer')}
                            className="rounded p-1.5 text-teal-700 hover:bg-teal-50"
                          >
                            <Printer className="h-3.5 w-3.5" />
                          </button>
                          {p.status !== 'cancelled' && (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setRetPurchaseId(p.id!);
                                  setRetQtys({});
                                  setActiveTab('returns');
                                }}
                                title={t(lang, 'إرجاع للمورد', 'Retour fournisseur')}
                                className="rounded p-1.5 text-amber-700 hover:bg-amber-50"
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleCancelPurchase(p)}
                                title={t(lang, 'إلغاء فاتورة الشراء', 'Annuler')}
                                className="rounded p-1.5 text-red-600 hover:bg-red-50"
                              >
                                <Ban className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filteredLog.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                        {t(lang, 'لا توجد فواتير مشتريات مطابقة', 'Aucun achat trouvé')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 7.2: SUPPLIER RETURNS (Preserved 100%) */}
      {activeTab === 'returns' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <form
            onSubmit={handleCreateSupplierReturn}
            className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 space-y-4"
          >
            <h3 className="text-sm font-bold text-slate-900">
              {t(lang, 'إنشاء عملية إرجاع للمورد', 'Créer un retour fournisseur')}
            </h3>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'اختر فاتورة الشراء الأصلية *', 'Facture d’achat d’origine *')}
              </label>
              <select
                required
                value={retPurchaseId}
                onChange={(e) => {
                  setRetPurchaseId(e.target.value ? Number(e.target.value) : '');
                  setRetQtys({});
                }}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
              >
                <option value="">{t(lang, '— اختر الفاتورة —', '— Choisir la facture —')}</option>
                {purchases
                  .filter((p) => p.status !== 'cancelled')
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.invoiceNumber} — {p.supplierName} ({formatMoney(p.total, cur)})
                    </option>
                  ))}
              </select>
            </div>

            {selectedRetPurchase && (
              <div className="space-y-2 max-h-56 overflow-y-auto">
                {selectedRetPurchase.items.map((it) => {
                  const maxRet = round2(it.quantity - (it.returnedQty ?? 0));
                  return (
                    <div
                      key={it.productId}
                      className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-2.5 text-xs"
                    >
                      <div>
                        <div className="font-semibold text-slate-900">{it.productName}</div>
                        <div className="text-slate-500">
                          {t(lang, 'الحد الأقصى:', 'Max :')} {maxRet} · {it.unitCost.toFixed(2)} {cur}
                        </div>
                      </div>
                      <input
                        type="number"
                        min="0"
                        max={maxRet}
                        step="0.5"
                        value={retQtys[it.productId] ?? 0}
                        onChange={(e) =>
                          setRetQtys((prev) => ({ ...prev, [it.productId]: Number(e.target.value) }))
                        }
                        className="w-20 rounded border border-slate-300 px-2 py-1 text-end font-mono"
                      />
                    </div>
                  );
                })}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'طريقة تسوية المبلغ', 'Règlement')}
                </label>
                <select
                  value={retSettlement}
                  onChange={(e) =>
                    setRetSettlement(e.target.value as 'cash' | 'credit_note' | 'bank_transfer')
                  }
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs"
                >
                  <option value="credit_note">{t(lang, 'خصم من رصيد المورد (إشعار دائن)', 'Avoir fournisseur')}</option>
                  <option value="cash">{t(lang, 'استرجاع نقداً', 'Remboursement espèces')}</option>
                  <option value="bank_transfer">{t(lang, 'تحويل بنكي', 'Virement bancaire')}</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'سبب الإرجاع', 'Motif')}
                </label>
                <input
                  value={retReason}
                  onChange={(e) => setRetReason(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-xs"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={!selectedRetPurchase}
              className="w-full rounded-lg bg-teal-700 py-2.5 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-40"
            >
              {t(lang, 'تأكيد الإرجاع وطباعة الوثيقة', 'Valider le retour & Imprimer')}
            </button>
          </form>

          <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="border-b border-slate-200 px-4 py-3 text-sm font-bold text-slate-900">
              {t(lang, 'سجل مسترجعات الموردين', 'Historique des retours fournisseurs')}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <th className="p-3 text-start">{t(lang, 'رقم الإرجاع', 'N° Retour')}</th>
                    <th className="p-3 text-start">{t(lang, 'المورد / الفاتورة', 'Fournisseur / Facture')}</th>
                    <th className="p-3 text-start">{t(lang, 'التسوية', 'Règlement')}</th>
                    <th className="p-3 text-end">{t(lang, 'القيمة', 'Montant')}</th>
                    <th className="p-3 text-end">{t(lang, 'طباعة', 'Imprimer')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {supplierReturns.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="p-3 font-mono font-semibold text-slate-900">{r.returnNumber}</td>
                      <td className="p-3">
                        <div className="font-medium text-slate-900">{r.supplierName}</div>
                        <div className="text-[11px] font-mono text-slate-500">{r.purchaseInvoiceNumber}</div>
                      </td>
                      <td className="p-3 text-slate-600">
                        {r.settlementMethod === 'credit_note'
                          ? t(lang, 'خصم من الحساب', 'Avoir')
                          : getPaymentMethodLabel(r.settlementMethod, lang)}
                      </td>
                      <td className="p-3 text-end font-mono font-bold text-amber-700">
                        {formatMoney(r.totalAmount, cur)}
                      </td>
                      <td className="p-3 text-end">
                        <button
                          type="button"
                          onClick={() => openPrint({ type: 'supplier_return', ret: r })}
                          className="rounded p-1.5 text-teal-700 hover:bg-teal-50"
                        >
                          <Printer className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {supplierReturns.length === 0 && (
                    <tr>
                      <td colSpan={5} className="p-8 text-center text-slate-400">
                        {t(lang, 'لا توجد مسترجعات مسجلة للموردين بعد', 'Aucun retour fournisseur enregistré')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Camera Barcode Scanner Modal (html5-qrcode) */}
      <CameraBarcodeScannerModal
        open={showCameraScanner}
        lang={lang}
        currency={cur}
        cartCount={items.length}
        cartTotal={total}
        onClose={() => setShowCameraScanner(false)}
        onScan={(code) => lookupAndAddBarcode(code)}
      />

      {/* Calculator Modal */}
      <CalculatorModal
        open={showCalculator}
        lang={lang}
        currency={cur}
        onClose={() => setShowCalculator(false)}
        onApplyValue={(val) => {
          if (paymentMethod === 'credit') setPaymentMethod('cash');
          setPaidAmount(String(val));
          notify(
            t(
              lang,
              `تم تطبيق ${val.toFixed(2)} ${cur} كمبلغ مدفوع للمورد`,
              `Payé fournisseur : ${val.toFixed(2)} ${cur}`
            )
          );
        }}
      />

      {/* Product Name Search Modal */}
      {showNameSearchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Search className="h-4 w-4 text-teal-700" />
                {t(lang, 'البحث السريع عن منتج للشراء', 'Recherche produit pour achat')}
              </h3>
              <button
                type="button"
                onClick={() => setShowNameSearchModal(false)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <input
              ref={nameSearchInputRef}
              type="text"
              value={nameSearch}
              onChange={(e) => setNameSearch(e.target.value)}
              placeholder={t(lang, 'اكتب اسم المنتج أو SKU أو الباركود...', 'Nom du produit, SKU ou code-barres...')}
              className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm focus:border-teal-600 focus:bg-white focus:outline-none"
            />

            <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-xl">
              {filteredProducts.slice(0, 25).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    addProductLine(p);
                    setShowNameSearchModal(false);
                  }}
                  className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-start hover:bg-orange-50"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-slate-900 truncate">{p.name}</div>
                    <div className="text-[11px] font-mono text-slate-500">
                      {p.barcode} · {t(lang, 'المخزون الحالي:', 'Stock :')} {p.quantity} {p.unit}
                    </div>
                  </div>
                  <div className="text-end shrink-0">
                    <div className="font-mono text-xs font-extrabold text-teal-800">
                      {p.purchasePrice.toFixed(2)} {cur}
                    </div>
                    <div className="text-[10px] text-slate-400">{t(lang, 'سعر الشراء', 'Coût')}</div>
                  </div>
                </button>
              ))}
              {filteredProducts.length === 0 && (
                <div className="p-6 text-center text-xs text-slate-400">
                  {t(lang, 'لا توجد نتائج مطابقة', 'Aucun produit trouvé')}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Purchase Extras Modal (Discount, Paid Amount, Notes, Costing Method) */}
      {showExtrasModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl space-y-4 text-xs">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-sm font-bold text-slate-900">
                {t(lang, 'تفاصيل الدفع والتكلفة والملاحظات', 'Remise, coût & notes')}
              </h3>
              <button
                type="button"
                onClick={() => setShowExtrasModal(false)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  {t(lang, 'الخصم من المورد', 'Remise fournisseur')}
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={discountAmount}
                  onChange={(e) => setDiscountAmount(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-end font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  {t(lang, 'المبلغ المدفوع', 'Montant payé')}
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  disabled={paymentMethod === 'credit'}
                  value={paymentMethod === 'credit' ? '0' : paidAmount}
                  onChange={(e) => setPaidAmount(e.target.value)}
                  placeholder={total.toFixed(2)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-end font-mono disabled:bg-slate-100"
                />
              </div>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                {t(lang, 'طريقة تحديث التكلفة', 'Méthode de mise à jour du coût')}
              </label>
              <select
                value={costingMethod}
                onChange={(e) => setCostingMethod(e.target.value as 'weighted_avg' | 'last_cost')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="weighted_avg">
                  {t(lang, 'المتوسط المرجح للتكلفة (CMUP)', 'Coût moyen pondéré (CMUP)')}
                </option>
                <option value="last_cost">
                  {t(lang, 'آخر سعر شراء', 'Dernier prix d’achat')}
                </option>
              </select>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                {t(lang, 'ملاحظة / رقم وصل التسليم', 'Notes / N° Bon de livraison')}
              </label>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowExtrasModal(false)}
                className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800"
              >
                {t(lang, 'تطبيق وإغلاق', 'Appliquer')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
