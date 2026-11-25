import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import {
  Camera,
  CheckCircle2,
  Flashlight,
  FlashlightOff,
  ImagePlus,
  RefreshCw,
  ScanBarcode,
  ShoppingCart,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { Language } from '../types';
import { t } from '../i18n/translations';

export interface ScanCallbackResult {
  found: boolean;
  label?: string;
  price?: number;
}

interface CameraBarcodeScannerModalProps {
  open: boolean;
  lang: Language;
  currency?: string;
  cartCount?: number;
  cartTotal?: number;
  onClose: () => void;
  onScan: (code: string) => ScanCallbackResult;
}

interface CameraDevice {
  id: string;
  label: string;
}

const SUPPORTED_FORMATS = [
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.CODE_93,
  Html5QrcodeSupportedFormats.CODABAR,
  Html5QrcodeSupportedFormats.ITF,
  Html5QrcodeSupportedFormats.QR_CODE,
];

function playBeep(success: boolean) {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(success ? 65 : [80, 40, 80]);
    }
  } catch {
    // Ignore vibration errors
  }

  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = success ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(success ? 1240 : 320, ctx.currentTime);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (success ? 0.13 : 0.24));
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (success ? 0.14 : 0.25));
    window.setTimeout(() => {
      ctx.close().catch(() => {});
    }, 350);
  } catch {
    // Ignore audio context restrictions
  }
}

