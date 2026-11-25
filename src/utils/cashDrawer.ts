import { CashDrawerConfig } from '../types';

interface SerialPortLike {
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  getInfo?: () => { usbVendorId?: number; usbProductId?: number };
  readable?: unknown;
  writable?: WritableStream<Uint8Array> | null;
}

interface NavigatorWithSerial extends Navigator {
  serial?: {
    getPorts: () => Promise<SerialPortLike[]>;
    requestPort: (options?: unknown) => Promise<SerialPortLike>;
  };
}

export interface CashDrawerResult {
  ok: boolean;
  mode: 'serial_escpos' | 'printer_driver';
  needsPairing?: boolean;
  messageAr: string;
  messageFr: string;
}

export function isWebSerialSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as NavigatorWithSerial;
  return Boolean(nav.serial && typeof nav.serial.requestPort === 'function');
}

export async function getPairedSerialPortsCount(): Promise<number> {
  if (!isWebSerialSupported()) return 0;
  try {
    const nav = navigator as NavigatorWithSerial;
    const ports = await nav.serial!.getPorts();
    return ports.length;
  } catch {
    return 0;
  }
}

export function buildEscPosDrawerCommand(config: CashDrawerConfig): Uint8Array {
  // Optional custom hex override (e.g. "1B 70 00 19 FA" or Star "07")
  const customHex = (config.customHexCommand ?? '').trim();
  if (customHex) {
    const tokens = customHex.split(/[\s,]+/).filter(Boolean);
    const parsed: number[] = [];
    for (const tok of tokens) {
      const clean = tok.replace(/^0x/i, '');
      const val = parseInt(clean, 16);
      if (!Number.isNaN(val) && val >= 0 && val <= 255) {
        parsed.push(val);
      }
    }
    if (parsed.length > 0) {
      return new Uint8Array(parsed);
    }
  }

  // Standard ESC/POS Cash Drawer Kick: ESC p m t1 t2
  const pin = config.pin === 1 ? 1 : 0;
  const t1 = Math.min(255, Math.max(1, Math.round((config.onTimeMs || 100) / 2)));
  const t2 = Math.min(255, Math.max(1, Math.round((config.offTimeMs || 200) / 2)));
  return new Uint8Array([0x1b, 0x70, pin, t1, t2]);
}

export async function pairCashDrawerSerialPort(): Promise<{
  ok: boolean;
  label?: string;
  messageAr: string;
  messageFr: string;
}> {
  if (!isWebSerialSupported()) {
    return {
      ok: false,
      messageAr:
        'متصفحك لا يدعم Web Serial للاتصال المباشر. استخدم Chrome أو Edge على الحاسوب، أو اختر وضع «تعريف طابعة النظام».',
      messageFr:
        'Web Serial non supporté par ce navigateur. Utilisez Chrome/Edge sur ordinateur ou le mode « Pilote imprimante ».',
    };
  }

  try {
    const nav = navigator as NavigatorWithSerial;
    const port = await nav.serial!.requestPort();
    const info = port.getInfo?.();
    const vid = info?.usbVendorId ? info.usbVendorId.toString(16).toUpperCase().padStart(4, '0') : null;
    const pid = info?.usbProductId ? info.usbProductId.toString(16).toUpperCase().padStart(4, '0') : null;
    const label = vid && pid ? `USB ${vid}:${pid}` : 'COM / Serial Port';
    return {
      ok: true,
      label,
      messageAr: `تم ربط منفذ الدرج / الطابعة بنجاح (${label})`,
      messageFr: `Port tiroir / imprimante associé (${label})`,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NotFoundError' || name === 'AbortError') {
      return {
        ok: false,
        messageAr: 'تم إلغاء اختيار المنفذ.',
        messageFr: 'Sélection du port annulée.',
      };
    }
    return {
      ok: false,
      messageAr: err instanceof Error ? err.message : 'تعذر ربط المنفذ التسلسلي',
      messageFr: err instanceof Error ? err.message : 'Échec d’association du port série',
    };
  }
}

