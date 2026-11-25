import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BarChart3,
  Boxes,
  ClipboardCheck,
  FolderTree,
  LayoutDashboard,
  Lock,
  Package,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
} from 'lucide-react';
import { db } from '../db/database';
import { useApp } from '../context/AppContext';
import { formatMoney, NAV_SECTIONS, t } from '../i18n/translations';
import { SectionId } from '../types';
import { getNavTileTheme } from '../utils/navThemes';
import { canAccessSection } from '../utils/permissions';

const TILE_ICONS: Partial<Record<SectionId, React.ComponentType<{ className?: string }>>> = {
  customers: Users,
  suppliers: Truck,
  inventory: Boxes,
  categories: FolderTree,
  pos: ShoppingCart,
  purchases: ShoppingBag,
  products: Package,
  stocktake: ClipboardCheck,
  dashboard: LayoutDashboard,
  payments: Wallet,
  reports: BarChart3,
  settings: Settings,
};

export const HomeLauncher: React.FC = () => {
  const { lang, settings, currentUser, setActiveSection } = useApp();
  const cur = settings.storeInfo.currency || 'MAD';
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});

  const customersCount = useLiveQuery(() => db.customers.count(), []) ?? 0;
  const suppliersCount = useLiveQuery(() => db.suppliers.count(), []) ?? 0;
  const categoriesCount = useLiveQuery(() => db.categories.count(), []) ?? 0;
  const products = useLiveQuery(() => db.products.toArray(), []) ?? [];
  const sales = useLiveQuery(() => db.saleInvoices.toArray(), []) ?? [];
  const purchases = useLiveQuery(() => db.purchaseInvoices.toArray(), []) ?? [];
  const installments = useLiveQuery(() => db.installments.toArray(), []) ?? [];

  const liveStats = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const todaySales = sales
      .filter((s) => s.status !== 'cancelled' && s.date.slice(0, 10) === today)
      .reduce((sum, s) => sum + s.total, 0);
    const lowStockCount = products.filter((p) => p.isActive && p.quantity <= p.minStock).length;
    const validPurchasesCount = purchases.filter((p) => p.status !== 'cancelled').length;
    const totalStockUnits = products.reduce((sum, p) => sum + Math.max(0, p.quantity), 0);
    const overdueInstallmentsCount = installments.filter(
      (i) => i.remainingAmount > 0.005 && i.dueDate < today
    ).length;

    return {
      todaySales,
      lowStockCount,
      validPurchasesCount,
      totalStockUnits,
      overdueInstallmentsCount,
    };
  }, [products, sales, purchases, installments]);

  const getSubtitle = (id: SectionId): string => {
    switch (id) {
      case 'customers':
        return liveStats.overdueInstallmentsCount > 0
          ? t(
              lang,
              `${customersCount} زبون • ${liveStats.overdueInstallmentsCount} قسط متأخر`,
              `${customersCount} clients • ${liveStats.overdueInstallmentsCount} échéance(s) en retard`
            )
          : t(lang, `${customersCount} زبون مسجل`, `${customersCount} clients`);
      case 'suppliers':
        return t(lang, `${suppliersCount} مورد مسجل`, `${suppliersCount} fournisseurs`);
      case 'inventory':
        return liveStats.lowStockCount > 0
          ? t(lang, `${liveStats.lowStockCount} تنبيه مخزون منخفض`, `${liveStats.lowStockCount} alertes stock`)
          : t(lang, `${Math.round(liveStats.totalStockUnits)} وحدة بالمخزون`, `${Math.round(liveStats.totalStockUnits)} unités`);
      case 'categories':
        return t(lang, `${categoriesCount} عائلة منتجات`, `${categoriesCount} familles`);
      case 'pos':
        return t(
          lang,
          `اليوم: ${formatMoney(liveStats.todaySales, cur)}`,
          `Jour : ${formatMoney(liveStats.todaySales, cur)}`
        );
      case 'purchases':
        return t(
          lang,
          `${liveStats.validPurchasesCount} فاتورة مشتريات`,
          `${liveStats.validPurchasesCount} factures d'achat`
        );
      case 'products':
        return t(lang, `${products.length} منتج مسجل`, `${products.length} produits`);
      case 'stocktake':
        return t(lang, 'جرد وتسوية الفروقات', 'Inventaire & écarts');
      case 'dashboard':
        return t(lang, 'ملخص الأداء والإحصائيات', 'KPIs & graphiques');
      case 'payments':
        return liveStats.overdueInstallmentsCount > 0
          ? t(
              lang,
              `${liveStats.overdueInstallmentsCount} قسط مستحق للتحصيل`,
              `${liveStats.overdueInstallmentsCount} échéance(s) à encaisser`
            )
          : t(lang, 'التحصيلات والأقساط والمصاريف', 'Encaissements & échéances');
      case 'reports':
        return t(lang, '21 تقريراً + تقارير الأرباح', '21 rapports + Profits');
      case 'settings':
        return t(lang, 'المتجر، الطباعة والنسخ', 'Magasin & sauvegarde');
      default:
        return '';
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1280px] py-1 sm:py-5 lg:py-8">
      {/* 2-col Phone / 3-col Tablet / 4-col Desktop Color-Coded Illustrated Launcher Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 md:gap-5 lg:gap-6">
        {NAV_SECTIONS.map((item) => {
          const Icon = TILE_ICONS[item.id] ?? LayoutDashboard;
          const theme = getNavTileTheme(item.id);
          const allowed = canAccessSection(currentUser, item.id);
          const subtitle = allowed
            ? getSubtitle(item.id)
            : t(lang, 'غير متاح لصلاحيات حسابك', 'Accès restreint');
          const label = lang === 'ar' ? item.labelAr : item.labelFr;
          const imageFailed = Boolean(failedImages[item.id]);

          return (
            <button
              key={item.id}
              type="button"
              disabled={!allowed}
              onClick={() => allowed && setActiveSection(item.id)}
              title={
                allowed
                  ? label
                  : t(lang, 'ليس لديك صلاحية فتح هذا القسم', 'Accès non autorisé pour ce profil')
              }
              className={`group relative flex flex-col items-center justify-center gap-2 sm:gap-3 rounded-2xl sm:rounded-[24px] border ${theme.borderColor} bg-gradient-to-b ${theme.cardGradient} px-2.5 py-3.5 sm:px-4 sm:py-5 lg:py-6 text-center text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.32),0_10px_22px_-8px_rgba(15,23,42,0.32)] transition-all duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                allowed
                  ? `hover:-translate-y-1 hover:brightness-105 hover:ring-2 ${theme.hoverRing} hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.42),0_18px_30px_-10px_rgba(15,23,42,0.42)] active:translate-y-0 active:scale-[0.985]`
                  : 'opacity-45 grayscale cursor-not-allowed'
              } focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#E5B84B]`}
            >
              {!allowed && (
                <span className="absolute top-2 end-2 sm:top-3 sm:end-3 inline-flex items-center gap-1 rounded-full bg-slate-950/75 px-1.5 sm:px-2 py-0.5 sm:py-1 text-[9px] sm:text-[10px] font-bold text-amber-300">
                  <Lock className="h-3 w-3" />
                  <span className="hidden sm:inline">{t(lang, 'مقفل', 'Verrouillé')}</span>
                </span>
              )}

              {allowed &&
                (item.id === 'customers' || item.id === 'payments') &&
                liveStats.overdueInstallmentsCount > 0 && (
                  <span className="absolute top-2 end-2 sm:top-3 sm:end-3 inline-flex items-center rounded-full bg-red-600 px-1.5 sm:px-2 py-0.5 text-[9px] sm:text-[10px] font-extrabold text-white shadow">
                    {liveStats.overdueInstallmentsCount}{' '}
                    {t(lang, 'متأخر', 'retard')}
                  </span>
                )}

              {/* Custom 3D Isometric Tile Artwork with Guaranteed Icon Fallback */}
              <div className="relative h-16 w-16 sm:h-24 sm:w-24 lg:h-28 lg:w-28 overflow-hidden rounded-xl sm:rounded-2xl bg-white/95 shadow-md ring-2 ring-white/35 transition-transform duration-150 group-hover:scale-105">
                {!imageFailed ? (
                  <img
                    src={theme.imageUrl}
                    alt={label}
                    referrerPolicy="no-referrer"
                    onError={() =>
                      setFailedImages((prev) => ({ ...prev, [item.id]: true }))
                    }
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-white/15">
                    <Icon className="h-8 w-8 sm:h-10 sm:w-10 text-slate-700" />
                  </div>
                )}
              </div>

              {/* Bold Tile Title & Live Contextual Counter */}
              <div className="space-y-0.5 w-full min-w-0">
                <div className="text-sm sm:text-base lg:text-lg font-extrabold tracking-tight text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.28)] truncate">
                  {label}
                </div>
                <div className={`text-[10px] sm:text-xs font-medium ${theme.subtitleTint} tabular-nums truncate w-full`}>
                  {subtitle}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
