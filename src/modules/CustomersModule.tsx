import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  CalendarClock,
  Download,
  Edit2,
  FileDown,
  FileText,
  Plus,
  Printer,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { db } from '../db/database';
import { logAudit, makeIdempotencyKey, recordCustomerPayment } from '../db/operations';
import { useApp } from '../context/AppContext';
import { Customer, Installment } from '../types';
import { formatDateTime, formatMoney, getStatusLabel, t } from '../i18n/translations';
import { exportRowsToExcel, exportTableToPdf } from '../utils/export';
import { toLocalIsoDate } from '../utils/datePeriods';
import { hasPermission } from '../utils/permissions';

export const CustomersModule: React.FC = () => {
  const { lang, settings, currentUser, notify, openPrint, requestGuardedAction } = useApp();
  const cur = settings.storeInfo.currency || 'MAD';
  const canManageCustomers = hasPermission(currentUser, 'canManageCustomers');

  const customers = useLiveQuery(() => db.customers.toArray(), []) ?? [];
  const saleInvoices = useLiveQuery(() => db.saleInvoices.toArray(), []) ?? [];
  const saleReturns = useLiveQuery(() => db.saleReturns.toArray(), []) ?? [];
  const customerPayments = useLiveQuery(() => db.customerPayments.toArray(), []) ?? [];
  const installments = useLiveQuery(() => db.installments.toArray(), []) ?? [];

  const [search, setSearch] = useState('');
  const [debtFilter, setDebtFilter] = useState<'all' | 'with_debt' | 'clear'>('all');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [statementCustomerId, setStatementCustomerId] = useState<number | null>(null);

  const [form, setForm] = useState({
    fullName: '',
    phone: '',
    address: '',
    creditLimit: 1000,
    openingBalance: 0,
    notes: '',
  });

  const todayIso = toLocalIsoDate(new Date());

  const enrichedCustomers = useMemo(() => {
    return customers.map((c) => {
      const cInvs = saleInvoices.filter(
        (i) => i.customerId === c.id && i.status !== 'cancelled'
      );
      const cRets = saleReturns.filter((r) => r.customerId === c.id);
      const cPays = customerPayments.filter((p) => p.customerId === c.id && !p.isCancelled);
      const cInsts = installments
        .filter((inst) => inst.customerId === c.id)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      const overdueInstallmentsCount = cInsts.filter(
        (inst) => inst.remainingAmount > 0.005 && inst.dueDate < todayIso
      ).length;
      const totalPurchases = cInvs.reduce((s, i) => s + i.total, 0);
      const totalPaid = cInvs.reduce((s, i) => s + i.paidAmount, 0);
      const remainingDebt =
        cInvs.reduce((s, i) => s + i.remainingAmount, 0) + (c.openingBalance || 0);
      const totalReturns = cRets.reduce((s, r) => s + r.totalAmount, 0);

      return {
        ...c,
        totalPurchases,
        totalPaid,
        remainingDebt,
        totalReturns,
        creditBalance: c.creditBalance || 0,
        overdueInstallmentsCount,
        installments: cInsts,
        invoices: cInvs,
        payments: cPays,
        returns: cRets,
      };
    });
  }, [customers, saleInvoices, saleReturns, customerPayments, installments, todayIso]);

  const filtered = useMemo(() => {
    return enrichedCustomers.filter((c) => {
      const q = search.trim().toLowerCase();
      const matchSearch =
        !q ||
        c.fullName.toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q) ||
        c.address.toLowerCase().includes(q);
      const matchDebt =
        debtFilter === 'all'
          ? true
          : debtFilter === 'with_debt'
            ? c.remainingDebt > 0.01
            : c.remainingDebt <= 0.01;
      return matchSearch && matchDebt;
    });
  }, [enrichedCustomers, search, debtFilter]);

  const totals = useMemo(() => {
    return filtered.reduce(
      (acc, c) => ({
        purchases: acc.purchases + c.totalPurchases,
        paid: acc.paid + c.totalPaid,
        remaining: acc.remaining + c.remainingDebt,
      }),
      { purchases: 0, paid: 0, remaining: 0 }
    );
  }, [filtered]);

  const openNew = () => {
    setEditing(null);
    setForm({
      fullName: '',
      phone: '',
      address: '',
      creditLimit: 1000,
      openingBalance: 0,
      notes: '',
    });
    setShowForm(true);
  };

  const openEdit = (c: Customer) => {
    setEditing(c);
    setForm({
      fullName: c.fullName,
      phone: c.phone,
      address: c.address,
      creditLimit: c.creditLimit,
      openingBalance: c.openingBalance,
      notes: c.notes ?? '',
    });
    setShowForm(true);
  };

  const handleCollectInstallment = async (inst: Installment) => {
    if (!currentUser) return;
    try {
      const pay = await recordCustomerPayment(
        {
          customerId: inst.customerId,
          customerName: inst.customerName,
          invoiceIds: [inst.saleInvoiceId],
          installmentId: inst.id,
          amount: inst.remainingAmount,
          paymentMethod: 'cash',
          date: new Date().toISOString(),
          notes: t(
            lang,
            `تحصيل القسط #${inst.installmentNumber} — فاتورة ${inst.saleInvoiceNumber}`,
            `Encaissement échéance #${inst.installmentNumber} — ${inst.saleInvoiceNumber}`
          ),
          idempotencyKey: makeIdempotencyKey('inst'),
        },
        currentUser
      );
      notify(
        t(
          lang,
          `تم تحصيل القسط #${inst.installmentNumber} (وصل #${pay.refNumber})`,
          `Échéance #${inst.installmentNumber} encaissée (Reçu #${pay.refNumber})`
        )
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageCustomers) {
      notify(t(lang, 'ليس لديك صلاحية إدارة الزبناء', 'Permission refusée'), 'error');
      return;
    }
    if (!form.fullName.trim()) return;
    if (editing?.id) {
      await db.customers.update(editing.id, {
        fullName: form.fullName.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        creditLimit: Number(form.creditLimit) || 0,
        openingBalance: Number(form.openingBalance) || 0,
        notes: form.notes.trim(),
      });
      if (currentUser) {
        await logAudit(
          currentUser,
          'CUSTOMER_UPDATED',
          'customer',
          editing.id,
          `تعديل بيانات الزبون: ${form.fullName}`
        );
      }
      notify(t(lang, 'تم تحديث بيانات الزبون', 'Client mis à jour'));
    } else {
      const id = await db.customers.add({
        fullName: form.fullName.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        creditLimit: Number(form.creditLimit) || 0,
        openingBalance: Number(form.openingBalance) || 0,
        notes: form.notes.trim(),
        createdAt: new Date().toISOString(),
      });
      if (currentUser) {
        await logAudit(
          currentUser,
          'CUSTOMER_CREATED',
          'customer',
          id,
          `إضافة زبون جديد: ${form.fullName}`
        );
      }
      notify(t(lang, 'تمت إضافة الزبون بنجاح', 'Client ajouté avec succès'));
    }
    setShowForm(false);
  };

  const handleDelete = (c: (typeof enrichedCustomers)[number]) => {
    if (c.id === 1) {
      notify(
        t(lang, 'لا يمكن حذف الزبون النقدي الافتراضي', 'Impossible de supprimer le client comptoir'),
        'warning'
      );
      return;
    }
    if (!currentUser?.permissions.canDeleteRecords) {
      notify(t(lang, 'ليس لديك صلاحية حذف الزبناء', 'Permission de suppression refusée'), 'error');
      return;
    }
    if (c.invoices.length > 0 || c.remainingDebt > 0) {
      notify(
        t(lang, 'لا يمكن حذف زبون مرتبط بفواتير أو ديون قائمة', 'Client lié à des factures ou dettes'),
        'error'
      );
      return;
    }
    requestGuardedAction({
      title: t(lang, 'تأكيد حذف الزبون', 'Confirmer la suppression'),
      description: t(
        lang,
        `هل أنت متأكد من حذف الزبون "${c.fullName}"؟`,
        `Voulez-vous vraiment supprimer le client "${c.fullName}" ?`
      ),
      isSensitiveDelete: true,
      onConfirm: async () => {
        await db.customers.delete(c.id!);
        if (currentUser) {
          await logAudit(
            currentUser,
            'CUSTOMER_DELETED',
            'customer',
            c.id!,
            `حذف الزبون: ${c.fullName}`
          );
        }
        notify(t(lang, 'تم حذف الزبون', 'Client supprimé'));
      },
    });
  };

  const handleExportExcel = () => {
    exportRowsToExcel(
      filtered.map((c) => ({
        [t(lang, 'الزبون', 'Client')]: c.fullName,
        [t(lang, 'الهاتف', 'Téléphone')]: c.phone,
        [t(lang, 'العنوان', 'Adresse')]: c.address,
        [t(lang, 'عدد الفواتير', 'Factures')]: c.invoices.length,
        [t(lang, 'إجمالي المشتريات', 'Total achats')]: c.totalPurchases,
        [t(lang, 'المدفوعات', 'Paiements')]: c.totalPaid,
        [t(lang, 'المتبقي', 'Reste')]: c.remainingDebt,
        [t(lang, 'الحد الائتماني', 'Plafond')]: c.creditLimit,
      })),
      'Customers',
      'customers_list.xlsx'
    );
  };

  const handleExportPdf = () => {
    exportTableToPdf(
      'Customers Register',
      `Exported ${new Date().toISOString().slice(0, 10)} (${filtered.length} clients)`,
      ['Client', 'Phone', 'Address', 'Invoices', 'Total', 'Paid', 'Remaining'],
      filtered.map((c) => [
        c.fullName,
        c.phone || '-',
        c.address || '-',
        String(c.invoices.length),
        c.totalPurchases.toFixed(2),
        c.totalPaid.toFixed(2),
        c.remainingDebt.toFixed(2),
      ]),
      'customers_register.pdf'
    );
  };

  const handlePrintList = () => {
    openPrint({
      type: 'generic_report',
      title: t(lang, 'سجل الزبناء وحسابات الديون', 'Registre des clients & créances'),
      subtitle: `${t(lang, 'عدد الزبناء:', 'Nombre :')} ${filtered.length} — ${new Date().toLocaleDateString(
        lang === 'ar' ? 'ar-MA' : 'fr-FR'
      )}`,
      columns: [
        t(lang, 'الزبون', 'Client'),
        t(lang, 'الهاتف', 'Téléphone'),
        t(lang, 'العنوان', 'Adresse'),
        t(lang, 'سجل فواتيره', 'Factures'),
        t(lang, 'المدفوعات', 'Paiements'),
        t(lang, 'المتبقي', 'Reste'),
      ],
      rows: filtered.map((c) => [
        c.fullName,
        c.phone || '—',
        c.address || '—',
        `${c.invoices.length} (${c.totalPurchases.toFixed(2)})`,
        c.totalPaid.toFixed(2),
        c.remainingDebt.toFixed(2),
      ]),
      summaryItems: [
        { label: t(lang, 'إجمالي الفواتير', 'Total ventes'), value: formatMoney(totals.purchases, cur) },
        { label: t(lang, 'إجمالي المدفوعات', 'Total payé'), value: formatMoney(totals.paid, cur) },
        { label: t(lang, 'إجمالي المتبقي (الديون)', 'Total créances'), value: formatMoney(totals.remaining, cur) },
      ],
    });
  };

  const statementCustomer = enrichedCustomers.find((c) => c.id === statementCustomerId) ?? null;
  const emptyFillerCount = Math.max(0, 12 - filtered.length);

  return (
    <div className="space-y-4">
      {/* Top Page Title matching blueprint */}
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 pb-2">
        <h2 className="text-2xl font-black tracking-tight text-slate-950">
          {t(lang, 'سجل الزبناء', 'Registre des clients')}
        </h2>
        <div className="text-xs font-semibold text-slate-600 font-mono tabular-nums">
          {t(lang, `العدد: ${filtered.length}`, `Total : ${filtered.length}`)} ·{' '}
          {t(lang, 'إجمالي الديون:', 'Créances :')}{' '}
          <span className="font-extrabold text-red-700">{formatMoney(totals.remaining, cur)}</span>
        </div>
      </div>

      {/* Action & Filter Toolbar (Exact layout & color hierarchy from blueprint) */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        {/* Start (Right in RTL): Search box + 3 Status Filters (الكل / عليهم ديون / حساب مصفى) */}
        <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[260px]">
          <div className="relative flex-1 min-w-[210px] max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-sky-700" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t(
                lang,
                'بحث بالاسم او الهاتف او العنوان',
                'Rechercher nom, téléphone ou adresse'
              )}
              className="w-full rounded-sm border-2 border-sky-600/80 bg-white py-2 ps-9 pe-3 text-sm font-semibold text-slate-900 placeholder:text-slate-500 focus:border-sky-800 focus:outline-none"
            />
          </div>

          <button
            type="button"
            onClick={() => setDebtFilter('all')}
            className={`rounded-sm border-2 px-4 py-2 text-xs font-extrabold transition-all whitespace-nowrap ${
              debtFilter === 'all'
                ? 'border-sky-800 bg-sky-50 text-slate-950 ring-2 ring-sky-500/30'
                : 'border-sky-600/75 bg-white text-slate-900 hover:bg-slate-50'
            }`}
          >
            {t(lang, 'الكل', 'Tous')}
          </button>

          <button
            type="button"
            onClick={() => setDebtFilter('with_debt')}
            className={`rounded-sm border-2 px-4 py-2 text-xs font-extrabold transition-all whitespace-nowrap ${
              debtFilter === 'with_debt'
                ? 'border-slate-950 bg-red-600 text-white ring-2 ring-red-500/40 shadow-sm'
                : 'border-sky-600/75 bg-red-600 text-white hover:bg-red-700'
            }`}
          >
            {t(lang, 'عليهم ديون', 'Avec dettes')}
          </button>

          <button
            type="button"
            onClick={() => setDebtFilter('clear')}
            className={`rounded-sm border-2 px-4 py-2 text-xs font-extrabold transition-all whitespace-nowrap ${
              debtFilter === 'clear'
                ? 'border-sky-800 bg-emerald-50 text-emerald-950 ring-2 ring-emerald-500/30'
                : 'border-sky-600/75 bg-white text-slate-900 hover:bg-slate-50'
            }`}
          >
            {t(lang, 'حساب مصفى', 'Compte soldé')}
          </button>
        </div>

        {/* End (Left in RTL): طباعة | Pdf | Excel | + اضافة زبون جديد */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handlePrintList}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-4 py-2 text-xs font-extrabold text-slate-950 shadow-md hover:bg-sky-400 active:scale-[0.98] whitespace-nowrap"
          >
            <Printer className="h-3.5 w-3.5" />
            <span>{t(lang, 'طباعة', 'Imprimer')}</span>
          </button>

          <button
            type="button"
            onClick={handleExportPdf}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-4 py-2 text-xs font-extrabold text-slate-950 shadow-md hover:bg-amber-300 active:scale-[0.98] whitespace-nowrap"
          >
            <FileDown className="h-3.5 w-3.5" />
            <span>Pdf</span>
          </button>

          <button
            type="button"
            onClick={handleExportExcel}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-extrabold text-slate-950 shadow-md hover:bg-emerald-500 active:scale-[0.98] whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Excel</span>
          </button>

          {canManageCustomers && (
            <button
              type="button"
              onClick={openNew}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-4 py-2 text-xs font-black text-slate-950 shadow-md hover:bg-amber-300 active:scale-[0.98] whitespace-nowrap"
            >
              <Plus className="h-4 w-4 stroke-[2.5]" />
              <span>{t(lang, 'اضافة زبون جديد', 'Nouveau client')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Full-Bordered Ledger Table (Peach header & crisp grid lines matching blueprint) */}
      <div className="rounded-lg border-2 border-slate-900 bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-[#F7C59F] text-slate-950 text-xs sm:text-sm">
                <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold">
                  {t(lang, 'الزبون', 'Client')}
                </th>
                <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold">
                  {t(lang, 'الهاتف', 'Téléphone')}
                </th>
                <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold">
                  {t(lang, 'العنوان', 'Adresse')}
                </th>
                <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold">
                  {t(lang, 'سجل فواتيره', 'Factures')}
                </th>
                <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold">
                  {t(lang, 'المدفوعات', 'Paiements')}
                </th>
                <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold">
                  {t(lang, 'المتبقي', 'Reste')}
                </th>
                <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold">
                  {t(lang, 'إجراءات', 'Actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const overLimit = c.creditLimit > 0 && c.remainingDebt > c.creditLimit;
                return (
                  <tr key={c.id} className="hover:bg-orange-50/50 transition-colors">
                    <td className="border border-slate-800/80 px-3 py-2 font-bold text-slate-950">
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <span>{c.fullName}</span>
                        <div className="flex items-center gap-1">
                          {c.overdueInstallmentsCount > 0 && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-extrabold text-white whitespace-nowrap">
                              <CalendarClock className="h-3 w-3" />
                              {c.overdueInstallmentsCount} {t(lang, 'قسط متأخر', 'retard')}
                            </span>
                          )}
                          {overLimit && (
                            <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700 whitespace-nowrap">
                              {t(lang, 'تجاوز الحد', 'Plafond dépassé')}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="border border-slate-800/80 px-3 py-2 text-center font-mono text-xs text-slate-800">
                      {c.phone || '—'}
                    </td>
                    <td className="border border-slate-800/80 px-3 py-2 text-center text-xs text-slate-700 max-w-[200px] truncate">
                      {c.address || '—'}
                    </td>
                    <td className="border border-slate-800/80 px-3 py-2 text-center">
                      <button
                        type="button"
                        onClick={() => setStatementCustomerId(c.id!)}
                        className="inline-flex items-center justify-center gap-1.5 rounded border border-sky-300 bg-sky-50 px-2.5 py-1 text-xs font-bold text-sky-900 hover:bg-sky-100 transition-colors"
                      >
                        <FileText className="h-3.5 w-3.5 text-sky-700 shrink-0" />
                        <span className="font-mono tabular-nums">
                          {c.invoices.length} {t(lang, 'فاتورة', 'fact.')} ·{' '}
                          {c.totalPurchases.toFixed(2)}
                        </span>
                      </button>
                    </td>
                    <td className="border border-slate-800/80 px-3 py-2 text-center font-mono text-xs font-bold tabular-nums text-emerald-700">
                      {formatMoney(c.totalPaid, cur)}
                    </td>
                    <td className="border border-slate-800/80 px-3 py-2 text-center font-mono text-xs font-extrabold tabular-nums">
                      <span className={c.remainingDebt > 0.01 ? 'text-red-700' : 'text-slate-600'}>
                        {formatMoney(c.remainingDebt, cur)}
                      </span>
                      {c.creditBalance > 0.01 && (
                        <div className="mt-0.5 text-[10px] font-bold text-teal-700">
                          {t(lang, 'رصيد له:', 'Crédit :')} {formatMoney(c.creditBalance, cur)}
                        </div>
                      )}
                    </td>
                    <td className="border border-slate-800/80 px-2 py-1.5">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          type="button"
                          onClick={() => setStatementCustomerId(c.id!)}
                          title={t(lang, 'كشف الحساب', 'Relevé de compte')}
                          className="rounded p-1.5 text-teal-700 hover:bg-teal-50"
                        >
                          <FileText className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            openPrint({
                              type: 'customer_statement',
                              customer: c,
                              invoices: c.invoices,
                              payments: c.payments,
                            })
                          }
                          title={t(lang, 'طباعة كشف الحساب', 'Imprimer le relevé')}
                          className="rounded p-1.5 text-sky-700 hover:bg-sky-50"
                        >
                          <Printer className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => openEdit(c)}
                          title={t(lang, 'تعديل', 'Modifier')}
                          className="rounded p-1.5 text-amber-700 hover:bg-amber-50"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                        {c.id !== 1 && (
                          <button
                            type="button"
                            onClick={() => handleDelete(c)}
                            title={t(lang, 'حذف', 'Supprimer')}
                            className="rounded p-1.5 text-red-600 hover:bg-red-50"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}

              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="border border-slate-800/80 px-4 py-8 text-center text-sm font-semibold text-slate-500"
                  >
                    {t(lang, 'لا يوجد زبناء مطابقون للبحث', 'Aucun client trouvé')}
                  </td>
                </tr>
              )}

              {/* Crisp empty ledger rows matching the blueprint sheet */}
              {Array.from({ length: emptyFillerCount }).map((_, idx) => (
                <tr key={`empty-cust-${idx}`} className="h-9">
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
            <tfoot>
              <tr className="bg-slate-100 text-xs font-extrabold text-slate-950">
                <td colSpan={3} className="border border-slate-900 px-3 py-2 text-start">
                  {t(lang, `المجموع العام (${filtered.length} زبون)`, `Total général (${filtered.length} clients)`)}
                </td>
                <td className="border border-slate-900 px-3 py-2 text-center font-mono tabular-nums">
                  {formatMoney(totals.purchases, cur)}
                </td>
                <td className="border border-slate-900 px-3 py-2 text-center font-mono tabular-nums text-emerald-800">
                  {formatMoney(totals.paid, cur)}
                </td>
                <td className="border border-slate-900 px-3 py-2 text-center font-mono tabular-nums text-red-700">
                  {formatMoney(totals.remaining, cur)}
                </td>
                <td className="border border-slate-900 px-3 py-2" />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Add / Edit Customer Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900">
                {editing
                  ? t(lang, 'تعديل بيانات الزبون', 'Modifier le client')
                  : t(lang, 'إضافة زبون جديد', 'Ajouter un client')}
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
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'الاسم الكامل *', 'Nom complet *')}
                </label>
                <input
                  required
                  value={form.fullName}
                  onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'رقم الهاتف', 'Téléphone')}
                  </label>
                  <input
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-teal-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, `الحد الائتماني (${cur})`, `Plafond crédit (${cur})`)}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.creditLimit}
                    onChange={(e) => setForm({ ...form, creditLimit: Number(e.target.value) })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-teal-600 focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'العنوان', 'Adresse')}
                </label>
                <input
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, `الرصيد الافتتاحي / دين سابق (${cur})`, `Solde initial (${cur})`)}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={form.openingBalance}
                    onChange={(e) => setForm({ ...form, openingBalance: Number(e.target.value) })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-teal-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'ملاحظات', 'Notes')}
                  </label>
                  <input
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
                  />
                </div>
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
                  className="rounded-lg bg-amber-400 px-5 py-2 text-sm font-extrabold text-slate-950 hover:bg-amber-300"
                >
                  {t(lang, 'حفظ البيانات', 'Enregistrer')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Customer Account Statement Drawer/Modal */}
      {statementCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 overflow-y-auto">
          <div className="w-full max-w-3xl rounded-xl border border-slate-200 bg-white p-6 shadow-xl my-6">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  {t(lang, 'كشف حساب الزبون:', 'Relevé client :')} {statementCustomer.fullName}
                </h3>
                <p className="text-xs text-slate-500">
                  {statementCustomer.phone} · {statementCustomer.address}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    openPrint({
                      type: 'customer_statement',
                      customer: statementCustomer,
                      invoices: statementCustomer.invoices,
                      payments: statementCustomer.payments,
                    })
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-sky-400"
                >
                  <Printer className="h-3.5 w-3.5" />
                  {t(lang, 'طباعة كشف الحساب', 'Imprimer le relevé')}
                </button>
                <button
                  type="button"
                  onClick={() => setStatementCustomerId(null)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 my-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs text-slate-500">{t(lang, 'إجمالي المشتريات', 'Total Achats')}</div>
                <div className="mt-1 font-mono font-bold text-slate-900">
                  {formatMoney(statementCustomer.totalPurchases, cur)}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs text-slate-500">{t(lang, 'إجمالي المؤدى', 'Total Payé')}</div>
                <div className="mt-1 font-mono font-bold text-emerald-700">
                  {formatMoney(statementCustomer.totalPaid, cur)}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs text-slate-500">{t(lang, 'المرتجعات', 'Retours')}</div>
                <div className="mt-1 font-mono font-bold text-slate-700">
                  {formatMoney(statementCustomer.totalReturns, cur)}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs text-slate-500">{t(lang, 'الدين المتبقي', 'Reste Dû')}</div>
                <div className="mt-1 font-mono font-bold text-red-700">
                  {formatMoney(statementCustomer.remainingDebt, cur)}
                </div>
                {statementCustomer.openingBalance > 0.01 && (
                  <div className="text-[10px] text-slate-500 font-mono">
                    {t(lang, 'منه رصيد افتتاحي:', 'Dont solde init. :')}{' '}
                    {formatMoney(statementCustomer.openingBalance, cur)}
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-teal-200 bg-teal-50/70 p-3">
                <div className="text-xs text-teal-800">{t(lang, 'رصيد لصالح الزبون', 'Crédit client')}</div>
                <div className="mt-1 font-mono font-bold text-teal-800">
                  {formatMoney(statementCustomer.creditBalance, cur)}
                </div>
                <div className="text-[10px] text-slate-500 font-mono">
                  {t(lang, 'السقف:', 'Plafond :')} {formatMoney(statementCustomer.creditLimit, cur)}
                </div>
              </div>
            </div>

            <div className="space-y-4 max-h-[55vh] overflow-y-auto">
              {/* Installments Schedule Table */}
              {statementCustomer.installments.length > 0 && (
                <div>
                  <h4 className="text-xs font-bold text-slate-800 mb-2 flex items-center gap-1.5">
                    <CalendarClock className="h-3.5 w-3.5 text-amber-700" />
                    {t(lang, 'جدول الأقساط وتواريخ الاستحقاق', 'Échéancier des paiements')}
                  </h4>
                  <table className="w-full text-xs border border-slate-200">
                    <thead>
                      <tr className="border-b border-slate-200 bg-amber-100/80 text-slate-900">
                        <th className="p-2 text-start">{t(lang, 'القسط', '#')}</th>
                        <th className="p-2 text-start">{t(lang, 'الفاتورة', 'Facture')}</th>
                        <th className="p-2 text-start">{t(lang, 'تاريخ الاستحقاق', 'Échéance')}</th>
                        <th className="p-2 text-end">{t(lang, 'المبلغ', 'Montant')}</th>
                        <th className="p-2 text-end">{t(lang, 'المتبقي', 'Reste')}</th>
                        <th className="p-2 text-center">{t(lang, 'الحالة', 'Statut')}</th>
                        <th className="p-2 text-center">{t(lang, 'تحصيل', 'Action')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {statementCustomer.installments.map((inst) => {
                        const isPaid = inst.remainingAmount <= 0.005;
                        const isOverdue = !isPaid && inst.dueDate < todayIso;
                        return (
                          <tr key={inst.id} className={isOverdue ? 'bg-red-50/60' : ''}>
                            <td className="p-2 font-mono font-bold">#{inst.installmentNumber}</td>
                            <td className="p-2 font-mono">{inst.saleInvoiceNumber}</td>
                            <td className="p-2 font-mono">{inst.dueDate}</td>
                            <td className="p-2 text-end font-mono">{inst.amount.toFixed(2)}</td>
                            <td className="p-2 text-end font-mono font-bold text-red-700">
                              {inst.remainingAmount.toFixed(2)}
                            </td>
                            <td className="p-2 text-center">
                              <span
                                className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                  isPaid
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : isOverdue
                                      ? 'bg-red-600 text-white'
                                      : inst.status === 'partial'
                                        ? 'bg-amber-100 text-amber-900'
                                        : 'bg-sky-100 text-sky-900'
                                }`}
                              >
                                {isPaid
                                  ? t(lang, 'مدفوع', 'Payé')
                                  : isOverdue
                                    ? t(lang, 'متأخر', 'En retard')
                                    : inst.status === 'partial'
                                      ? t(lang, 'جزئي', 'Partiel')
                                      : t(lang, 'مستحق', 'À échoir')}
                              </span>
                            </td>
                            <td className="p-2 text-center">
                              {!isPaid ? (
                                <button
                                  type="button"
                                  onClick={() => handleCollectInstallment(inst)}
                                  className="rounded bg-teal-700 px-2 py-0.5 text-[10px] font-bold text-white hover:bg-teal-800"
                                >
                                  {t(lang, 'تحصيل القسط', 'Encaisser')}
                                </button>
                              ) : (
                                <span className="text-[10px] text-emerald-700 font-semibold">✓</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <div>
                <h4 className="text-xs font-semibold text-slate-700 mb-2">
                  {t(lang, 'سجل الفواتير', 'Historique des factures')}
                </h4>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-[#F7C59F]/60 text-slate-900">
                      <th className="p-2 text-start">{t(lang, 'رقم الفاتورة', 'N°')}</th>
                      <th className="p-2 text-start">{t(lang, 'التاريخ', 'Date')}</th>
                      <th className="p-2 text-end">{t(lang, 'الإجمالي', 'Total')}</th>
                      <th className="p-2 text-end">{t(lang, 'المدفوع', 'Payé')}</th>
                      <th className="p-2 text-end">{t(lang, 'المتبقي', 'Reste')}</th>
                      <th className="p-2 text-end">{t(lang, 'الحالة', 'Statut')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {statementCustomer.invoices.map((inv) => (
                      <tr key={inv.id}>
                        <td className="p-2 font-mono font-medium">{inv.invoiceNumber}</td>
                        <td className="p-2">{formatDateTime(inv.date, lang)}</td>
                        <td className="p-2 text-end font-mono">{inv.total.toFixed(2)}</td>
                        <td className="p-2 text-end font-mono text-emerald-700">{inv.paidAmount.toFixed(2)}</td>
                        <td className="p-2 text-end font-mono text-red-700">{inv.remainingAmount.toFixed(2)}</td>
                        <td className="p-2 text-end">{getStatusLabel(inv.status, lang)}</td>
                      </tr>
                    ))}
                    {statementCustomer.invoices.length === 0 && (
                      <tr>
                        <td colSpan={6} className="p-4 text-center text-slate-400">
                          {t(lang, 'لا توجد فواتير', 'Aucune facture')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-slate-700 mb-2">
                  {t(lang, 'سجل الدفعات والمرتجعات', 'Paiements et retours')}
                </h4>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-[#F7C59F]/60 text-slate-900">
                      <th className="p-2 text-start">{t(lang, 'المرجع', 'Réf')}</th>
                      <th className="p-2 text-start">{t(lang, 'التاريخ', 'Date')}</th>
                      <th className="p-2 text-start">{t(lang, 'الفواتير المرتبطة', 'Factures')}</th>
                      <th className="p-2 text-end">{t(lang, 'المبلغ', 'Montant')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {statementCustomer.payments.map((p) => (
                      <tr key={p.id}>
                        <td className="p-2 font-mono">#{p.refNumber}</td>
                        <td className="p-2">{formatDateTime(p.date, lang)}</td>
                        <td className="p-2 font-mono">{p.invoiceNumbers.join(', ') || '—'}</td>
                        <td className="p-2 text-end font-mono font-semibold text-emerald-700">
                          {formatMoney(p.amount, cur)}
                        </td>
                      </tr>
                    ))}
                    {statementCustomer.returns.map((r) => (
                      <tr key={`ret-${r.id}`}>
                        <td className="p-2 font-mono text-amber-700">{r.returnNumber}</td>
                        <td className="p-2">{formatDateTime(r.date, lang)}</td>
                        <td className="p-2">
                          {t(lang, 'مرتجع مبيعات', 'Retour vente')} ({r.saleInvoiceNumber})
                        </td>
                        <td className="p-2 text-end font-mono text-amber-700">
                          -{formatMoney(r.totalAmount, cur)}
                        </td>
                      </tr>
                    ))}
                    {statementCustomer.payments.length === 0 &&
                      statementCustomer.returns.length === 0 && (
                        <tr>
                          <td colSpan={4} className="p-4 text-center text-slate-400">
                            {t(lang, 'لا توجد دفعات أو مرتجعات', 'Aucun paiement ou retour')}
                          </td>
                        </tr>
                      )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
