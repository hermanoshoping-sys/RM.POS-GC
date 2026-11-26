import React, { useState } from 'react';
import { CheckCircle2, Database, ShieldCheck, Store, UserCheck } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { completeFirstRunSetup } from '../db/database';
import { t } from '../i18n/translations';

export const FirstRunWizard: React.FC = () => {
  const {
    lang,
    setLang,
    setCurrentUser,
    setIsLocked,
    setNeedsFirstRunSetup,
    setSessionBackupPassphrase,
    notify,
  } = useApp();

  const [storeName, setStoreName] = useState('RM.POS GC');
  const [currency, setCurrency] = useState('د.م');
  const [fullName, setFullName] = useState('مدير المتجر');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [includeDemoData, setIncludeDemoData] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const cleanUser = username.trim();
    if (cleanUser.length < 3) {
      setError(
        t(
          lang,
          'اسم المستخدم يجب أن يحتوي على 3 أحرف على الأقل',
          'Le nom d’utilisateur doit contenir au moins 3 caractères'
        )
      );
      return;
    }
    if (/\s/.test(cleanUser)) {
      setError(
        t(
          lang,
          'اسم المستخدم لا يجب أن يحتوي على مسافات',
          'Le nom d’utilisateur ne doit pas contenir d’espaces'
        )
      );
      return;
    }
    if (password.length < 6) {
      setError(
        t(
          lang,
          'يجب تعيين كلمة سر للمدير لا تقل عن 6 أحرف',
          'Le mot de passe administrateur doit contenir au moins 6 caractères'
        )
      );
      return;
    }
    if (password !== confirmPassword) {
      setError(
        t(
          lang,
          'كلمتا السر غير متطابقتين',
          'Les deux mots de passe ne correspondent pas'
        )
      );
      return;
    }

    setSubmitting(true);
    try {
      const admin = await completeFirstRunSetup({
        adminUsername: cleanUser,
        adminFullName: fullName.trim() || 'مدير المتجر',
        adminPassword: password,
        storeName: storeName.trim() || 'RM.POS GC',
        currency: currency.trim() || 'د.م',
        defaultLanguage: lang,
        loadDemoData: includeDemoData,
      });
      setSessionBackupPassphrase(password);
      setCurrentUser(admin);
      setNeedsFirstRunSetup(false);
      setIsLocked(false);
      setPassword('');
      setConfirmPassword('');
      notify(
        t(
          lang,
          `تم إعداد حساب المدير "${admin.fullName}" بنجاح`,
          `Compte administrateur « ${admin.fullName} » configuré avec succès`
        )
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-br from-[#041022] via-[#0B274D] to-[#041022] p-3 sm:p-6 overflow-y-auto">
      <div className="my-auto w-full max-w-lg rounded-2xl border border-[#D9A738]/40 bg-white p-5 sm:p-7 shadow-2xl">
        {/* Top brand & language bar */}
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-4">
          <div className="flex items-center gap-3">
            <img
              src="/assets/aistudio/image_39bba8ff.png"
              alt="RM.POS GC"
              className="h-12 w-12 rounded-xl object-contain shadow-sm"
            />
            <div>
              <div dir="ltr" className="text-lg font-black tracking-wide text-[#0B274D]">
                RM.POS GC
              </div>
              <p className="text-xs font-semibold text-slate-600">
                {t(lang, 'معالج التشغيل الأول — تهيئة حساب المدير', 'Assistant de premier démarrage — Compte administrateur')}
              </p>
            </div>
          </div>

          <div className="flex items-center rounded-lg border border-slate-200 bg-slate-100 p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setLang('ar')}
              className={`rounded-md px-2.5 py-1 font-bold transition-colors ${
                lang === 'ar' ? 'bg-[#0B274D] text-[#FDE68A]' : 'text-slate-600'
              }`}
            >
              AR
            </button>
            <button
              type="button"
              onClick={() => setLang('fr')}
              className={`rounded-md px-2.5 py-1 font-bold transition-colors ${
                lang === 'fr' ? 'bg-[#0B274D] text-[#FDE68A]' : 'text-slate-600'
              }`}
            >
              FR
            </button>
          </div>
        </div>

        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-teal-200 bg-teal-50/70 p-3 text-xs text-teal-900">
          <ShieldCheck className="h-4 w-4 text-teal-700 shrink-0 mt-0.5" />
          <p className="leading-relaxed">
            {t(
              lang,
              'لأمان متجرك، لا توجد حسابات جاهزة مسبقاً. أنشئ الآن حساب المدير وكلمة سر قوية لبدء استخدام النظام وتشفير النسخ الاحتياطية.',
              'Pour la sécurité de votre magasin, aucun compte par défaut n’est pré-créé. Créez votre compte administrateur et un mot de passe fort.'
            )}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3.5">
          {/* Store info */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 mb-1">
                <Store className="h-3.5 w-3.5 text-[#2563A6]" />
                {t(lang, 'اسم المتجر / السوبر مارشي', 'Nom du magasin')}
              </label>
              <input
                type="text"
                required
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                {t(lang, 'العملة', 'Devise')}
              </label>
              <input
                type="text"
                required
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
              />
            </div>
          </div>

          {/* Admin credentials */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 mb-1">
                <UserCheck className="h-3.5 w-3.5 text-[#2563A6]" />
                {t(lang, 'الاسم الكامل للمدير', 'Nom complet (Admin)')}
              </label>
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                {t(lang, 'اسم المستخدم للدخول', 'Identifiant de connexion')}
              </label>
              <input
                type="text"
                required
                minLength={3}
                dir="ltr"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                {t(lang, 'كلمة سر المدير (6 أحرف على الأقل)', 'Mot de passe (min. 6 car.)')}
              </label>
              <input
                type="password"
                required
                minLength={6}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                {t(lang, 'تأكيد كلمة السر', 'Confirmer le mot de passe')}
              </label>
              <input
                type="password"
                required
                minLength={6}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
              />
            </div>
          </div>

          {/* Optional Demo Data checkbox */}
          <label className="flex items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3 cursor-pointer hover:bg-slate-100/80 transition-colors">
            <input
              type="checkbox"
              checked={includeDemoData}
              onChange={(e) => setIncludeDemoData(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-700 focus:ring-teal-600"
            />
            <div className="text-xs">
              <div className="flex items-center gap-1.5 font-bold text-slate-800">
                <Database className="h-3.5 w-3.5 text-amber-600" />
                {t(lang, 'إضافة بيانات تجريبية اختيارية', 'Ajouter des données de démonstration (optionnel)')}
              </div>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {t(
                  lang,
                  'إدراج منتجات وعائلات وزبناء وموردين للتجربة (اتركه غير مفعّل للبدء بقاعدة بيانات فارغة للعمل الفعلي).',
                  'Insérer des produits, familles, clients et fournisseurs d’exemple (laisser décoché pour démarrer à vide).'
                )}
              </p>
            </div>
          </label>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#0B274D] px-4 py-3 text-sm font-bold text-[#FDE68A] shadow-md hover:bg-[#163d73] transition-colors disabled:opacity-50"
          >
            <CheckCircle2 className="h-4 w-4" />
            {submitting
              ? t(lang, 'جاري تهيئة النظام...', 'Initialisation en cours...')
              : t(lang, 'إنشاء حساب المدير وبدء العمل', 'Créer le compte administrateur et démarrer')}
          </button>
        </form>
      </div>
    </div>
  );
};
