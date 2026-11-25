import React, { useEffect, useState } from 'react';
import { LogIn, ShieldAlert } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { db } from '../db/database';
import { verifyPassword } from '../utils/crypto';
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
    // If previous lock already expired, reset attempts so user gets fresh tries after waiting
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
  const { lang, settings, setCurrentUser, setIsLocked, notify } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [throttle, setThrottle] = useState<LoginThrottleState>(() => readThrottleState());
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
        setError('');
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [throttle.lockedUntil]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const freshThrottle = readThrottleState();
    setThrottle(freshThrottle);
    if (Date.now() < freshThrottle.lockedUntil) {
      const secs = Math.ceil((freshThrottle.lockedUntil - Date.now()) / 1000);
      setError(
        t(
          lang,
          `تم قفل المحاولات مؤقتاً — انتظر ${secs} ثانية`,
          `Accès bloqué temporairement — patientez ${secs}s`
        )
      );
      return;
    }

    setLoading(true);
    try {
      const user = await db.users.where('username').equals(username.trim()).first();
      if (!user || !user.isActive) {
        await recordFailure(username.trim(), 'مستخدم غير موجود أو معطل', freshThrottle);
        return;
      }
      const ok = await verifyPassword(password, user.passwordSalt, user.passwordHash);
      if (!ok) {
        await recordFailure(username.trim(), 'كلمة سر خاطئة', freshThrottle);
        return;
      }

      await db.loginLogs.add({
        date: new Date().toISOString(),
        username: user.username,
        status: 'success',
        details: 'تسجيل دخول ناجح',
      });
      const cleared = { attempts: 0, lockedUntil: 0 };
      writeThrottleState(cleared);
      setThrottle(cleared);
      setCurrentUser(user);
      setIsLocked(false);
      setPassword('');
      notify(t(lang, `مرحباً ${user.fullName}`, `Bienvenue ${user.fullName}`));
    } finally {
      setLoading(false);
    }
  };

  const recordFailure = async (
    uname: string,
    reason: string,
    currentThrottle: LoginThrottleState
  ) => {
    const nextAttempts = currentThrottle.attempts + 1;
    const max = Math.max(2, settings.security.maxLoginAttempts || 5);
    let nextLockedUntil = 0;

    if (nextAttempts >= max) {
      nextLockedUntil = Date.now() + 60_000; // 60 seconds persistent cooldown
    }

    const nextState: LoginThrottleState = {
      attempts: nextAttempts,
      lockedUntil: nextLockedUntil,
    };
    writeThrottleState(nextState);
    setThrottle(nextState);
    setNowTs(Date.now());

    await db.loginLogs.add({
      date: new Date().toISOString(),
      username: uname || 'unknown',
      status: nextAttempts >= max ? 'locked' : 'failed',
      details: `${reason} (المحاولة ${nextAttempts}/${max})`,
    });

    if (nextAttempts >= max) {
      setError(
        t(
          lang,
          'تجاوزت الحد الأقصى لمحاولات الدخول. تم القفل لمدة 60 ثانية.',
          'Nombre maximal de tentatives atteint. Verrouillage pendant 60 secondes.'
        )
      );
    } else {
      setError(
        t(
          lang,
          `بيانات الدخول غير صحيحة (${nextAttempts}/${max})`,
          `Identifiants incorrects (${nextAttempts}/${max})`
        )
      );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/95 p-3 sm:p-4 overflow-y-auto">
      <div className="my-auto w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 sm:p-7 shadow-2xl">
        <div className="flex flex-col items-center text-center">
          <img
            src="/assets/aistudio/image_39bba8ff.png"
            alt="RM.POS GC"
            className="h-20 w-20 rounded-2xl object-contain shadow-md"
          />
          <div dir="ltr" className="mt-3 text-xl font-black tracking-wide text-[#0B274D]">
            RM.POS GC
          </div>
          <h1 className="mt-0.5 text-sm font-bold text-slate-700">
            {settings.storeInfo.storeName}
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            {t(lang, 'تسجيل الدخول وتحديد صلاحيات المستخدم', 'Connexion et sélection du profil utilisateur')}
          </p>
        </div>

        <form onSubmit={handleLogin} className="mt-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              {t(lang, 'اسم المستخدم', 'Nom d’utilisateur')}
            </label>
            <input
              type="text"
              required
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t(lang, 'أدخل اسم المستخدم', 'Nom d’utilisateur')}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              {t(lang, 'كلمة السر', 'Mot de passe')}
            </label>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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

          {error && remainingLockSecs === 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || remainingLockSecs > 0}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 transition-colors disabled:opacity-50"
          >
            <LogIn className="h-4 w-4" />
            {loading ? t(lang, 'جاري الدخول...', 'Connexion...') : t(lang, 'دخول', 'Se connecter')}
          </button>

          <p className="text-center text-[11px] leading-relaxed text-slate-500">
            {t(
              lang,
              'يتم إدارة الحسابات وكلمات السر من قبل مدير المتجر عبر الإعدادات › الأمان والصلاحيات.',
              'Les comptes et mots de passe sont gérés par le responsable dans Paramètres › Sécurité.'
            )}
          </p>
        </form>
      </div>
    </div>
  );
};
