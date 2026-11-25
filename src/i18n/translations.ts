import { Language, PaymentMethod, SectionId } from '../types';

export interface NavItemDef {
  id: SectionId;
  index: number;
  labelAr: string;
  labelFr: string;
}

// 12-tile Launcher structure matching the executive 4x3 grid layout (with Profit Reports merged into Reports)
export const NAV_SECTIONS: NavItemDef[] = [
  { id: 'customers', index: 1, labelAr: 'الزبناء', labelFr: 'Clients' },
  { id: 'suppliers', index: 2, labelAr: 'الموردون', labelFr: 'Fournisseurs' },
  { id: 'inventory', index: 3, labelAr: 'المخزون', labelFr: 'Stock' },
  { id: 'categories', index: 4, labelAr: 'عائلات المنتجات', labelFr: 'Familles' },
  { id: 'pos', index: 5, labelAr: 'نقطة بيع', labelFr: 'Point de vente' },
  { id: 'purchases', index: 6, labelAr: 'نقطة المشتريات', labelFr: 'Achats' },
  { id: 'products', index: 7, labelAr: 'المنتجات', labelFr: 'Produits' },
  { id: 'stocktake', index: 8, labelAr: 'جرد المخزون', labelFr: 'Inventaire' },
  { id: 'dashboard', index: 9, labelAr: 'الواجهة الرئيسية', labelFr: 'Tableau de bord' },
  { id: 'payments', index: 10, labelAr: 'الدفعات', labelFr: 'Paiements' },
  { id: 'reports', index: 11, labelAr: 'التقارير', labelFr: 'Rapports & Profits' },
  { id: 'settings', index: 12, labelAr: 'الإعدادات', labelFr: 'Paramètres' },
];

export const PAYMENT_METHODS: { value: PaymentMethod; ar: string; fr: string }[] = [
  { value: 'cash', ar: 'نقداً', fr: 'Espèces' },
  { value: 'card', ar: 'بطاقة بنكية', fr: 'Carte bancaire' },
  { value: 'bank_transfer', ar: 'تحويل بنكي', fr: 'Virement bancaire' },
  { value: 'check', ar: 'شيك', fr: 'Chèque' },
  { value: 'credit', ar: 'آجل (دين)', fr: 'Crédit' },
];

export const PRODUCT_UNITS = [
  { value: 'قطعة', ar: 'قطعة', fr: 'Pièce' },
  { value: 'كيلوغرام', ar: 'كيلوغرام', fr: 'Kilogramme (kg)' },
  { value: 'غرام', ar: 'غرام', fr: 'Gramme (g)' },
  { value: 'لتر', ar: 'لتر', fr: 'Litre (L)' },
  { value: 'علبة', ar: 'علبة', fr: 'Boîte' },
  { value: 'قنينة', ar: 'قنينة', fr: 'Bouteille' },
  { value: 'حزمة', ar: 'حزمة', fr: 'Pack' },
  { value: 'كرتون', ar: 'كرتون', fr: 'Carton' },
];

export const EXPENSE_CATEGORIES = [
  { value: 'rent', ar: 'كراء المحل', fr: 'Loyer' },
  { value: 'electricity_water', ar: 'الماء والكهرباء', fr: 'Eau & Électricité' },
  { value: 'salaries', ar: 'أجور العمال', fr: 'Salaires' },
  { value: 'transport', ar: 'النقل والتوصيل', fr: 'Transport' },
  { value: 'maintenance', ar: 'الصيانة والتجهيز', fr: 'Maintenance' },
  { value: 'telecom', ar: 'الهاتف والإنترنت', fr: 'Télécom & Internet' },
  { value: 'taxes', ar: 'الضرائب والرسوم', fr: 'Taxes & Impôts' },
  { value: 'other', ar: 'مصاريف أخرى', fr: 'Autres frais' },
];

export function t(lang: Language, ar: string, fr: string): string {
  return lang === 'ar' ? ar : fr;
}

export function formatMoney(amount: number, currency = 'MAD'): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `${safe.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

export function formatDateTime(iso: string, lang: Language): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(lang === 'ar' ? 'ar-MA' : 'fr-FR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateOnly(iso: string): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

export function getPaymentMethodLabel(method: PaymentMethod, lang: Language): string {
  const found = PAYMENT_METHODS.find((m) => m.value === method);
  return found ? (lang === 'ar' ? found.ar : found.fr) : method;
}

export function getStatusLabel(status: string, lang: Language): string {
  const map: Record<string, { ar: string; fr: string }> = {
    paid: { ar: 'مؤداة بالكامل', fr: 'Payée' },
    partial: { ar: 'دفع جزئي', fr: 'Partielle' },
    unpaid: { ar: 'غير مؤداة (آجل)', fr: 'Impayée (Crédit)' },
    cancelled: { ar: 'ملغاة', fr: 'Annulée' },
  };
  const item = map[status];
  return item ? (lang === 'ar' ? item.ar : item.fr) : status;
}

export function getExpenseCategoryLabel(cat: string, lang: Language): string {
  const found = EXPENSE_CATEGORIES.find((c) => c.value === cat);
  return found ? (lang === 'ar' ? found.ar : found.fr) : cat;
}
