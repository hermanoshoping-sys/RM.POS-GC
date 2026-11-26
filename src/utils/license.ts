import { computeSha256 } from './crypto';

const LICENSE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LICENSE_REGEX = /^RMGC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const ACTIVATION_REGEX = /^ACT-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(raw?: string | null): string {
  return (raw ?? '').trim().toLowerCase();
}

export function isValidEmail(raw?: string | null): boolean {
  const clean = normalizeEmail(raw);
  return clean.length >= 5 && clean.length <= 254 && EMAIL_REGEX.test(clean);
}

export function normalizePhone(raw?: string | null): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  return hasPlus ? `+${digits}` : digits;
}

export function isValidPhone(raw?: string | null): boolean {
  const norm = normalizePhone(raw);
  const digitsOnly = norm.replace(/\D/g, '');
  return digitsOnly.length >= 8 && digitsOnly.length <= 15;
}

export function looksLikeEmail(raw: string): boolean {
  return raw.includes('@');
}

export function looksLikePhone(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('@')) return false;
  return /^[+\d\s\-().]{8,20}$/.test(trimmed) && isValidPhone(trimmed);
}

export function normalizeLicenseNumber(raw?: string | null): string {
  const cleaned = (raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  const body = cleaned.startsWith('RMGC') ? cleaned.slice(4) : cleaned;
  if (body.length === 12) {
    return `RMGC-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
  }
  return (raw ?? '').trim().toUpperCase();
}

export function isValidLicenseFormat(raw?: string | null): boolean {
  return LICENSE_REGEX.test(normalizeLicenseNumber(raw));
}

export function normalizeActivationCode(raw?: string | null): string {
  const cleaned = (raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  const body = cleaned.startsWith('ACT') ? cleaned.slice(3) : cleaned;
  if (body.length === 8) {
    return `ACT-${body.slice(0, 4)}-${body.slice(4, 8)}`;
  }
  return (raw ?? '').trim().toUpperCase();
}

export function isValidActivationFormat(raw?: string | null): boolean {
  return ACTIVATION_REGEX.test(normalizeActivationCode(raw));
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Cryptographically derives the canonical activation code for a normalized license number.
 */
export async function deriveActivationCodeForLicense(licenseNumber: string): Promise<string> {
  const normalized = normalizeLicenseNumber(licenseNumber);
  if (!isValidLicenseFormat(normalized)) {
    throw new Error('صيغة رقم الرخصة غير صالحة (المتوقع: RMGC-XXXX-XXXX-XXXX)');
  }
  const digestHex = await computeSha256(`RM.POS.GC::LICENSE_ACTIVATION::V1::${normalized}`);
  let chars = '';
  for (let i = 0; i < 8; i++) {
    const byteVal = parseInt(digestHex.slice(i * 2, i * 2 + 2), 16);
    chars += LICENSE_ALPHABET[byteVal % LICENSE_ALPHABET.length];
  }
  return `ACT-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

/**
 * Verifies that an activation code cryptographically matches the given license number.
 */
export async function verifyLicenseActivationPair(
  licenseNumber: string,
  activationCode: string
): Promise<boolean> {
  const normLicense = normalizeLicenseNumber(licenseNumber);
  const normCode = normalizeActivationCode(activationCode);
  if (!isValidLicenseFormat(normLicense) || !isValidActivationFormat(normCode)) {
    return false;
  }
  const expected = await deriveActivationCodeForLicense(normLicense);
  return constantTimeEquals(normCode, expected);
}

/**
 * Generates a fresh random license number and its matching activation code.
 */
export async function generateLicensePair(): Promise<{
  licenseNumber: string;
  activationCode: string;
}> {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let raw = '';
  for (let i = 0; i < 12; i++) {
    raw += LICENSE_ALPHABET[bytes[i] % LICENSE_ALPHABET.length];
  }
  const licenseNumber = `RMGC-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  const activationCode = await deriveActivationCodeForLicense(licenseNumber);
  return { licenseNumber, activationCode };
}
