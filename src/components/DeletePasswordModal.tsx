import React, { useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { t } from '../i18n/translations';

export const DeletePasswordModal: React.FC = () => {
  const { guardRequest, closeGuard, verifyDeletePassword, lang, notify } = useApp();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (!guardRequest) return null;

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (guardRequest.requirePassword) {
        const valid = await verifyDeletePassword(password);
        if (!valid) {
          setError(t(lang, 'كلمة سر الحذف غير صحيحة', 'Mot de passe de suppression incorrect'));
          setLoading(false);
          return;
        }
      }
      await guardRequest.onConfirm();
      setPassword('');
      closeGuard();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="no-print fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-50 text-red-700">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <h3 className="text-base font-semibold text-slate-900">{guardRequest.title}</h3>
          </div>
          <button
            type="button"
            onClick={() => {
              setPassword('');
              setError('');
              closeGuard();
            }}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-3 text-sm text-slate-600 leading-relaxed">{guardRequest.description}</p>

        <form onSubmit={handleConfirm} className="mt-4 space-y-4">
          {guardRequest.requirePassword && (
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                {t(lang, 'أدخل كلمة سر الحذف للتأكيد', 'Saisir le mot de passe de suppression')}
              </label>
              <input
                type="password"
                autoFocus
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
              />
              {error && <p className="mt-1.5 text-xs font-medium text-red-600">{error}</p>}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => {
                setPassword('');
                setError('');
                closeGuard();
              }}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              {t(lang, 'إلغاء', 'Annuler')}
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {loading ? t(lang, 'جاري التحقق...', 'Vérification...') : t(lang, 'تأكيد العملية', 'Confirmer')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
