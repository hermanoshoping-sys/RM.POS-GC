export type QuickPeriodId =
  | 'all'
  | 'today'
  | 'this_week'
  | 'this_month'
  | 'last_month'
  | 'this_year'
  | 'last_year'
  | 'custom';

export const toLocalIsoDate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const getQuickPeriodRange = (
  period: Exclude<QuickPeriodId, 'all' | 'custom'>
): { from: string; to: string } => {
  const now = new Date();
  const today = toLocalIsoDate(now);

  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'this_week': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const diffToMonday = (start.getDay() + 6) % 7;
      start.setDate(start.getDate() - diffToMonday);
      return { from: toLocalIsoDate(start), to: today };
    }
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: toLocalIsoDate(start), to: today };
    }
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: toLocalIsoDate(start), to: toLocalIsoDate(end) };
    }
    case 'this_year': {
      const start = new Date(now.getFullYear(), 0, 1);
      return { from: toLocalIsoDate(start), to: today };
    }
    case 'last_year': {
      const start = new Date(now.getFullYear() - 1, 0, 1);
      const end = new Date(now.getFullYear() - 1, 11, 31);
      return { from: toLocalIsoDate(start), to: toLocalIsoDate(end) };
    }
  }
};

export const QUICK_PERIODS: {
  id: Exclude<QuickPeriodId, 'all' | 'custom'>;
  ar: string;
  fr: string;
}[] = [
  { id: 'today', ar: 'اليوم', fr: "Aujourd'hui" },
  { id: 'this_week', ar: 'هذا الاسبوع', fr: 'Cette semaine' },
  { id: 'this_month', ar: 'هذا الشهر', fr: 'Ce mois' },
  { id: 'last_month', ar: 'الشهر الماضي', fr: 'Mois dernier' },
  { id: 'this_year', ar: 'هذه السنة', fr: 'Cette année' },
  { id: 'last_year', ar: 'السنة الماضية', fr: 'Année dernière' },
];
