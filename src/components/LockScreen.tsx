import React, { useEffect, useState } from 'react';
import {
  Building2,
  Check,
  Copy,
  KeyRound,
  LogIn,
  Mail,
  Phone,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { db } from '../db/database';
import { authenticateAccountUser, registerNewAccount } from '../db/accountsDb';
import {
  generateLicensePair,
  normalizeActivationCode,
  normalizeLicenseNumber,
} from '../utils/license';
import { t } from '../i18n/translations';

const THROTTLE_STORAGE_KEY = 'rmpos_login_throttle_v1';

interface LoginThrottleState {
  attempts: number;
  lockedUntil: number;
}

function readThrottleState(): LoginThrottleState {
  try {
    const raw = window.localStorage.getItem(THROTTLE_STORAGE_KEY);
    if (!raw) return { attempts: 0, lockedUntil: 0 };
    const parsed = JSON.parse(raw) as Partial<LoginThrottleState>;
    const lockedUntil = Number(parsed.lockedUntil) || 0;
    const attempts = Number(parsed.attempts) || 0;
    if (lockedUntil > 0 && Date.now() >= lockedUntil) {
      window.localStorage.removeItem(THROTTLE_STORAGE_KEY);
      return { attempts: 0, lockedUntil: 0 };
    }
    return { attempts, lockedUntil };
  } catch {
    return { attempts: 0, lockedUntil: 0 };
  }
}

function writeThrottleState(state: LoginThrottleState): void {
  try {
    if (state.attempts === 0 && state.lockedUntil === 0) {
      window.localStorage.removeItem(THROTTLE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THROTTLE_STORAGE_KEY, JSON.stringify(state));
    }
  } catch {
    // Ignore storage quota issues
  }
}

export const LockScreen: React.FC = () => {
  const {
    lang,
    setLang,
    settings,
    accounts,
    activeAccount,
    authPortalMode,
    setAuthPortalMode,
    activateAccountSession,
    signOutAccount,
    notify,
  } = useApp();

  const [mode, setMode] = useState<'login' | 'register'>(
    accounts.length === 0 ? 'register' : authPortalMode
  );

  // Sync mode when context asks for register/login explicitly
  useEffect(() => {
    if (accounts.length === 0) {
      setMode('register');
    } else {
      setMode(authPortalMode);
    }
  }, [authPortalMode, accounts.length]);

  // Login Form State
  const [identifier, setIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState<string>(
    activeAccount?.accountId ?? ''
  );
  const [throttle, setThrottle] = useState<LoginThrottleState>(() => readThrottleState());
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  useEffect(() => {
    setSelectedAccountId(activeAccount?.accountId ?? '');
  }, [activeAccount?.accountId]);

  // Registration Form State
  const [storeName, setStoreName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirmPassword, setRegConfirmPassword] = useState('');
  const [licenseNumber, setLicenseNumber] = useState('');
  const [activationCode, setActivationCode] = useState('');
  const [currency, setCurrency] = useState('د.م');
  const [loadDemoData, setLoadDemoData] = useState(false);
  const [regError, setRegError] = useState('');
  const [regLoading, setRegLoading] = useState(false);
  const [copiedLicense, setCopiedLicense] = useState(false);

  const remainingLockSecs = Math.max(0, Math.ceil((throttle.lockedUntil - nowTs) / 1000));

  useEffect(() => {
    if (throttle.lockedUntil <= Date.now()) return;
    const timer = window.setInterval(() => {
      const curr = Date.now();
      setNowTs(curr);
      if (curr >= throttle.lockedUntil) {
        const cleared = { attempts: 0, lockedUntil: 0 };
        writeThrottleState(cleared);
        setThrottle(cleared);
        setLoginError('');
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [throttle.lockedUntil]);

  const recordFailure = async (idLabel: string, currentThrottle: LoginThrottleState) => {
    const nextAttempts = currentThrottle.attempts + 1;
    const max = Math.max(2, settings.security.maxLoginAttempts || 5);
    let nextLockedUntil = 0;

    if (nextAttempts >= max) {
      nextLockedUntil = Date.now() + 60_000;
    }

    const nextState: LoginThrottleState = {
      attempts: nextAttempts,
      lockedUntil: nextLockedUntil,
    };
    writeThrottleState(nextState);
    setThrottle(nextState);
    setNowTs(Date.now());

    if (activeAccount) {
      try {
        await db.loginLogs.add({
          date: new Date().toISOString(),
          username: idLabel || 'unknown',
          status: nextAttempts >= max ? 'locked' : 'failed',
          details: `فشل تسجيل الدخول (المحاولة ${nextAttempts}/${max})`,
        });
      } catch {
        // Ignore if active tenant DB is not open
      }
    }

    if (nextAttempts >= max) {
      setLoginError(
        t(
          lang,
          'تجاوزت الحد الأقصى لمحاولات الدخول. تم القفل لمدة 60 ثانية.',
          'Nombre maximal de tentatives atteint. Verrouillage pendant 60 secondes.'
        )
      );
    } else {
      setLoginError(
        t(
          lang,
          `بيانات الدخول غير صحيحة (${nextAttempts}/${max})`,
          `Identifiants incorrects (${nextAttempts}/${max})`
        )
      );
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');

    const freshThrottle = readThrottleState();
    setThrottle(freshThrottle);
    if (Date.now() < freshThrottle.lockedUntil) {
      const secs = Math.ceil((freshThrottle.lockedUntil - Date.now()) / 1000);
      setLoginError(
        t(
          lang,
          `تم قفل المحاولات مؤقتاً — انتظر ${secs} ثانية`,
          `Accès bloqué temporairement — patientez ${secs}s`
        )
      );
      return;
    }

    setLoginLoading(true);
    try {
      const { account, user } = await authenticateAccountUser({
        identifier: identifier.trim(),
        password: loginPassword,
        preferredAccountId: selectedAccountId || null,
      });

      const cleared = { attempts: 0, lockedUntil: 0 };
      writeThrottleState(cleared);
      setThrottle(cleared);

      const passForMemory = loginPassword;
      setLoginPassword('');
      await activateAccountSession(account, user, passForMemory);
      notify(
        t(
          lang,
          `مرحباً ${user.fullName} — ${account.storeName}`,
          `Bienvenue ${user.fullName} — ${account.storeName}`
        )
      );
    } catch {
      await recordFailure(identifier.trim(), freshThrottle);
    } finally {
      setLoginLoading(false);
    }
  };

  const handleGenerateLicense = async () => {
    const pair = await generateLicensePair();
    setLicenseNumber(pair.licenseNumber);
    setActivationCode(pair.activationCode);
    setRegError('');
    setCopiedLicense(false);
  };

  const handleCopyLicensePair = async () => {
    if (!licenseNumber || !activationCode) return;
    try {
      await navigator.clipboard.writeText(
        `RM.POS GC\nLicense: ${normalizeLicenseNumber(licenseNumber)}\nActivation: ${normalizeActivationCode(activationCode)}`
      );
      setCopiedLicense(true);
      window.setTimeout(() => setCopiedLicense(false), 2000);
    } catch {
      // Ignore clipboard permission denial
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegError('');

    if (regPassword.length < 6) {
      setRegError(
        t(
          lang,
          'كلمة السر يجب أن تتكون من 6 أحرف على الأقل',
          'Le mot de passe doit contenir au moins 6 caractères'
        )
      );
      return;
    }
    if (regPassword !== regConfirmPassword) {
      setRegError(
        t(lang, 'كلمتا السر غير متطابقتين', 'Les deux mots de passe ne correspondent pas')
      );
      return;
    }

    setRegLoading(true);
    try {
      const { account, adminUser } = await registerNewAccount({
        storeName,
        ownerName,
        email: regEmail,
        phone: regPhone,
        password: regPassword,
        licenseNumber,
        activationCode,
        currency,
        defaultLanguage: lang,
        loadDemoData,
      });

      const passForMemory = regPassword;
      setRegPassword('');
      setRegConfirmPassword('');
      await activateAccountSession(account, adminUser, passForMemory);
      notify(
        t(
          lang,
          `تم تفعيل الرخصة ${account.licenseNumber} وإنشاء الحساب المستقل "${account.storeName}" بنجاح`,
          `Licence ${account.licenseNumber} activée et compte « ${account.storeName} » créé`
        )
      );
    } catch (err) {
      setRegError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-br from-[#041022] via-[#0B274D] to-[#041022] p-3 sm:p-4 overflow-y-auto">
      <div
        className={`my-auto w-full ${
          mode === 'register' ? 'max-w-2xl' : 'max-w-md'
        } rounded-2xl border-2 border-[#D9A738]/70 bg-white shadow-2xl overflow-hidden transition-all`}
      >
        {/* Top Navy & Gold Brand Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 bg-gradient-to-r from-[#041022] via-[#0B274D] to-[#041022] px-5 py-4 text-white border-b-2 border-[#D9A738]">
          <div className="flex items-center gap-3">
            <img
              src="/assets/aistudio/image_39bba8ff.png"
              alt="RM.POS GC"
              className="h-12 w-12 rounded-xl bg-white/10 p-1 object-contain shadow-sm"
            />
            <div>
              <div dir="ltr" className="text-lg font-black tracking-wide text-[#FDE68A]">
                RM.POS GC
              </div>
              <p className="text-[11px] text-blue-100">
                {mode === 'register'
                  ? t(
                      lang,
                      'إنشاء حساب متجر مستقل وتفعيل الرخصة',
                      'Créer un compte magasin indépendant & activer la licence'
                    )
                  : activeAccount
                    ? `${activeAccount.storeName} · ${activeAccount.licenseNumber}`
                    : t(
                        lang,
                        'تسجيل الدخول بالبريد الإلكتروني أو رقم الهاتف',
                        'Connexion par e-mail ou numéro de téléphone'
                      )}
              </p>
            </div>
          </div>

          <div className="flex items-center rounded-lg border border-white/20 bg-white/10 p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setLang('ar')}
              className={`rounded-md px-2.5 py-1 font-bold ${
                lang === 'ar' ? 'bg-[#F2B83B] text-slate-950' : 'text-blue-100 hover:text-white'
              }`}
            >
              AR
            </button>
            <button
              type="button"
              onClick={() => setLang('fr')}
              className={`rounded-md px-2.5 py-1 font-bold ${
                lang === 'fr' ? 'bg-[#F2B83B] text-slate-950' : 'text-blue-100 hover:text-white'
              }`}
            >
              FR
            </button>
          </div>
        </div>

        {/* Mode Switcher Tabs: Sign In vs Create Independent Account */}
        <div className="grid grid-cols-2 border-b border-slate-200 bg-slate-50 p-1.5 gap-1.5">
          <button
            type="button"
            disabled={accounts.length === 0}
            onClick={() => {
              setMode('login');
              setAuthPortalMode('login');
              setLoginError('');
            }}
            className={`inline-flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-extrabold transition-all ${
              mode === 'login'
                ? 'bg-[#0B274D] text-[#FDE68A] shadow-sm'
                : 'text-slate-700 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed'
            }`}
          >
            <LogIn className="h-4 w-4" />
            <span>{t(lang, 'تسجيل الدخول', 'Se connecter')}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('register');
              setAuthPortalMode('register');
              setRegError('');
            }}
            className={`inline-flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-extrabold transition-all ${
              mode === 'register'
                ? 'bg-[#0B274D] text-[#FDE68A] shadow-sm'
                : 'text-slate-700 hover:bg-white'
            }`}
          >
            <UserPlus className="h-4 w-4" />
            <span>{t(lang, 'إنشاء حساب جديد (برخصة)', 'Créer un compte (Licence)')}</span>
          </button>
        </div>

        {/* SIGN IN VIEW */}
        {mode === 'login' ? (
          <form onSubmit={handleLogin} className="p-5 sm:p-6 space-y-4">
            {/* Active locked account badge OR multi-account selector */}
            {activeAccount ? (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs">
                <div className="min-w-0">
                  <div className="font-bold text-slate-900 truncate flex items-center gap-1.5">
                    <Building2 className="h-3.5 w-3.5 text-[#0B274D] shrink-0" />
                    <span className="truncate">{activeAccount.storeName}</span>
                  </div>
                  <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                    {t(lang, 'الرخصة:', 'Licence :')} {activeAccount.licenseNumber}
                  </div>
                </div>
                {accounts.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      signOutAccount('login');
                      setSelectedAccountId('');
                    }}
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-bold text-[#0B274D] hover:bg-amber-50 shrink-0"
                  >
                    {t(lang, 'تبديل الحساب', 'Changer')}
                  </button>
                )}
              </div>
            ) : accounts.length > 1 ? (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {t(lang, 'الحساب / المتجر (اختياري)', 'Compte / Magasin (optionnel)')}
                </label>
                <select
                  value={selectedAccountId}
                  onChange={(e) => setSelectedAccountId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 focus:border-teal-600 focus:outline-none"
                >
                  <option value="">
                    {t(
                      lang,
                      'تحديد تلقائي عبر البريد الإلكتروني أو رقم الهاتف',
                      'Détection automatique par e-mail ou téléphone'
                    )}
                  </option>
                  {accounts.map((acc) => (
                    <option key={acc.accountId} value={acc.accountId}>
                      {acc.storeName} ({acc.licenseNumber})
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                {t(
                  lang,
                  'البريد الإلكتروني أو رقم الهاتف (أو اسم المستخدم)',
                  'E-mail, numéro de téléphone (ou identifiant)'
                )}
              </label>
              <input
                type="text"
                required
                autoFocus
                autoComplete="username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder={t(
                  lang,
                  'example@mail.com أو 0612345678 أو username',
                  'example@mail.com, 0612345678 ou identifiant'
                )}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                {t(lang, 'كلمة السر', 'Mot de passe')}
              </label>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
              />
            </div>

            {remainingLockSecs > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                <ShieldAlert className="h-4 w-4 shrink-0" />
                <span>
                  {t(
                    lang,
                    `القفل المؤقت فعّال — الوقت المتبقي: ${remainingLockSecs} ثانية`,
                    `Blocage temporaire actif — ${remainingLockSecs}s restantes`
                  )}
                </span>
              </div>
            )}

            {loginError && remainingLockSecs === 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
                {loginError}
              </div>
            )}

            <button
              type="submit"
              disabled={loginLoading || remainingLockSecs > 0}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-teal-800 transition-colors disabled:opacity-50"
            >
              <LogIn className="h-4 w-4" />
              {loginLoading
                ? t(lang, 'جاري التحقق وفتح الحساب...', 'Vérification en cours...')
                : t(lang, 'تسجيل الدخول', 'Se connecter')}
            </button>

            <p className="text-center text-[11px] leading-relaxed text-slate-500">
              {t(
                lang,
                'كل حساب متجر معزول بالكامل ببياناته ومخزونه ومستخدميه (البائعين والمسيرين).',
                'Chaque compte magasin dispose de sa propre base isolée et de ses propres utilisateurs.'
              )}
            </p>
          </form>
        ) : (
          /* CREATE INDEPENDENT ACCOUNT + LICENSE ACTIVATION VIEW */
          <form onSubmit={handleRegister} className="p-5 sm:p-6 space-y-4">
            <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-3 text-xs text-slate-800 flex items-start gap-2.5">
              <ShieldCheck className="h-5 w-5 text-[#0B274D] shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                {t(
                  lang,
                  'سيتم إنشاء قاعدة بيانات مستقلة تماماً لهذا الحساب وربطها برقم الرخصة ورقم التفعيل، مع إمكانية إضافة مستخدمين (بائعين ومسيرين) بصلاحيات خاصة داخل الحساب.',
                  'Une base de données totalement isolée sera créée pour ce compte, liée à sa licence et son code d’activation, avec gestion complète des utilisateurs internes.'
                )}
              </p>
            </div>

            {/* Store & Owner */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1">
                  {t(lang, 'اسم المتجر / الحساب *', 'Nom du magasin / compte *')}
                </label>
                <input
                  type="text"
                  required
                  value={storeName}
                  onChange={(e) => setStoreName(e.target.value)}
                  placeholder={t(lang, 'مثال: سوبر مارشي الأطلس', 'Ex: Supermarché Atlas')}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1">
                  {t(lang, 'الاسم الكامل لصاحب الحساب / المدير *', 'Nom complet du gérant / admin *')}
                </label>
                <input
                  type="text"
                  required
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                  placeholder={t(lang, 'الاسم الكامل', 'Nom et prénom')}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-teal-600 focus:outline-none"
                />
              </div>
            </div>

            {/* Email & Phone (at least one required) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1 flex items-center gap-1">
                  <Mail className="h-3.5 w-3.5 text-teal-700" />
                  <span>{t(lang, 'البريد الإلكتروني (للدخول)', 'Adresse e-mail (connexion)')}</span>
                </label>
                <input
                  type="email"
                  dir="ltr"
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                  placeholder="name@store.com"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1 flex items-center gap-1">
                  <Phone className="h-3.5 w-3.5 text-teal-700" />
                  <span>{t(lang, 'رقم الهاتف (للدخول)', 'Numéro de téléphone (connexion)')}</span>
                </label>
                <input
                  type="tel"
                  dir="ltr"
                  value={regPhone}
                  onChange={(e) => setRegPhone(e.target.value)}
                  placeholder="+212 6 00 00 00 00"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono focus:border-teal-600 focus:outline-none"
                />
              </div>
            </div>
            <p className="text-[11px] text-slate-500 -mt-2">
              {t(
                lang,
                '* أدخل البريد الإلكتروني أو رقم الهاتف على الأقل (أو كليهما لتتمكن من تسجيل الدخول بأي منهما).',
                '* Saisissez au moins un e-mail ou un numéro de téléphone (ou les deux).'
              )}
            </p>

            {/* License Number + Activation Code Section */}
            <div className="rounded-xl border-2 border-[#D9A738]/70 bg-amber-50/50 p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-extrabold text-[#0B274D]">
                  <KeyRound className="h-4 w-4 text-[#B47B10]" />
                  <span>
                    {t(lang, 'بيانات الرخصة والتفعيل (إلزامية)', 'Licence & code d’activation (obligatoire)')}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleGenerateLicense}
                    className="inline-flex items-center gap-1 rounded-lg bg-[#0B274D] px-2.5 py-1.5 text-[11px] font-bold text-[#FDE68A] hover:bg-[#133A6E]"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {t(lang, 'إصدار رخصة وتفعيل جديد', 'Générer licence')}
                  </button>
                  {licenseNumber && activationCode && (
                    <button
                      type="button"
                      onClick={handleCopyLicensePair}
                      title={t(lang, 'نسخ الرخصة ورقم التفعيل', 'Copier la licence')}
                      className="inline-flex items-center gap-1 rounded-lg border border-amber-400 bg-white px-2 py-1.5 text-[11px] font-bold text-slate-700 hover:bg-amber-50"
                    >
                      {copiedLicense ? (
                        <Check className="h-3.5 w-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      <span>{copiedLicense ? t(lang, 'نُسخت', 'Copié') : t(lang, 'نسخ', 'Copier')}</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold text-slate-800 mb-1">
                    {t(lang, 'رقم الرخصة *', 'Numéro de licence *')}
                  </label>
                  <input
                    type="text"
                    required
                    dir="ltr"
                    value={licenseNumber}
                    onChange={(e) => setLicenseNumber(e.target.value.toUpperCase())}
                    placeholder="RMGC-XXXX-XXXX-XXXX"
                    className="w-full rounded-lg border border-amber-400 bg-white px-3 py-2 text-xs font-mono font-bold tracking-wider text-slate-900 focus:border-[#0B274D] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-800 mb-1">
                    {t(lang, 'رقم التفعيل *', 'Code d’activation *')}
                  </label>
                  <input
                    type="text"
                    required
                    dir="ltr"
                    value={activationCode}
                    onChange={(e) => setActivationCode(e.target.value.toUpperCase())}
                    placeholder="ACT-XXXX-XXXX"
                    className="w-full rounded-lg border border-amber-400 bg-white px-3 py-2 text-xs font-mono font-bold tracking-wider text-slate-900 focus:border-[#0B274D] focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Password & Currency */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1">
                  {t(lang, 'كلمة السر (6+ أحرف) *', 'Mot de passe (6+ car.) *')}
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  autoComplete="new-password"
                  value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1">
                  {t(lang, 'تأكيد كلمة السر *', 'Confirmer mot de passe *')}
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  autoComplete="new-password"
                  value={regConfirmPassword}
                  onChange={(e) => setRegConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1">
                  {t(lang, 'العملة', 'Devise')}
                </label>
                <input
                  type="text"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono focus:border-teal-600 focus:outline-none"
                />
              </div>
            </div>

            {/* Optional Demo Data */}
            <label className="flex items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 cursor-pointer text-xs">
              <input
                type="checkbox"
                checked={loadDemoData}
                onChange={(e) => setLoadDemoData(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-700"
              />
              <div>
                <span className="font-bold text-slate-900">
                  {t(lang, 'تحميل بيانات تجريبية لهذا الحساب (اختياري)', 'Charger des données de démonstration (optionnel)')}
                </span>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {t(
                    lang,
                    'اتركه غير محدد للبدء بحساب فارغ وجاهز لبيانات متجرك الحقيقية.',
                    'Laissez décoché pour démarrer avec une base propre.'
                  )}
                </p>
              </div>
            </label>

            {regError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
                {regError}
              </div>
            )}

            <button
              type="submit"
              disabled={regLoading}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#0B274D] px-4 py-3 text-sm font-extrabold text-[#FDE68A] hover:bg-[#133A6E] transition-colors disabled:opacity-50"
            >
              <ShieldCheck className="h-4 w-4" />
              {regLoading
                ? t(lang, 'جاري تفعيل الرخصة وإنشاء الحساب...', 'Activation et création en cours...')
                : t(lang, 'تفعيل الرخصة وإنشاء الحساب المستقل', 'Activer la licence et créer le compte')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
