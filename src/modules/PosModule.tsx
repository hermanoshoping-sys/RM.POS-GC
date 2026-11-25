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
  Clock,
  CreditCard,
  Download,
  Edit2,
  Eye,
  FileDown,
  Inbox,
  Package,
  PauseCircle,
  Percent,
  Plus,
  Printer,
  ReceiptText,
  RotateCcw,
  Save,
  ScanBarcode,
  Search,
  Split,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import { db } from '../db/database';
import {
  cancelSaleInvoice,
  createSaleInvoice,
  createSaleReturn,
  logAudit,
  makeIdempotencyKey,
  round2,
  updateSaleInvoiceControlled,
  updateSettingsSection,
} from '../db/operations';
import { useApp } from '../context/AppContext';
import {
  InstallmentFrequency,
  PaymentMethod,
  PaymentSplit,
  Product,
  SaleInvoice,
  SaleInvoiceItem,
} from '../types';
import {
  formatDateTime,
  formatMoney,
  getPaymentMethodLabel,
  getStatusLabel,
  PAYMENT_METHODS,
  t,
} from '../i18n/translations';
import { exportRowsToExcel, exportTableToPdf } from '../utils/export';
import { CameraBarcodeScannerModal } from '../components/CameraBarcodeScannerModal';
import { CalculatorModal } from '../components/CalculatorModal';
import {
  calculateSaleReturnBreakdown,
  getEffectiveReturnUnitPrice,
  toSaleReturnItems,
} from '../utils/returns';
import { openCashDrawer } from '../utils/cashDrawer';

type KeypadTarget = 'qty' | 'paid' | 'discount' | 'price';