function triggerDriverPulsePrint(): void {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.style.opacity = '0';
  iframe.style.pointerEvents = 'none';
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (doc) {
    doc.open();
    doc.write(
      `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:80mm 10mm;margin:0}body{margin:0;padding:0;font-size:1px;color:#fff}</style></head><body>&nbsp;</body></html>`
    );
    doc.close();
  }

  const cleanup = () => {
    window.setTimeout(() => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }, 1000);
  };

  try {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
  } finally {
    cleanup();
  }
}

export async function openCashDrawer(
  config: CashDrawerConfig,
  options?: { promptPairIfNeeded?: boolean }
): Promise<CashDrawerResult> {
  if (!config.enabled) {
    return {
      ok: false,
      mode: config.mode,
      messageAr: 'ميزة درج النقدية (Tiroir) معطّلة في الإعدادات.',
      messageFr: 'La fonction tiroir-caisse est désactivée dans les paramètres.',
    };
  }

  if (config.mode === 'printer_driver') {
    try {
      triggerDriverPulsePrint();
      return {
        ok: true,
        mode: 'printer_driver',
        messageAr:
          'تم إرسال أمر فتح الدرج عبر طابعة النظام (تأكد من تفعيل خيار فتح الدرج في إعدادات تعريف الطابعة).',
        messageFr:
          'Commande d’ouverture envoyée au pilote imprimante (activez l’option tiroir dans le pilote).',
      };
    } catch (err) {
      return {
        ok: false,
        mode: 'printer_driver',
        messageAr: err instanceof Error ? err.message : 'تعذر إرسال أمر الطباعة للدرج',
        messageFr: err instanceof Error ? err.message : 'Échec de l’envoi vers l’imprimante',
      };
    }
  }

  // Direct ESC/POS over Web Serial
  if (!isWebSerialSupported()) {
    return {
      ok: false,
      mode: 'serial_escpos',
      messageAr:
        'المتصفح الحالي لا يدعم الاتصال المباشر (Web Serial). استخدم Chrome/Edge أو بدّل الوضع إلى «تعريف طابعة النظام» في الإعدادات.',
      messageFr:
        'Web Serial non disponible sur ce navigateur. Utilisez Chrome/Edge ou passez en mode « Pilote imprimante ».',
    };
  }

  const nav = navigator as NavigatorWithSerial;
  let port: SerialPortLike | undefined;

  try {
    const ports = await nav.serial!.getPorts();
    port = ports[0];

    if (!port) {
      if (options?.promptPairIfNeeded) {
        port = await nav.serial!.requestPort();
      } else {
        return {
          ok: false,
          mode: 'serial_escpos',
          needsPairing: true,
          messageAr:
            'لم يتم ربط منفذ الطابعة/الدرج بعد. اذهب إلى الإعدادات ← الطباعة ← درج النقدية لربط المنفذ.',
          messageFr:
            'Aucun port tiroir associé. Allez dans Paramètres → Impression → Tiroir-caisse pour l’associer.',
        };
      }
    }

    const command = buildEscPosDrawerCommand(config);
    let openedHere = false;

    if (!port.writable) {
      await port.open({ baudRate: config.baudRate || 9600 });
      openedHere = true;
    }

    if (!port.writable) {
      throw new Error('المنفذ غير قابل للكتابة / Port non accessible en écriture');
    }

    const writer = port.writable.getWriter();
    try {
      await writer.write(command);
    } finally {
      writer.releaseLock();
    }

    if (openedHere) {
      await port.close();
    }

    return {
      ok: true,
      mode: 'serial_escpos',
      messageAr: 'تم إرسال نبضة فتح درج النقدية (ESC/POS) بنجاح',
      messageFr: 'Impulsion d’ouverture du tiroir-caisse (ESC/POS) envoyée',
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NotFoundError' || name === 'AbortError') {
      return {
        ok: false,
        mode: 'serial_escpos',
        messageAr: 'تم إلغاء اختيار منفذ الدرج.',
        messageFr: 'Sélection du port annulée.',
      };
    }
    return {
      ok: false,
      mode: 'serial_escpos',
      messageAr:
        err instanceof Error
          ? `تعذر فتح الدرج: ${err.message}`
          : 'تعذر الاتصال بمنفذ درج النقدية',
      messageFr:
        err instanceof Error
          ? `Erreur tiroir-caisse : ${err.message}`
          : 'Impossible de communiquer avec le port série',
    };
  }
}
