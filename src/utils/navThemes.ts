import { SectionId } from '../types';

export interface NavTileTheme {
  imageUrl: string;
  cardGradient: string;
  hoverRing: string;
  borderColor: string;
  subtitleTint: string;
  quickBg: string;
}

export const NAV_TILE_THEMES: Record<string, NavTileTheme> = {
  customers: {
    imageUrl: '/src/assets/images/tile_customers_1795446827767.jpg',
    cardGradient: 'from-[#2563EB] via-[#1D4ED8] to-[#1E40AF]',
    hoverRing: 'hover:ring-[#93C5FD]',
    borderColor: 'border-[#1E3A8A]/50',
    subtitleTint: 'text-blue-100',
    quickBg: 'from-[#2563EB] to-[#1E40AF]',
  },
  suppliers: {
    imageUrl: '/src/assets/images/tile_suppliers_1795446828418.jpg',
    cardGradient: 'from-[#D97706] via-[#B45309] to-[#92400E]',
    hoverRing: 'hover:ring-[#FDE68A]',
    borderColor: 'border-[#78350F]/50',
    subtitleTint: 'text-amber-100',
    quickBg: 'from-[#D97706] to-[#92400E]',
  },
  inventory: {
    imageUrl: '/src/assets/images/tile_inventory_1795446831247.jpg',
    cardGradient: 'from-[#0D9488] via-[#0F766E] to-[#115E59]',
    hoverRing: 'hover:ring-[#5EEAD4]',
    borderColor: 'border-[#134E4A]/50',
    subtitleTint: 'text-teal-100',
    quickBg: 'from-[#0D9488] to-[#115E59]',
  },
  categories: {
    imageUrl: '/src/assets/images/tile_categories_1795446827771.jpg',
    cardGradient: 'from-[#7C3AED] via-[#6D28D9] to-[#5B21B6]',
    hoverRing: 'hover:ring-[#DDD6FE]',
    borderColor: 'border-[#4C1D95]/50',
    subtitleTint: 'text-violet-100',
    quickBg: 'from-[#7C3AED] to-[#5B21B6]',
  },
  pos: {
    imageUrl: '/src/assets/images/tile_pos_1795446829475.jpg',
    cardGradient: 'from-[#059669] via-[#047857] to-[#065F46]',
    hoverRing: 'hover:ring-[#6EE7B7]',
    borderColor: 'border-[#064E3B]/50',
    subtitleTint: 'text-emerald-100',
    quickBg: 'from-[#059669] to-[#065F46]',
  },
  purchases: {
    imageUrl: '/src/assets/images/tile_purchases_1795446829360.jpg',
    cardGradient: 'from-[#EA580C] via-[#C2410C] to-[#9A3412]',
    hoverRing: 'hover:ring-[#FDBA74]',
    borderColor: 'border-[#7C2D12]/50',
    subtitleTint: 'text-orange-100',
    quickBg: 'from-[#EA580C] to-[#9A3412]',
  },
  products: {
    imageUrl: '/src/assets/images/tile_products_1795446830948.jpg',
    cardGradient: 'from-[#0284C7] via-[#0369A1] to-[#075985]',
    hoverRing: 'hover:ring-[#7DD3FC]',
    borderColor: 'border-[#0C4A6E]/50',
    subtitleTint: 'text-sky-100',
    quickBg: 'from-[#0284C7] to-[#075985]',
  },
  stocktake: {
    imageUrl: '/src/assets/images/tile_stocktake_1795446834064.jpg',
    cardGradient: 'from-[#0891B2] via-[#0E7490] to-[#155E75]',
    hoverRing: 'hover:ring-[#67E8F9]',
    borderColor: 'border-[#164E63]/50',
    subtitleTint: 'text-cyan-100',
    quickBg: 'from-[#0891B2] to-[#155E75]',
  },
  dashboard: {
    imageUrl: '/src/assets/images/tile_dashboard_1795446828418.jpg',
    cardGradient: 'from-[#1E3A8A] via-[#1D357A] to-[#172554]',
    hoverRing: 'hover:ring-[#FCD34D]',
    borderColor: 'border-[#0F172A]/60',
    subtitleTint: 'text-indigo-100',
    quickBg: 'from-[#1E3A8A] to-[#172554]',
  },
  payments: {
    imageUrl: '/src/assets/images/tile_payments_1795446839712.jpg',
    cardGradient: 'from-[#CA8A04] via-[#A16207] to-[#854D0E]',
    hoverRing: 'hover:ring-[#FEF08A]',
    borderColor: 'border-[#713F12]/50',
    subtitleTint: 'text-yellow-100',
    quickBg: 'from-[#CA8A04] to-[#854D0E]',
  },
  reports: {
    imageUrl: '/src/assets/images/tile_reports_1795446831658.jpg',
    cardGradient: 'from-[#E11D48] via-[#BE123C] to-[#9F1239]',
    hoverRing: 'hover:ring-[#FDA4AF]',
    borderColor: 'border-[#881337]/50',
    subtitleTint: 'text-rose-100',
    quickBg: 'from-[#E11D48] to-[#9F1239]',
  },
  settings: {
    imageUrl: '/src/assets/images/tile_settings_1795446830648.jpg',
    cardGradient: 'from-[#475569] via-[#334155] to-[#1E293B]',
    hoverRing: 'hover:ring-[#CBD5E1]',
    borderColor: 'border-[#0F172A]/50',
    subtitleTint: 'text-slate-200',
    quickBg: 'from-[#475569] to-[#1E293B]',
  },
};

export function getNavTileTheme(id: SectionId): NavTileTheme {
  return NAV_TILE_THEMES[id] ?? NAV_TILE_THEMES.dashboard;
}