export const PosModule: React.FC = () => {
  const {
    lang,
    settings,
    currentUser,
    notify,
    openPrint,
    requestGuardedAction,
    setActiveSection,
  } = useApp();
  const cur = settings.storeInfo.currency || 'MAD';

  const [activeTab, setActiveTab] = useState<'pos' | 'sales_log'>('pos');
  const [now, setNow] = useState<Date>(() => new Date());

  // Live clock for top amber header
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const categories = useLiveQuery(() => db.categories.toArray(), []) ?? [];
  const customers = useLiveQuery(() => db.customers.toArray(), []) ?? [];
  const users = useLiveQuery(() => db.users.toArray(), []) ?? [];
  const heldCarts = useLiveQuery(() => db.heldCarts.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const saleInvoices = useLiveQuery(() => db.saleInvoices.orderBy('date').reverse().toArray(), []) ?? [];
  const saleReturns = useLiveQuery(() => db.saleReturns.toArray(), []) ?? [];

  // POS Cart & Terminal State
  const [barcodeInput, setBarcodeInput] = useState('');
  const [nameSearch, setNameSearch] = useState('');
  const [showNameSearchModal, setShowNameSearchModal] = useState(false);
  const [showCameraScanner, setShowCameraScanner] = useState(false);
  const [showCalculator, setShowCalculator] = useState(false);
  const [showExtrasModal, setShowExtrasModal] = useState(false);
  const [showDrawerReasonModal, setShowDrawerReasonModal] = useState(false);
  const [drawerReason, setDrawerReason] = useState('');
  const [openingDrawer, setOpeningDrawer] = useState(false);

  const [selectedCat, setSelectedCat] = useState<string>('all');
  const [catPage, setCatPage] = useState<number>(0);

  const [priceTier, setPriceTier] = useState<'retail' | 'wholesale' | 'second'>(
    settings.posConfig.defaultPriceTier || 'retail'
  );
  const [customerId, setCustomerId] = useState<number>(1);
  const [cart, setCart] = useState<SaleInvoiceItem[]>([]);
  const cartRef = useRef<SaleInvoiceItem[]>(cart);
  useEffect(() => {
    cartRef.current = cart;
  }, [cart]);
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);

  const executeOpenCashDrawer = async (source: 'manual' | 'cash_sale', reason?: string) => {
    if (!currentUser) return;
    if (!currentUser.permissions?.canSell && !currentUser.permissions?.canManageSettings) {
      notify(t(lang, 'ليس لديك صلاحية فتح درج النقدية', 'Permission refusée pour ouvrir le tiroir'), 'error');
      return;
    }
    setOpeningDrawer(true);
    try {
      const res = await openCashDrawer(settings.printing.cashDrawer, {
        promptPairIfNeeded: source === 'manual',
      });
      if (res.ok) {
        await logAudit(
          currentUser,
          'CASH_DRAWER_OPENED',
          'cashDrawer',
          source,
          source === 'cash_sale'
            ? `فتح تلقائي لدرج النقدية عند بيع نقدي (${reason || ''})`
            : `فتح يدوي لدرج النقدية${reason ? `: ${reason}` : ''}`
        );
        if (source === 'manual') {
          notify(lang === 'ar' ? res.messageAr : res.messageFr, 'success');
        }
      } else if (source === 'manual' || !res.needsPairing) {
        notify(lang === 'ar' ? res.messageAr : res.messageFr, 'warning');
      }
    } finally {
      setOpeningDrawer(false);
    }
  };

  const handleManualOpenDrawerClick = () => {
    if (!settings.printing.cashDrawer.enabled) {
      notify(
        t(lang, 'ميزة فتح الدرج معطلة — فعّلها من الإعدادات ← الطباعة', 'Tiroir désactivé dans Paramètres → Impression'),
        'warning'
      );
      return;
    }
    if (settings.printing.cashDrawer.requireReasonOnManualOpen) {
      setDrawerReason('');
      setShowDrawerReasonModal(true);
      return;
    }
    void executeOpenCashDrawer('manual');
  };

  const manualDrawerRef = useRef(handleManualOpenDrawerClick);
  manualDrawerRef.current = handleManualOpenDrawerClick;

  // Keyboard shortcuts: F2 camera barcode scanner, F9 open cash drawer (Tiroir)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (activeTab !== 'pos') return;
      if (e.key === 'F2') {
        e.preventDefault();
        setShowCameraScanner((prev) => !prev);
      } else if (e.key === 'F9') {
        e.preventDefault();
        manualDrawerRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTab]);

  // Keypad State
  const [keypadTarget, setKeypadTarget] = useState<KeypadTarget>('qty');
  const [keypadBuffer, setKeypadBuffer] = useState<string>('');

  const [discountType, setDiscountType] = useState<'fixed' | 'percent'>('fixed');
  const [discountValue, setDiscountValue] = useState<number>(0);
  const [paymentMode, setPaymentMode] = useState<'single' | 'split'>('single');
  const [singleMethod, setSingleMethod] = useState<PaymentMethod>('cash');
  const [paidInput, setPaidInput] = useState<string>('');
  const [splits, setSplits] = useState<PaymentSplit[]>([
    { method: 'cash', amount: 0 },
    { method: 'card', amount: 0 },
  ]);
  const [notes, setNotes] = useState('');
  const [installmentCount, setInstallmentCount] = useState<number>(1);
  const [installmentFrequency, setInstallmentFrequency] = useState<InstallmentFrequency>('monthly');
  const [firstDueDate, setFirstDueDate] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  });
  const [applyCreditBalance, setApplyCreditBalance] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastInvoice, setLastInvoice] = useState<SaleInvoice | null>(null);
  const [showHeldModal, setShowHeldModal] = useState(false);

  // Sales Log Filter & Action Modals (6.1)
  const [logSearch, setLogSearch] = useState('');
  const [logStatus, setLogStatus] = useState<string>('all');
  const [logSeller, setLogSeller] = useState<string>('all');
  const [logDateFrom, setLogDateFrom] = useState('');
  const [logDateTo, setLogDateTo] = useState('');
  const [detailInvoice, setDetailInvoice] = useState<SaleInvoice | null>(null);
  const [cancelTarget, setCancelTarget] = useState<SaleInvoice | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [returnTarget, setReturnTarget] = useState<SaleInvoice | null>(null);
  const [returnQtys, setReturnQtys] = useState<Record<number, number>>({});
  const [returnReason, setReturnReason] = useState('');
  const [returnMethod, setReturnMethod] = useState<PaymentMethod>('cash');
  const [editTarget, setEditTarget] = useState<SaleInvoice | null>(null);
  const [editItems, setEditItems] = useState<SaleInvoiceItem[]>([]);
  const [editDiscount, setEditDiscount] = useState(0);

  const barcodeInputRef = useRef<HTMLInputElement | null>(null);
  const nameSearchInputRef = useRef<HTMLInputElement | null>(null);

  const activeProducts = useMemo(() => products.filter((p) => p.isActive), [products]);

  const filteredProducts = useMemo(() => {
    const q = nameSearch.trim().toLowerCase();
    return activeProducts.filter((p) => {
      const matchCat = selectedCat === 'all' || String(p.categoryId ?? '') === selectedCat;
      const matchQ =
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.barcode.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q);
      return matchCat && matchQ;
    });
  }, [activeProducts, nameSearch, selectedCat]);

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

  const getProductTierPrice = (p: Product) => {
    if (priceTier === 'wholesale') return p.wholesalePrice || p.salePrice;
    if (priceTier === 'second') return p.secondSalePrice || p.salePrice;
    return p.salePrice;
  };

  const addToCart = (p: Product): boolean => {
    const allowNeg = settings.posConfig.allowNegativeStock;
    const step = p.isWeighted ? 0.5 : 1;
    const currentCart = cartRef.current;
    const existing = currentCart.find((c) => c.productId === p.id);
    const nextQty = round2((existing?.quantity ?? 0) + step);

    if (!allowNeg && nextQty > p.quantity) {
      notify(
        t(
          lang,
          `الكمية غير متوفرة لـ "${p.name}" (المتوفر: ${p.quantity}) — يمكنك السماح بالبيع السالب من الإعدادات`,
          `Stock insuffisant pour "${p.name}" (Dispo : ${p.quantity})`
        ),
        'warning'
      );
      return false;
    }

    const price = getProductTierPrice(p);
    let updatedCart: SaleInvoiceItem[];
    if (existing) {
      updatedCart = currentCart.map((c) =>
        c.productId === p.id
          ? { ...c, quantity: nextQty, total: round2(nextQty * c.unitPrice - c.discount) }
          : c
      );
    } else {
      updatedCart = [
        ...currentCart,
        {
          productId: p.id!,
          productName: p.name,
          barcode: p.barcode,
          unit: p.unit,
          quantity: step,
          unitPrice: price,
          costPrice: p.purchasePrice,
          discount: 0,
          total: round2(step * price),
        },
      ];
    }
    cartRef.current = updatedCart;
    setCart(updatedCart);
    setSelectedProductId(p.id!);
    setKeypadTarget('qty');
    setKeypadBuffer('');
    return true;
  };

  const lookupAndAddBarcode = (
    rawCode: string
  ): { found: boolean; label?: string; price?: number } => {
    const q = rawCode.trim().toLowerCase();
    if (!q) return { found: false };
    const exact = activeProducts.find(
      (p) => p.barcode.toLowerCase() === q || p.sku.toLowerCase() === q
    );
    if (!exact) {
      notify(
        t(lang, `لم يتم العثور على منتج بالباركود: ${rawCode}`, `Code-barres introuvable : ${rawCode}`),
        'warning'
      );
      return { found: false };
    }
    const ok = addToCart(exact);
    return { found: ok, label: exact.name, price: getProductTierPrice(exact) };
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
      // Fallback: if no exact barcode match, filter by name
      setNameSearch(q);
    }
  };

  const updateCartItem = (productId: number, patch: Partial<SaleInvoiceItem>) => {
    const prod = products.find((p) => p.id === productId);
    setCart((prev) =>
      prev
        .map((c) => {
          if (c.productId !== productId) return c;
          const nextQty = patch.quantity !== undefined ? Math.max(0, patch.quantity) : c.quantity;
          if (prod && !settings.posConfig.allowNegativeStock && nextQty > prod.quantity) {
            notify(
              t(lang, `الحد المتوفر في المخزون هو ${prod.quantity}`, `Stock max : ${prod.quantity}`),
              'warning'
            );
            return c;
          }
          const nextPrice =
            patch.unitPrice !== undefined ? Math.max(0, patch.unitPrice) : c.unitPrice;
          const nextDisc =
            patch.discount !== undefined ? Math.max(0, patch.discount) : c.discount;
          return {
            ...c,
            quantity: nextQty,
            unitPrice: nextPrice,
            discount: nextDisc,
            total: round2(Math.max(0, nextQty * nextPrice - nextDisc)),
          };
        })
        .filter((c) => c.quantity > 0)
    );
  };

  const handleDeleteSelectedLine = () => {
    if (cart.length === 0) {
      notify(t(lang, 'السلة فارغة', 'Le panier est vide'), 'warning');
      return;
    }
    const targetId = selectedProductId ?? cart[cart.length - 1]?.productId;
    if (!targetId) return;
    const idx = cart.findIndex((c) => c.productId === targetId);
    const nextCart = cart.filter((c) => c.productId !== targetId);
    setCart(nextCart);
    const fallbackItem = nextCart[Math.max(0, idx - 1)] ?? nextCart[0] ?? null;
    setSelectedProductId(fallbackItem?.productId ?? null);
    setKeypadBuffer('');
  };

  // Numeric Keypad Handler
  const handleKeypadPress = (key: string) => {
    if (key === 'CL') {
      setKeypadBuffer('');
      if (keypadTarget === 'paid') {
        setPaidInput('');
      } else if (keypadTarget === 'discount') {
        setDiscountValue(0);
      } else if (keypadTarget === 'qty' && selectedProductId) {
        updateCartItem(selectedProductId, { quantity: 1 });
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
      setPaymentMode('single');
      if (singleMethod === 'credit') setSingleMethod('cash');
      setPaidInput(nextBuf);
    } else if (keypadTarget === 'discount') {
      setDiscountValue(Math.max(0, parsed));
    } else {
      const targetId = selectedProductId ?? cart[cart.length - 1]?.productId;
      if (!targetId) {
        notify(t(lang, 'اختر منتجاً من الفاتورة أولاً', 'Sélectionnez une ligne d’abord'), 'warning');
        return;
      }
      setSelectedProductId(targetId);
      if (keypadTarget === 'qty') {
        if (parsed > 0) updateCartItem(targetId, { quantity: parsed });
      } else if (keypadTarget === 'price') {
        updateCartItem(targetId, { unitPrice: parsed });
      }
    }
  };

  // Calculations
  const subtotal = round2(cart.reduce((s, c) => s + c.total, 0));
  const discountAmount =
    discountType === 'percent'
      ? round2((subtotal * Math.min(100, Math.max(0, discountValue))) / 100)
      : round2(Math.min(subtotal, Math.max(0, discountValue)));
  const taxRate = settings.storeInfo.taxEnabled ? settings.storeInfo.defaultTaxRate : 0;
  const taxable = Math.max(0, round2(subtotal - discountAmount));
  const taxAmount = round2((taxable * taxRate) / 100);
  const grandTotal = round2(taxable + taxAmount);

  const effectiveTendered = useMemo(() => {
    if (paymentMode === 'split') {
      return round2(splits.reduce((s, p) => s + (Number(p.amount) || 0), 0));
    }
    if (singleMethod === 'credit') return 0;
    if (paidInput === '') return grandTotal;
    return Math.max(0, Number(paidInput) || 0);
  }, [paymentMode, splits, singleMethod, paidInput, grandTotal]);

  const paidAmount = Math.min(grandTotal, effectiveTendered);
  const remainingAmount = round2(Math.max(0, grandTotal - paidAmount));
  const changeGiven = round2(Math.max(0, effectiveTendered - grandTotal));

  const selectedCustomer = customers.find((c) => c.id === customerId) ?? customers[0];

  const customerCreditSummary = useMemo(() => {
    if (!selectedCustomer || !selectedCustomer.id || selectedCustomer.id === 1) {
      return {
        currentDebt: 0,
        creditLimit: 0,
        creditBalance: 0,
        availableCredit: Infinity,
      };
    }
    const openInvoicesDebt = saleInvoices
      .filter((s) => s.customerId === selectedCustomer.id && s.status !== 'cancelled')
      .reduce((sum, s) => sum + s.remainingAmount, 0);
    const currentDebt = round2(openInvoicesDebt + Math.max(0, selectedCustomer.openingBalance || 0));
    const creditLimit = selectedCustomer.creditLimit || 0;
    const creditBalance = round2(selectedCustomer.creditBalance || 0);
    const availableCredit =
      creditLimit > 0 ? round2(Math.max(0, creditLimit - currentDebt)) : Infinity;
    return { currentDebt, creditLimit, creditBalance, availableCredit };
  }, [selectedCustomer, saleInvoices]);

  const appliedCreditPreview =
    applyCreditBalance && customerCreditSummary.creditBalance > 0
      ? round2(Math.min(customerCreditSummary.creditBalance, Math.max(0, grandTotal - paidAmount)))
      : 0;
  const effectivePaidAmount = round2(Math.min(grandTotal, paidAmount + appliedCreditPreview));
  const netRemainingAmount = round2(Math.max(0, grandTotal - effectivePaidAmount));
  const exceedsCreditLimit =
    netRemainingAmount > 0.005 &&
    customerCreditSummary.creditLimit > 0 &&
    round2(customerCreditSummary.currentDebt + netRemainingAmount) >
      customerCreditSummary.creditLimit + 0.005;

  const selectQuickPaymentMethod = (method: PaymentMethod) => {
    setPaymentMode('single');
    setSingleMethod(method);
    if (method === 'credit') {
      setPaidInput('0');
    } else if (paidInput === '0') {
      setPaidInput('');
    }
  };

  const handleCheckout = async (shouldPrint: boolean) => {
    if (!currentUser?.permissions.canSell) {
      notify(t(lang, 'ليس لديك صلاحية البيع', 'Permission de vente refusée'), 'error');
      return;
    }
    if (cart.length === 0) {
      notify(t(lang, 'سلة البيع فارغة', 'Le panier est vide'), 'warning');
      return;
    }
    if (netRemainingAmount > 0.01 && customerId === 1) {
      notify(
        t(
          lang,
          'يرجى اختيار زبون مسجل للبيع الآجل أو الدفع الجزئي',
          'Sélectionnez un client enregistré pour le crédit'
        ),
        'warning'
      );
      return;
    }
    if (exceedsCreditLimit) {
      notify(
        t(
          lang,
          `لا يمكن إتمام البيع: يتجاوز سقف الائتمان للزبون (${formatMoney(customerCreditSummary.creditLimit, cur)} — المتاح: ${formatMoney(customerCreditSummary.availableCredit, cur)})`,
          `Plafond de crédit dépassé (Disponible : ${formatMoney(customerCreditSummary.availableCredit, cur)})`
        ),
        'error'
      );
      return;
    }

    const executeSale = async () => {
      setSubmitting(true);
      try {
        const finalSplits: PaymentSplit[] =
          paymentMode === 'split'
            ? splits.filter((s) => s.amount > 0)
            : singleMethod === 'credit'
              ? []
              : [{ method: singleMethod, amount: paidAmount }];

        const inv = await createSaleInvoice(
          {
            customerId: selectedCustomer?.id ?? 1,
            customerName: selectedCustomer?.fullName ?? 'زبون عابر (نقدي)',
            items: cart,
            discountType,
            discountValue,
            taxRate,
            paymentSplits: finalSplits,
            tenderedAmount: effectiveTendered,
            isCredit: netRemainingAmount > 0.01,
            dueDate: netRemainingAmount > 0.01 ? firstDueDate : undefined,
            installmentCount: netRemainingAmount > 0.01 ? installmentCount : undefined,
            installmentFrequency: netRemainingAmount > 0.01 ? installmentFrequency : undefined,
            applyCreditBalance,
            notes: notes.trim() || undefined,
            idempotencyKey: makeIdempotencyKey('pos'),
          },
          currentUser
        );

        setLastInvoice(inv);
        setCart([]);
        setSelectedProductId(null);
        setKeypadBuffer('');
        setDiscountValue(0);
        setPaidInput('');
        setNotes('');
        setInstallmentCount(1);
        setApplyCreditBalance(false);
        setSingleMethod('cash');
        setPaymentMode('single');
        setSplits([
          { method: 'cash', amount: 0 },
          { method: 'card', amount: 0 },
        ]);
        notify(
          t(
            lang,
            `تم تسجيل الفاتورة ${inv.invoiceNumber} بنجاح`,
            `Facture ${inv.invoiceNumber} enregistrée`
          )
        );
        const willPrint = shouldPrint || settings.printing.autoPrint;
        const hasCashPayment = finalSplits.some((s) => s.method === 'cash' && s.amount > 0);
        if (
          hasCashPayment &&
          settings.printing.cashDrawer.enabled &&
          settings.printing.cashDrawer.autoOpenOnCashSale &&
          (settings.printing.cashDrawer.mode === 'serial_escpos' || !willPrint)
        ) {
          void executeOpenCashDrawer('cash_sale', inv.invoiceNumber);
        }
        if (willPrint) {
          openPrint({ type: 'sale_invoice', invoice: inv });
        }
        barcodeInputRef.current?.focus();
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        setSubmitting(false);
      }
    };

    requestGuardedAction({
      title: t(lang, 'تأكيد إتمام عملية البيع', 'Confirmer la vente'),
      description: t(
        lang,
        `تأكيد حفظ فاتورة بمبلغ ${formatMoney(grandTotal, cur)} للزبون ${selectedCustomer?.fullName ?? ''}؟`,
        `Confirmer la facture de ${formatMoney(grandTotal, cur)} ?`
      ),
      isFinancialConfirm: true,
      onConfirm: executeSale,
    });
  };

  const handleHoldCart = async () => {
    if (cart.length === 0) return;
    await db.heldCarts.add({
      label: `${selectedCustomer?.fullName ?? 'زبون'} (${cart.length}) — ${grandTotal.toFixed(2)} ${cur}`,
      customerId,
      items: cart,
      discountType,
      discountValue,
      createdAt: new Date().toISOString(),
      sellerName: currentUser?.fullName ?? '',
    });
    setCart([]);
    setSelectedProductId(null);
    setKeypadBuffer('');
    setDiscountValue(0);
    setPaidInput('');
    setShowHeldModal(false);
    notify(t(lang, 'تم تعليق الفاتورة ويمكن استرجاعها لاحقاً', 'Panier mis en attente'));
  };

  const handleResumeCart = async (heldId: number) => {
    const held = await db.heldCarts.get(heldId);
    if (!held) return;
    setCart(held.items);
    setSelectedProductId(held.items[0]?.productId ?? null);
    setCustomerId(held.customerId ?? 1);
    setDiscountType(held.discountType);
    setDiscountValue(held.discountValue);
    await db.heldCarts.delete(heldId);
    setShowHeldModal(false);
    notify(t(lang, 'تم استرجاع الفاتورة المعلقة', 'Panier restauré'));
  };

  // Filtered Sales Log (6.1)
  const filteredInvoices = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    return saleInvoices.filter((inv) => {
      const matchQ =
        !q ||
        inv.invoiceNumber.toLowerCase().includes(q) ||
        inv.customerName.toLowerCase().includes(q);
      const matchStatus = logStatus === 'all' || inv.status === logStatus;
      const matchSeller = logSeller === 'all' || String(inv.sellerId) === logSeller;
      const d = inv.date.slice(0, 10);
      const matchFrom = !logDateFrom || d >= logDateFrom;
      const matchTo = !logDateTo || d <= logDateTo;
      return matchQ && matchStatus && matchSeller && matchFrom && matchTo;
    });
  }, [saleInvoices, logSearch, logStatus, logSeller, logDateFrom, logDateTo]);

  const handleConfirmCancel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelTarget || !currentUser) return;
    if (!currentUser.permissions.canCancelSale) {
      notify(t(lang, 'ليس لديك صلاحية إلغاء الفواتير', 'Permission d’annulation refusée'), 'error');
      return;
    }
    try {
      await cancelSaleInvoice(cancelTarget.id!, cancelReason, currentUser);
      notify(t(lang, 'تم إلغاء الفاتورة وإرجاع المخزون بقيد عكسي', 'Facture annulée et stock restauré'));
      setCancelTarget(null);
      setCancelReason('');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const returnBreakdown = useMemo(() => {
    if (!returnTarget) return null;
    const priorReturnedTotal = round2(
      saleReturns
        .filter((r) => r.saleInvoiceId === returnTarget.id)
        .reduce((s, r) => s + r.totalAmount, 0)
    );
    return calculateSaleReturnBreakdown(returnTarget, returnQtys, priorReturnedTotal);
  }, [returnTarget, returnQtys, saleReturns]);

  const handleConfirmReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnTarget || !currentUser || !returnBreakdown) return;
    const itemsToReturn = toSaleReturnItems(returnBreakdown.items);
    try {
      await createSaleReturn(
        returnTarget.id!,
        itemsToReturn,
        returnMethod,
        returnReason || 'مرتجع زبون',
        currentUser
      );
      notify(t(lang, 'تم تسجيل المرتجع وتحديث المخزون والحساب بدقة', 'Retour enregistré avec calcul exact'));
      setReturnTarget(null);
      setReturnQtys({});
      setReturnReason('');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleConfirmEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTarget || !currentUser) return;
    try {
      await updateSaleInvoiceControlled(
        editTarget.id!,
        { items: editItems, discountAmount: editDiscount, notes: editTarget.notes },
        currentUser
      );
      notify(t(lang, 'تم تعديل الفاتورة وتحديث فروقات المخزون', 'Facture modifiée'));
      setEditTarget(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const exportSalesExcel = () => {
    exportRowsToExcel(
      filteredInvoices.map((inv) => ({
        Invoice: inv.invoiceNumber,
        Date: formatDateTime(inv.date, lang),
        Customer: inv.customerName,
        Seller: inv.sellerName,
        Total: inv.total,
        Paid: inv.paidAmount,
        Remaining: inv.remainingAmount,
        Method: inv.paymentMethod,
        Status: inv.status,
      })),
      'SalesInvoices',
      'sales_invoices.xlsx'
    );
  };

  const exportSalesPdf = () => {
    exportTableToPdf(
      'Sales Invoices Register',
      `Exported ${new Date().toISOString().slice(0, 10)} (${filteredInvoices.length} invoices)`,
      ['Invoice', 'Date', 'Customer', 'Total', 'Paid', 'Remaining', 'Status'],
      filteredInvoices.map((i) => [
        i.invoiceNumber,
        i.date.slice(0, 16).replace('T', ' '),
        i.customerName,
        i.total.toFixed(2),
        i.paidAmount.toFixed(2),
        i.remainingAmount.toFixed(2),
        i.status,
      ]),
      'sales_invoices.pdf'
    );
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
      {/* TOP AMBER/GOLD BAR (Matching blueprint image) */}
      <div className="rounded-xl border-2 border-amber-400 bg-amber-300 px-3 py-2 shadow-sm text-slate-950">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          {/* Start (Right in RTL): Back button + Customer Selector */}
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
              <UserCheck className="h-4 w-4 text-amber-800 shrink-0" />
              <select
                value={customerId}
                onChange={(e) => setCustomerId(Number(e.target.value))}
                aria-label={t(lang, 'اختيار الزبون', 'Choisir le client')}
                className="bg-transparent text-xs font-bold text-slate-900 focus:outline-none max-w-[180px] sm:max-w-[220px]"
              >
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.fullName} {c.phone && c.id !== 1 ? `(${c.phone})` : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Center: Logo + Program Name + Quick POS / Log Switcher */}
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
                  {t(lang, 'نقطة البيع السريع — POS', 'Point de Vente — POS')}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1 rounded-lg bg-amber-400/70 p-0.5 border border-amber-500/50">
              <button
                type="button"
                onClick={() => setActiveTab('pos')}
                className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors whitespace-nowrap ${
                  activeTab === 'pos'
                    ? 'bg-slate-950 text-amber-300 shadow-sm'
                    : 'text-slate-900 hover:bg-amber-200/70'
                }`}
              >
                {t(lang, '6. نقطة البيع', '6. Caisse POS')}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('sales_log')}
                className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors whitespace-nowrap ${
                  activeTab === 'sales_log'
                    ? 'bg-slate-950 text-amber-300 shadow-sm'
                    : 'text-slate-900 hover:bg-amber-200/70'
                }`}
              >
                {t(lang, `6.1 سجل الفواتير (${saleInvoices.length})`, `6.1 Journal (${saleInvoices.length})`)}
              </button>
            </div>
          </div>

          {/* End (Left in RTL): One-Tap Camera Scan + Price Tier + Live Date & Time */}
          <div className="flex items-center gap-2">
            {activeTab === 'pos' && (
              <>
                <button
                  type="button"
                  onClick={() => setShowCameraScanner(true)}
                  title={t(lang, 'مسح الباركود بكاميرا الجهاز (F2)', 'Scanner code-barres caméra (F2)')}
                  className="inline-flex items-center gap-1.5 rounded-lg border-2 border-slate-900 bg-teal-700 px-2.5 py-1.5 text-xs font-extrabold text-white shadow-sm hover:bg-teal-800 active:scale-[0.98]"
                >
                  <Camera className="h-4 w-4 shrink-0" />
                  <span>{t(lang, 'مسح بالكاميرا', 'Caméra')}</span>
                </button>
                {settings.printing.cashDrawer.enabled && (
                  <button
                    type="button"
                    disabled={openingDrawer}
                    onClick={handleManualOpenDrawerClick}
                    title={t(lang, 'فتح درج النقدية (F9)', 'Ouvrir le tiroir-caisse (F9)')}
                    className="inline-flex items-center gap-1.5 rounded-lg border-2 border-slate-900 bg-slate-900 px-2.5 py-1.5 text-xs font-extrabold text-amber-300 shadow-sm hover:bg-slate-800 active:scale-[0.98] disabled:opacity-60"
                  >
                    <Inbox className="h-4 w-4 shrink-0" />
                    <span>{t(lang, 'فتح الدرج (F9)', 'Tiroir (F9)')}</span>
                  </button>
                )}
                <select
                  value={priceTier}
                  onChange={(e) =>
                    setPriceTier(e.target.value as 'retail' | 'wholesale' | 'second')
                  }
                  className="rounded-lg border border-amber-600/40 bg-white/90 px-2 py-1 text-[11px] font-bold text-slate-900"
                >
                  <option value="retail">{t(lang, 'تقسيط', 'Détail')}</option>
                  <option value="wholesale">{t(lang, 'جملة', 'Gros')}</option>
                  <option value="second">{t(lang, 'سعر 2', 'Tarif 2')}</option>
                </select>
              </>
            )}
            <div className="rounded-lg border border-amber-600/40 bg-amber-200/75 px-3 py-1 text-center font-mono leading-tight tabular-nums">
              <div className="text-xs font-extrabold text-slate-950">{liveTimeStr}</div>
              <div className="text-[10px] font-semibold text-slate-800">{liveDateStr}</div>
            </div>
          </div>
        </div>
      </div>

      {activeTab === 'pos' ? (
        /* MAIN BLUEPRINT SPLIT LAYOUT */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5 items-stretch">
          {/* RIGHT PANEL IN RTL (5 cols): Receipt Table + Barcode/Camera + TOTALE + Keypad & Actions */}
          <div className="lg:col-span-5 flex flex-col gap-2">
            {/* 1. Receipt Table (Qte | article | TTC | total) */}
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
                        TTC
                      </th>
                      <th className="w-20 px-2 py-2 text-end font-extrabold">
                        total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {cart.map((item) => {
                      const isSelected = selectedProductId === item.productId;
                      return (
                        <tr
                          key={item.productId}
                          onClick={() => {
                            setSelectedProductId(item.productId);
                            setKeypadBuffer('');
                          }}
                          className={`cursor-pointer border-b border-slate-300 transition-colors ${
                            isSelected
                              ? 'bg-sky-100 text-slate-950 font-semibold'
                              : 'hover:bg-slate-50 text-slate-800'
                          }`}
                        >
                          <td className="border-e border-slate-300 px-1.5 py-1.5 text-center font-mono font-bold tabular-nums">
                            {item.quantity}
                          </td>
                          <td className="border-e border-slate-300 px-2 py-1.5">
                            <div className="truncate font-semibold max-w-[165px] sm:max-w-[200px]">
                              {item.productName}
                            </div>
                            {item.discount > 0 && (
                              <div className="text-[10px] text-amber-700 font-mono">
                                -{item.discount.toFixed(2)} {cur}
                              </div>
                            )}
                          </td>
                          <td className="border-e border-slate-300 px-2 py-1.5 text-end font-mono tabular-nums">
                            {item.unitPrice.toFixed(2)}
                          </td>
                          <td className="px-2 py-1.5 text-end font-mono font-bold tabular-nums">
                            {item.total.toFixed(2)}
                          </td>
                        </tr>
                      );
                    })}
                    {/* Authentic receipt empty ledger lines when cart has fewer than 8 items */}
                    {Array.from({ length: Math.max(0, 8 - cart.length) }).map((_, i) => (
                      <tr key={`empty-${i}`} className="h-8 border-b border-slate-200/90">
                        <td className="border-e border-slate-200/90" />
                        <td className="border-e border-slate-200/90" />
                        <td className="border-e border-slate-200/90" />
                        <td />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Compact Selected Item Quick Controls & Discount / Split Indicators */}
              <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-slate-300 bg-slate-50 px-2.5 py-1.5 text-[11px]">
                <div className="flex items-center gap-1.5 text-slate-700">
                  <span className="font-bold">
                    {t(lang, `المواد: ${cart.length}`, `Articles : ${cart.length}`)}
                  </span>
                  {discountAmount > 0 && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono font-bold text-amber-900">
                      -{discountAmount.toFixed(2)} {cur}
                    </span>
                  )}
                  {paymentMode === 'split' && (
                    <span className="rounded bg-teal-100 px-1.5 py-0.5 font-bold text-teal-900">
                      {t(lang, 'دفع متعدد', 'Multi-paiement')}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setShowExtrasModal(true)}
                    className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    <Percent className="h-3 w-3 text-amber-600" />
                    {t(lang, 'خصم / تقسيم الدفع', 'Remise / Multi')}
                  </button>

                  {/* Live Paper Size Synced with Settings (A4 / 80mm / 58mm) */}
                  <div
                    className="inline-flex items-center rounded border border-slate-300 bg-white p-0.5 text-[10px]"
                    title={t(lang, 'حجم ورقة الطباعة التلقائي للفاتورة', 'Format papier automatique')}
                  >
                    {(['a4', '80mm', '58mm'] as const).map((sz) => (
                      <button
                        key={sz}
                        type="button"
                        onClick={async () => {
                          if (!currentUser || settings.printing.salesFormat === sz) return;
                          await updateSettingsSection(
                            (prev) => ({
                              ...prev,
                              printing: { ...prev.printing, salesFormat: sz },
                            }),
                            currentUser,
                            `تغيير حجم ورقة الطباعة من نقطة البيع إلى ${sz.toUpperCase()}`
                          );
                          notify(
                            t(
                              lang,
                              `تم تعيين حجم ورق الطباعة إلى ${sz.toUpperCase()} تلقائياً`,
                              `Format papier défini sur ${sz.toUpperCase()}`
                            )
                          );
                        }}
                        className={`rounded px-1.5 py-0.5 font-mono font-bold transition-colors ${
                          settings.printing.salesFormat === sz
                            ? 'bg-teal-700 text-white'
                            : 'text-slate-600 hover:bg-slate-100'
                        }`}
                      >
                        {sz.toUpperCase()}
                      </button>
                    ))}
                  </div>

                  {(lastInvoice || saleInvoices[0]) && (
                    <button
                      type="button"
                      onClick={() =>
                        openPrint({
                          type: 'sale_invoice',
                          invoice: lastInvoice ?? saleInvoices[0],
                        })
                      }
                      title={t(
                        lang,
                        `إعادة طباعة آخر فاتورة (${settings.printing.salesFormat.toUpperCase()})`,
                        `Réimprimer dernière (${settings.printing.salesFormat.toUpperCase()})`
                      )}
                      className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 font-semibold text-teal-800 hover:bg-teal-50"
                    >
                      <Printer className="h-3 w-3" />
                      {t(lang, 'آخر فاتورة', 'Dernière')}
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
                    'البحث ب كود بار (امسح واضغط Enter)...',
                    'Rechercher par code-barres (Entrée)...'
                  )}
                  className="w-full rounded-lg border-2 border-slate-800 bg-white py-2.5 ps-9 pe-3 text-center text-xs font-bold text-slate-900 placeholder:text-slate-500 focus:border-teal-700 focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={() => setShowCameraScanner(true)}
                title={t(lang, 'فتح كاميرا قارئ الباركود (F2)', 'Scanner avec la caméra (F2)')}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border-2 border-slate-900 bg-teal-700 px-3.5 py-2 text-xs font-extrabold text-white hover:bg-teal-800 active:scale-[0.98] shrink-0"
              >
                <Camera className="h-4 w-4 shrink-0" />
                <span>{t(lang, 'كاميرا', 'Caméra')}</span>
              </button>
            </div>

            {/* 3. Green TOTALE Banner */}
            <div className="rounded-lg border-2 border-slate-900 bg-lime-500 text-slate-950 shadow-sm overflow-hidden">
              <div className="flex items-center justify-between px-3.5 py-2" dir="ltr">
                <span className="text-base font-black tracking-wide border-r-2 border-slate-900/40 pr-3">
                  TOTALE
                </span>
                <span className="font-mono text-2xl font-black tabular-nums">
                  {grandTotal.toFixed(2)} <span className="text-sm font-extrabold">{cur}</span>
                </span>
              </div>
              {/* Compact Paid / Remaining / Change bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-900/25 bg-lime-400/75 px-3 py-1 text-[11px] font-bold">
                <span>
                  {t(lang, 'المدفوع:', 'Payé :')}{' '}
                  <span className="font-mono tabular-nums">{effectivePaidAmount.toFixed(2)}</span>
                </span>
                <span className={netRemainingAmount > 0 ? 'text-red-900' : 'text-slate-900'}>
                  {t(lang, 'المتبقي:', 'Reste :')}{' '}
                  <span className="font-mono tabular-nums">{netRemainingAmount.toFixed(2)}</span>
                </span>
                {changeGiven > 0 && (
                  <span className="rounded bg-slate-950 px-1.5 py-0.5 text-lime-300 font-mono tabular-nums">
                    {t(lang, 'الباقي للزبون:', 'Monnaie :')} {changeGiven.toFixed(2)}
                  </span>
                )}
              </div>

              {/* Customer Credit Limit, Credit Balance & Installments Strip */}
              {customerId !== 1 && (customerCreditSummary.creditLimit > 0 || customerCreditSummary.creditBalance > 0 || netRemainingAmount > 0.005) && (
                <div className={`border-t border-slate-900/25 px-3 py-1.5 text-[11px] space-y-1.5 ${exceedsCreditLimit ? 'bg-red-100 text-red-950' : 'bg-white/90 text-slate-800'}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-bold">
                      {t(lang, 'الدين الحالي:', 'Dette :')}{' '}
                      <span className="font-mono">{customerCreditSummary.currentDebt.toFixed(2)}</span>
                      {customerCreditSummary.creditLimit > 0 && (
                        <>
                          {' / '}
                          {t(lang, 'السقف:', 'Plafond :')}{' '}
                          <span className="font-mono">{customerCreditSummary.creditLimit.toFixed(2)}</span>
                        </>
                      )}
                    </span>
                    {customerCreditSummary.creditBalance > 0 && (
                      <label className="inline-flex items-center gap-1 font-bold text-teal-800 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={applyCreditBalance}
                          onChange={(e) => setApplyCreditBalance(e.target.checked)}
                        />
                        {t(
                          lang,
                          `استعمال رصيد الزبون (${customerCreditSummary.creditBalance.toFixed(2)})`,
                          `Utiliser avoir (${customerCreditSummary.creditBalance.toFixed(2)})`
                        )}
                      </label>
                    )}
                  </div>

                  {exceedsCreditLimit && (
                    <div className="rounded bg-red-600 px-2 py-1 text-[10px] font-extrabold text-white">
                      {t(
                        lang,
                        `تنبيه: البيع يتجاوز سقف الائتمان المتاح (${customerCreditSummary.availableCredit.toFixed(2)} ${cur})`,
                        `Attention : plafond dépassé (Dispo : ${customerCreditSummary.availableCredit.toFixed(2)} ${cur})`
                      )}
                    </div>
                  )}

                  {netRemainingAmount > 0.005 && !exceedsCreditLimit && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      <span className="font-extrabold text-slate-900">
                        {t(lang, 'جدول الأقساط:', 'Échéancier :')}
                      </span>
                      <select
                        value={installmentCount}
                        onChange={(e) => setInstallmentCount(Number(e.target.value))}
                        className="rounded border border-slate-400 bg-white px-1.5 py-0.5 text-[11px] font-mono font-bold"
                      >
                        {[1, 2, 3, 4, 6, 12].map((n) => (
                          <option key={n} value={n}>
                            {n} {t(lang, n === 1 ? 'قسط' : 'أقساط', n === 1 ? 'échéance' : 'échéances')}
                          </option>
                        ))}
                      </select>
                      <select
                        value={installmentFrequency}
                        onChange={(e) => setInstallmentFrequency(e.target.value as InstallmentFrequency)}
                        className="rounded border border-slate-400 bg-white px-1.5 py-0.5 text-[11px] font-bold"
                      >
                        <option value="weekly">{t(lang, 'أسبوعي', 'Hebdo')}</option>
                        <option value="biweekly">{t(lang, 'نصف شهري', 'Quinzaine')}</option>
                        <option value="monthly">{t(lang, 'شهري', 'Mensuel')}</option>
                      </select>
                      <input
                        type="date"
                        value={firstDueDate}
                        onChange={(e) => setFirstDueDate(e.target.value)}
                        title={t(lang, 'تاريخ أول استحقاق', '1re échéance')}
                        className="rounded border border-slate-400 bg-white px-1.5 py-0.5 font-mono text-[10px]"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 4. Bottom Split: Action Buttons Stack (Right in RTL) + Numeric Keypad (Left in RTL) */}
            <div className="grid grid-cols-12 gap-1.5 items-stretch">
              {/* Action Buttons Stack (Matches exact color stack in diagram) */}
              <div className="col-span-6 flex flex-col gap-1">
                {/* Yellow: Attentes (Hold / Resume Carts) */}
                <button
                  type="button"
                  onClick={() => setShowHeldModal(true)}
                  className="flex items-center justify-between rounded-md border border-slate-900 bg-amber-400 px-2.5 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-300 active:scale-[0.99]"
                >
                  <span className="inline-flex items-center gap-1 truncate">
                    <PauseCircle className="h-3.5 w-3.5 shrink-0" />
                    <span>{t(lang, 'Attentes (تعليق)', 'Attentes')}</span>
                  </span>
                  {heldCarts.length > 0 && (
                    <span className="rounded bg-slate-950 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
                      {heldCarts.length}
                    </span>
                  )}
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

                {/* Sky Blue: Calculatrices + Dark Navy: Tiroir (Open Cash Drawer) */}
                <div className="grid grid-cols-2 gap-1">
                  <button
                    type="button"
                    onClick={() => setShowCalculator(true)}
                    className="flex items-center justify-center gap-1 rounded-md border border-slate-900 bg-sky-500 px-1.5 py-2 text-[11px] font-extrabold text-slate-950 hover:bg-sky-400 active:scale-[0.99]"
                  >
                    <Calculator className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{t(lang, 'حاسبة', 'Calcul')}</span>
                  </button>
                  <button
                    type="button"
                    disabled={openingDrawer}
                    onClick={handleManualOpenDrawerClick}
                    title={t(lang, 'فتح درج النقدية (F9)', 'Ouvrir tiroir-caisse (F9)')}
                    className="flex items-center justify-center gap-1 rounded-md border border-slate-900 bg-[#0B274D] px-1.5 py-2 text-[11px] font-extrabold text-[#FDE68A] hover:bg-slate-900 active:scale-[0.99] disabled:opacity-50"
                  >
                    <Inbox className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{t(lang, 'فتح الدرج', 'Tiroir')}</span>
                  </button>
                </div>

                {/* 2x2 Payment Methods Grid: cheque / espece / credit / banque */}
                <div className="grid grid-cols-2 gap-1" dir="ltr">
                  <button
                    type="button"
                    onClick={() => selectQuickPaymentMethod('check')}
                    className={`relative flex items-center justify-center gap-1 rounded-md border px-1.5 py-2 text-[11px] font-extrabold transition-all ${
                      paymentMode === 'single' && singleMethod === 'check'
                        ? 'border-2 border-slate-950 bg-amber-200 text-slate-950 ring-2 ring-slate-950/30'
                        : 'border-slate-800 bg-amber-100 text-slate-900 hover:bg-amber-200'
                    }`}
                  >
                    {paymentMode === 'single' && singleMethod === 'check' && (
                      <Check className="h-3 w-3 shrink-0" />
                    )}
                    <span>cheque</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => selectQuickPaymentMethod('cash')}
                    className={`relative flex items-center justify-center gap-1 rounded-md border px-1.5 py-2 text-[11px] font-extrabold transition-all ${
                      paymentMode === 'single' && singleMethod === 'cash'
                        ? 'border-2 border-slate-950 bg-lime-400 text-slate-950 ring-2 ring-slate-950/30'
                        : 'border-slate-800 bg-lime-300 text-slate-900 hover:bg-lime-400'
                    }`}
                  >
                    {paymentMode === 'single' && singleMethod === 'cash' && (
                      <Check className="h-3 w-3 shrink-0" />
                    )}
                    <span>espèce</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => selectQuickPaymentMethod('credit')}
                    className={`relative flex items-center justify-center gap-1 rounded-md border px-1.5 py-2 text-[11px] font-extrabold transition-all ${
                      paymentMode === 'single' && singleMethod === 'credit'
                        ? 'border-2 border-slate-950 bg-red-600 text-white ring-2 ring-red-900/40'
                        : 'border-slate-800 bg-red-600/90 text-white hover:bg-red-600'
                    }`}
                  >
                    {paymentMode === 'single' && singleMethod === 'credit' && (
                      <Check className="h-3 w-3 shrink-0" />
                    )}
                    <span>crédit</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => selectQuickPaymentMethod('card')}
                    className={`relative flex items-center justify-center gap-1 rounded-md border px-1.5 py-2 text-[11px] font-extrabold transition-all ${
                      paymentMode === 'single' &&
                      (singleMethod === 'card' || singleMethod === 'bank_transfer')
                        ? 'border-2 border-slate-950 bg-sky-300 text-slate-950 ring-2 ring-slate-950/30'
                        : 'border-slate-800 bg-sky-200 text-slate-900 hover:bg-sky-300'
                    }`}
                  >
                    {paymentMode === 'single' &&
                      (singleMethod === 'card' || singleMethod === 'bank_transfer') && (
                        <Check className="h-3 w-3 shrink-0" />
                      )}
                    <span>banque</span>
                  </button>
                </div>

                {/* Green: حفظ وطباعة + Quick Save-only icon button */}
                <div className="flex items-stretch gap-1">
                  <button
                    type="button"
                    disabled={submitting || cart.length === 0}
                    onClick={() => handleCheckout(true)}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-md border border-slate-900 bg-lime-500 px-2 py-2 text-xs font-extrabold text-slate-950 hover:bg-lime-400 disabled:opacity-50"
                  >
                    <Printer className="h-3.5 w-3.5 shrink-0" />
                    <span>{t(lang, 'حفظ وطباعة', 'Valider & Imprimer')}</span>
                  </button>
                  <button
                    type="button"
                    disabled={submitting || cart.length === 0}
                    onClick={() => handleCheckout(false)}
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

              {/* Numeric Keypad (3x4 grid: 1-9, CL, 0, ,) */}
              <div className="col-span-6 flex flex-col gap-1">
                {/* Compact Target Mode Strip */}
                <div className="grid grid-cols-3 gap-0.5 rounded-md border border-slate-800 bg-slate-100 p-0.5 text-[10px] font-bold">
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
                    {t(lang, 'الكمية', 'Qté')}
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
                    {t(lang, 'المدفوع', 'Payé')}
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
                    {t(lang, 'خصم', 'Remise')}
                  </button>
                </div>

                {/* 3x4 Keypad Grid (Forced LTR so 1-2-3 reads left-to-right like diagram) */}
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

          {/* LEFT PANEL IN RTL (7 cols): Dense Product Cards Grid + 2x6 Light Blue Categories Bar */}
          <div className="lg:col-span-7 flex flex-col gap-2">
            {/* Active Name Search Filter Banner (appears when searching by name) */}
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

            {/* Dense Peach Product Cards Grid (Matches screenshot cells) */}
            <div className="flex-1 rounded-xl border-2 border-slate-800 bg-orange-50/40 p-1.5 overflow-y-auto max-h-[54vh] lg:max-h-[540px]">
              {filteredProducts.length === 0 ? (
                <div className="flex h-64 flex-col items-center justify-center gap-2 text-slate-500 text-xs">
                  <Package className="h-8 w-8 text-slate-400" />
                  <span>{t(lang, 'لا توجد منتجات في هذه المجموعة', 'Aucun produit dans cette catégorie')}</span>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-1.5">
                  {filteredProducts.map((p) => {
                    const tierPrice = getProductTierPrice(p);
                    const outOfStock = p.quantity <= 0 && !settings.posConfig.allowNegativeStock;
                    const inCartQty = cart.find((c) => c.productId === p.id)?.quantity ?? 0;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        disabled={outOfStock}
                        onClick={() => addToCart(p)}
                        className={`relative flex flex-col items-center justify-between rounded-md border p-2 text-center transition-all min-h-[118px] ${
                          outOfStock
                            ? 'border-slate-300 bg-slate-100 opacity-55 cursor-not-allowed'
                            : 'border-slate-800/70 bg-orange-100/75 hover:bg-orange-200/80 hover:border-slate-950 active:scale-[0.98]'
                        }`}
                      >
                        {inCartQty > 0 && (
                          <span className="absolute top-1 end-1 rounded bg-slate-950 px-1.5 py-0.5 font-mono text-[10px] font-bold text-lime-300">
                            ×{inCartQty}
                          </span>
                        )}

                        {/* Product Image or Clean Fallback */}
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

                        {/* Product Name */}
                        <div className="mt-1.5 text-[11px] font-bold text-slate-950 line-clamp-2 leading-tight">
                          {p.name}
                        </div>

                        {/* Price & Stock */}
                        <div className="mt-1 w-full flex items-center justify-between gap-1 border-t border-orange-300/70 pt-1">
                          <span className="font-mono text-xs font-black text-slate-950 tabular-nums">
                            {tierPrice.toFixed(2)}
                          </span>
                          <span
                            className={`font-mono text-[10px] tabular-nums ${
                              p.quantity <= p.minStock
                                ? 'text-red-700 font-extrabold'
                                : 'text-slate-600 font-semibold'
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
              {/* Amber Left & Right Pagination Arrows (placed on start/right side next to keypad in RTL matching diagram) */}
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

              {/* 6x2 Light Blue Categories Grid */}
              <div className="flex-1 grid grid-cols-3 sm:grid-cols-6 grid-rows-2 border-2 border-slate-800 rounded-md overflow-hidden bg-sky-100">
                {Array.from({ length: CATS_PER_PAGE }).map((_, idx) => {
                  const slot = visibleCategories[idx];
                  if (!slot) {
                    return (
                      <div
                        key={`empty-cat-${idx}`}
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
      ) : (
        /* 6.1 SALES INVOICES LOG (Preserved 100%) */
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3">
            <div className="flex flex-wrap items-center gap-2 flex-1">
              <div className="relative min-w-[200px] flex-1">
                <Search className="pointer-events-none absolute top-2.5 start-3 h-4 w-4 text-slate-400" />
                <input
                  value={logSearch}
                  onChange={(e) => setLogSearch(e.target.value)}
                  placeholder={t(lang, 'بحث برقم الفاتورة أو الزبون...', 'N° facture ou client...')}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 ps-9 pe-3 text-xs focus:border-teal-600 focus:bg-white focus:outline-none"
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
                <option value="unpaid">{t(lang, 'آجل', 'Impayée')}</option>
                <option value="cancelled">{t(lang, 'ملغاة', 'Annulée')}</option>
              </select>
              <select
                value={logSeller}
                onChange={(e) => setLogSeller(e.target.value)}
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
              >
                <option value="all">{t(lang, 'كل البائعين', 'Tous vendeurs')}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
              <input
                type="date"
                value={logDateFrom}
                onChange={(e) => setLogDateFrom(e.target.value)}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-mono"
              />
              <input
                type="date"
                value={logDateTo}
                onChange={(e) => setLogDateTo(e.target.value)}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-mono"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={exportSalesExcel}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5" /> Excel
              </button>
              <button
                type="button"
                onClick={exportSalesPdf}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <FileDown className="h-3.5 w-3.5" /> PDF
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <th className="px-3 py-3 text-start font-semibold">{t(lang, 'رقم الفاتورة', 'N° Facture')}</th>
                    <th className="px-3 py-3 text-start font-semibold">{t(lang, 'التاريخ والوقت', 'Date')}</th>
                    <th className="px-3 py-3 text-start font-semibold">{t(lang, 'الزبون / البائع', 'Client / Vendeur')}</th>
                    <th className="px-3 py-3 text-end font-semibold">{t(lang, 'الإجمالي', 'Total')}</th>
                    <th className="px-3 py-3 text-end font-semibold">{t(lang, 'المدفوع', 'Payé')}</th>
                    <th className="px-3 py-3 text-end font-semibold">{t(lang, 'المتبقي', 'Reste')}</th>
                    <th className="px-3 py-3 text-start font-semibold">{t(lang, 'الدفع / الحالة', 'Mode / Statut')}</th>
                    <th className="px-3 py-3 text-end font-semibold">{t(lang, 'إجراءات', 'Actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredInvoices.map((inv) => (
                    <tr
                      key={inv.id}
                      className={`hover:bg-slate-50 ${inv.status === 'cancelled' ? 'opacity-60' : ''}`}
                    >
                      <td className="px-3 py-3 font-mono font-semibold text-slate-900">
                        {inv.invoiceNumber}
                      </td>
                      <td className="px-3 py-3 text-slate-600">{formatDateTime(inv.date, lang)}</td>
                      <td className="px-3 py-3">
                        <div className="font-medium text-slate-900">{inv.customerName}</div>
                        <div className="text-[11px] text-slate-500">{inv.sellerName}</div>
                      </td>
                      <td className="px-3 py-3 text-end font-mono font-semibold tabular-nums text-slate-900">
                        {formatMoney(inv.total, cur)}
                      </td>
                      <td className="px-3 py-3 text-end font-mono tabular-nums text-emerald-700">
                        {formatMoney(inv.paidAmount, cur)}
                      </td>
                      <td className="px-3 py-3 text-end font-mono tabular-nums text-red-700">
                        {formatMoney(inv.remainingAmount, cur)}
                      </td>
                      <td className="px-3 py-3">
                        <div className="text-slate-700">{getPaymentMethodLabel(inv.paymentMethod, lang)}</div>
                        <div
                          className={`text-[11px] font-medium ${
                            inv.status === 'paid'
                              ? 'text-emerald-700'
                              : inv.status === 'cancelled'
                                ? 'text-red-700'
                                : 'text-amber-700'
                          }`}
                        >
                          {getStatusLabel(inv.status, lang)}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setDetailInvoice(inv)}
                            title={t(lang, 'التفاصيل', 'Détails')}
                            className="rounded p-1.5 text-slate-600 hover:bg-slate-100"
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => openPrint({ type: 'sale_invoice', invoice: inv })}
                            title={t(lang, 'إعادة الطباعة', 'Réimprimer')}
                            className="rounded p-1.5 text-teal-700 hover:bg-teal-50"
                          >
                            <Printer className="h-3.5 w-3.5" />
                          </button>
                          {inv.status !== 'cancelled' && currentUser?.permissions.canEditInvoice && (
                            <button
                              type="button"
                              onClick={() => {
                                setEditTarget(inv);
                                setEditItems(inv.items.map((x) => ({ ...x })));
                                setEditDiscount(inv.discountAmount);
                              }}
                              title={t(lang, 'تعديل الفاتورة', 'Modifier')}
                              className="rounded p-1.5 text-slate-600 hover:bg-slate-100"
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {inv.status !== 'cancelled' && (
                            <button
                              type="button"
                              onClick={() => {
                                setReturnTarget(inv);
                                setReturnQtys({});
                                setReturnReason('');
                              }}
                              title={t(lang, 'تسجيل مرتجع', 'Enregistrer un retour')}
                              className="rounded p-1.5 text-amber-700 hover:bg-amber-50"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {inv.status !== 'cancelled' && currentUser?.permissions.canCancelSale && (
                            <button
                              type="button"
                              onClick={() => {
                                setCancelTarget(inv);
                                setCancelReason('');
                              }}
                              title={t(lang, 'إلغاء الفاتورة', 'Annuler la facture')}
                              className="rounded p-1.5 text-red-600 hover:bg-red-50"
                            >
                              <Ban className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filteredInvoices.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                        {t(lang, 'لا توجد فواتير مطابقة', 'Aucune facture trouvée')}
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
        cartCount={cart.length}
        cartTotal={grandTotal}
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
          setPaymentMode('single');
          if (singleMethod === 'credit') setSingleMethod('cash');
          setPaidInput(String(val));
          notify(t(lang, `تم تطبيق ${val.toFixed(2)} ${cur} كمبلغ مدفوع`, `Montant payé : ${val.toFixed(2)} ${cur}`));
        }}
      />

      {/* Product Name Search Modal */}
      {showNameSearchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Search className="h-4 w-4 text-teal-700" />
                {t(lang, 'البحث السريع بإسم المنتج', 'Recherche rapide par nom')}
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
              {filteredProducts.slice(0, 25).map((p) => {
                const price = getProductTierPrice(p);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      addToCart(p);
                      setShowNameSearchModal(false);
                    }}
                    className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-start hover:bg-orange-50"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-slate-900 truncate">{p.name}</div>
                      <div className="text-[11px] font-mono text-slate-500">
                        {p.barcode} · {t(lang, 'المخزون:', 'Stock :')} {p.quantity} {p.unit}
                      </div>
                    </div>
                    <span className="font-mono text-xs font-extrabold text-teal-800 shrink-0">
                      {price.toFixed(2)} {cur}
                    </span>
                  </button>
                );
              })}
              {filteredProducts.length === 0 && (
                <div className="p-6 text-center text-xs text-slate-400">
                  {t(lang, 'لا توجد نتائج مطابقة', 'Aucun produit trouvé')}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Discount, Split Payment & Partial Payment Modal */}
      {showExtrasModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl space-y-4 text-xs">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Split className="h-4 w-4 text-teal-700" />
                {t(lang, 'الخصم والدفع الجزئي / المتعدد', 'Remise et paiement multiple')}
              </h3>
              <button
                type="button"
                onClick={() => setShowExtrasModal(false)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Discount */}
            <div className="space-y-1.5">
              <label className="block font-semibold text-slate-700">
                {t(lang, 'خصم الفاتورة:', 'Remise globale :')}
              </label>
              <div className="flex items-center gap-2">
                <select
                  value={discountType}
                  onChange={(e) => setDiscountType(e.target.value as 'fixed' | 'percent')}
                  className="rounded-lg border border-slate-300 px-2.5 py-2"
                >
                  <option value="fixed">{cur}</option>
                  <option value="percent">%</option>
                </select>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(Number(e.target.value))}
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-end font-mono"
                />
              </div>
            </div>

            {/* Payment Mode */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-700">{t(lang, 'وضع الدفع:', 'Mode de paiement :')}</span>
                <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
                  <button
                    type="button"
                    onClick={() => setPaymentMode('single')}
                    className={`rounded px-2.5 py-1 font-semibold ${
                      paymentMode === 'single' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                    }`}
                  >
                    {t(lang, 'طريقة واحدة', 'Simple')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentMode('split')}
                    className={`rounded px-2.5 py-1 font-semibold ${
                      paymentMode === 'split' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                    }`}
                  >
                    {t(lang, 'أكثر من طريقة', 'Multiple')}
                  </button>
                </div>
              </div>

              {paymentMode === 'single' ? (
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={singleMethod}
                    onChange={(e) => setSingleMethod(e.target.value as PaymentMethod)}
                    className="rounded-lg border border-slate-300 px-2.5 py-2 font-medium"
                  >
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {lang === 'ar' ? m.ar : m.fr}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    disabled={singleMethod === 'credit'}
                    value={singleMethod === 'credit' ? '0' : paidInput}
                    onChange={(e) => setPaidInput(e.target.value)}
                    placeholder={`${t(lang, 'المدفوع', 'Reçu')} (${grandTotal.toFixed(2)})`}
                    className="rounded-lg border border-slate-300 px-2.5 py-2 text-end font-mono disabled:bg-slate-100"
                  />
                </div>
              ) : (
                <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                  {splits.map((sp, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <select
                        value={sp.method}
                        onChange={(e) =>
                          setSplits((prev) =>
                            prev.map((x, i) =>
                              i === idx ? { ...x, method: e.target.value as PaymentMethod } : x
                            )
                          )
                        }
                        className="flex-1 rounded border border-slate-300 bg-white px-2 py-1.5"
                      >
                        {PAYMENT_METHODS.filter((m) => m.value !== 'credit').map((m) => (
                          <option key={m.value} value={m.value}>
                            {lang === 'ar' ? m.ar : m.fr}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={sp.amount}
                        onChange={(e) =>
                          setSplits((prev) =>
                            prev.map((x, i) =>
                              i === idx ? { ...x, amount: Number(e.target.value) } : x
                            )
                          )
                        }
                        className="w-24 rounded border border-slate-300 bg-white px-2 py-1.5 text-end font-mono"
                      />
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      setSplits((prev) => [...prev, { method: 'bank_transfer', amount: 0 }])
                    }
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-700 hover:underline"
                  >
                    <Plus className="h-3 w-3" /> {t(lang, 'إضافة وسيلة دفع أخرى', 'Ajouter un mode')}
                  </button>
                </div>
              )}
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                {t(lang, 'ملاحظة على الفاتورة', 'Notes')}
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

      {/* Held Carts Modal (Attentes) */}
      {showHeldModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Clock className="h-4 w-4 text-amber-600" />
                {t(lang, 'الفواتير المعلقة (Attentes)', 'Paniers en attente')}
              </h3>
              <button
                type="button"
                onClick={() => setShowHeldModal(false)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {cart.length > 0 && (
              <button
                type="button"
                onClick={handleHoldCart}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-amber-400 px-4 py-2.5 text-xs font-extrabold text-slate-950 hover:bg-amber-300"
              >
                <PauseCircle className="h-4 w-4" />
                {t(
                  lang,
                  `تعليق السلة الحالية (${cart.length} مواد — ${grandTotal.toFixed(2)} ${cur})`,
                  `Mettre le panier actuel en attente (${cart.length})`
                )}
              </button>
            )}

            <div className="space-y-2 max-h-72 overflow-y-auto">
              {heldCarts.map((h) => (
                <div
                  key={h.id}
                  className="flex items-center justify-between rounded-lg border border-slate-200 p-3"
                >
                  <div>
                    <div className="text-xs font-semibold text-slate-900">{h.label}</div>
                    <div className="text-[11px] text-slate-500">
                      {formatDateTime(h.createdAt, lang)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleResumeCart(h.id!)}
                      className="rounded-lg bg-teal-700 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-800"
                    >
                      {t(lang, 'استرجاع', 'Reprendre')}
                    </button>
                    <button
                      type="button"
                      onClick={() => db.heldCarts.delete(h.id!)}
                      className="rounded-lg p-1.5 text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
              {heldCarts.length === 0 && (
                <div className="py-6 text-center text-xs text-slate-400">
                  {t(lang, 'لا توجد فواتير معلقة حالياً', 'Aucun panier en attente')}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Invoice Details Modal (6.1) */}
      {detailInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <ReceiptText className="h-4 w-4 text-teal-700" />
                  {t(lang, 'تفاصيل الفاتورة', 'Détails facture')} {detailInvoice.invoiceNumber}
                </h3>
                <p className="text-xs text-slate-500">
                  {formatDateTime(detailInvoice.date, lang)} · {detailInvoice.customerName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDetailInvoice(null)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {detailInvoice.cancelReason && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                {t(lang, 'سبب الإلغاء:', 'Motif d’annulation :')} {detailInvoice.cancelReason} (
                {detailInvoice.cancelledBy})
              </div>
            )}
            <table className="mt-4 w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <th className="p-2 text-start">{t(lang, 'المنتج', 'Produit')}</th>
                  <th className="p-2 text-center">{t(lang, 'الكمية', 'Qté')}</th>
                  <th className="p-2 text-center">{t(lang, 'مرتجع', 'Retourné')}</th>
                  <th className="p-2 text-end">{t(lang, 'السعر', 'P.U')}</th>
                  <th className="p-2 text-end">{t(lang, 'المجموع', 'Total')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {detailInvoice.items.map((it, idx) => (
                  <tr key={idx}>
                    <td className="p-2 font-medium">{it.productName}</td>
                    <td className="p-2 text-center font-mono">{it.quantity}</td>
                    <td className="p-2 text-center font-mono text-amber-700">{it.returnedQty ?? 0}</td>
                    <td className="p-2 text-end font-mono">{it.unitPrice.toFixed(2)}</td>
                    <td className="p-2 text-end font-mono font-semibold">{it.total.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Cancel Invoice Modal (6.1) */}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleConfirmCancel}
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl space-y-4"
          >
            <h3 className="text-base font-bold text-red-700">
              {t(lang, `إلغاء الفاتورة ${cancelTarget.invoiceNumber}`, `Annuler ${cancelTarget.invoiceNumber}`)}
            </h3>
            <p className="text-xs text-slate-600">
              {t(
                lang,
                'الفواتير المعتمدة لا تُحذف نهائياً؛ سيتم إلغاؤها وتسجيل قيد عكسي لإرجاع الكميات إلى المخزون وحفظ العملية في سجل التدقيق.',
                'La facture sera annulée avec écriture inverse de stock et trace d’audit.'
              )}
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'سبب الإلغاء (إجباري) *', 'Motif d’annulation (obligatoire) *')}
              </label>
              <textarea
                required
                rows={2}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCancelTarget(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium"
              >
                {t(lang, 'تراجع', 'Fermer')}
              </button>
              <button
                type="submit"
                className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700"
              >
                {t(lang, 'تأكيد الإلغاء', 'Confirmer annulation')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Sale Return Modal (6.1 — Exact Discount & Tax Proration + Debt/Cash Split) */}
      {returnTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleConfirmReturn}
            className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-6 shadow-xl space-y-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  {t(lang, `تسجيل مرتجع من الفاتورة ${returnTarget.invoiceNumber}`, `Retour sur ${returnTarget.invoiceNumber}`)}
                </h3>
                <p className="text-[11px] text-slate-500">
                  {t(
                    lang,
                    `خصم الفاتورة: ${returnTarget.discountAmount.toFixed(2)} · الضريبة: ${returnTarget.taxRate}% · المتبقي كدين: ${returnTarget.remainingAmount.toFixed(2)} ${cur}`,
                    `Remise facture : ${returnTarget.discountAmount.toFixed(2)} · TVA : ${returnTarget.taxRate}% · Reste dû : ${returnTarget.remainingAmount.toFixed(2)} ${cur}`
                  )}
                </p>
              </div>
              <button type="button" onClick={() => setReturnTarget(null)} className="rounded p-1 text-slate-400">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-2 max-h-56 overflow-y-auto">
              {returnTarget.items.map((it) => {
                const maxAvail = round2(it.quantity - (it.returnedQty ?? 0));
                const effUnit = round2(getEffectiveReturnUnitPrice(returnTarget, it));
                const differsFromGross = Math.abs(effUnit - it.unitPrice) > 0.005;
                return (
                  <div
                    key={it.productId}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-2.5 text-xs"
                  >
                    <div>
                      <div className="font-semibold text-slate-900">{it.productName}</div>
                      <div className="text-slate-500">
                        {t(lang, 'القابل للإرجاع:', 'Retournable :')} {maxAvail} ·{' '}
                        {t(lang, 'سعر الاسترداد الصافي:', 'Prix net retour :')}{' '}
                        <span className="font-mono font-bold text-teal-800">
                          {effUnit.toFixed(2)} {cur}
                        </span>
                        {differsFromGross && (
                          <span className="ms-1 text-[10px] text-slate-400 line-through font-mono">
                            {it.unitPrice.toFixed(2)}
                          </span>
                        )}
                      </div>
                    </div>
                    <input
                      type="number"
                      min="0"
                      max={maxAvail}
                      step="0.1"
                      value={returnQtys[it.productId] ?? 0}
                      onChange={(e) =>
                        setReturnQtys((prev) => ({
                          ...prev,
                          [it.productId]: Number(e.target.value),
                        }))
                      }
                      className="w-20 rounded border border-slate-300 px-2 py-1 text-end font-mono"
                    />
                  </div>
                );
              })}
            </div>

            {returnBreakdown && returnBreakdown.totalReturnAmount > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs space-y-1.5">
                <div className="flex items-center justify-between font-bold text-slate-900">
                  <span>{t(lang, 'صافي قيمة المرتجع (بعد الخصم والضريبة):', 'Valeur nette du retour :')}</span>
                  <span className="font-mono text-sm">
                    {formatMoney(returnBreakdown.totalReturnAmount, cur)}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 border-t border-amber-200 pt-1.5 text-[11px]">
                  <div className="flex items-center justify-between text-sky-900">
                    <span>{t(lang, 'تخفيض من الدين:', 'Réduction dette :')}</span>
                    <span className="font-mono font-bold">
                      {formatMoney(returnBreakdown.debtReduction, cur)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-emerald-900">
                    <span>
                      {returnMethod === 'credit' && returnTarget.customerId && returnTarget.customerId > 1
                        ? t(lang, 'يُضاف لرصيد الزبون:', 'Ajouté en avoir :')
                        : t(lang, 'استرداد نقدي/بنكي:', 'Remboursement :')}
                    </span>
                    <span className="font-mono font-bold">
                      {formatMoney(returnBreakdown.cashRefund, cur)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'طريقة تسوية الاسترداد النقدي', 'Mode de remboursement')}
                </label>
                <select
                  value={returnMethod}
                  onChange={(e) => setReturnMethod(e.target.value as PaymentMethod)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.value === 'credit'
                        ? t(lang, 'إضافة إلى رصيد الزبون (Avoir)', 'Avoir client (crédit)')
                        : lang === 'ar'
                          ? m.ar
                          : m.fr}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'سبب الإرجاع', 'Motif')}
                </label>
                <input
                  value={returnReason}
                  onChange={(e) => setReturnReason(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReturnTarget(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium"
              >
                {t(lang, 'إلغاء', 'Annuler')}
              </button>
              <button
                type="submit"
                disabled={!returnBreakdown || returnBreakdown.totalReturnAmount <= 0}
                className="rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {t(lang, 'تأكيد المرتجع', 'Valider le retour')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Controlled Edit Invoice Modal (6.1) */}
      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleConfirmEdit}
            className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-6 shadow-xl space-y-4"
          >
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-teal-700" />
              {t(lang, `تعديل الفاتورة ${editTarget.invoiceNumber}`, `Modifier ${editTarget.invoiceNumber}`)}
            </h3>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {editItems.map((it, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-2 text-xs"
                >
                  <span className="font-medium flex-1 truncate">{it.productName}</span>
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={it.quantity}
                    onChange={(e) => {
                      const q = Number(e.target.value) || 0;
                      setEditItems((prev) =>
                        prev.map((x, i) =>
                          i === idx ? { ...x, quantity: q, total: round2(q * x.unitPrice - x.discount) } : x
                        )
                      );
                    }}
                    className="w-20 rounded border border-slate-300 px-2 py-1 font-mono text-end"
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={it.unitPrice}
                    onChange={(e) => {
                      const p = Number(e.target.value) || 0;
                      setEditItems((prev) =>
                        prev.map((x, i) =>
                          i === idx ? { ...x, unitPrice: p, total: round2(x.quantity * p - x.discount) } : x
                        )
                      );
                    }}
                    className="w-24 rounded border border-slate-300 px-2 py-1 font-mono text-end"
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-xs">
              <span>{t(lang, 'الخصم الإجمالي:', 'Remise totale :')}</span>
              <input
                type="number"
                min="0"
                step="0.5"
                value={editDiscount}
                onChange={(e) => setEditDiscount(Number(e.target.value))}
                className="w-28 rounded border border-slate-300 px-2 py-1 font-mono text-end"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditTarget(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs"
              >
                {t(lang, 'إلغاء', 'Annuler')}
              </button>
              <button
                type="submit"
                className="rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800"
              >
                {t(lang, 'حفظ التعديل', 'Enregistrer')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Manual Cash Drawer Open Reason Modal (when requireReasonOnManualOpen is enabled) */}
      {showDrawerReasonModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!drawerReason.trim()) return;
              setShowDrawerReasonModal(false);
              await executeOpenCashDrawer('manual', drawerReason.trim());
            }}
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl space-y-3"
          >
            <div className="flex items-center justify-between border-b border-slate-200 pb-2.5">
              <div className="flex items-center gap-2">
                <Inbox className="h-4 w-4 text-amber-700" />
                <h3 className="text-sm font-bold text-slate-900">
                  {t(lang, 'سبب فتح درج النقدية (Tiroir)', 'Motif d’ouverture du tiroir')}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowDrawerReasonModal(false)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {[
                { ar: 'صرف فكة للزبون', fr: 'Rendre la monnaie' },
                { ar: 'تزويد الصندوق', fr: 'Ajout fond de caisse' },
                { ar: 'سحب نقدي', fr: 'Prélèvement espèces' },
                { ar: 'جرد الصندوق', fr: 'Contrôle caisse' },
              ].map((preset) => {
                const label = lang === 'ar' ? preset.ar : preset.fr;
                return (
                  <button
                    key={preset.ar}
                    type="button"
                    onClick={() => setDrawerReason(label)}
                    className={`rounded-md border px-2.5 py-1 text-[11px] font-bold transition-colors ${
                      drawerReason === label
                        ? 'border-amber-700 bg-amber-100 text-amber-950'
                        : 'border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div>
              <input
                required
                autoFocus
                value={drawerReason}
                onChange={(e) => setDrawerReason(e.target.value)}
                placeholder={t(lang, 'أدخل سبب فتح الدرج للتسجيل في سجل التدقيق...', 'Indiquez le motif...')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-teal-700 focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowDrawerReasonModal(false)}
                className="rounded-lg border border-slate-300 px-4 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                {t(lang, 'إلغاء', 'Annuler')}
              </button>
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B274D] px-4 py-1.5 text-xs font-extrabold text-[#FDE68A] hover:bg-slate-900"
              >
                <Inbox className="h-3.5 w-3.5" />
                {t(lang, 'فتح الدرج الآن', 'Ouvrir le tiroir')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
