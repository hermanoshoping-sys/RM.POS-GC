import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, CalendarClock, Download, Plus, Printer, Receipt, RotateCcw, Search, Upload, X } from 'lucide-react';
import { db } from '../db/database';
import {
  addExpenseRecord,
  makeIdempotencyKey,
  recordCustomerPayment,
  recordSupplierPayment,
} from '../db/operations';
import { useApp } from '../context/AppContext';
import { Installment, PaymentMethod } from '../types';
import {
  EXPENSE_CATEGORIES,
  formatDateTime,
  formatMoney,
  getExpenseCategoryLabel,
  getPaymentMethodLabel,
  PAYMENT_METHODS,
  t,
} from '../i18n/translations';
import { exportRowsToExcel } from '../utils/export';
import { getQuickPeriodRange, QUICK_PERIODS, QuickPeriodId, toLocalIsoDate } from '../utils/datePeriods';

export type PaymentTabId = 'customers' | 'suppliers' | 'expenses' | 'cashflow';

interface PaymentsModuleProps {
  activeTab?: PaymentTabId;
  onTabChange?: (tab: PaymentTabId) => void;
}

const MIN_SHEET_ROWS = 16;

export const PaymentsModule: React.FC<PaymentsModuleProps> = ({
  activeTab: controlledTab,
  onTabChange,
}) => {
  const { lang, settings, currentUser, notify, openPrint } = useApp();
  const cur = settings.storeInfo.currency || 'MAD';

  const [internalTab, setInternalTab] = useState<PaymentTabId>('customers');
  const activeTab = controlledTab ?? internalTab;
  const setActiveTab = (tab: PaymentTabId) => {
    if (onTabChange) onTabChange(tab);
    else setInternalTab(tab);
  };

  const customers = useLiveQuery(() => db.customers.toArray(), []) ?? [];
  const suppliers = useLiveQuery(() => db.suppliers.toArray(), []) ?? [];
  const saleInvoices = useLiveQuery(() => db.saleInvoices.toArray(), []) ?? [];
  const saleReturns = useLiveQuery(() => db.saleReturns.toArray(), []) ?? [];
  const purchaseInvoices = useLiveQuery(() => db.purchaseInvoices.toArray(), []) ?? [];
  const customerPayments = useLiveQuery(() => db.customerPayments.orderBy('refNumber').reverse().toArray(), []) ?? [];
  const supplierPayments = useLiveQuery(() => db.supplierPayments.orderBy('refNumber').reverse().toArray(), []) ?? [];
  const expenses = useLiveQuery(() => db.expenses.orderBy('date').reverse().toArray(), []) ?? [];
  const installments = useLiveQuery(() => db.installments.toArray(), []) ?? [];

  // Shared Search & Period Filters (Inventory style)
  const [search, setSearch] = useState('');
  const [activePeriod, setActivePeriod] = useState<QuickPeriodId>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [custFilterId, setCustFilterId] = useState<string>('all');
  const [supFilterId, setSupFilterId] = useState<string>('all');
  const [expFilterCat, setExpFilterCat] = useState<string>('all');

  // Action Modals
  const [modalMode, setModalMode] = useState<null | 'customer' | 'supplier' | 'expense'>(null);

  // 9.1 Customer Payment Form
  const [custId, setCustId] = useState<number>(2);
  const [selectedSaleIds, setSelectedSaleIds] = useState<number[]>([]);
  const [selectedInstallmentId, setSelectedInstallmentId] = useState<number | null>(null);
  const [custAmount, setCustAmount] = useState<number>(0);
  const [custMethod, setCustMethod] = useState<PaymentMethod>('cash');
  const [custDate, setCustDate] = useState(toLocalIsoDate(new Date()));
  const [custNotes, setCustNotes] = useState('');
  const [custAllowOverpay, setCustAllowOverpay] = useState(false);

  // 9.2 Supplier Payment Form
  const [supId, setSupId] = useState<number>(1);
  const [selectedPurchaseIds, setSelectedPurchaseIds] = useState<number[]>([]);
  const [supAmount, setSupAmount] = useState<number>(0);
  const [supMethod, setSupMethod] = useState<PaymentMethod>('bank_transfer');
  const [supDate, setSupDate] = useState(toLocalIsoDate(new Date()));
  const [supNotes, setSupNotes] = useState('');
  const [supAllowOverpay, setSupAllowOverpay] = useState(false);

  // 9.3 Expense Form
  const [expName, setExpName] = useState('');
  const [expCat, setExpCat] = useState('rent');
  const [expAmount, setExpAmount] = useState<number>(0);
  const [expDate, setExpDate] = useState(toLocalIsoDate(new Date()));
  const [expMethod, setExpMethod] = useState<PaymentMethod>('cash');
  const [expNotes, setExpNotes] = useState('');
  const [expAttach, setExpAttach] = useState('');

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
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
  };

  const openCustInvoices = useMemo(
    () =>
      saleInvoices.filter(
        (i) => i.customerId === custId && i.status !== 'cancelled' && i.remainingAmount > 0.005
      ),
    [saleInvoices, custId]
  );

  const openSupInvoices = useMemo(
    () =>
      purchaseInvoices.filter(
        (p) => p.supplierId === supId && p.status !== 'cancelled' && p.remainingAmount > 0.005
      ),
    [purchaseInvoices, supId]
  );

  const selectedCustomerObj = useMemo(
    () => customers.find((c) => c.id === custId) ?? null,
    [customers, custId]
  );
  const custOpeningOwed = Math.max(0, selectedCustomerObj?.openingBalance ?? 0);
  const custInvoicesOwed = useMemo(
    () => openCustInvoices.reduce((s, inv) => s + inv.remainingAmount, 0),
    [openCustInvoices]
  );
  const custTotalOwed = Math.round((custOpeningOwed + custInvoicesOwed) * 100) / 100;
  const custOverpayExcess = Math.max(0, Math.round((Number(custAmount || 0) - custTotalOwed) * 100) / 100);

  const selectedSupplierObj = useMemo(
    () => suppliers.find((s) => s.id === supId) ?? null,
    [suppliers, supId]
  );
  const supOpeningOwed = Math.max(0, selectedSupplierObj?.openingBalance ?? 0);
  const supInvoicesOwed = useMemo(
    () => openSupInvoices.reduce((s, inv) => s + inv.remainingAmount, 0),
    [openSupInvoices]
  );
  const supTotalOwed = Math.round((supOpeningOwed + supInvoicesOwed) * 100) / 100;
  const supOverpayExcess = Math.max(0, Math.round((Number(supAmount || 0) - supTotalOwed) * 100) / 100);

  const todayIso = toLocalIsoDate(new Date());
  const dueInstallments = useMemo(
    () =>
      installments
        .filter((inst) => inst.remainingAmount > 0.005)
        .filter((inst) => custFilterId === 'all' || String(inst.customerId) === custFilterId)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    [installments, custFilterId]
  );

  const toggleSaleId = (id: number) => {
    setSelectedSaleIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const togglePurchaseId = (id: number) => {
    setSelectedPurchaseIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const openInstallmentCollection = (inst: Installment) => {
    setCustId(inst.customerId);
    setSelectedSaleIds([inst.saleInvoiceId]);
    setSelectedInstallmentId(inst.id ?? null);
    setCustAmount(inst.remainingAmount);
    setCustMethod('cash');
    setCustDate(toLocalIsoDate(new Date()));
    setCustNotes(
      t(
        lang,
        `تحصيل القسط #${inst.installmentNumber} — فاتورة ${inst.saleInvoiceNumber}`,
        `Échéance #${inst.installmentNumber} — Facture ${inst.saleInvoiceNumber}`
      )
    );
    setCustAllowOverpay(false);
    setModalMode('customer');
  };

  const openNewModal = (kind: 'customer' | 'supplier' | 'expense') => {
    if (kind === 'customer') {
      const firstReal = customers.find((c) => c.id !== 1);
      if (firstReal?.id && !customers.some((c) => c.id === custId && c.id !== 1)) {
        setCustId(firstReal.id);
      }
      setSelectedSaleIds([]);
      setSelectedInstallmentId(null);
      setCustAmount(0);
      setCustDate(toLocalIsoDate(new Date()));
      setCustNotes('');
      setCustAllowOverpay(false);
    } else if (kind === 'supplier') {
      if (suppliers[0]?.id && !suppliers.some((s) => s.id === supId)) {
        setSupId(suppliers[0].id);
      }
      setSelectedPurchaseIds([]);
      setSupAmount(0);
      setSupDate(toLocalIsoDate(new Date()));
      setSupNotes('');
      setSupAllowOverpay(false);
    } else {
      setExpName('');
      setExpAmount(0);
      setExpDate(toLocalIsoDate(new Date()));
      setExpNotes('');
      setExpAttach('');
    }
    setModalMode(kind);
  };

  const handleSaveCustomerPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    const customer = customers.find((c) => c.id === custId);
    if (!customer) return;
    try {
      const pay = await recordCustomerPayment(
        {
          customerId: customer.id!,
          customerName: customer.fullName,
          invoiceIds: selectedSaleIds,
          installmentId: selectedInstallmentId ?? undefined,
          amount: Number(custAmount),
          paymentMethod: custMethod,
          date: new Date(`${custDate}T${new Date().toTimeString().slice(0, 8)}`).toISOString(),
          notes: custNotes.trim() || undefined,
          allowOverpaymentAsCredit: custAllowOverpay,
          idempotencyKey: makeIdempotencyKey('cpay'),
        },
        currentUser
      );
      setCustAmount(0);
      setSelectedSaleIds([]);
      setSelectedInstallmentId(null);
      setCustNotes('');
      setCustAllowOverpay(false);
      setModalMode(null);
      notify(t(lang, `تم تسجيل الدفعة #${pay.refNumber} وتحديث رصيد الزبون`, `Paiement #${pay.refNumber} enregistré`));
      openPrint({ type: 'customer_payment', payment: pay });
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleSaveSupplierPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    const supplier = suppliers.find((s) => s.id === supId);
    if (!supplier) return;
    try {
      const pay = await recordSupplierPayment(
        {
          supplierId: supplier.id!,
          supplierName: supplier.businessName,
          purchaseIds: selectedPurchaseIds,
          amount: Number(supAmount),
          paymentMethod: supMethod,
          date: new Date(`${supDate}T${new Date().toTimeString().slice(0, 8)}`).toISOString(),
          notes: supNotes.trim() || undefined,
          allowOverpaymentAsCredit: supAllowOverpay,
          idempotencyKey: makeIdempotencyKey('spay'),
        },
        currentUser
      );
      setSupAmount(0);
      setSelectedPurchaseIds([]);
      setSupNotes('');
      setSupAllowOverpay(false);
      setModalMode(null);
      notify(t(lang, `تم تسجيل دفعة المورد #${pay.refNumber}`, `Paiement fournisseur #${pay.refNumber} enregistré`));
      openPrint({ type: 'supplier_payment', payment: pay });
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleExpenseAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setExpAttach(reader.result);
    };
    reader.readAsDataURL(f);
  };

  const handleSaveExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser || !expName.trim() || expAmount <= 0) return;
    await addExpenseRecord(
      {
        name: expName.trim(),
        category: expCat,
        amount: Number(expAmount),
        date: new Date(`${expDate}T12:00:00`).toISOString(),
        paymentMethod: expMethod,
        notes: expNotes.trim() || undefined,
        attachmentDataUrl: expAttach || undefined,
      },
      currentUser
    );
    setExpName('');
    setExpAmount(0);
    setExpNotes('');
    setExpAttach('');
    setModalMode(null);
    notify(t(lang, 'تم تسجيل المصروف بنجاح', 'Dépense enregistrée'));
  };

  // Filtered datasets
  const filteredCustPayments = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customerPayments.filter((p) => {
      if (p.isCancelled || !inRange(p.date)) return false;
      if (custFilterId !== 'all' && String(p.customerId) !== custFilterId) return false;
      if (
        q &&
        !p.customerName.toLowerCase().includes(q) &&
        !String(p.refNumber).includes(q) &&
        !p.invoiceNumbers.join(' ').toLowerCase().includes(q) &&
        !(p.notes ?? '').toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [customerPayments, custFilterId, search, dateFrom, dateTo]);

  const filteredSupPayments = useMemo(() => {
    const q = search.trim().toLowerCase();
    return supplierPayments.filter((p) => {
      if (p.isCancelled || !inRange(p.date)) return false;
      if (supFilterId !== 'all' && String(p.supplierId) !== supFilterId) return false;
      if (
        q &&
        !p.supplierName.toLowerCase().includes(q) &&
        !String(p.refNumber).includes(q) &&
        !p.purchaseNumbers.join(' ').toLowerCase().includes(q) &&
        !(p.notes ?? '').toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [supplierPayments, supFilterId, search, dateFrom, dateTo]);

  const filteredExpenses = useMemo(() => {
    const q = search.trim().toLowerCase();
    return expenses.filter((e) => {
      if (e.isCancelled || !inRange(e.date)) return false;
      if (expFilterCat !== 'all' && e.category !== expFilterCat) return false;
      if (
        q &&
        !e.name.toLowerCase().includes(q) &&
        !getExpenseCategoryLabel(e.category, lang).toLowerCase().includes(q) &&
        !(e.notes ?? '').toLowerCase().includes(q) &&
        !e.userName.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [expenses, expFilterCat, search, dateFrom, dateTo, lang]);

  // Unified Cashflow Ledger (Tab 4)
  const cashflowRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list: {
      id: string;
      date: string;
      kind: 'customer_in' | 'supplier_out' | 'expense_out' | 'return_refund_out';
      ref: string;
      party: string;
      method: PaymentMethod;
      inAmount: number;
      outAmount: number;
      notes: string;
      user: string;
    }[] = [];

    customerPayments
      .filter((p) => !p.isCancelled && inRange(p.date))
      .forEach((p) => {
        list.push({
          id: `c-${p.id}`,
          date: p.date,
          kind: 'customer_in',
          ref: `#${p.refNumber}`,
          party: p.customerName,
          method: p.paymentMethod,
          inAmount: p.amount,
          outAmount: 0,
          notes: p.invoiceNumbers.join(', ') || p.notes || '',
          user: p.userName || '—',
        });
      });

    supplierPayments
      .filter((p) => !p.isCancelled && inRange(p.date))
      .forEach((p) => {
        list.push({
          id: `s-${p.id}`,
          date: p.date,
          kind: 'supplier_out',
          ref: `#${p.refNumber}`,
          party: p.supplierName,
          method: p.paymentMethod,
          inAmount: 0,
          outAmount: p.amount,
          notes: p.purchaseNumbers.join(', ') || p.notes || '',
          user: p.userName || '—',
        });
      });

    expenses
      .filter((e) => !e.isCancelled && inRange(e.date))
      .forEach((e) => {
        list.push({
          id: `e-${e.id}`,
          date: e.date,
          kind: 'expense_out',
          ref: `EXP-${e.id}`,
          party: `${e.name} (${getExpenseCategoryLabel(e.category, lang)})`,
          method: e.paymentMethod,
          inAmount: 0,
          outAmount: e.amount,
          notes: e.notes || '',
          user: e.userName || '—',
        });
      });

    saleReturns
      .filter((r) => inRange(r.date))
      .forEach((r) => {
        const cashOut =
          r.cashRefund !== undefined
            ? r.cashRefund
            : r.refundMethod === 'cash'
              ? r.totalAmount
              : 0;
        if (cashOut <= 0.005) return;
        list.push({
          id: `ret-${r.id}`,
          date: r.date,
          kind: 'return_refund_out',
          ref: r.returnNumber,
          party: `${r.customerName} (${t(lang, 'استرداد نقدي لمرتجع', 'Remboursement retour')})`,
          method: 'cash',
          inAmount: 0,
          outAmount: cashOut,
          notes: `${r.saleInvoiceNumber} — ${r.reason || ''}`,
          user: r.userName || '—',
        });
      });

    return list
      .filter(
        (r) =>
          !q ||
          r.party.toLowerCase().includes(q) ||
          r.ref.toLowerCase().includes(q) ||
          r.notes.toLowerCase().includes(q)
      )
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [customerPayments, supplierPayments, expenses, saleReturns, search, dateFrom, dateTo, lang]);

  const totalCustPaid = useMemo(
    () => filteredCustPayments.reduce((s, p) => s + p.amount, 0),
    [filteredCustPayments]
  );
  const totalSupPaid = useMemo(
    () => filteredSupPayments.reduce((s, p) => s + p.amount, 0),
    [filteredSupPayments]
  );
  const totalExpAmt = useMemo(
    () => filteredExpenses.reduce((s, e) => s + e.amount, 0),
    [filteredExpenses]
  );
  const cashflowTotals = useMemo(
    () =>
      cashflowRows.reduce(
        (acc, r) => ({
          inSum: acc.inSum + r.inAmount,
          outSum: acc.outSum + r.outAmount,
          net: acc.net + r.inAmount - r.outAmount,
        }),
        { inSum: 0, outSum: 0, net: 0 }
      ),
    [cashflowRows]
  );

  // Print & Excel Export
  const handlePrintCurrent = () => {
    const periodLabel =
      dateFrom || dateTo ? `${dateFrom || '...'} ← ${dateTo || '...'}` : t(lang, 'كل الفترات', 'Toutes périodes');

    if (activeTab === 'customers') {
      openPrint({
        type: 'generic_report',
        title: t(lang, 'سجل دفعات الزبناء', 'Journal des paiements clients'),
        subtitle: `${periodLabel} · ${filteredCustPayments.length} ${t(lang, 'دفعة', 'paiements')}`,
        summaryItems: [{ label: t(lang, 'إجمالي التحصيلات', 'Total encaissé'), value: formatMoney(totalCustPaid, cur) }],
        columns: [
          t(lang, 'المرجع', 'Réf'),
          t(lang, 'التاريخ', 'Date'),
          t(lang, 'الزبون', 'Client'),
          t(lang, 'الفواتير', 'Factures'),
          t(lang, 'الطريقة', 'Mode'),
          t(lang, 'المبلغ', 'Montant'),
          t(lang, 'المتبقي بعده', 'Reste'),
          t(lang, 'ملاحظات', 'Notes'),
        ],
        rows: filteredCustPayments.map((p) => [
          `#${p.refNumber}`,
          formatDateTime(p.date, lang),
          p.customerName,
          p.invoiceNumbers.join(', ') || '—',
          getPaymentMethodLabel(p.paymentMethod, lang),
          p.amount.toFixed(2),
          p.remainingAfter.toFixed(2),
          p.notes || '—',
        ]),
      });
      return;
    }

    if (activeTab === 'suppliers') {
      openPrint({
        type: 'generic_report',
        title: t(lang, 'سجل دفعات الموردين', 'Journal paiements fournisseurs'),
        subtitle: `${periodLabel} · ${filteredSupPayments.length} ${t(lang, 'دفعة', 'paiements')}`,
        summaryItems: [{ label: t(lang, 'إجمالي المدفوع', 'Total payé'), value: formatMoney(totalSupPaid, cur) }],
        columns: [
          t(lang, 'المرجع', 'Réf'),
          t(lang, 'التاريخ', 'Date'),
          t(lang, 'المورد', 'Fournisseur'),
          t(lang, 'الفواتير', 'Factures'),
          t(lang, 'الطريقة', 'Mode'),
          t(lang, 'المدفوع', 'Payé'),
          t(lang, 'المتبقي بعده', 'Reste'),
          t(lang, 'ملاحظات', 'Notes'),
        ],
        rows: filteredSupPayments.map((p) => [
          `#${p.refNumber}`,
          formatDateTime(p.date, lang),
          p.supplierName,
          p.purchaseNumbers.join(', ') || '—',
          getPaymentMethodLabel(p.paymentMethod, lang),
          p.amount.toFixed(2),
          p.remainingAfter.toFixed(2),
          p.notes || '—',
        ]),
      });
      return;
    }

    if (activeTab === 'expenses') {
      openPrint({
        type: 'generic_report',
        title: t(lang, 'سجل المصاريف التشغيلية', 'Journal des dépenses'),
        subtitle: `${periodLabel} · ${filteredExpenses.length} ${t(lang, 'مصروف', 'dépenses')}`,
        summaryItems: [{ label: t(lang, 'إجمالي المصاريف', 'Total dépenses'), value: formatMoney(totalExpAmt, cur) }],
        columns: [
          t(lang, 'التاريخ', 'Date'),
          t(lang, 'المصروف', 'Libellé'),
          t(lang, 'التصنيف', 'Catégorie'),
          t(lang, 'طريقة الدفع', 'Mode'),
          t(lang, 'المبلغ', 'Montant'),
          t(lang, 'المسؤول', 'Responsable'),
          t(lang, 'ملاحظات', 'Notes'),
        ],
        rows: filteredExpenses.map((e) => [
          formatDateTime(e.date, lang),
          e.name,
          getExpenseCategoryLabel(e.category, lang),
          getPaymentMethodLabel(e.paymentMethod, lang),
          e.amount.toFixed(2),
          e.userName,
          e.notes || '—',
        ]),
      });
      return;
    }

    openPrint({
      type: 'generic_report',
      title: t(lang, 'ملخص حركات الصندوق والدفعات', 'Flux de caisse & paiements'),
      subtitle: `${periodLabel} · ${cashflowRows.length} ${t(lang, 'عملية', 'opérations')}`,
      summaryItems: [
        { label: t(lang, 'المداخيل', 'Entrées'), value: formatMoney(cashflowTotals.inSum, cur) },
        { label: t(lang, 'المصاريف والموردون', 'Sorties'), value: formatMoney(cashflowTotals.outSum, cur) },
        { label: t(lang, 'الصافي', 'Net'), value: formatMoney(cashflowTotals.net, cur) },
      ],
      columns: [
        t(lang, 'التاريخ', 'Date'),
        t(lang, 'المرجع', 'Réf'),
        t(lang, 'النوع', 'Type'),
        t(lang, 'الطرف / البيان', 'Tiers / Libellé'),
        t(lang, 'الطريقة', 'Mode'),
        t(lang, 'مداخيل (+)', 'Entrée (+)'),
        t(lang, 'مصاريف (-)', 'Sortie (-)'),
      ],
      rows: cashflowRows.map((r) => [
        formatDateTime(r.date, lang),
        r.ref,
        r.kind === 'customer_in'
          ? t(lang, 'دفعة زبون', 'Client')
          : r.kind === 'supplier_out'
            ? t(lang, 'دفعة مورد', 'Fournisseur')
            : r.kind === 'return_refund_out'
              ? t(lang, 'استرداد مرتجع', 'Remboursement retour')
              : t(lang, 'مصروف', 'Dépense'),
        r.party,
        getPaymentMethodLabel(r.method, lang),
        r.inAmount ? r.inAmount.toFixed(2) : '—',
        r.outAmount ? r.outAmount.toFixed(2) : '—',
      ]),
    });
  };

  const handleExportExcel = () => {
    if (activeTab === 'customers') {
      if (!filteredCustPayments.length) {
        notify(t(lang, 'لا توجد بيانات للتصدير', 'Aucune donnée à exporter'), 'warning');
        return;
      }
      exportRowsToExcel(
        filteredCustPayments.map((p) => ({
          [t(lang, 'المرجع', 'Réf')]: `#${p.refNumber}`,
          [t(lang, 'التاريخ', 'Date')]: formatDateTime(p.date, lang),
          [t(lang, 'الزبون', 'Client')]: p.customerName,
          [t(lang, 'الفواتير', 'Factures')]: p.invoiceNumbers.join(', '),
          [t(lang, 'طريقة الدفع', 'Mode')]: getPaymentMethodLabel(p.paymentMethod, lang),
          [t(lang, 'المبلغ', 'Montant')]: p.amount,
          [t(lang, 'المتبقي', 'Reste')]: p.remainingAfter,
          [t(lang, 'ملاحظات', 'Notes')]: p.notes || '',
        })),
        'CustomerPayments',
        'customer_payments.xlsx'
      );
    } else if (activeTab === 'suppliers') {
      if (!filteredSupPayments.length) {
        notify(t(lang, 'لا توجد بيانات للتصدير', 'Aucune donnée à exporter'), 'warning');
        return;
      }
      exportRowsToExcel(
        filteredSupPayments.map((p) => ({
          [t(lang, 'المرجع', 'Réf')]: `#${p.refNumber}`,
          [t(lang, 'التاريخ', 'Date')]: formatDateTime(p.date, lang),
          [t(lang, 'المورد', 'Fournisseur')]: p.supplierName,
          [t(lang, 'الفواتير', 'Factures')]: p.purchaseNumbers.join(', '),
          [t(lang, 'طريقة الدفع', 'Mode')]: getPaymentMethodLabel(p.paymentMethod, lang),
          [t(lang, 'المبلغ', 'Montant')]: p.amount,
          [t(lang, 'المتبقي', 'Reste')]: p.remainingAfter,
          [t(lang, 'ملاحظات', 'Notes')]: p.notes || '',
        })),
        'SupplierPayments',
        'supplier_payments.xlsx'
      );
    } else if (activeTab === 'expenses') {
      if (!filteredExpenses.length) {
        notify(t(lang, 'لا توجد بيانات للتصدير', 'Aucune donnée à exporter'), 'warning');
        return;
      }
      exportRowsToExcel(
        filteredExpenses.map((e) => ({
          [t(lang, 'التاريخ', 'Date')]: formatDateTime(e.date, lang),
          [t(lang, 'المصروف', 'Libellé')]: e.name,
          [t(lang, 'التصنيف', 'Catégorie')]: getExpenseCategoryLabel(e.category, lang),
          [t(lang, 'الطريقة', 'Mode')]: getPaymentMethodLabel(e.paymentMethod, lang),
          [t(lang, 'المبلغ', 'Montant')]: e.amount,
          [t(lang, 'المسؤول', 'Par')]: e.userName,
          [t(lang, 'ملاحظات', 'Notes')]: e.notes || '',
        })),
        'Expenses',
        'expenses.xlsx'
      );
    } else {
      if (!cashflowRows.length) {
        notify(t(lang, 'لا توجد بيانات للتصدير', 'Aucune donnée à exporter'), 'warning');
        return;
      }
      exportRowsToExcel(
        cashflowRows.map((r) => ({
          [t(lang, 'التاريخ', 'Date')]: formatDateTime(r.date, lang),
          [t(lang, 'المرجع', 'Réf')]: r.ref,
          [t(lang, 'البيان', 'Libellé')]: r.party,
          [t(lang, 'الطريقة', 'Mode')]: getPaymentMethodLabel(r.method, lang),
          [t(lang, 'مداخيل', 'Entrées')]: r.inAmount,
          [t(lang, 'مصاريف', 'Sorties')]: r.outAmount,
          [t(lang, 'ملاحظات', 'Notes')]: r.notes,
        })),
        'Cashflow',
        'cashflow_payments.xlsx'
      );
    }
    notify(t(lang, 'تم تصدير ملف Excel بنجاح', 'Fichier Excel exporté avec succès'));
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
              { id: 'customers', ar: 'دفعات الزبناء', fr: 'Paiements clients' },
              { id: 'suppliers', ar: 'دفعات الموردين', fr: 'Paiements fournisseurs' },
              { id: 'expenses', ar: 'المصاريف التشغيلية', fr: 'Dépenses' },
              { id: 'cashflow', ar: 'ملخص الصندوق', fr: 'Flux de caisse' },
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

      {/* Search + 6 Quick Date Period Buttons + Date Range + Primary Add Action */}
      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 bg-white px-2 py-2 rounded-lg border border-slate-200 shadow-xs">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t(lang, 'بحث بالاسم أو المرجع أو الفاتورة أو الملاحظة', 'Rechercher par nom, réf, facture...')}
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

        {/* 6 Quick Period Buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          {QUICK_PERIODS.map((p) => {
            const isActive = activePeriod === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => handleSelectQuickPeriod(p.id)}
                className={`rounded-lg border-[1.5px] px-2.5 sm:px-3 py-2 text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${
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

        {/* Date Range */}
        <div className="flex items-center gap-1.5 shrink-0">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => handleManualDateFrom(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs font-mono tabular-nums text-slate-800 focus:border-slate-900 focus:outline-none"
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => handleManualDateTo(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs font-mono tabular-nums text-slate-800 focus:border-slate-900 focus:outline-none"
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

        {/* Contextual entity filter + Add button */}
        {activeTab === 'customers' && (
          <>
            <select
              value={custFilterId}
              onChange={(e) => setCustFilterId(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-bold text-slate-800"
            >
              <option value="all">{t(lang, 'جميع الزبناء', 'Tous clients')}</option>
              {customers
                .filter((c) => c.id !== 1)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.fullName}
                  </option>
                ))}
            </select>
            <button
              type="button"
              onClick={() => openNewModal('customer')}
              className="inline-flex items-center gap-1.5 rounded-lg border-[1.5px] border-teal-900 bg-teal-700 px-3.5 py-2 text-xs font-extrabold text-white hover:bg-teal-800 whitespace-nowrap shrink-0"
            >
              <Plus className="h-4 w-4" />
              {t(lang, 'دفعة زبون جديدة', 'Paiement client')}
            </button>
          </>
        )}

        {activeTab === 'suppliers' && (
          <>
            <select
              value={supFilterId}
              onChange={(e) => setSupFilterId(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-bold text-slate-800"
            >
              <option value="all">{t(lang, 'جميع الموردين', 'Tous fournisseurs')}</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.businessName}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => openNewModal('supplier')}
              className="inline-flex items-center gap-1.5 rounded-lg border-[1.5px] border-teal-900 bg-teal-700 px-3.5 py-2 text-xs font-extrabold text-white hover:bg-teal-800 whitespace-nowrap shrink-0"
            >
              <Plus className="h-4 w-4" />
              {t(lang, 'دفعة مورد جديدة', 'Paiement fournisseur')}
            </button>
          </>
        )}

        {activeTab === 'expenses' && (
          <>
            <select
              value={expFilterCat}
              onChange={(e) => setExpFilterCat(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-bold text-slate-800"
            >
              <option value="all">{t(lang, 'كل التصنيفات', 'Toutes catégories')}</option>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {lang === 'ar' ? c.ar : c.fr}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => openNewModal('expense')}
              className="inline-flex items-center gap-1.5 rounded-lg border-[1.5px] border-teal-900 bg-teal-700 px-3.5 py-2 text-xs font-extrabold text-white hover:bg-teal-800 whitespace-nowrap shrink-0"
            >
              <Plus className="h-4 w-4" />
              {t(lang, 'تسجيل مصروف جديد', 'Nouvelle dépense')}
            </button>
          </>
        )}

        {activeTab === 'cashflow' && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => openNewModal('customer')}
              className="inline-flex items-center gap-1 rounded-lg border-[1.5px] border-emerald-900 bg-emerald-700 px-2.5 py-2 text-xs font-extrabold text-white hover:bg-emerald-800 whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5" />
              {t(lang, 'زبون', 'Client')}
            </button>
            <button
              type="button"
              onClick={() => openNewModal('supplier')}
              className="inline-flex items-center gap-1 rounded-lg border-[1.5px] border-sky-900 bg-sky-700 px-2.5 py-2 text-xs font-extrabold text-white hover:bg-sky-800 whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5" />
              {t(lang, 'مورد', 'Fourn.')}
            </button>
            <button
              type="button"
              onClick={() => openNewModal('expense')}
              className="inline-flex items-center gap-1 rounded-lg border-[1.5px] border-amber-900 bg-amber-600 px-2.5 py-2 text-xs font-extrabold text-white hover:bg-amber-700 whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5" />
              {t(lang, 'مصروف', 'Dépense')}
            </button>
          </div>
        )}
      </div>

      {/* TAB 1: Customer Payments Spreadsheet + Due Installments Strip */}
      {activeTab === 'customers' && (
        <div className="space-y-2.5">
          {dueInstallments.length > 0 && (
            <div className="rounded-lg border-[1.5px] border-amber-700 bg-amber-50/70 p-2.5 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-1.5 font-extrabold text-amber-950">
                  <CalendarClock className="h-4 w-4 text-amber-700" />
                  <span>
                    {t(
                      lang,
                      `الأقساط المستحقة والمتأخرة (${dueInstallments.length})`,
                      `Échéances en cours / en retard (${dueInstallments.length})`
                    )}
                  </span>
                </div>
                <span className="font-mono text-[11px] font-bold text-red-700">
                  {t(lang, 'المتأخرة:', 'En retard :')}{' '}
                  {dueInstallments.filter((i) => i.dueDate < todayIso).length} ·{' '}
                  {formatMoney(
                    dueInstallments.reduce((s, i) => s + i.remainingAmount, 0),
                    cur
                  )}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {dueInstallments.slice(0, 8).map((inst) => {
                  const isOverdue = inst.dueDate < todayIso;
                  return (
                    <div
                      key={inst.id}
                      className={`flex items-center justify-between gap-2.5 rounded-lg border px-2.5 py-1.5 text-xs bg-white ${
                        isOverdue ? 'border-red-400 bg-red-50/40' : 'border-amber-300'
                      }`}
                    >
                      <div>
                        <div className="font-bold text-slate-900 flex items-center gap-1.5">
                          <span>{inst.customerName}</span>
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-extrabold ${
                              isOverdue
                                ? 'bg-red-600 text-white'
                                : 'bg-amber-200 text-amber-950'
                            }`}
                          >
                            {isOverdue ? t(lang, 'متأخر', 'Retard') : t(lang, 'مستحق', 'À échoir')}
                          </span>
                        </div>
                        <div className="font-mono text-[11px] text-slate-600">
                          {inst.saleInvoiceNumber} · #{inst.installmentNumber} · {inst.dueDate} ·{' '}
                          <span className="font-extrabold text-red-700">
                            {formatMoney(inst.remainingAmount, cur)}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => openInstallmentCollection(inst)}
                        className="rounded-md bg-teal-700 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-teal-800 whitespace-nowrap"
                      >
                        {t(lang, 'تحصيل', 'Encaisser')}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-[#FCE08B] text-slate-950">
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[85px]">
                    {t(lang, 'المرجع', 'Réf')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[130px]">
                    {t(lang, 'التاريخ', 'Date')}
                  </th>
                  <th className="border border-slate-900 px-3 py-2 text-center font-extrabold min-w-[180px]">
                    {t(lang, 'الزبون', 'Client')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold min-w-[150px]">
                    {t(lang, 'الفواتير المرتبطة', 'Factures liées')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[115px]">
                    {t(lang, 'طريقة الدفع', 'Mode')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[125px]">
                    {t(lang, 'المبلغ المؤدى', 'Montant')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[125px]">
                    {t(lang, 'المتبقي بعد الأداء', 'Reste après')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold min-w-[140px]">
                    {t(lang, 'ملاحظات', 'Notes')}
                  </th>
                  <th className="border border-slate-900 px-2 py-2 text-center font-extrabold whitespace-nowrap w-[85px]">
                    {t(lang, 'الوصل', 'Reçu')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredCustPayments.map((p) => (
                  <tr key={p.id} className="h-[32px] hover:bg-amber-50/50 transition-colors">
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums text-slate-900">
                      #{p.refNumber}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-slate-700 whitespace-nowrap">
                      {formatDateTime(p.date, lang)}
                    </td>
                    <td className="border border-slate-800/80 px-2.5 py-1 font-bold text-slate-950">
                      {p.customerName}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] text-slate-700">
                      <div>{p.invoiceNumbers.join(', ') || '—'}</div>
                      {(p.openingBalancePaid ?? 0) > 0 && (
                        <div className="text-[10px] text-sky-700 font-sans font-bold">
                          {t(lang, 'سداد رصيد افتتاحي:', 'Solde initial :')}{' '}
                          {formatMoney(p.openingBalancePaid!, cur)}
                        </div>
                      )}
                      {(p.creditAdded ?? 0) > 0 && (
                        <div className="text-[10px] text-teal-700 font-sans font-bold">
                          +{t(lang, 'رصيد للزبون:', 'Crédit client :')}{' '}
                          {formatMoney(p.creditAdded!, cur)}
                        </div>
                      )}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-medium text-slate-700">
                      {getPaymentMethodLabel(p.paymentMethod, lang)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums text-emerald-700">
                      {formatMoney(p.amount, cur)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-semibold tabular-nums text-amber-800">
                      {formatMoney(p.remainingAfter, cur)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-slate-600 truncate max-w-[180px]">
                      {p.notes || '—'}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-0.5 text-center">
                      <button
                        type="button"
                        onClick={() => openPrint({ type: 'customer_payment', payment: p })}
                        className="inline-flex items-center gap-1 rounded border border-slate-800 bg-white px-2 py-0.5 text-[11px] font-bold text-slate-900 hover:bg-[#FCE08B]"
                      >
                        <Printer className="h-3 w-3 text-teal-800" />
                        {t(lang, 'وصل', 'Reçu')}
                      </button>
                    </td>
                  </tr>
                ))}
                {renderBlankRows(filteredCustPayments.length, 9)}
              </tbody>
              <tfoot>
                <tr className="bg-[#FEF3C7] text-slate-950 font-extrabold text-xs">
                  <td colSpan={5} className="border border-slate-900 px-3 py-2 text-start">
                    {t(lang, `المجموع (${filteredCustPayments.length} دفعة)`, `Total (${filteredCustPayments.length} paiements)`)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums text-emerald-800">
                    {formatMoney(totalCustPaid, cur)}
                  </td>
                  <td colSpan={3} className="border border-slate-900 px-2 py-2" />
                </tr>
              </tfoot>
            </table>
          </div>
          </div>
        </div>
      )}

      {/* TAB 2: Supplier Payments Spreadsheet */}
      {activeTab === 'suppliers' && (
        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-[#FCE08B] text-slate-950">
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[85px]">
                    {t(lang, 'المرجع', 'Réf')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[130px]">
                    {t(lang, 'التاريخ', 'Date')}
                  </th>
                  <th className="border border-slate-900 px-3 py-2 text-center font-extrabold min-w-[180px]">
                    {t(lang, 'المورد', 'Fournisseur')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold min-w-[150px]">
                    {t(lang, 'فواتير الشراء', 'Factures achat')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[115px]">
                    {t(lang, 'طريقة الدفع', 'Mode')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[125px]">
                    {t(lang, 'المبلغ المدفوع', 'Payé')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[125px]">
                    {t(lang, 'المتبقي للمورد', 'Reste dû')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold min-w-[140px]">
                    {t(lang, 'ملاحظات', 'Notes')}
                  </th>
                  <th className="border border-slate-900 px-2 py-2 text-center font-extrabold whitespace-nowrap w-[85px]">
                    {t(lang, 'الوصل', 'Reçu')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredSupPayments.map((p) => (
                  <tr key={p.id} className="h-[32px] hover:bg-amber-50/50 transition-colors">
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums text-slate-900">
                      #{p.refNumber}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-slate-700 whitespace-nowrap">
                      {formatDateTime(p.date, lang)}
                    </td>
                    <td className="border border-slate-800/80 px-2.5 py-1 font-bold text-slate-950">
                      {p.supplierName}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] text-slate-700">
                      <div>{p.purchaseNumbers.join(', ') || '—'}</div>
                      {(p.openingBalancePaid ?? 0) > 0 && (
                        <div className="text-[10px] text-sky-700 font-sans font-bold">
                          {t(lang, 'سداد رصيد افتتاحي:', 'Solde initial :')}{' '}
                          {formatMoney(p.openingBalancePaid!, cur)}
                        </div>
                      )}
                      {(p.creditAdded ?? 0) > 0 && (
                        <div className="text-[10px] text-teal-700 font-sans font-bold">
                          +{t(lang, 'رصيد لدى المورد:', 'Crédit fournisseur :')}{' '}
                          {formatMoney(p.creditAdded!, cur)}
                        </div>
                      )}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-medium text-slate-700">
                      {getPaymentMethodLabel(p.paymentMethod, lang)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums text-slate-950">
                      {formatMoney(p.amount, cur)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold tabular-nums text-red-700">
                      {formatMoney(p.remainingAfter, cur)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-slate-600 truncate max-w-[180px]">
                      {p.notes || '—'}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-0.5 text-center">
                      <button
                        type="button"
                        onClick={() => openPrint({ type: 'supplier_payment', payment: p })}
                        className="inline-flex items-center gap-1 rounded border border-slate-800 bg-white px-2 py-0.5 text-[11px] font-bold text-slate-900 hover:bg-[#FCE08B]"
                      >
                        <Printer className="h-3 w-3 text-teal-800" />
                        {t(lang, 'وصل', 'Reçu')}
                      </button>
                    </td>
                  </tr>
                ))}
                {renderBlankRows(filteredSupPayments.length, 9)}
              </tbody>
              <tfoot>
                <tr className="bg-[#FEF3C7] text-slate-950 font-extrabold text-xs">
                  <td colSpan={5} className="border border-slate-900 px-3 py-2 text-start">
                    {t(lang, `المجموع (${filteredSupPayments.length} دفعة)`, `Total (${filteredSupPayments.length} paiements)`)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums text-slate-950">
                    {formatMoney(totalSupPaid, cur)}
                  </td>
                  <td colSpan={3} className="border border-slate-900 px-2 py-2" />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: Expenses Spreadsheet */}
      {activeTab === 'expenses' && (
        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-[#FCE08B] text-slate-950">
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[130px]">
                    {t(lang, 'التاريخ', 'Date')}
                  </th>
                  <th className="border border-slate-900 px-3 py-2 text-center font-extrabold min-w-[200px]">
                    {t(lang, 'المصروف', 'Libellé')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[135px]">
                    {t(lang, 'التصنيف', 'Catégorie')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[115px]">
                    {t(lang, 'طريقة الدفع', 'Mode')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[125px]">
                    {t(lang, 'المبلغ', 'Montant')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[125px]">
                    {t(lang, 'المسؤول', 'Responsable')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold min-w-[170px]">
                    {t(lang, 'ملاحظات', 'Notes')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredExpenses.map((e) => (
                  <tr key={e.id} className="h-[32px] hover:bg-amber-50/50 transition-colors">
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-slate-700 whitespace-nowrap">
                      {formatDateTime(e.date, lang)}
                    </td>
                    <td className="border border-slate-800/80 px-2.5 py-1 font-bold text-slate-950">
                      {e.name}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-semibold text-slate-700">
                      {getExpenseCategoryLabel(e.category, lang)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center text-slate-700">
                      {getPaymentMethodLabel(e.paymentMethod, lang)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums text-red-700">
                      {formatMoney(e.amount, cur)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center text-slate-700">
                      {e.userName}
                    </td>
                    <td className="border border-slate-800/80 px-2.5 py-1 text-slate-600">
                      {e.notes || '—'}
                    </td>
                  </tr>
                ))}
                {renderBlankRows(filteredExpenses.length, 7)}
              </tbody>
              <tfoot>
                <tr className="bg-[#FEF3C7] text-slate-950 font-extrabold text-xs">
                  <td colSpan={4} className="border border-slate-900 px-3 py-2 text-start">
                    {t(lang, `المجموع (${filteredExpenses.length} مصروف)`, `Total (${filteredExpenses.length} dépenses)`)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums text-red-800">
                    {formatMoney(totalExpAmt, cur)}
                  </td>
                  <td colSpan={2} className="border border-slate-900 px-2 py-2" />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: Unified Cashflow Ledger */}
      {activeTab === 'cashflow' && (
        <div className="border-[1.5px] border-slate-900 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-[#FCE08B] text-slate-950">
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[130px]">
                    {t(lang, 'التاريخ', 'Date')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[90px]">
                    {t(lang, 'المرجع', 'Réf')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[115px]">
                    {t(lang, 'نوع الحركة', 'Type')}
                  </th>
                  <th className="border border-slate-900 px-3 py-2 text-center font-extrabold min-w-[200px]">
                    {t(lang, 'الطرف / البيان', 'Tiers / Libellé')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[110px]">
                    {t(lang, 'الطريقة', 'Mode')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[125px]">
                    {t(lang, 'مداخيل (+)', 'Entrées (+)')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold whitespace-nowrap w-[125px]">
                    {t(lang, 'مصاريف (-)', 'Sorties (-)')}
                  </th>
                  <th className="border border-slate-900 px-2.5 py-2 text-center font-extrabold min-w-[140px]">
                    {t(lang, 'ملاحظات', 'Notes')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {cashflowRows.map((r) => (
                  <tr key={r.id} className="h-[31px] hover:bg-amber-50/50 transition-colors">
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-slate-700 whitespace-nowrap">
                      {formatDateTime(r.date, lang)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-bold tabular-nums text-slate-800">
                      {r.ref}
                    </td>
                    <td
                      className={`border border-slate-800/80 px-2 py-1 text-center font-bold ${
                        r.kind === 'customer_in'
                          ? 'bg-emerald-50 text-emerald-800'
                          : r.kind === 'supplier_out'
                            ? 'bg-sky-50 text-sky-900'
                            : r.kind === 'return_refund_out'
                              ? 'bg-amber-50 text-amber-900'
                              : 'bg-red-50 text-red-800'
                      }`}
                    >
                      {r.kind === 'customer_in'
                        ? t(lang, 'تحصيل زبون', 'Encaissement')
                        : r.kind === 'supplier_out'
                          ? t(lang, 'أداء مورد', 'Fournisseur')
                          : r.kind === 'return_refund_out'
                            ? t(lang, 'استرداد مرتجع', 'Remboursement retour')
                            : t(lang, 'مصروف', 'Dépense')}
                    </td>
                    <td className="border border-slate-800/80 px-2.5 py-1 font-bold text-slate-950">
                      {r.party}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center text-slate-700">
                      {getPaymentMethodLabel(r.method, lang)}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums text-emerald-700">
                      {r.inAmount > 0 ? `+${r.inAmount.toFixed(2)}` : '—'}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-center font-mono font-extrabold tabular-nums text-red-700">
                      {r.outAmount > 0 ? `-${r.outAmount.toFixed(2)}` : '—'}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1 text-slate-600 truncate max-w-[180px]">
                      {r.notes || '—'}
                    </td>
                  </tr>
                ))}
                {renderBlankRows(cashflowRows.length, 8)}
              </tbody>
              <tfoot>
                <tr className="bg-[#FEF3C7] text-slate-950 font-extrabold text-xs">
                  <td colSpan={5} className="border border-slate-900 px-3 py-2 text-start">
                    {t(
                      lang,
                      `صافي حركة الدفعات (${cashflowRows.length} عملية): ${formatMoney(cashflowTotals.net, cur)}`,
                      `Solde net (${cashflowRows.length} opérations) : ${formatMoney(cashflowTotals.net, cur)}`
                    )}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums text-emerald-800">
                    +{formatMoney(cashflowTotals.inSum, cur)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2 text-center font-mono tabular-nums text-red-800">
                    -{formatMoney(cashflowTotals.outSum, cur)}
                  </td>
                  <td className="border border-slate-900 px-2 py-2" />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Compact Utility Footer Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-0.5 text-xs text-slate-600">
        <div className="font-mono tabular-nums">
          {t(lang, 'تحصيلات الزبناء:', 'Clients :')} <strong className="text-emerald-700">{formatMoney(totalCustPaid, cur)}</strong>
          {' · '}
          {t(lang, 'مدفوعات الموردين:', 'Fournisseurs :')} <strong className="text-slate-900">{formatMoney(totalSupPaid, cur)}</strong>
          {' · '}
          {t(lang, 'المصاريف:', 'Dépenses :')} <strong className="text-red-700">{formatMoney(totalExpAmt, cur)}</strong>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExportExcel}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-800 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5 text-emerald-700" />
            {t(lang, 'تصدير Excel', 'Exporter Excel')}
          </button>
          <button
            type="button"
            onClick={handlePrintCurrent}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B274D] px-3.5 py-1.5 text-xs font-bold text-white hover:bg-[#133A6E]"
          >
            <Printer className="h-3.5 w-3.5 text-[#F4BE42]" />
            {t(lang, 'طباعة الجدول', 'Imprimer')}
          </button>
        </div>
      </div>

      {/* Modal: New Customer Payment */}
      {modalMode === 'customer' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleSaveCustomerPayment}
            className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  {t(lang, 'تسجيل دفعة زبون جديدة', 'Nouveau paiement client')}
                </h3>
                <span className="font-mono text-xs text-teal-800 font-semibold">
                  {t(lang, 'المرجع التالي:', 'Réf :')} #{settings.storeInfo.customerPaymentNextRef}
                </span>
              </div>
              <button type="button" onClick={() => setModalMode(null)} className="rounded-lg p-1 text-slate-500 hover:bg-slate-100">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'اختر الزبون', 'Client')}
              </label>
              <select
                value={custId}
                onChange={(e) => {
                  setCustId(Number(e.target.value));
                  setSelectedSaleIds([]);
                  setSelectedInstallmentId(null);
                  setCustAllowOverpay(false);
                }}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
              >
                {customers
                  .filter((c) => c.id !== 1)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.fullName}
                    </option>
                  ))}
              </select>
            </div>

            {/* Balance Breakdown (Opening Balance + Open Invoices + Existing Credit) */}
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-slate-600">{t(lang, 'الرصيد الافتتاحي المستحق:', 'Solde initial dû :')}</span>
                <span className="font-mono font-bold text-slate-900">{formatMoney(custOpeningOwed, cur)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">{t(lang, 'مجموع الفواتير المفتوحة:', 'Factures impayées :')}</span>
                <span className="font-mono font-bold text-slate-900">{formatMoney(custInvoicesOwed, cur)}</span>
              </div>
              <div className="flex items-center justify-between border-t border-slate-200 pt-1">
                <span className="font-bold text-slate-900">{t(lang, 'إجمالي الدين المستحق:', 'Total dû :')}</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-extrabold text-red-700">{formatMoney(custTotalOwed, cur)}</span>
                  {custTotalOwed > 0.005 && (
                    <button
                      type="button"
                      onClick={() => setCustAmount(custTotalOwed)}
                      className="rounded border border-teal-700 bg-teal-50 px-1.5 py-0.5 text-[10px] font-bold text-teal-800 hover:bg-teal-100"
                    >
                      {t(lang, 'تسديد الكل', 'Solder tout')}
                    </button>
                  )}
                </div>
              </div>
              {(selectedCustomerObj?.creditBalance ?? 0) > 0.005 && (
                <div className="flex items-center justify-between text-teal-800 pt-0.5">
                  <span>{t(lang, 'رصيد حالي لصالح الزبون:', 'Crédit client actuel :')}</span>
                  <span className="font-mono font-bold">{formatMoney(selectedCustomerObj!.creditBalance!, cur)}</span>
                </div>
              )}
            </div>

            {openCustInvoices.length > 0 && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-700">
                  {t(lang, 'ربط الدفعة بفاتورة أو عدة فواتير (اختياري)', 'Lier aux factures impayées')}
                </label>
                <div className="max-h-36 overflow-y-auto space-y-1 rounded-lg border border-slate-200 p-2 bg-slate-50">
                  {openCustInvoices.map((inv) => (
                    <label
                      key={inv.id}
                      className="flex items-center justify-between text-xs cursor-pointer rounded px-2 py-1 hover:bg-white"
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedSaleIds.includes(inv.id!)}
                          onChange={() => toggleSaleId(inv.id!)}
                        />
                        <span className="font-mono font-medium">{inv.invoiceNumber}</span>
                      </span>
                      <span className="font-mono text-red-700 font-semibold">
                        {formatMoney(inv.remainingAmount, cur)}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, `المبلغ المؤدى (${cur}) *`, `Montant (${cur}) *`)}
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={custAmount || ''}
                  onChange={(e) => setCustAmount(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'طريقة الدفع', 'Mode')}
                </label>
                <select
                  value={custMethod}
                  onChange={(e) => setCustMethod(e.target.value as PaymentMethod)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                >
                  {PAYMENT_METHODS.filter((m) => m.value !== 'credit').map((m) => (
                    <option key={m.value} value={m.value}>
                      {lang === 'ar' ? m.ar : m.fr}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {custOverpayExcess > 0.005 && (
              <div className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-xs text-amber-950 space-y-2">
                <div className="flex items-center gap-1.5 font-bold">
                  <AlertTriangle className="h-4 w-4 text-amber-700 shrink-0" />
                  <span>
                    {t(
                      lang,
                      `المبلغ يتجاوز إجمالي الدين بفائض قدره ${formatMoney(custOverpayExcess, cur)}`,
                      `Le montant dépasse la dette de ${formatMoney(custOverpayExcess, cur)}`
                    )}
                  </span>
                </div>
                <label className="flex items-center gap-2 cursor-pointer font-semibold">
                  <input
                    type="checkbox"
                    checked={custAllowOverpay}
                    onChange={(e) => setCustAllowOverpay(e.target.checked)}
                  />
                  <span>
                    {t(
                      lang,
                      'تسجيل الفائض كرصيد مسبق لصالح الزبون (قابل للاستعمال في المبيعات القادمة)',
                      'Enregistrer le surplus comme avoir / crédit client'
                    )}
                  </span>
                </label>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'تاريخ الدفعة', 'Date')}
                </label>
                <input
                  type="date"
                  value={custDate}
                  onChange={(e) => setCustDate(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'ملاحظات', 'Notes')}
                </label>
                <input
                  value={custNotes}
                  onChange={(e) => setCustNotes(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setModalMode(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                {t(lang, 'إلغاء', 'Annuler')}
              </button>
              <button
                type="submit"
                disabled={custOverpayExcess > 0.005 && !custAllowOverpay}
                className="inline-flex items-center gap-2 rounded-lg bg-teal-700 px-4 py-2 text-xs font-bold text-white hover:bg-teal-800 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Receipt className="h-4 w-4" />
                {t(lang, 'حفظ الدفعة وطباعة الوصل', 'Enregistrer & Imprimer')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal: New Supplier Payment */}
      {modalMode === 'supplier' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleSaveSupplierPayment}
            className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  {t(lang, 'تسجيل دفعة لمورد', 'Nouveau paiement fournisseur')}
                </h3>
                <span className="font-mono text-xs text-teal-800 font-semibold">
                  #{settings.storeInfo.supplierPaymentNextRef}
                </span>
              </div>
              <button type="button" onClick={() => setModalMode(null)} className="rounded-lg p-1 text-slate-500 hover:bg-slate-100">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'اختر المورد', 'Fournisseur')}
              </label>
              <select
                value={supId}
                onChange={(e) => {
                  setSupId(Number(e.target.value));
                  setSelectedPurchaseIds([]);
                  setSupAllowOverpay(false);
                }}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
              >
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.businessName}
                  </option>
                ))}
              </select>
            </div>

            {/* Supplier Balance Breakdown */}
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-slate-600">{t(lang, 'الرصيد الافتتاحي للمورد:', 'Solde initial dû :')}</span>
                <span className="font-mono font-bold text-slate-900">{formatMoney(supOpeningOwed, cur)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">{t(lang, 'مجموع فواتير الشراء المفتوحة:', 'Achats impayés :')}</span>
                <span className="font-mono font-bold text-slate-900">{formatMoney(supInvoicesOwed, cur)}</span>
              </div>
              <div className="flex items-center justify-between border-t border-slate-200 pt-1">
                <span className="font-bold text-slate-900">{t(lang, 'إجمالي المستحق للمورد:', 'Total dû :')}</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-extrabold text-red-700">{formatMoney(supTotalOwed, cur)}</span>
                  {supTotalOwed > 0.005 && (
                    <button
                      type="button"
                      onClick={() => setSupAmount(supTotalOwed)}
                      className="rounded border border-teal-700 bg-teal-50 px-1.5 py-0.5 text-[10px] font-bold text-teal-800 hover:bg-teal-100"
                    >
                      {t(lang, 'تسديد الكل', 'Solder tout')}
                    </button>
                  )}
                </div>
              </div>
              {(selectedSupplierObj?.creditBalance ?? 0) > 0.005 && (
                <div className="flex items-center justify-between text-teal-800 pt-0.5">
                  <span>{t(lang, 'رصيد مسبق لدى المورد:', 'Avoir fournisseur actuel :')}</span>
                  <span className="font-mono font-bold">{formatMoney(selectedSupplierObj!.creditBalance!, cur)}</span>
                </div>
              )}
            </div>

            {openSupInvoices.length > 0 && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-700">
                  {t(lang, 'ربط بفواتير الشراء المستحقة', 'Lier aux factures d’achat')}
                </label>
                <div className="max-h-36 overflow-y-auto space-y-1 rounded-lg border border-slate-200 p-2 bg-slate-50">
                  {openSupInvoices.map((inv) => (
                    <label
                      key={inv.id}
                      className="flex items-center justify-between text-xs cursor-pointer rounded px-2 py-1 hover:bg-white"
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedPurchaseIds.includes(inv.id!)}
                          onChange={() => togglePurchaseId(inv.id!)}
                        />
                        <span className="font-mono font-medium">{inv.invoiceNumber}</span>
                      </span>
                      <span className="font-mono text-red-700 font-semibold">
                        {formatMoney(inv.remainingAmount, cur)}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, `المبلغ المدفوع (${cur}) *`, `Montant (${cur}) *`)}
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={supAmount || ''}
                  onChange={(e) => setSupAmount(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'طريقة الدفع', 'Mode')}
                </label>
                <select
                  value={supMethod}
                  onChange={(e) => setSupMethod(e.target.value as PaymentMethod)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                >
                  {PAYMENT_METHODS.filter((m) => m.value !== 'credit').map((m) => (
                    <option key={m.value} value={m.value}>
                      {lang === 'ar' ? m.ar : m.fr}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {supOverpayExcess > 0.005 && (
              <div className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-xs text-amber-950 space-y-2">
                <div className="flex items-center gap-1.5 font-bold">
                  <AlertTriangle className="h-4 w-4 text-amber-700 shrink-0" />
                  <span>
                    {t(
                      lang,
                      `المبلغ يتجاوز المستحق للمورد بفائض قدره ${formatMoney(supOverpayExcess, cur)}`,
                      `Le montant dépasse la dette de ${formatMoney(supOverpayExcess, cur)}`
                    )}
                  </span>
                </div>
                <label className="flex items-center gap-2 cursor-pointer font-semibold">
                  <input
                    type="checkbox"
                    checked={supAllowOverpay}
                    onChange={(e) => setSupAllowOverpay(e.target.checked)}
                  />
                  <span>
                    {t(
                      lang,
                      'تسجيل الفائض كرصيد مسبق لدى المورد',
                      'Enregistrer le surplus comme avoir chez le fournisseur'
                    )}
                  </span>
                </label>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'تاريخ الأداء', 'Date')}
                </label>
                <input
                  type="date"
                  value={supDate}
                  onChange={(e) => setSupDate(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'ملاحظات', 'Notes')}
                </label>
                <input
                  value={supNotes}
                  onChange={(e) => setSupNotes(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setModalMode(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                {t(lang, 'إلغاء', 'Annuler')}
              </button>
              <button
                type="submit"
                disabled={supOverpayExcess > 0.005 && !supAllowOverpay}
                className="inline-flex items-center gap-2 rounded-lg bg-teal-700 px-4 py-2 text-xs font-bold text-white hover:bg-teal-800 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Receipt className="h-4 w-4" />
                {t(lang, 'حفظ الدفعة وطباعة الوصل', 'Valider & Imprimer')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal: New Expense */}
      {modalMode === 'expense' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleSaveExpense}
            className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-sm font-bold text-slate-900">
                {t(lang, 'تسجيل مصروف تشغيلي جديد', 'Enregistrer une dépense')}
              </h3>
              <button type="button" onClick={() => setModalMode(null)} className="rounded-lg p-1 text-slate-500 hover:bg-slate-100">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'اسم المصروف *', 'Libellé *')}
              </label>
              <input
                required
                value={expName}
                onChange={(e) => setExpName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'التصنيف', 'Catégorie')}
                </label>
                <select
                  value={expCat}
                  onChange={(e) => setExpCat(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                >
                  {EXPENSE_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {lang === 'ar' ? c.ar : c.fr}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, `المبلغ (${cur}) *`, `Montant (${cur}) *`)}
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={expAmount || ''}
                  onChange={(e) => setExpAmount(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'التاريخ', 'Date')}
                </label>
                <input
                  type="date"
                  value={expDate}
                  onChange={(e) => setExpDate(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'طريقة الدفع', 'Mode')}
                </label>
                <select
                  value={expMethod}
                  onChange={(e) => setExpMethod(e.target.value as PaymentMethod)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                >
                  {PAYMENT_METHODS.filter((m) => m.value !== 'credit').map((m) => (
                    <option key={m.value} value={m.value}>
                      {lang === 'ar' ? m.ar : m.fr}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'ملاحظات', 'Notes')}
              </label>
              <input
                value={expNotes}
                onChange={(e) => setExpNotes(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
              />
            </div>

            <div>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
                <Upload className="h-3.5 w-3.5" />
                {t(lang, 'إرفاق صورة وصل أو وثيقة', 'Joindre justificatif')}
                <input type="file" accept="image/*" onChange={handleExpenseAttach} className="hidden" />
              </label>
              {expAttach && (
                <img
                  src={expAttach}
                  alt="attachment"
                  referrerPolicy="no-referrer"
                  className="mt-2 h-14 w-14 rounded border border-slate-200 object-cover"
                />
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setModalMode(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                {t(lang, 'إلغاء', 'Annuler')}
              </button>
              <button
                type="submit"
                className="rounded-lg bg-teal-700 px-4 py-2 text-xs font-bold text-white hover:bg-teal-800"
              >
                {t(lang, 'حفظ المصروف', 'Enregistrer la dépense')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
