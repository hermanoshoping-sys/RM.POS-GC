import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
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
import { logAudit } from '../db/operations';
import { useApp } from '../context/AppContext';
import { Supplier } from '../types';
import { formatDateTime, formatMoney, t } from '../i18n/translations';
import { exportRowsToExcel, exportTableToPdf } from '../utils/export';

export const SuppliersModule: React.FC = () => {
  const { lang, settings, currentUser, notify, openPrint, requestGuardedAction } = useApp();
  const cur = settings.storeInfo.currency || 'MAD';

  const suppliers = useLiveQuery(() => db.suppliers.toArray(), []) ?? [];
  const purchases = useLiveQuery(() => db.purchaseInvoices.toArray(), []) ?? [];
  const supplierPayments = useLiveQuery(() => db.supplierPayments.toArray(), []) ?? [];
  const supplierReturns = useLiveQuery(() => db.supplierReturns.toArray(), []) ?? [];

  const [search, setSearch] = useState('');
  const [balanceFilter, setBalanceFilter] = useState<'all' | 'with_due' | 'clear'>('all');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [statementSupplierId, setStatementSupplierId] = useState<number | null>(null);

  const [form, setForm] = useState({
    businessName: '',
    phone: '',
    address: '',
    taxId: '',
    openingBalance: 0,
    notes: '',
  });

  const enriched = useMemo(() => {
    return suppliers.map((s) => {
      const sPurch = purchases.filter((p) => p.supplierId === s.id && p.status !== 'cancelled');
      const sPays = supplierPayments.filter((p) => p.supplierId === s.id && !p.isCancelled);
      const sRets = supplierReturns.filter((r) => r.supplierId === s.id);

      const totalPurchases = sPurch.reduce((sum, p) => sum + p.total, 0);
      const totalPaid = sPurch.reduce((sum, p) => sum + p.paidAmount, 0);
      const totalReturns = sRets.reduce((sum, r) => sum + r.totalAmount, 0);
      const remaining =
        sPurch.reduce((sum, p) => sum + p.remainingAmount, 0) + (s.openingBalance || 0);

      return {
        ...s,
        totalPurchases,
        totalPaid,
        totalReturns,
        remaining,
        purchases: sPurch,
        payments: sPays,
        returns: sRets,
      };
    });
  }, [suppliers, purchases, supplierPayments, supplierReturns]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enriched.filter((s) => {
      const matchSearch =
        !q ||
        s.businessName.toLowerCase().includes(q) ||
        s.phone.toLowerCase().includes(q) ||
        s.address.toLowerCase().includes(q) ||
        (s.taxId ?? '').toLowerCase().includes(q);
      const matchBalance =
        balanceFilter === 'all'
          ? true
          : balanceFilter === 'with_due'
            ? s.remaining > 0.01
            : s.remaining <= 0.01;
      return matchSearch && matchBalance;
    });
  }, [enriched, search, balanceFilter]);

  const totals = useMemo(() => {
    return filtered.reduce(
      (acc, s) => ({
        purchases: acc.purchases + s.totalPurchases,
        paid: acc.paid + s.totalPaid,
        returns: acc.returns + s.totalReturns,
        remaining: acc.remaining + s.remaining,
      }),
      { purchases: 0, paid: 0, returns: 0, remaining: 0 }
    );
  }, [filtered]);

  const openNew = () => {
    setEditing(null);
    setForm({ businessName: '', phone: '', address: '', taxId: '', openingBalance: 0, notes: '' });
    setShowForm(true);
  };

  const openEdit = (s: Supplier) => {
    setEditing(s);
    setForm({
      businessName: s.businessName,
      phone: s.phone,
      address: s.address,
      taxId: s.taxId ?? '',
      openingBalance: s.openingBalance,
      notes: s.notes ?? '',
    });
    setShowForm(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.businessName.trim()) return;
    if (editing?.id) {
      await db.suppliers.update(editing.id, {
        businessName: form.businessName.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        taxId: form.taxId.trim(),
        openingBalance: Number(form.openingBalance) || 0,
        notes: form.notes.trim(),
      });
      if (currentUser) {
        await logAudit(
          currentUser,
          'SUPPLIER_UPDATED',
          'supplier',
          editing.id,
          `تعديل المورد: ${form.businessName}`
        );
      }
      notify(t(lang, 'تم تحديث بيانات المورد', 'Fournisseur mis à jour'));
    } else {
      const id = await db.suppliers.add({
        businessName: form.businessName.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        taxId: form.taxId.trim(),
        openingBalance: Number(form.openingBalance) || 0,
        notes: form.notes.trim(),
        createdAt: new Date().toISOString(),
      });
      if (currentUser) {
        await logAudit(
          currentUser,
          'SUPPLIER_CREATED',
          'supplier',
          id,
          `إضافة مورد جديد: ${form.businessName}`
        );
      }
      notify(t(lang, 'تمت إضافة المورد بنجاح', 'Fournisseur ajouté'));
    }
    setShowForm(false);
  };

  const handleDelete = (s: (typeof enriched)[number]) => {
    if (!currentUser?.permissions.canDeleteRecords) {
      notify(t(lang, 'ليس لديك صلاحية حذف الموردين', 'Permission refusée'), 'error');
      return;
    }
    if (s.purchases.length > 0 || s.remaining > 0) {
      notify(
        t(lang, 'لا يمكن حذف مورد لديه فواتير مشتريات أو مستحقات قائمة', 'Fournisseur lié à des achats'),
        'error'
      );
      return;
    }
    requestGuardedAction({
      title: t(lang, 'تأكيد حذف المورد', 'Confirmer la suppression'),
      description: t(lang, `هل تريد حذف المورد "${s.businessName}"؟`, `Supprimer "${s.businessName}" ?`),
      isSensitiveDelete: true,
      onConfirm: async () => {
        await db.suppliers.delete(s.id!);
        if (currentUser) {
          await logAudit(
            currentUser,
            'SUPPLIER_DELETED',
            'supplier',
            s.id!,
            `حذف المورد: ${s.businessName}`
          );
        }
        notify(t(lang, 'تم حذف المورد', 'Fournisseur supprimé'));
      },
    });
  };

  const handleExportExcel = () => {
    exportRowsToExcel(
      filtered.map((s) => ({
        [t(lang, 'المورد (الاسم التجاري)', 'Raison sociale')]: s.businessName,
        [t(lang, 'الهاتف', 'Téléphone')]: s.phone,
        [t(lang, 'العنوان', 'Adresse')]: s.address,
        [t(lang, 'الرقم الضريبي', 'ICE / IF')]: s.taxId ?? '',
        [t(lang, 'فواتير المشتريات', 'Achats')]: s.totalPurchases,
        [t(lang, 'المدفوعات', 'Payé')]: s.totalPaid,
        [t(lang, 'المسترجعات', 'Retours')]: s.totalReturns,
        [t(lang, 'المتبقي للمورد', 'Reste fournisseur')]: s.remaining,
      })),
      'Suppliers',
      'suppliers_list.xlsx'
    );
  };

  const handleExportPdf = () => {
    exportTableToPdf(
      'Suppliers Register',
      `Exported ${new Date().toISOString().slice(0, 10)} (${filtered.length} suppliers)`,
      ['Supplier', 'Phone', 'ICE / Address', 'Purchases', 'Paid', 'Returns', 'Remaining'],
      filtered.map((s) => [
        s.businessName,
        s.phone || '-',
        s.taxId || s.address || '-',
        s.totalPurchases.toFixed(2),
        s.totalPaid.toFixed(2),
        s.totalReturns.toFixed(2),
        s.remaining.toFixed(2),
      ]),
      'suppliers_register.pdf'
    );
  };

  const handlePrintList = () => {
    openPrint({
      type: 'generic_report',
      title: t(lang, 'سجل الموردين والمستحقات', 'Registre des fournisseurs & soldes'),
      subtitle: `${t(lang, 'عدد الموردين:', 'Nombre :')} ${filtered.length} — ${new Date().toLocaleDateString(
        lang === 'ar' ? 'ar-MA' : 'fr-FR'
      )}`,
      columns: [
        t(lang, 'المورد', 'Fournisseur'),
        t(lang, 'الهاتف', 'Téléphone'),
        t(lang, 'العنوان / الضريبة', 'Adresse / ICE'),
        t(lang, 'سجل مشترياته', 'Achats'),
        t(lang, 'المدفوعات', 'Paiements'),
        t(lang, 'المتبقي للمورد', 'Reste dû'),
      ],
      rows: filtered.map((s) => [
        s.businessName,
        s.phone || '—',
        [s.address, s.taxId].filter(Boolean).join(' / ') || '—',
        `${s.purchases.length} (${s.totalPurchases.toFixed(2)})`,
        s.totalPaid.toFixed(2),
        s.remaining.toFixed(2),
      ]),
      summaryItems: [
        { label: t(lang, 'إجمالي المشتريات', 'Total achats'), value: formatMoney(totals.purchases, cur) },
        { label: t(lang, 'إجمالي المدفوعات', 'Total payé'), value: formatMoney(totals.paid, cur) },
        { label: t(lang, 'إجمالي المستحقات للموردين', 'Total dettes'), value: formatMoney(totals.remaining, cur) },
      ],
    });
  };

  const statementSupplier = enriched.find((s) => s.id === statementSupplierId) ?? null;
  const emptyFillerCount = Math.max(0, 12 - filtered.length);

  return (
    <div className="space-y-4">
      {/* Top Page Title matching blueprint */}
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 pb-2">
        <h2 className="text-2xl font-black tracking-tight text-slate-950">
          {t(lang, 'سجل الموردين', 'Registre des fournisseurs')}
        </h2>
        <div className="text-xs font-semibold text-slate-600 font-mono tabular-nums">
          {t(lang, `العدد: ${filtered.length}`, `Total : ${filtered.length}`)} ·{' '}
          {t(lang, 'مستحقات الموردين:', 'Soldes dus :')}{' '}
          <span className="font-extrabold text-red-700">{formatMoney(totals.remaining, cur)}</span>
        </div>
      </div>

      {/* Action & Filter Toolbar (Exact layout & color hierarchy tailored for Suppliers) */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        {/* Start (Right in RTL): Search box + 3 Status Filters (الكل / لهم مستحقات / حساب مصفى) */}
        <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[260px]">
          <div className="relative flex-1 min-w-[210px] max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-sky-700" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t(
                lang,
                'بحث بالاسم التجاري او الهاتف او الرقم الضريبي',
                'Rechercher fournisseur, téléphone ou ICE'
              )}
              className="w-full rounded-sm border-2 border-sky-600/80 bg-white py-2 ps-9 pe-3 text-sm font-semibold text-slate-900 placeholder:text-slate-500 focus:border-sky-800 focus:outline-none"
            />
          </div>

          <button
            type="button"
            onClick={() => setBalanceFilter('all')}
            className={`rounded-sm border-2 px-4 py-2 text-xs font-extrabold transition-all whitespace-nowrap ${
              balanceFilter === 'all'
                ? 'border-sky-800 bg-sky-50 text-slate-950 ring-2 ring-sky-500/30'
                : 'border-sky-600/75 bg-white text-slate-900 hover:bg-slate-50'
            }`}
          >
            {t(lang, 'الكل', 'Tous')}
          </button>

          <button
            type="button"
            onClick={() => setBalanceFilter('with_due')}
            className={`rounded-sm border-2 px-4 py-2 text-xs font-extrabold transition-all whitespace-nowrap ${
              balanceFilter === 'with_due'
                ? 'border-slate-950 bg-red-600 text-white ring-2 ring-red-500/40 shadow-sm'
                : 'border-sky-600/75 bg-red-600 text-white hover:bg-red-700'
            }`}
          >
            {t(lang, 'لهم مستحقات', 'Solde à payer')}
          </button>

          <button
            type="button"
            onClick={() => setBalanceFilter('clear')}
            className={`rounded-sm border-2 px-4 py-2 text-xs font-extrabold transition-all whitespace-nowrap ${
              balanceFilter === 'clear'
                ? 'border-sky-800 bg-emerald-50 text-emerald-950 ring-2 ring-emerald-500/30'
                : 'border-sky-600/75 bg-white text-slate-900 hover:bg-slate-50'
            }`}
          >
            {t(lang, 'حساب مصفى', 'Compte soldé')}
          </button>
        </div>

        {/* End (Left in RTL): طباعة | Pdf | Excel | + اضافة مورد جديد */}
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

          <button
            type="button"
            onClick={openNew}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-4 py-2 text-xs font-black text-slate-950 shadow-md hover:bg-amber-300 active:scale-[0.98] whitespace-nowrap"
          >
            <Plus className="h-4 w-4 stroke-[2.5]" />
            <span>{t(lang, 'اضافة مورد جديد', 'Nouveau fournisseur')}</span>
          </button>
        </div>
      </div>

      {/* Full-Bordered Ledger Table (Peach header & crisp grid lines tailored for Suppliers) */}
      <div className="rounded-lg border-2 border-slate-900 bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-[#F7C59F] text-slate-950 text-xs sm:text-sm">
                <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold">
                  {t(lang, 'المورد', 'Fournisseur')}
                </th>
                <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold">
                  {t(lang, 'الهاتف', 'Téléphone')}
                </th>
                <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold">
                  {t(lang, 'العنوان / الضريبة', 'Adresse / ICE')}
                </th>
                <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold">
                  {t(lang, 'سجل فواتير المشتريات', 'Factures achats')}
                </th>
                <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold">
                  {t(lang, 'المدفوعات', 'Paiements')}
                </th>
                <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold">
                  {t(lang, 'المتبقي للمورد', 'Reste dû')}
                </th>
                <th className="border border-slate-900 px-3 py-2.5 text-center font-extrabold">
                  {t(lang, 'إجراءات', 'Actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} className="hover:bg-orange-50/50 transition-colors">
                  <td className="border border-slate-800/80 px-3 py-2 font-bold text-slate-950">
                    <div>{s.businessName}</div>
                    {s.returns.length > 0 && (
                      <div className="text-[10px] font-semibold text-amber-800">
                        {t(lang, `مسترجعات: ${s.returns.length} (${s.totalReturns.toFixed(2)})`, `Retours : ${s.returns.length}`)}
                      </div>
                    )}
                  </td>
                  <td className="border border-slate-800/80 px-3 py-2 text-center font-mono text-xs text-slate-800">
                    {s.phone || '—'}
                  </td>
                  <td className="border border-slate-800/80 px-3 py-2 text-center text-xs text-slate-700">
                    <div className="truncate max-w-[190px] mx-auto">{s.address || '—'}</div>
                    {s.taxId && (
                      <div className="font-mono text-[10px] text-slate-500">ICE: {s.taxId}</div>
                    )}
                  </td>
                  <td className="border border-slate-800/80 px-3 py-2 text-center">
                    <button
                      type="button"
                      onClick={() => setStatementSupplierId(s.id!)}
                      className="inline-flex items-center justify-center gap-1.5 rounded border border-sky-300 bg-sky-50 px-2.5 py-1 text-xs font-bold text-sky-900 hover:bg-sky-100 transition-colors"
                    >
                      <FileText className="h-3.5 w-3.5 text-sky-700 shrink-0" />
                      <span className="font-mono tabular-nums">
                        {s.purchases.length} {t(lang, 'فاتورة', 'fact.')} ·{' '}
                        {s.totalPurchases.toFixed(2)}
                      </span>
                    </button>
                  </td>
                  <td className="border border-slate-800/80 px-3 py-2 text-center font-mono text-xs font-bold tabular-nums text-emerald-700">
                    {formatMoney(s.totalPaid, cur)}
                  </td>
                  <td className="border border-slate-800/80 px-3 py-2 text-center font-mono text-xs font-extrabold tabular-nums">
                    <span className={s.remaining > 0.01 ? 'text-red-700' : 'text-slate-600'}>
                      {formatMoney(s.remaining, cur)}
                    </span>
                    {(s.creditBalance ?? 0) > 0.01 && (
                      <div className="mt-0.5 text-[10px] font-bold text-teal-700">
                        {t(lang, 'رصيد لنا:', 'Avoir :')} {formatMoney(s.creditBalance!, cur)}
                      </div>
                    )}
                  </td>
                  <td className="border border-slate-800/80 px-2 py-1.5">
                    <div className="flex items-center justify-center gap-1">
                      <button
                        type="button"
                        onClick={() => setStatementSupplierId(s.id!)}
                        title={t(lang, 'كشف حساب المورد', 'Relevé fournisseur')}
                        className="rounded p-1.5 text-teal-700 hover:bg-teal-50"
                      >
                        <FileText className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          openPrint({
                            type: 'supplier_statement',
                            supplier: s,
                            purchases: s.purchases,
                            payments: s.payments,
                            returns: s.returns,
                          })
                        }
                        title={t(lang, 'طباعة كشف الحساب', 'Imprimer le relevé')}
                        className="rounded p-1.5 text-sky-700 hover:bg-sky-50"
                      >
                        <Printer className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => openEdit(s)}
                        title={t(lang, 'تعديل', 'Modifier')}
                        className="rounded p-1.5 text-amber-700 hover:bg-amber-50"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(s)}
                        title={t(lang, 'حذف', 'Supprimer')}
                        className="rounded p-1.5 text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}

              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="border border-slate-800/80 px-4 py-8 text-center text-sm font-semibold text-slate-500"
                  >
                    {t(lang, 'لا يوجد موردون مطابقون للبحث', 'Aucun fournisseur trouvé')}
                  </td>
                </tr>
              )}

              {/* Crisp empty ledger rows matching the blueprint sheet */}
              {Array.from({ length: emptyFillerCount }).map((_, idx) => (
                <tr key={`empty-sup-${idx}`} className="h-9">
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
                  {t(lang, `المجموع العام (${filtered.length} مورد)`, `Total général (${filtered.length} fournisseurs)`)}
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

      {/* Add/Edit Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900">
                {editing
                  ? t(lang, 'تعديل بيانات المورد', 'Modifier le fournisseur')
                  : t(lang, 'إضافة مورد جديد', 'Nouveau fournisseur')}
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
                  {t(lang, 'الاسم التجاري *', 'Raison sociale *')}
                </label>
                <input
                  required
                  value={form.businessName}
                  onChange={(e) => setForm({ ...form, businessName: e.target.value })}
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
                    {t(lang, 'الرقم الضريبي (ICE / IF)', 'Identifiant fiscal (ICE)')}
                  </label>
                  <input
                    value={form.taxId}
                    onChange={(e) => setForm({ ...form, taxId: e.target.value })}
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
                    {t(lang, `الرصيد الافتتاحي (${cur})`, `Solde d’ouverture (${cur})`)}
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
                  {t(lang, 'حفظ', 'Enregistrer')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Supplier Account Statement */}
      {statementSupplier && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 overflow-y-auto">
          <div className="w-full max-w-3xl rounded-xl border border-slate-200 bg-white p-6 shadow-xl my-6">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  {t(lang, 'كشف حساب المورد:', 'Relevé fournisseur :')} {statementSupplier.businessName}
                </h3>
                <p className="text-xs text-slate-500">
                  {statementSupplier.phone} · {statementSupplier.taxId || '—'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    openPrint({
                      type: 'supplier_statement',
                      supplier: statementSupplier,
                      purchases: statementSupplier.purchases,
                      payments: statementSupplier.payments,
                      returns: statementSupplier.returns,
                    })
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-sky-400"
                >
                  <Printer className="h-3.5 w-3.5" />
                  {t(lang, 'طباعة كشف الحساب', 'Imprimer')}
                </button>
                <button
                  type="button"
                  onClick={() => setStatementSupplierId(null)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs text-slate-500">{t(lang, 'المشتريات', 'Achats')}</div>
                <div className="mt-1 font-mono font-bold text-slate-900">
                  {formatMoney(statementSupplier.totalPurchases, cur)}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs text-slate-500">{t(lang, 'المدفوع', 'Payé')}</div>
                <div className="mt-1 font-mono font-bold text-emerald-700">
                  {formatMoney(statementSupplier.totalPaid, cur)}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs text-slate-500">{t(lang, 'مسترجعات المورد', 'Retours')}</div>
                <div className="mt-1 font-mono font-bold text-slate-700">
                  {formatMoney(statementSupplier.totalReturns, cur)}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs text-slate-500">{t(lang, 'المتبقي للمورد', 'Reste dû')}</div>
                <div className="mt-1 font-mono font-bold text-red-700">
                  {formatMoney(statementSupplier.remaining, cur)}
                </div>
              </div>
            </div>

            <div className="space-y-4 max-h-[55vh] overflow-y-auto">
              <div>
                <h4 className="text-xs font-semibold text-slate-700 mb-2">
                  {t(lang, 'سجل فواتير المشتريات', 'Factures d’achat')}
                </h4>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-[#F7C59F]/60 text-slate-900">
                      <th className="p-2 text-start">{t(lang, 'الرقم', 'N°')}</th>
                      <th className="p-2 text-start">{t(lang, 'التاريخ', 'Date')}</th>
                      <th className="p-2 text-end">{t(lang, 'الإجمالي', 'Total')}</th>
                      <th className="p-2 text-end">{t(lang, 'المدفوع', 'Payé')}</th>
                      <th className="p-2 text-end">{t(lang, 'المتبقي', 'Reste')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {statementSupplier.purchases.map((p) => (
                      <tr key={p.id}>
                        <td className="p-2 font-mono">{p.invoiceNumber}</td>
                        <td className="p-2">{formatDateTime(p.date, lang)}</td>
                        <td className="p-2 text-end font-mono">{p.total.toFixed(2)}</td>
                        <td className="p-2 text-end font-mono text-emerald-700">{p.paidAmount.toFixed(2)}</td>
                        <td className="p-2 text-end font-mono text-red-700">{p.remainingAmount.toFixed(2)}</td>
                      </tr>
                    ))}
                    {statementSupplier.purchases.length === 0 && (
                      <tr>
                        <td colSpan={5} className="p-4 text-center text-slate-400">
                          {t(lang, 'لا توجد فواتير مشتريات', 'Aucun achat')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-slate-700 mb-2">
                  {t(lang, 'سجل الدفعات والمسترجعات', 'Paiements et retours fournisseur')}
                </h4>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-[#F7C59F]/60 text-slate-900">
                      <th className="p-2 text-start">{t(lang, 'المرجع', 'Réf')}</th>
                      <th className="p-2 text-start">{t(lang, 'التاريخ', 'Date')}</th>
                      <th className="p-2 text-start">{t(lang, 'التفاصيل', 'Détails')}</th>
                      <th className="p-2 text-end">{t(lang, 'المبلغ', 'Montant')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {statementSupplier.payments.map((p) => (
                      <tr key={p.id}>
                        <td className="p-2 font-mono">#{p.refNumber}</td>
                        <td className="p-2">{formatDateTime(p.date, lang)}</td>
                        <td className="p-2 font-mono">{p.purchaseNumbers.join(', ') || '—'}</td>
                        <td className="p-2 text-end font-mono text-emerald-700">
                          {formatMoney(p.amount, cur)}
                        </td>
                      </tr>
                    ))}
                    {statementSupplier.returns.map((r) => (
                      <tr key={`sr-${r.id}`}>
                        <td className="p-2 font-mono text-amber-700">{r.returnNumber}</td>
                        <td className="p-2">{formatDateTime(r.date, lang)}</td>
                        <td className="p-2">
                          {t(lang, 'إرجاع للمورد', 'Retour')} ({r.purchaseInvoiceNumber})
                        </td>
                        <td className="p-2 text-end font-mono text-amber-700">
                          -{formatMoney(r.totalAmount, cur)}
                        </td>
                      </tr>
                    ))}
                    {statementSupplier.payments.length === 0 &&
                      statementSupplier.returns.length === 0 && (
                        <tr>
                          <td colSpan={4} className="p-4 text-center text-slate-400">
                            {t(lang, 'لا توجد دفعات أو مسترجعات', 'Aucun paiement ou retour')}
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
