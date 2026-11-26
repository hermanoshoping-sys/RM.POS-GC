import React, { useEffect, useState } from 'react';
import { Calculator, CheckCircle2, Lock, PlayCircle, RefreshCw, X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  CashSessionSummary,
  closeCashSession,
  computeCashSessionSummary,
  openCashSession,
  round2,
} from '../db/operations';
import { CashSession } from '../types';
import { formatDateTime, formatMoney, t } from '../i18n/translations';

interface CashSessionModalProps {
  open: boolean;
  activeSession: CashSession | undefined;
  onClose: () => void;
}

export const CashSessionModal: React.FC<CashSessionModalProps> = ({
  open,
  activeSession,
  onClose,
}) => {
  const { lang, settings, currentUser, notify } = useApp();
  const cur = settings.storeInfo.currency || 'MAD';

  const [openingBalance, setOpeningBalance] = useState('0');
  const [countedCash, setCountedCash] = useState('');
  const [notes, setNotes] = useState('');
  const [summary, setSummary] = useState<CashSessionSummary | null>(null);
  const [loading, setLoading] = useState(false);

  const loadSummary = async () => {
    if (!activeSession) {
      setSummary(null);
      return;
    }
    const res = await computeCashSessionSummary(
      activeSession.openedAt,
      new Date().toISOString(),
      activeSession.openingBalance
    );
    setSummary(res);
  };

  useEffect(() => {
    if (!open) return;
    setNotes('');
    if (activeSession) {
      setCountedCash('');
      loadSummary();
    } else {
      setOpeningBalance('0');
      setSummary(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeSession?.id]);

  if (!open) return null;

  const countedNum = countedCash.trim() === '' ? null : Number(countedCash);
  const liveVariance =
    summary && countedNum !== null && !Number.isNaN(countedNum)
      ? round2(countedNum - summary.expectedCash)
      : null;

  const handleOpenShift = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    setLoading(true);
    try {
      await openCashSession(Math.max(0, Number(openingBalance) || 0), currentUser, notes);
      notify(t(lang, 'تم فتح وردية الصندوق بنجاح', 'Session de caisse ouverte avec succès'));
      onClose();
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleCloseShift = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser || !activeSession?.id) return;
    if (countedCash.trim() === '' || Number.isNaN(Number(countedCash))) {
      notify(t(lang, 'أدخل مبلغ النقد المعدود في الصندوق', 'Saisissez le montant compté en caisse'), 'warning');
      return;
    }
    setLoading(true);
    try {
      const closed = await closeCashSession(
        activeSession.id,
        Math.max(0, Number(countedCash)),
        currentUser,
        notes
      );
      const diff = closed.variance ?? 0;
      notify(
        t(
          lang,
          `تم إغلاق الوردية #${closed.id} — الفارق: ${diff >= 0 ? '+' : ''}${diff.toFixed(2)} ${cur}`,
          `Session #${closed.id} clôturée — Écart : ${diff >= 0 ? '+' : ''}${diff.toFixed(2)} ${cur}`
        ),
        Math.abs(diff) > 0.01 ? 'warning' : 'success'
      );
      onClose();
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="no-print fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-3 sm:p-4 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="my-auto w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between bg-[#0B274D] px-5 py-3.5 text-white">
          <div className="flex items-center gap-2">
            <Calculator className="h-5 w-5 text-[#FDE68A]" />
            <div>
              <h3 className="text-sm font-extrabold">
                {activeSession
                  ? t(lang, `إغلاق وجرد الوردية #${activeSession.id}`, `Clôture & comptage session #${activeSession.id}`)
                  : t(lang, 'فتح وردية صندوق جديدة', 'Ouvrir une nouvelle session de caisse')}
              </h3>
              {activeSession && (
                <p className="text-[11px] text-blue-200">
                  {t(lang, 'فُتحت في:', 'Ouverte le :')} {formatDateTime(activeSession.openedAt, lang)} —{' '}
                  {activeSession.openedByUserName}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-blue-100 hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        {!activeSession ? (
          <form onSubmit={handleOpenShift} className="p-5 space-y-4">
            <p className="text-xs text-slate-600 leading-relaxed">
              {t(
                lang,
                'أدخل رصيد الافتتاح النقدي الموجود حالياً في درج الصندوق لبدء تتبع حركات النقدية وحساب الفارق عند الإغلاق.',
                'Saisissez le fond de caisse initial pour suivre tous les flux espèces et calculer l’écart à la clôture.'
              )}
            </p>
            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1">
                {t(lang, `رصيد الافتتاح (${cur})`, `Fond de caisse initial (${cur})`)}
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                autoFocus
                value={openingBalance}
                onChange={(e) => setOpeningBalance(e.target.value)}
                className="w-full rounded-lg border-2 border-slate-300 px-3 py-2.5 text-base font-mono font-bold text-slate-900 focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                {t(lang, 'ملاحظة (اختياري)', 'Note (optionnel)')}
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t(lang, 'مثال: وردية الصباح', 'Ex: Équipe du matin')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-teal-600 focus:outline-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
              >
                {t(lang, 'إلغاء', 'Annuler')}
              </button>
              <button
                type="submit"
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-5 py-2 text-xs font-extrabold text-white hover:bg-emerald-800 disabled:opacity-50"
              >
                <PlayCircle className="h-4 w-4" />
                {t(lang, 'فتح الوردية الآن', 'Ouvrir la session')}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleCloseShift} className="p-5 space-y-4">
            {/* Breakdown Table */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-2 text-xs">
              <div className="flex items-center justify-between pb-1.5 border-b border-slate-200">
                <span className="font-extrabold text-slate-900">
                  {t(lang, 'حساب النقد المتوقع بالصندوق', 'Calcul du solde espèces attendu')}
                </span>
                <button
                  type="button"
                  onClick={loadSummary}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-teal-700 hover:underline"
                >
                  <RefreshCw className="h-3 w-3" />
                  {t(lang, 'تحديث', 'Actualiser')}
                </button>
              </div>

              {summary && (
                <div className="space-y-1.5 font-mono tabular-nums">
                  <div className="flex justify-between text-slate-700">
                    <span className="font-sans font-semibold">{t(lang, 'رصيد الافتتاح', 'Fond d’ouverture')}</span>
                    <span className="font-bold">{formatMoney(summary.openingBalance, cur)}</span>
                  </div>
                  <div className="flex justify-between text-emerald-700">
                    <span className="font-sans font-semibold">+ {t(lang, 'مبيعات نقدية', 'Ventes espèces')}</span>
                    <span className="font-bold">+{formatMoney(summary.cashSales, cur)}</span>
                  </div>
                  <div className="flex justify-between text-emerald-700">
                    <span className="font-sans font-semibold">+ {t(lang, 'تحصيلات نقدية (ديون/أقساط)', 'Encaissements espèces')}</span>
                    <span className="font-bold">+{formatMoney(summary.cashCollections, cur)}</span>
                  </div>
                  <div className="flex justify-between text-red-700">
                    <span className="font-sans font-semibold">− {t(lang, 'استردادات نقدية (مرتجعات)', 'Remboursements espèces')}</span>
                    <span className="font-bold">-{formatMoney(summary.cashRefunds, cur)}</span>
                  </div>
                  <div className="flex justify-between text-red-700">
                    <span className="font-sans font-semibold">− {t(lang, 'مصاريف نقدية', 'Dépenses espèces')}</span>
                    <span className="font-bold">-{formatMoney(summary.cashExpenses, cur)}</span>
                  </div>
                  <div className="flex justify-between text-red-700">
                    <span className="font-sans font-semibold">− {t(lang, 'دفعات موردين نقدية', 'Paiements fournisseurs espèces')}</span>
                    <span className="font-bold">-{formatMoney(summary.cashSupplierPayments, cur)}</span>
                  </div>

                  <div className="flex justify-between pt-2 border-t border-slate-300 text-sm text-[#0B274D]">
                    <span className="font-sans font-black">{t(lang, 'النقد المتوقع', 'Espèces attendues')}</span>
                    <span className="font-black">{formatMoney(summary.expectedCash, cur)}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Counted Cash Input */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1">
                  {t(lang, `النقد المعدود فعلياً (${cur}) *`, `Espèces comptées (${cur}) *`)}
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  autoFocus
                  value={countedCash}
                  onChange={(e) => setCountedCash(e.target.value)}
                  placeholder={summary ? summary.expectedCash.toFixed(2) : '0.00'}
                  className="w-full rounded-lg border-2 border-slate-900 px-3 py-2 text-base font-mono font-black text-slate-950 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div className="flex flex-col justify-center rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <span className="text-[11px] font-semibold text-slate-600">
                  {t(lang, 'الفارق (المعدود − المتوقع)', 'Écart (Compté − Attendu)')}
                </span>
                <span
                  className={`font-mono text-lg font-black tabular-nums ${
                    liveVariance === null
                      ? 'text-slate-400'
                      : Math.abs(liveVariance) < 0.01
                        ? 'text-emerald-700'
                        : liveVariance > 0
                          ? 'text-blue-700'
                          : 'text-red-700'
                  }`}
                >
                  {liveVariance === null
                    ? '—'
                    : `${liveVariance >= 0 ? '+' : ''}${formatMoney(liveVariance, cur)}`}
                </span>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                {t(lang, 'ملاحظات الجرد والإغلاق', 'Notes de clôture')}
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t(lang, 'سبب الفارق إن وجد أو ملاحظات تسليم الوردية', 'Motif d’écart éventuel ou remarques')}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-teal-600 focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
              >
                {t(lang, 'إلغاء', 'Annuler')}
              </button>
              <button
                type="submit"
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B274D] px-5 py-2 text-xs font-extrabold text-[#FDE68A] hover:bg-[#163d73] disabled:opacity-50"
              >
                {liveVariance !== null && Math.abs(liveVariance) < 0.01 ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <Lock className="h-4 w-4" />
                )}
                {t(lang, 'تأكيد جرد وإغلاق الوردية', 'Confirmer la clôture')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
