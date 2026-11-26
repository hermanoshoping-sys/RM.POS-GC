import React, { useEffect, useState } from 'react';
import {
  Building2,
  Check,
  CheckCircle2,
  Cloud,
  CloudDownload,
  CloudUpload,
  Copy,
  KeyRound,
  LogIn,
  LogOut,
  Mail,
  Phone,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { db } from '../db/database';
import { authenticateAccountUser, registerNewAccount } from '../db/accountsDb';
import { CloudAccountDoc, formatFirebaseAuthError } from '../services/cloudSync';
import {
  generateLicensePair,
  normalizeActivationCode,
  normalizeLicenseNumber,
} from '../utils/license';
import { formatDateTime, t } from '../i18n/translations';

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

const GoogleIcon: React.FC<{ className?: string }> = ({ className = 'h-4 w-4' }) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="#4285F4"
      d="M23.745 12.27c0-.79-.07-1.54-.19-2.27h-11.3v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
    />
    <path
      fill="#34A853"
      d="M12.255 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96h-3.98v3.09C3.515 21.3 7.565 24 12.255 24z"
    />
    <path
      fill="#FBBC05"
      d="M5.525 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62h-3.98a11.86 11.86 0 000 10.76l3.98-3.09z"
    />
    <path
      fill="#EA4335"
      d="M12.255 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C18.205 1.19 15.495 0 12.255 0c-4.69 0-8.74 2.7-10.71 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
    />
  </svg>
);

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
    cloudUser,
    cloudAccounts,
    refreshCloudAccounts,
    signInWithGoogle,
    signInWithCloudEmail,
    registerWithCloudEmail,
    resendVerificationEmail,
    signOutCloud,
    openCloudAccountOnDevice,
    linkAccountToCloud,
  } = useApp();

  const [mode, setMode] = useState<'login' | 'register'>(authPortalMode);

  useEffect(() => {
    setMode(authPortalMode);
  }, [authPortalMode]);

  // Cloud Email Auth State
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudError, setCloudError] = useState('');
  const [cloudNotice, setCloudNotice] = useState('');
  const [showEmailPasswordCloud, setShowEmailPasswordCloud] = useState(false);
  const [cloudAuthTab, setCloudAuthTab] = useState<'signin' | 'signup'>('signin');
  const [cloudEmailInput, setCloudEmailInput] = useState('');
  const [cloudPwdInput, setCloudPwdInput] = useState('');
  const [cloudNameInput, setCloudNameInput] = useState('');
  const [openingCloudId, setOpeningCloudId] = useState<string | null>(null);
  const [linkingLocalId, setLinkingLocalId] = useState<string | null>(null);

  // Local Login Form State (for cashiers/staff & offline login)
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

  // Auto-fill email and owner name in registration when connected to a cloud email
  useEffect(() => {
    if (cloudUser?.email && !regEmail) {
      setRegEmail(cloudUser.email);
    }
    if (cloudUser?.displayName && !ownerName) {
      setOwnerName(cloudUser.displayName);
    }
  }, [cloudUser?.email, cloudUser?.displayName, regEmail, ownerName]);

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

  const handleOpenCloudAccount = async (acc: CloudAccountDoc) => {
    setCloudError('');
    setOpeningCloudId(acc.accountId);
    try {
      await openCloudAccountOnDevice(acc);
      notify(
        t(
          lang,
          `تم فتح ومزامنة «${acc.storeName}» على هذا الجهاز بنجاح`,
          `« ${acc.storeName} » ouvert et synchronisé sur cet appareil`
        )
      );
    } catch (err) {
      setCloudError(formatFirebaseAuthError(err, lang));
    } finally {
      setOpeningCloudId(null);
    }
  };

  const handleGoogleSignIn = async () => {
    setCloudError('');
    setCloudNotice('');
    setCloudBusy(true);
    try {
      const { user, accounts: remoteAccounts } = await signInWithGoogle();
      if (remoteAccounts.length === 1 && !activeAccount) {
        // 1-click seamless cross-device sign-in when this email owns a single cloud store
        await handleOpenCloudAccount(remoteAccounts[0]);
      } else if (remoteAccounts.length > 0) {
        notify(
          t(
            lang,
            `تم الاتصال بالبريد ${user.email} — اختر المتجر لفتحه على هذا الجهاز`,
            `Connecté avec ${user.email} — choisissez votre magasin`
          ),
          'info'
        );
      } else {
        notify(
          t(
            lang,
            `تم ربط البريد ${user.email} — يمكنك الآن إنشاء متجر جديد أو ربط متجرك المحلي`,
            `E-mail ${user.email} connecté — créez un magasin ou liez votre magasin local`
          ),
          'info'
        );
      }
    } catch (err) {
      setCloudError(formatFirebaseAuthError(err, lang));
    } finally {
      setCloudBusy(false);
    }
  };

  const handleCloudEmailPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCloudError('');
    setCloudNotice('');
    setCloudBusy(true);
    try {
      if (cloudAuthTab === 'signin') {
        const { user, accounts: remoteAccounts } = await signInWithCloudEmail(
          cloudEmailInput.trim(),
          cloudPwdInput
        );
        setCloudPwdInput('');
        if (!user.emailVerified) {
          setCloudNotice(
            t(
              lang,
              'تم تسجيل الدخول، ولكن يجب تأكيد بريدك الإلكتروني عبر الرابط المرسل لتفعيل المزامنة السحابية.',
              'Connecté, mais veuillez confirmer votre e-mail via le lien envoyé pour activer la synchronisation.'
            )
          );
        } else if (remoteAccounts.length === 1 && !activeAccount) {
          await handleOpenCloudAccount(remoteAccounts[0]);
        }
      } else {
        await registerWithCloudEmail(
          cloudEmailInput.trim(),
          cloudPwdInput,
          cloudNameInput.trim()
        );
        setCloudPwdInput('');
        setCloudNotice(
          t(
            lang,
            'تم إنشاء حساب البريد السحابي وإرسال رابط التفعيل إلى بريدك الإلكتروني. بعد الضغط على الرابط، اضغط «تحديث الحالة».',
            'Compte e-mail cloud créé. Cliquez sur le lien de vérification envoyé à votre boîte mail puis actualisez.'
          )
        );
      }
    } catch (err) {
      setCloudError(formatFirebaseAuthError(err, lang));
    } finally {
      setCloudBusy(false);
    }
  };

  const handleLinkLocalToCloud = async (localAcc: (typeof accounts)[number]) => {
    setCloudError('');
    setLinkingLocalId(localAcc.accountId);
    try {
      await linkAccountToCloud(localAcc);
    } catch (err) {
      setCloudError(formatFirebaseAuthError(err, lang));
    } finally {
      setLinkingLocalId(null);
    }
  };

  const handleReloadVerification = async () => {
    if (!cloudUser) return;
    setCloudBusy(true);
    setCloudError('');
    try {
      await cloudUser.reload();
      if (cloudUser.emailVerified) {
        await refreshCloudAccounts(cloudUser.uid);
        setCloudNotice(
          t(lang, 'تم تأكيد البريد الإلكتروني بنجاح!', 'Adresse e-mail vérifiée avec succès !')
        );
      } else {
        setCloudNotice(
          t(
            lang,
            'لم يتم تأكيد البريد بعد — تحقق من صندوق الوارد أو الرسائل غير المرغوب فيها.',
            'E-mail non encore vérifié — vérifiez votre boîte de réception ou les spams.'
          )
        );
      }
    } catch (err) {
      setCloudError(formatFirebaseAuthError(err, lang));
    } finally {
      setCloudBusy(false);
    }
  };

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
      const effectiveEmail = cloudUser?.email ? cloudUser.email : regEmail;
      const { account, adminUser } = await registerNewAccount({
        storeName,
        ownerName,
        email: effectiveEmail,
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
      await activateAccountSession(account, adminUser, passForMemory, {
        autoSyncToCloud: Boolean(cloudUser?.emailVerified),
      });
      notify(
        t(
          lang,
          cloudUser?.emailVerified
            ? `تم تفعيل الرخصة ${account.licenseNumber} وربط «${account.storeName}» بالبريد ${cloudUser.email} للمزامنة من أي جهاز`
            : `تم تفعيل الرخصة ${account.licenseNumber} وإنشاء الحساب المستقل «${account.storeName}» بنجاح`,
          cloudUser?.emailVerified
            ? `Licence ${account.licenseNumber} activée et « ${account.storeName} » synchronisé sur ${cloudUser.email}`
            : `Licence ${account.licenseNumber} activée et compte « ${account.storeName} » créé`
        )
      );
    } catch (err) {
      setRegError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegLoading(false);
    }
  };

  const unlinkedLocalAccounts = accounts.filter(
    (a) => !cloudUser || a.cloudUid !== cloudUser.uid
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-br from-[#041022] via-[#0B274D] to-[#041022] p-3 sm:p-4 overflow-y-auto">
      <div
        className={`my-auto w-full ${
          mode === 'register' ? 'max-w-2xl' : 'max-w-lg'
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
                      'إنشاء حساب متجر مستقل وتفعيل الرخصة والمزامنة السحابية',
                      'Créer un compte magasin indépendant & synchronisation cloud'
                    )
                  : activeAccount
                    ? `${activeAccount.storeName} · ${activeAccount.licenseNumber}`
                    : t(
                        lang,
                        'تسجيل الدخول بالبريد الإلكتروني من أي جهاز',
                        'Connexion par e-mail depuis n’importe quel appareil'
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
            onClick={() => {
              setMode('login');
              setAuthPortalMode('login');
              setLoginError('');
            }}
            className={`inline-flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-extrabold transition-all ${
              mode === 'login'
                ? 'bg-[#0B274D] text-[#FDE68A] shadow-sm'
                : 'text-slate-700 hover:bg-white'
            }`}
          >
            <LogIn className="h-4 w-4" />
            <span>{t(lang, 'تسجيل الدخول (من أي جهاز)', 'Se connecter (Tout appareil)')}</span>
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
          <div className="p-5 sm:p-6 space-y-5">
            {/* CLOUD EMAIL MULTI-DEVICE PANEL */}
            <div className="rounded-2xl border-2 border-[#0B274D]/15 bg-gradient-to-b from-blue-50/80 to-white p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#0B274D] text-[#FDE68A]">
                    <Cloud className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-xs font-extrabold text-[#0B274D]">
                      {t(lang, 'الدخول السحابي بالبريد الإلكتروني', 'Connexion E-mail Cloud')}
                    </h3>
                    <p className="text-[11px] text-slate-600">
                      {t(
                        lang,
                        'افتح متجرك وبياناتك ومستخدميك من أي هاتف أو حاسوب',
                        'Accédez à votre magasin et vos données depuis tout appareil'
                      )}
                    </p>
                  </div>
                </div>
                {cloudUser && (
                  <button
                    type="button"
                    onClick={() => void signOutCloud()}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-700 hover:bg-red-50 hover:text-red-700 hover:border-red-200"
                  >
                    <LogOut className="h-3 w-3" />
                    <span>{t(lang, 'تغيير البريد', 'Changer')}</span>
                  </button>
                )}
              </div>

              {!cloudUser ? (
                <div className="space-y-2.5">
                  <button
                    type="button"
                    disabled={cloudBusy}
                    onClick={handleGoogleSignIn}
                    className="flex w-full items-center justify-center gap-2.5 rounded-xl border-2 border-slate-300 bg-white px-4 py-2.5 text-xs sm:text-sm font-extrabold text-slate-900 shadow-sm hover:border-[#0B274D] hover:bg-slate-50 transition-all disabled:opacity-50"
                  >
                    <GoogleIcon className="h-4 w-4 shrink-0" />
                    <span>
                      {cloudBusy
                        ? t(lang, 'جاري الاتصال بالبريد السحابي...', 'Connexion en cours...')
                        : t(
                            lang,
                            'المتابعة عبر البريد الإلكتروني (Google)',
                            'Continuer avec votre e-mail Google'
                          )}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setShowEmailPasswordCloud((v) => !v);
                      setCloudError('');
                    }}
                    className="w-full text-center text-[11px] font-bold text-[#0B274D] hover:underline"
                  >
                    {showEmailPasswordCloud
                      ? t(lang, 'إخفاء خيار البريد وكلمة السر السحابية', 'Masquer e-mail/mot de passe cloud')
                      : t(
                          lang,
                          'أو الدخول / إنشاء حساب ببريد إلكتروني وكلمة سر سحابية',
                          'Ou se connecter avec e-mail et mot de passe cloud'
                        )}
                  </button>

                  {showEmailPasswordCloud && (
                    <form
                      onSubmit={handleCloudEmailPasswordSubmit}
                      className="rounded-xl border border-slate-200 bg-white p-3 space-y-2.5"
                    >
                      <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-0.5 text-[11px] font-bold">
                        <button
                          type="button"
                          onClick={() => setCloudAuthTab('signin')}
                          className={`rounded-md py-1.5 ${
                            cloudAuthTab === 'signin'
                              ? 'bg-white text-[#0B274D] shadow-xs'
                              : 'text-slate-600'
                          }`}
                        >
                          {t(lang, 'دخول ببريد سحابي', 'Connexion')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setCloudAuthTab('signup')}
                          className={`rounded-md py-1.5 ${
                            cloudAuthTab === 'signup'
                              ? 'bg-white text-[#0B274D] shadow-xs'
                              : 'text-slate-600'
                          }`}
                        >
                          {t(lang, 'تسجيل بريد جديد', 'Inscription')}
                        </button>
                      </div>

                      {cloudAuthTab === 'signup' && (
                        <input
                          type="text"
                          required
                          value={cloudNameInput}
                          onChange={(e) => setCloudNameInput(e.target.value)}
                          placeholder={t(lang, 'الاسم الكامل', 'Nom complet')}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-teal-600 focus:outline-none"
                        />
                      )}
                      <input
                        type="email"
                        required
                        dir="ltr"
                        value={cloudEmailInput}
                        onChange={(e) => setCloudEmailInput(e.target.value)}
                        placeholder="owner@store.com"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono focus:border-teal-600 focus:outline-none"
                      />
                      <input
                        type="password"
                        required
                        minLength={6}
                        value={cloudPwdInput}
                        onChange={(e) => setCloudPwdInput(e.target.value)}
                        placeholder={t(lang, 'كلمة السر السحابية (6+ أحرف)', 'Mot de passe cloud (6+ car.)')}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-teal-600 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={cloudBusy}
                        className="w-full rounded-lg bg-[#0B274D] py-2 text-xs font-bold text-[#FDE68A] hover:bg-[#133A6E] disabled:opacity-50"
                      >
                        {cloudAuthTab === 'signin'
                          ? t(lang, 'تسجيل الدخول بالبريد السحابي', 'Connexion e-mail cloud')
                          : t(lang, 'إنشاء بريد سحابي وإرسال التفعيل', 'Créer et envoyer le lien')}
                      </button>
                    </form>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Connected Email Badge */}
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                      <span className="font-mono font-bold text-slate-900 truncate" dir="ltr">
                        {cloudUser.email}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void refreshCloudAccounts(cloudUser.uid)}
                      className="inline-flex items-center gap-1 rounded-md bg-white border border-emerald-200 px-2 py-1 text-[11px] font-bold text-emerald-800 hover:bg-emerald-100"
                    >
                      <RefreshCw className="h-3 w-3" />
                      {t(lang, 'تحديث المتاجر', 'Actualiser')}
                    </button>
                  </div>

                  {/* Email Verification Warning if unverified */}
                  {!cloudUser.emailVerified && (
                    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 space-y-2">
                      <p className="font-semibold">
                        {t(
                          lang,
                          'يرجى تأكيد بريدك الإلكتروني عبر الرابط المرسل إليه لتفعيل المزامنة السحابية.',
                          'Veuillez confirmer votre e-mail via le lien envoyé pour activer la synchronisation.'
                        )}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={handleReloadVerification}
                          className="rounded-lg bg-amber-600 px-3 py-1 text-[11px] font-bold text-white hover:bg-amber-700"
                        >
                          {t(lang, 'تحققت من بريدي — تحديث', 'J’ai vérifié — Actualiser')}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            resendVerificationEmail()
                              .then(() =>
                                setCloudNotice(
                                  t(lang, 'تم إعادة إرسال رابط التفعيل', 'Lien renvoyé')
                                )
                              )
                              .catch((e) => setCloudError(formatFirebaseAuthError(e, lang)))
                          }
                          className="rounded-lg border border-amber-400 bg-white px-3 py-1 text-[11px] font-bold text-amber-900 hover:bg-amber-100"
                        >
                          {t(lang, 'إعادة إرسال الرابط', 'Renvoyer le lien')}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Synced Cloud Store Accounts */}
                  {cloudUser.emailVerified && cloudAccounts.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-[11px] font-bold text-slate-600">
                        {t(
                          lang,
                          `المتاجر المرتبطة بهذا البريد (${cloudAccounts.length}):`,
                          `Magasins liés à cet e-mail (${cloudAccounts.length}) :`
                        )}
                      </div>
                      {cloudAccounts.map((cAcc) => (
                        <div
                          key={cAcc.accountId}
                          className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-xs"
                        >
                          <div className="min-w-0">
                            <div className="font-extrabold text-xs text-slate-900 truncate flex items-center gap-1.5">
                              <Building2 className="h-3.5 w-3.5 text-[#0B274D] shrink-0" />
                              <span className="truncate">{cAcc.storeName}</span>
                            </div>
                            <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                              {cAcc.licenseNumber} ·{' '}
                              {cAcc.lastSyncedAt && 'toDate' in cAcc.lastSyncedAt
                                ? formatDateTime(cAcc.lastSyncedAt.toDate().toISOString(), lang)
                                : formatDateTime(cAcc.activatedAt, lang)}
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={openingCloudId !== null}
                            onClick={() => void handleOpenCloudAccount(cAcc)}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3 py-2 text-[11px] font-bold text-white hover:bg-teal-800 shrink-0 disabled:opacity-50"
                          >
                            <CloudDownload className="h-3.5 w-3.5" />
                            <span>
                              {openingCloudId === cAcc.accountId
                                ? t(lang, 'جاري الفتح...', 'Ouverture...')
                                : t(lang, 'فتح على هذا الجهاز', 'Ouvrir ici')}
                            </span>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* No cloud accounts yet: offer linking existing local store OR creating new one */}
                  {cloudUser.emailVerified && cloudAccounts.length === 0 && (
                    <div className="rounded-xl border border-blue-200 bg-white p-3 space-y-2.5 text-xs">
                      <p className="text-slate-700 leading-relaxed">
                        {t(
                          lang,
                          'لا توجد متاجر محفوظة سحابياً على هذا البريد بعد. يمكنك ربط متجر محلي موجود أو إنشاء متجر جديد برخصة.',
                          'Aucun magasin cloud trouvé pour cet e-mail. Liez un magasin local ou créez-en un nouveau.'
                        )}
                      </p>

                      {unlinkedLocalAccounts.map((loc) => (
                        <button
                          key={loc.accountId}
                          type="button"
                          disabled={linkingLocalId !== null}
                          onClick={() => void handleLinkLocalToCloud(loc)}
                          className="flex w-full items-center justify-between gap-2 rounded-lg border border-teal-300 bg-teal-50 px-3 py-2 text-xs font-bold text-teal-900 hover:bg-teal-100 disabled:opacity-50"
                        >
                          <span className="truncate">
                            {t(lang, `ربط ومزامنة «${loc.storeName}»`, `Lier et synchroniser « ${loc.storeName} »`)}
                          </span>
                          <span className="inline-flex items-center gap-1 shrink-0 text-[11px]">
                            <CloudUpload className="h-3.5 w-3.5" />
                            {linkingLocalId === loc.accountId
                              ? t(lang, 'جاري الرفع...', 'Envoi...')
                              : t(lang, 'رفع للسحابة', 'Synchroniser')}
                          </span>
                        </button>
                      ))}

                      <button
                        type="button"
                        onClick={() => {
                          setMode('register');
                          setAuthPortalMode('register');
                          setRegEmail(cloudUser.email ?? '');
                          if (cloudUser.displayName) setOwnerName(cloudUser.displayName);
                        }}
                        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#0B274D] px-3 py-2 text-xs font-extrabold text-[#FDE68A] hover:bg-[#133A6E]"
                      >
                        <UserPlus className="h-3.5 w-3.5" />
                        <span>
                          {t(lang, 'إنشاء متجر جديد مرتبط بهذا البريد', 'Créer un nouveau magasin lié')}
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              )}

              {cloudNotice && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] font-semibold text-blue-900">
                  {cloudNotice}
                </div>
              )}

              {cloudError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-semibold text-red-700">
                  {cloudError}
                </div>
              )}
            </div>

            {/* LOCAL STAFF / OFFLINE SIGN-IN FORM (when at least 1 local account exists on this device) */}
            {accounts.length > 0 && (
              <form onSubmit={handleLogin} className="space-y-3.5 border-t border-slate-200 pt-4">
                <div className="text-[11px] font-extrabold uppercase tracking-wide text-slate-500">
                  {t(
                    lang,
                    'أو دخول محلي للموظفين / العمل بدون إنترنت',
                    'Ou connexion locale (employés / mode hors ligne)'
                  )}
                </div>

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
                    : t(lang, 'دخول محلي', 'Connexion locale')}
                </button>
              </form>
            )}
          </div>
        ) : (
          /* CREATE INDEPENDENT ACCOUNT + LICENSE ACTIVATION VIEW */
          <form onSubmit={handleRegister} className="p-5 sm:p-6 space-y-4">
            {/* Cloud Email Link Banner inside Registration */}
            {cloudUser?.emailVerified ? (
              <div className="rounded-xl border border-emerald-300 bg-emerald-50/80 p-3 text-xs text-emerald-950 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Cloud className="h-4 w-4 text-emerald-700 shrink-0" />
                  <span className="truncate">
                    {t(
                      lang,
                      `سيتم ربط هذا المتجر تلقائياً بالبريد السحابي: `,
                      `Ce magasin sera automatiquement synchronisé avec : `
                    )}
                    <strong className="font-mono" dir="ltr">
                      {cloudUser.email}
                    </strong>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void signOutCloud()}
                  className="text-[11px] font-bold text-emerald-800 underline shrink-0"
                >
                  {t(lang, 'تغيير', 'Changer')}
                </button>
              </div>
            ) : (
              <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-3 text-xs text-slate-800 flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex items-start gap-2 max-w-md">
                  <Cloud className="h-4 w-4 text-[#0B274D] shrink-0 mt-0.5" />
                  <p className="leading-relaxed">
                    {t(
                      lang,
                      'اربط حسابك ببريدك الإلكتروني السحابي (Google) لتتمكن من فتح متجرك من أي هاتف أو حاسوب في أي وقت.',
                      'Connectez votre e-mail Google pour accéder à votre magasin depuis tout appareil.'
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={cloudBusy}
                  onClick={handleGoogleSignIn}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-extrabold text-slate-900 shadow-xs hover:border-[#0B274D]"
                >
                  <GoogleIcon className="h-3.5 w-3.5" />
                  <span>{t(lang, 'ربط بريد Google', 'Lier e-mail Google')}</span>
                </button>
              </div>
            )}

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

            {/* Email & Phone */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1 flex items-center gap-1">
                  <Mail className="h-3.5 w-3.5 text-teal-700" />
                  <span>{t(lang, 'البريد الإلكتروني (للدخول والمزامنة)', 'Adresse e-mail (connexion & sync)')}</span>
                </label>
                <input
                  type="email"
                  dir="ltr"
                  value={cloudUser?.email ? cloudUser.email : regEmail}
                  readOnly={Boolean(cloudUser?.email)}
                  onChange={(e) => setRegEmail(e.target.value)}
                  placeholder="name@store.com"
                  className={`w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono focus:border-teal-600 focus:outline-none ${
                    cloudUser?.email ? 'bg-slate-100 text-slate-700' : ''
                  }`}
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1 flex items-center gap-1">
                  <Phone className="h-3.5 w-3.5 text-teal-700" />
                  <span>{t(lang, 'رقم الهاتف (اختياري للدخول)', 'Numéro de téléphone (optionnel)')}</span>
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
                  {t(lang, 'كلمة سر القفل المحلي (6+) *', 'Mot de passe local (6+) *')}
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