export const CameraBarcodeScannerModal: React.FC<CameraBarcodeScannerModalProps> = ({
  open,
  lang,
  currency = 'MAD',
  cartCount,
  cartTotal,
  onClose,
  onScan,
}) => {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastScanRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const onScanRef = useRef(onScan);
  const onCloseRef = useRef(onClose);

  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  const [continuous, setContinuous] = useState<boolean>(true);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [torchSupported, setTorchSupported] = useState<boolean>(false);
  const [torchOn, setTorchOn] = useState<boolean>(false);
  const [status, setStatus] = useState<'initializing' | 'scanning' | 'error'>('initializing');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [sessionCount, setSessionCount] = useState<number>(0);
  const [lastFeedback, setLastFeedback] = useState<{
    code: string;
    found: boolean;
    label?: string;
    price?: number;
  } | null>(null);
  const [manualCode, setManualCode] = useState('');

  const continuousRef = useRef(continuous);
  const soundRef = useRef(soundEnabled);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    continuousRef.current = continuous;
  }, [continuous]);

  useEffect(() => {
    soundRef.current = soundEnabled;
  }, [soundEnabled]);

  const readerElementId = 'pos-camera-barcode-reader';

  const stopScanner = useCallback(async () => {
    const instance = scannerRef.current;
    setTorchOn(false);
    setTorchSupported(false);
    if (!instance) return;
    try {
      if (runningRef.current) {
        await instance.stop();
        runningRef.current = false;
      }
      instance.clear();
    } catch {
      runningRef.current = false;
    } finally {
      scannerRef.current = null;
    }
  }, []);

  const processDecodedCode = useCallback(
    (rawText: string, bypassDebounce = false) => {
      const cleaned = rawText.trim();
      if (!cleaned) return;
      const now = Date.now();
      if (
        !bypassDebounce &&
        lastScanRef.current.code === cleaned &&
        now - lastScanRef.current.at < 1500
      ) {
        return;
      }
      lastScanRef.current = { code: cleaned, at: now };

      const result = onScanRef.current(cleaned);
      if (soundRef.current) {
        playBeep(result.found);
      }
      if (result.found) {
        setSessionCount((c) => c + 1);
      }
      setLastFeedback({
        code: cleaned,
        found: result.found,
        label: result.label,
        price: result.price,
      });

      if (!continuousRef.current && result.found) {
        stopScanner().then(() => onCloseRef.current());
      }
    },
    [stopScanner]
  );

  const startScanner = useCallback(
    async (cameraIdOrFacing?: string) => {
      await stopScanner();
      const container = document.getElementById(readerElementId);
      if (!container || !mountedRef.current) return;

      setStatus('initializing');
      setErrorMsg('');

      try {
        const html5QrCode = new Html5Qrcode(readerElementId, {
          formatsToSupport: SUPPORTED_FORMATS,
          verbose: false,
        });
        scannerRef.current = html5QrCode;

        const config = {
          fps: 14,
          qrbox: (viewfinderWidth: number, viewfinderHeight: number) => {
            const w = Math.min(340, Math.floor(viewfinderWidth * 0.84));
            const h = Math.min(180, Math.floor(viewfinderHeight * 0.48));
            return { width: Math.max(180, w), height: Math.max(110, h) };
          },
          aspectRatio: 1.5,
        };

        const onDecoded = (decodedText: string) => {
          if (!mountedRef.current) return;
          processDecodedCode(decodedText, false);
        };

        // Try requested camera or rear environment camera first; fall back to first available webcam on desktop
        try {
          const cameraConstraint = cameraIdOrFacing
            ? cameraIdOrFacing
            : { facingMode: 'environment' };
          await html5QrCode.start(cameraConstraint, config, onDecoded, () => {});
        } catch (firstErr) {
          if (cameraIdOrFacing) throw firstErr;
          const fallbackCams = await Html5Qrcode.getCameras();
          if (!fallbackCams || fallbackCams.length === 0) throw firstErr;
          const rear = fallbackCams.find((d) => /back|rear|environment/i.test(d.label));
          const chosen = rear ?? fallbackCams[0];
          setSelectedCameraId(chosen.id);
          await html5QrCode.start(chosen.id, config, onDecoded, () => {});
        }

        if (!mountedRef.current) {
          await stopScanner();
          return;
        }

        runningRef.current = true;
        setStatus('scanning');

        // Check flashlight/torch capability
        try {
          const caps = html5QrCode.getRunningTrackCapabilities() as MediaTrackCapabilities & {
            torch?: boolean;
          };
          setTorchSupported(Boolean(caps?.torch));
        } catch {
          setTorchSupported(false);
        }

        // Enumerate cameras for switching
        try {
          const devs = await Html5Qrcode.getCameras();
          if (devs && devs.length > 0 && mountedRef.current) {
            setCameras(devs.map((d) => ({ id: d.id, label: d.label })));
            if (!cameraIdOrFacing) {
              const rear = devs.find((d) => /back|rear|environment/i.test(d.label));
              setSelectedCameraId((prev) => prev || rear?.id || devs[0].id);
            }
          }
        } catch {
          // Camera list optional
        }
      } catch (err) {
        runningRef.current = false;
        if (!mountedRef.current) return;
        setStatus('error');
        const message = err instanceof Error ? err.message : String(err);
        setErrorMsg(
          t(
            lang,
            `تعذر تشغيل البث المباشر للكاميرا (${message}). يمكنك منح إذن الكاميرا أو التقاط صورة للباركود أو إدخاله يدوياً بالأسفل.`,
            `Impossible de démarrer la caméra (${message}). Vérifiez les permissions, scannez une image ou saisissez le code manuellement.`
          )
        );
      }
    },
    [lang, processDecodedCode, stopScanner]
  );

  useEffect(() => {
    if (!open) {
      stopScanner();
      return;
    }
    setLastFeedback(null);
    setManualCode('');
    setSessionCount(0);
    lastScanRef.current = { code: '', at: 0 };
    const timer = window.setTimeout(() => {
      startScanner(selectedCameraId || undefined);
    }, 100);
    return () => {
      window.clearTimeout(timer);
      stopScanner();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleToggleTorch = async () => {
    const instance = scannerRef.current;
    if (!instance || !runningRef.current || !torchSupported) return;
    try {
      const nextState = !torchOn;
      await instance.applyVideoConstraints({
        advanced: [{ torch: nextState } as MediaTrackConstraintSet],
      });
      setTorchOn(nextState);
    } catch {
      setTorchSupported(false);
    }
  };

  const handleSwitchCamera = async () => {
    if (cameras.length < 2) {
      await startScanner(undefined);
      return;
    }
    const idx = cameras.findIndex((c) => c.id === selectedCameraId);
    const next = cameras[(idx + 1) % cameras.length];
    setSelectedCameraId(next.id);
    await startScanner(next.id);
  };

  const handleImageFileScan = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const wasRunning = runningRef.current;
    await stopScanner();

    try {
      const fileScanner = new Html5Qrcode(readerElementId, {
        formatsToSupport: SUPPORTED_FORMATS,
        verbose: false,
      });
      const decoded = await fileScanner.scanFile(file, false);
      fileScanner.clear();
      processDecodedCode(decoded, true);
    } catch {
      if (soundEnabled) playBeep(false);
      setLastFeedback({
        code: file.name,
        found: false,
        label: t(lang, 'لم يتم التعرف على باركود واضح في الصورة', 'Aucun code-barres détecté dans l’image'),
      });
    } finally {
      if (wasRunning && continuousRef.current && mountedRef.current) {
        startScanner(selectedCameraId || undefined);
      }
    }
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = manualCode.trim();
    if (!cleaned) return;
    processDecodedCode(cleaned, true);
    setManualCode('');
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-3 sm:p-4">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border-2 border-slate-800 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-amber-500/50 bg-amber-300 px-4 py-3 text-slate-950">
          <div className="flex items-center gap-2 min-w-0">
            <ScanBarcode className="h-5 w-5 shrink-0" />
            <div className="min-w-0">
              <h3 className="text-sm font-black truncate">
                {t(lang, 'ماسح الباركود بالكاميرا (POS)', 'Scanner code-barres caméra')}
              </h3>
              {sessionCount > 0 && (
                <div className="text-[11px] font-bold text-amber-950/80">
                  {t(lang, `تم مسح ${sessionCount} منتج في هذه الجلسة`, `${sessionCount} article(s) scanné(s)`)}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {torchSupported && (
              <button
                type="button"
                onClick={handleToggleTorch}
                title={t(lang, 'الفلاش', 'Lampe torche')}
                className={`rounded-lg p-1.5 transition-colors ${
                  torchOn
                    ? 'bg-slate-950 text-amber-300'
                    : 'bg-white/75 text-slate-800 hover:bg-white'
                }`}
              >
                {torchOn ? <Flashlight className="h-4 w-4" /> : <FlashlightOff className="h-4 w-4" />}
              </button>
            )}
            <button
              type="button"
              onClick={() => setSoundEnabled((s) => !s)}
              title={t(lang, 'الصوت', 'Son')}
              className="rounded-lg bg-white/75 p-1.5 text-slate-800 hover:bg-white"
            >
              {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </button>
            {cameras.length > 1 && (
              <button
                type="button"
                onClick={handleSwitchCamera}
                title={t(lang, 'تبديل الكاميرا', 'Changer de caméra')}
                className="rounded-lg bg-white/75 p-1.5 text-slate-800 hover:bg-white"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                stopScanner().then(onClose);
              }}
              className="rounded-lg bg-white/75 p-1.5 text-slate-800 hover:bg-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Mode & Camera Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs">
          <div className="flex items-center gap-1 rounded-lg bg-slate-200/80 p-0.5">
            <button
              type="button"
              onClick={() => setContinuous(true)}
              className={`rounded-md px-2.5 py-1 font-bold transition-colors ${
                continuous ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              {t(lang, 'مسح متواصل', 'Scan continu')}
            </button>
            <button
              type="button"
              onClick={() => setContinuous(false)}
              className={`rounded-md px-2.5 py-1 font-bold transition-colors ${
                !continuous ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              {t(lang, 'مسح واحد', 'Scan unique')}
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleImageFileScan}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-700 hover:bg-slate-100"
            >
              <ImagePlus className="h-3.5 w-3.5 text-teal-700" />
              <span>{t(lang, 'مسح من صورة', 'Depuis image')}</span>
            </button>
            {cameras.length > 1 && (
              <select
                value={selectedCameraId}
                onChange={(e) => {
                  setSelectedCameraId(e.target.value);
                  startScanner(e.target.value);
                }}
                className="max-w-[140px] truncate rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold"
              >
                {cameras.map((cam, idx) => (
                  <option key={cam.id} value={cam.id}>
                    {cam.label || `${t(lang, 'كاميرا', 'Caméra')} ${idx + 1}`}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Camera Viewport & Controls */}
        <div className="p-4 space-y-3">
          <div className="relative overflow-hidden rounded-xl border-2 border-slate-900 bg-slate-950 min-h-[240px] flex items-center justify-center">
            <div id={readerElementId} className="w-full" />
            {status === 'initializing' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-950/85 text-white text-xs">
                <Camera className="h-8 w-8 animate-pulse text-amber-300" />
                <span className="font-semibold">
                  {t(lang, 'جاري تشغيل الكاميرا...', 'Activation de la caméra...')}
                </span>
              </div>
            )}
            {status === 'error' && (
              <div className="p-5 text-center text-xs text-red-200 space-y-3">
                <p className="leading-relaxed">{errorMsg}</p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => startScanner(selectedCameraId || undefined)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-3.5 py-2 font-bold text-slate-950 hover:bg-amber-300"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t(lang, 'إعادة التشغيل', 'Réessayer')}
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-3.5 py-2 font-bold text-white hover:bg-teal-500"
                  >
                    <ImagePlus className="h-3.5 w-3.5" />
                    {t(lang, 'التقاط صورة باركود', 'Prendre une photo')}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Last Scanned Feedback */}
          {lastFeedback && (
            <div
              className={`flex items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-xs font-bold ${
                lastFeedback.found
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-950'
                  : 'border-amber-300 bg-amber-50 text-amber-950'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <CheckCircle2
                  className={`h-4 w-4 shrink-0 ${
                    lastFeedback.found ? 'text-emerald-600' : 'text-amber-600'
                  }`}
                />
                <span className="truncate">
                  {lastFeedback.found
                    ? `${t(lang, 'تمت الإضافة للسلة:', 'Ajouté au panier :')} ${lastFeedback.label ?? lastFeedback.code}`
                    : `${t(lang, 'غير موجود:', 'Introuvable :')} ${lastFeedback.label ?? lastFeedback.code}`}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0 font-mono text-[11px]">
                {lastFeedback.found && lastFeedback.price !== undefined && (
                  <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-white tabular-nums">
                    {lastFeedback.price.toFixed(2)} {currency}
                  </span>
                )}
                <span className="opacity-70">{lastFeedback.code}</span>
              </div>
            </div>
          )}

          {/* Manual Barcode Fallback */}
          <form onSubmit={handleManualSubmit} className="flex items-center gap-2">
            <input
              type="text"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder={t(
                lang,
                'أو أدخل الباركود يدوياً واضغط Enter...',
                'Ou saisir le code-barres manuellement...'
              )}
              className="flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-mono focus:border-teal-600 focus:bg-white focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-lg bg-teal-700 px-4 py-2 text-xs font-bold text-white hover:bg-teal-800"
            >
              {t(lang, 'إضافة', 'Ajouter')}
            </button>
          </form>

          {/* Live Cart Summary Footer inside Scanner */}
          {typeof cartCount === 'number' && typeof cartTotal === 'number' && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-900 px-3.5 py-2.5 text-white">
              <div className="flex items-center gap-2 text-xs">
                <ShoppingCart className="h-4 w-4 text-lime-400" />
                <span className="font-bold">
                  {t(lang, `السلة: ${cartCount} منتج`, `Panier : ${cartCount}`)}
                </span>
                <span className="text-slate-400">·</span>
                <span className="font-mono font-black text-lime-300 tabular-nums">
                  {cartTotal.toFixed(2)} {currency}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  stopScanner().then(onClose);
                }}
                className="rounded-lg bg-lime-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-lime-400"
              >
                {t(lang, 'تم / العودة للسلة', 'Terminer')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
