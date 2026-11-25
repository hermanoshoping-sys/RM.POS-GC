/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  BarChart3,
  Boxes,
  Calendar,
  ClipboardCheck,
  Clock,
  FolderTree,
  LayoutDashboard,
  LayoutGrid,
  Lock,
  Package,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { AppProvider, useApp } from './context/AppContext';
import { NAV_SECTIONS, t } from './i18n/translations';
import { SectionId } from './types';
import { HomeLauncher } from './components/HomeLauncher';
import { DashboardModule, DashboardTabId } from './modules/DashboardModule';
import { CustomersModule } from './modules/CustomersModule';
import { SuppliersModule } from './modules/SuppliersModule';
import { CategoriesModule, CategoryTabId } from './modules/CategoriesModule';
import { ProductsModule } from './modules/ProductsModule';
import { PosModule } from './modules/PosModule';
import { PurchasesModule } from './modules/PurchasesModule';
import { InventoryModule, InventoryTabId } from './modules/InventoryModule';
import { StocktakeModule } from './modules/StocktakeModule';
import { PaymentsModule, PaymentTabId } from './modules/PaymentsModule';
import { ReportsModule, ReportTabId } from './modules/ReportsModule';
import { SettingsModule, SettingsTabId } from './modules/SettingsModule';
import { PrintModal } from './components/PrintModal';
import { DeletePasswordModal } from './components/DeletePasswordModal';
import { LockScreen } from './components/LockScreen';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import { getNavTileTheme } from './utils/navThemes';
import { canAccessSection, hasPermission } from './utils/permissions';

const SECTION_ICONS: Partial<Record<SectionId, React.ComponentType<{ className?: string }>>> = {
  dashboard: LayoutDashboard,
  customers: Users,
  suppliers: Truck,
  categories: FolderTree,
  products: Package,
  pos: ShoppingCart,
  purchases: ShoppingBag,
  inventory: Boxes,
  stocktake: ClipboardCheck,
  payments: Wallet,
  reports: BarChart3,
  settings: Settings,
};

const AppShell: React.FC = () => {
  const {
    ready,
    lang,
    setLang,
    activeSection,
    setActiveSection,
    settings,
    currentUser,
    isLocked,
    setIsLocked,
    toasts,
    dismissToast,
  } = useApp();

  const [quickNavOpen, setQuickNavOpen] = useState(false);
  const [dashboardTab, setDashboardTab] = useState<DashboardTabId>('overview');
  const [inventoryTab, setInventoryTab] = useState<InventoryTabId>('sold_log');
  const [categoryTab, setCategoryTab] = useState<CategoryTabId>('list');
  const [paymentsTab, setPaymentsTab] = useState<PaymentTabId>('customers');
  const [reportsTab, setReportsTab] = useState<ReportTabId>('sales');
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('security');
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-600 text-sm">
        {t(lang, 'جاري تحميل قاعدة البيانات المحلية...', 'Chargement de la base locale...')}
      </div>
    );
  }

  const activeNavDef = NAV_SECTIONS.find((n) => n.id === activeSection);
  const dateDisplay = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(
    now.getDate()
  ).padStart(2, '0')}`;
  const timeDisplay = `${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes()
  ).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

  const renderSection = () => {
    if (!canAccessSection(currentUser, activeSection)) {
      return (
        <div className="mx-auto my-12 max-w-md rounded-2xl border border-amber-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700">
            <Lock className="h-6 w-6" />
          </div>
          <h2 className="text-base font-bold text-slate-900">
            {t(lang, 'ليس لديك صلاحية فتح هذا القسم', 'Accès non autorisé à cette section')}
          </h2>
          <p className="mt-1.5 text-xs text-slate-600">
            {t(
              lang,
              'حسابك الحالي لا يملك الصلاحية المطلوبة. اطلب من مدير المتجر تعديل الصلاحيات من الإعدادات.',
              'Votre profil actuel ne dispose pas des droits requis. Contactez l’administrateur.'
            )}
          </p>
          <button
            type="button"
            onClick={() => setActiveSection('home')}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[#0B274D] px-4 py-2 text-xs font-bold text-white hover:bg-[#163d73]"
          >
            {t(lang, 'العودة إلى القائمة الرئيسية', 'Retour au menu principal')}
          </button>
        </div>
      );
    }

    switch (activeSection) {
      case 'home':
        return <HomeLauncher />;
      case 'dashboard':
        return <DashboardModule activeTab={dashboardTab} onTabChange={setDashboardTab} />;
      case 'customers':
        return <CustomersModule />;
      case 'suppliers':
        return <SuppliersModule />;
      case 'categories':
        return <CategoriesModule activeTab={categoryTab} onTabChange={setCategoryTab} />;
      case 'products':
        return <ProductsModule />;
      case 'pos':
        return <PosModule />;
      case 'purchases':
        return <PurchasesModule />;
      case 'inventory':
        return <InventoryModule activeTab={inventoryTab} onTabChange={setInventoryTab} />;
      case 'stocktake':
        return <StocktakeModule />;
      case 'payments':
        return <PaymentsModule activeTab={paymentsTab} onTabChange={setPaymentsTab} />;
      case 'reports':
        return (
          <ReportsModule
            activeTab={
              reportsTab === 'profits' && !hasPermission(currentUser, 'canViewProfits')
                ? 'sales'
                : reportsTab
            }
            onTabChange={setReportsTab}
          />
        );
      case 'profit_reports':
        return <ReportsModule initialTab="profits" activeTab="profits" onTabChange={setReportsTab} />;
      case 'settings':
        return <SettingsModule activeTab={settingsTab} onTabChange={setSettingsTab} />;
      default:
        return <HomeLauncher />;
    }
  };

  const showMobileBottomNav = activeSection !== 'pos' && activeSection !== 'purchases';

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900 flex flex-col">
      {/* Executive Navy & Gold Top Header Bar */}
      <header className="no-print sticky top-0 z-30 w-full bg-gradient-to-r from-[#041022] via-[#0B274D] to-[#041022] border-b-[3px] border-[#D9A738] shadow-md pt-safe">
        <div className="relative mx-auto flex h-14 sm:h-16 max-w-[1600px] items-center justify-between px-2.5 sm:px-5 lg:px-6 gap-2">
          {/* Start Zone (Right in RTL): Store Logo & Store Name */}
          <button
            type="button"
            onClick={() => setActiveSection('home')}
            className="flex items-center gap-2 sm:gap-2.5 min-w-0 text-start group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E5B84B] rounded-lg py-1"
            title={t(lang, 'العودة إلى القائمة الرئيسية', 'Retour au menu principal')}
          >
            {settings.storeInfo.logoDataUrl ? (
              <img
                src={settings.storeInfo.logoDataUrl}
                alt={settings.storeInfo.storeName}
                referrerPolicy="no-referrer"
                className="h-8 w-8 sm:h-9 sm:w-9 rounded-lg border border-[#D9A738]/60 bg-white/10 object-contain p-0.5 shrink-0"
              />
            ) : (
              <div className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-lg border border-[#D9A738]/60 bg-gradient-to-b from-[#173E73] to-[#0A2040] text-[#F5C656] font-extrabold text-sm shrink-0 shadow-inner">
                {settings.storeInfo.storeName.slice(0, 1) || 'م'}
              </div>
            )}
            <span className="hidden sm:inline text-sm lg:text-base font-bold tracking-tight text-white truncate max-w-[130px] md:max-w-[175px] lg:max-w-[230px] group-hover:text-[#FDE68A] transition-colors">
              {settings.storeInfo.storeName}
            </span>
          </button>

          {/* Center Zone (Desktop lg+): Sculpted Metallic Gold Crest (RM.POS GC Logo & Name) */}
          <button
            type="button"
            onClick={() => setActiveSection('home')}
            title={t(lang, 'القائمة الرئيسية — RM.POS GC', 'Menu principal — RM.POS GC')}
            className="hidden lg:flex absolute left-1/2 top-0 -translate-x-1/2 h-[60px] min-w-[300px] xl:min-w-[350px] items-center justify-center gap-2.5 px-10 bg-gradient-to-b from-[#FEF08A] via-[#F2B83B] to-[#C98512] text-[#1A1205] shadow-[0_6px_16px_rgba(0,0,0,0.45)] transition-transform duration-150 hover:brightness-105 focus-visible:outline-none [clip-path:polygon(0_0,100%_0,90%_100%,10%_100%)]"
          >
            <img
              src="/assets/aistudio/image_39bba8ff.png"
              alt="RM.POS GC"
              className="h-11 w-11 rounded-xl object-contain shadow-sm shrink-0"
            />
            <span
              dir="ltr"
              className="text-lg xl:text-xl font-black tracking-wide text-[#0B1F44] whitespace-nowrap"
            >
              RM.POS GC
            </span>
          </button>

          {/* Compact Phone & Tablet RM.POS GC Identity (prevents overlap on <1024px) */}
          <button
            type="button"
            onClick={() => setActiveSection('home')}
            className="flex lg:hidden items-center gap-1.5 sm:gap-2 rounded-lg bg-gradient-to-b from-[#FEF08A] via-[#F2B83B] to-[#C98512] px-2.5 sm:px-3.5 py-1 sm:py-1.5 shadow-sm shrink-0"
          >
            <img
              src="/assets/aistudio/image_39bba8ff.png"
              alt="RM.POS GC"
              className="h-7 w-7 sm:h-8 sm:w-8 rounded-md object-contain shrink-0"
            />
            <span dir="ltr" className="text-xs sm:text-sm font-black tracking-wide text-[#0B1F44] whitespace-nowrap">
              RM.POS GC
            </span>
          </button>

          {/* End Zone (Left in RTL): Live Date & Time + Utility Controls */}
          <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
            {/* Live Date & Clock (Full on xl+, compact time on md-lg) */}
            <div className="hidden md:flex items-center gap-2 border-s border-white/25 ps-2.5 text-xs text-white font-mono tabular-nums" dir="ltr">
              <span className="hidden xl:inline-flex items-center gap-1.5 font-semibold">
                <Calendar className="h-3.5 w-3.5 text-[#F4BE42]" />
                {dateDisplay}
              </span>
              <span className="hidden xl:inline text-white/30">|</span>
              <span className="inline-flex items-center gap-1.5 font-semibold">
                <Clock className="h-3.5 w-3.5 text-[#F4BE42]" />
                {timeDisplay}
              </span>
            </div>

            <PWAInstallButton lang={lang} />

            {/* Bilingual AR / FR Switch */}
            <div className="flex items-center rounded-lg border border-white/20 bg-white/10 p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => setLang('ar')}
                className={`min-h-[30px] rounded-md px-2 py-1 font-bold transition-colors ${
                  lang === 'ar' ? 'bg-[#F2B83B] text-slate-950' : 'text-blue-100 hover:text-white'
                }`}
              >
                AR
              </button>
              <button
                type="button"
                onClick={() => setLang('fr')}
                className={`min-h-[30px] rounded-md px-2 py-1 font-bold transition-colors ${
                  lang === 'fr' ? 'bg-[#F2B83B] text-slate-950' : 'text-blue-100 hover:text-white'
                }`}
              >
                FR
              </button>
            </div>

            {/* User & Lock */}
            <button
              type="button"
              onClick={() => setIsLocked(true)}
              title={`${currentUser?.fullName ?? 'Admin'} — ${t(lang, 'قفل النظام', 'Verrouiller')}`}
              className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-white/20 transition-colors shrink-0"
            >
              <Lock className="h-3.5 w-3.5 text-[#F4BE42]" />
              <span className="hidden xl:inline max-w-[100px] truncate">
                {currentUser?.fullName ?? 'Admin'}
              </span>
            </button>
          </div>
        </div>
      </header>

      {/* Contextual Sub-Bar when inside any module (except POS/Purchases which have their own amber bar) */}
      {activeSection !== 'home' && activeSection !== 'pos' && activeSection !== 'purchases' && (() => {
        const isFullWidthModule =
          activeSection === 'inventory' ||
          activeSection === 'categories' ||
          activeSection === 'payments' ||
          activeSection === 'reports' ||
          activeSection === 'profit_reports' ||
          activeSection === 'settings' ||
          activeSection === 'dashboard';

        const renderSubTabButtons = (
          items: readonly { id: string; ar: string; fr: string }[],
          currentId: string,
          onSelect: (id: string) => void
        ) => (
          <div className="order-3 xl:order-2 flex w-full xl:w-auto flex-nowrap sm:flex-wrap items-center justify-start sm:justify-center gap-1.5 sm:gap-2 overflow-x-auto no-scrollbar pb-0.5 sm:pb-0">
            {items.map((tab) => {
              const isActive = currentId === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onSelect(tab.id)}
                  className={`min-h-[36px] rounded-lg border-[1.5px] px-3 sm:px-3.5 py-1.5 text-xs sm:text-[13px] font-bold transition-all whitespace-nowrap shrink-0 ${
                    isActive
                      ? 'border-[#0B274D] bg-[#0B274D] text-[#FDE68A] shadow-sm'
                      : 'border-slate-900 bg-white text-slate-900 hover:bg-amber-50'
                  }`}
                >
                  {lang === 'ar' ? tab.ar : tab.fr}
                </button>
              );
            })}
          </div>
        );

        return (
          <div className="no-print border-b border-slate-200 bg-white">
            <div
              className={`mx-auto flex flex-wrap items-center justify-between gap-2 py-2 ${
                isFullWidthModule ? 'max-w-none px-2.5 sm:px-3 lg:px-4' : 'max-w-[1440px] px-2.5 sm:px-4 lg:px-6'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={() => setActiveSection('home')}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-[#2563A6] px-2.5 sm:px-3 py-1.5 text-xs font-bold text-white hover:bg-[#1C4F87] transition-colors whitespace-nowrap shrink-0"
                >
                  <ArrowRight className={`h-3.5 w-3.5 ${lang === 'fr' ? 'rotate-180' : ''}`} />
                  <span className="hidden sm:inline">{t(lang, 'القائمة الرئيسية', 'Menu principal')}</span>
                  <span className="sm:hidden">{t(lang, 'الرئيسية', 'Accueil')}</span>
                </button>

                <span className="text-slate-300">/</span>

                <span className="text-xs sm:text-sm font-bold text-slate-900 truncate">
                  {activeNavDef
                    ? lang === 'ar'
                      ? activeNavDef.labelAr
                      : activeNavDef.labelFr
                    : t(lang, 'التقارير', 'Rapports')}
                </span>
              </div>

              {activeSection === 'dashboard' &&
                renderSubTabButtons(
                  [
                    { id: 'overview', ar: 'نظرة عامة والرسوم', fr: 'Vue générale' },
                    { id: 'products', ar: 'المنتجات والمخزون', fr: 'Produits & Stock' },
                    { id: 'invoices', ar: 'آخر الفواتير', fr: 'Dernières factures' },
                    { id: 'balances', ar: 'الذمم والسيولة', fr: 'Créances & Dettes' },
                  ] as const,
                  dashboardTab,
                  (id) => setDashboardTab(id as DashboardTabId)
                )}

              {activeSection === 'inventory' &&
                renderSubTabButtons(
                  [
                    { id: 'sold_log', ar: 'سجل المنتجات المباعة', fr: 'Journal vendus' },
                    { id: 'sold_stock', ar: 'مخزون المنتجات المباعة', fr: 'Stock vendus' },
                    { id: 'remaining', ar: 'مخزون المنتجات المتبقية', fr: 'Stock restant' },
                    { id: 'purchased_log', ar: 'سجل المنتجات المشتراة', fr: 'Journal achetés' },
                  ] as const,
                  inventoryTab,
                  (id) => setInventoryTab(id as InventoryTabId)
                )}

              {activeSection === 'categories' &&
                renderSubTabButtons(
                  [
                    { id: 'list', ar: 'لائحة العائلات', fr: 'Liste des familles' },
                    { id: 'sales_stats', ar: 'مبيعات وأرباح العائلات', fr: 'Ventes & Profits' },
                    { id: 'stock_summary', ar: 'مخزون العائلات', fr: 'Stock par famille' },
                    { id: 'category_products', ar: 'منتجات العائلة', fr: 'Produits de la famille' },
                  ] as const,
                  categoryTab,
                  (id) => setCategoryTab(id as CategoryTabId)
                )}

              {activeSection === 'payments' &&
                renderSubTabButtons(
                  [
                    { id: 'customers', ar: 'دفعات الزبناء', fr: 'Paiements clients' },
                    { id: 'suppliers', ar: 'دفعات الموردين', fr: 'Paiements fournisseurs' },
                    { id: 'expenses', ar: 'المصاريف التشغيلية', fr: 'Dépenses' },
                    { id: 'cashflow', ar: 'ملخص الصندوق', fr: 'Flux de caisse' },
                  ] as const,
                  paymentsTab,
                  (id) => setPaymentsTab(id as PaymentTabId)
                )}

              {(activeSection === 'reports' || activeSection === 'profit_reports') &&
                renderSubTabButtons(
                  [
                    { id: 'sales', ar: 'تقارير المبيعات', fr: 'Rapports ventes' },
                    { id: 'stock', ar: 'المشتريات والمخزون', fr: 'Achats & Stock' },
                    { id: 'finance', ar: 'الديون والصندوق', fr: 'Dettes & Caisse' },
                    ...(hasPermission(currentUser, 'canViewProfits')
                      ? [{ id: 'profits', ar: 'تقارير الأرباح (COGS)', fr: 'Profits (COGS)' }]
                      : []),
                  ],
                  activeSection === 'profit_reports' ? 'profits' : reportsTab,
                  (id) => {
                    if (id === 'profits' && !hasPermission(currentUser, 'canViewProfits')) return;
                    if (activeSection === 'profit_reports') setActiveSection('reports');
                    setReportsTab(id as ReportTabId);
                  }
                )}

              {activeSection === 'settings' &&
                renderSubTabButtons(
                  [
                    { id: 'security', ar: 'الأمان والصلاحيات', fr: 'Sécurité' },
                    { id: 'store', ar: 'بيانات السوبر مارشي', fr: 'Magasin' },
                    { id: 'printing', ar: 'الطباعة', fr: 'Impression' },
                    { id: 'invoice', ar: 'تخصيص الفاتورة', fr: 'Factures' },
                    { id: 'backup', ar: 'النسخ الاحتياطي', fr: 'Sauvegarde' },
                  ] as const,
                  settingsTab,
                  (id) => setSettingsTab(id as SettingsTabId)
                )}

              <div className="order-2 xl:order-3 flex items-center gap-1.5 sm:gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setQuickNavOpen(true)}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 sm:px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                >
                  <LayoutGrid className="h-3.5 w-3.5 text-[#2563A6]" />
                  <span className="hidden xs:inline sm:inline">{t(lang, 'التنقل السريع', 'Navigation')}</span>
                </button>

                {hasPermission(currentUser, 'canSell') && (
                  <button
                    type="button"
                    onClick={() => setActiveSection('pos')}
                    className="hidden sm:inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-teal-800 whitespace-nowrap shrink-0"
                  >
                    <ShoppingCart className="h-3.5 w-3.5" />
                    {t(lang, 'نقطة بيع', 'POS')}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Main Content Area (Full-width without sidebar obstruction, with bottom safe space for mobile nav) */}
      <main
        className={`no-print flex-1 w-full mx-auto ${showMobileBottomNav ? 'pb-20 md:pb-6' : 'pb-4'} ${
          activeSection === 'pos' || activeSection === 'purchases'
            ? 'p-1.5 sm:p-2 lg:p-3 max-w-none'
            : activeSection === 'inventory' ||
                activeSection === 'categories' ||
                activeSection === 'payments' ||
                activeSection === 'reports' ||
                activeSection === 'profit_reports' ||
                activeSection === 'settings' ||
                activeSection === 'dashboard'
              ? 'p-2 sm:p-3.5 max-w-none'
              : activeSection === 'home'
                ? 'p-3 sm:p-6 lg:p-8 max-w-[1440px] flex items-start sm:items-center'
                : 'p-2.5 sm:p-4 lg:p-6 max-w-[1440px]'
        }`}
      >
        {renderSection()}
      </main>

      {/* Mobile Bottom Navigation Bar (Phones only, thumb-zone ergonomics) */}
      {showMobileBottomNav && (
        <nav
          aria-label={t(lang, 'التنقل السريع للهاتف', 'Navigation mobile')}
          className="no-print md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur-md shadow-[0_-4px_16px_rgba(15,23,42,0.08)] pb-safe"
        >
          <div className="grid grid-cols-5 items-center h-14 px-1">
            {[
              {
                id: 'home' as const,
                label: t(lang, 'الرئيسية', 'Accueil'),
                icon: LayoutDashboard,
                allowed: true,
                onClick: () => setActiveSection('home'),
              },
              {
                id: 'pos' as const,
                label: t(lang, 'نقطة بيع', 'POS'),
                icon: ShoppingCart,
                allowed: canAccessSection(currentUser, 'pos'),
                onClick: () => setActiveSection('pos'),
              },
              {
                id: 'inventory' as const,
                label: t(lang, 'المخزون', 'Stock'),
                icon: Boxes,
                allowed: canAccessSection(currentUser, 'inventory'),
                onClick: () => setActiveSection('inventory'),
              },
              {
                id: 'payments' as const,
                label: t(lang, 'الدفعات', 'Caisse'),
                icon: Wallet,
                allowed: canAccessSection(currentUser, 'payments'),
                onClick: () => setActiveSection('payments'),
              },
              {
                id: 'more' as const,
                label: t(lang, 'الأقسام', 'Menu'),
                icon: LayoutGrid,
                allowed: true,
                onClick: () => setQuickNavOpen(true),
              },
            ].map((item) => {
              const Icon = item.icon;
              const isActive =
                item.id === 'more'
                  ? quickNavOpen
                  : activeSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={!item.allowed}
                  onClick={item.onClick}
                  className={`flex flex-col items-center justify-center gap-0.5 min-h-[44px] rounded-lg px-1 transition-colors ${
                    !item.allowed
                      ? 'opacity-35 text-slate-400'
                      : isActive
                        ? 'text-[#0B274D] font-extrabold'
                        : 'text-slate-500 hover:text-slate-900 font-semibold'
                  }`}
                >
                  <span
                    className={`flex h-7 w-10 items-center justify-center rounded-full transition-colors ${
                      isActive ? 'bg-[#FCE08B] text-[#0B274D]' : ''
                    }`}
                  >
                    <Icon className="h-4.5 w-4.5" />
                  </span>
                  <span className="text-[10px] leading-tight truncate max-w-full">
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        </nav>
      )}

      {/* Quick Navigation Switcher Modal (Bottom-sheet style on mobile, centered on tablet/desktop) */}
      {quickNavOpen && (
        <div
          className="no-print fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/60 p-0 sm:p-4 backdrop-blur-[1px]"
          onClick={(e) => {
            if (e.target === e.currentTarget) setQuickNavOpen(false);
          }}
        >
          <div className="w-full max-w-2xl max-h-[88dvh] overflow-y-auto rounded-t-3xl sm:rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 shadow-2xl pb-safe">
            <div className="sm:hidden mx-auto mb-2.5 h-1.5 w-10 rounded-full bg-slate-300" />
            <div className="mb-3.5 flex items-center justify-between border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2">
                <LayoutGrid className="h-4 w-4 text-[#2563A6]" />
                <h3 className="text-sm font-bold text-slate-900">
                  {t(lang, 'التنقل السريع بين الأقسام', 'Navigation rapide')}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setQuickNavOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5 sm:gap-3">
              {NAV_SECTIONS.map((item) => {
                const Icon = SECTION_ICONS[item.id] ?? LayoutDashboard;
                const theme = getNavTileTheme(item.id);
                const isActive = activeSection === item.id;
                const allowed = canAccessSection(currentUser, item.id);
                const label = lang === 'ar' ? item.labelAr : item.labelFr;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={!allowed}
                    onClick={() => {
                      if (!allowed) return;
                      setActiveSection(item.id);
                      setQuickNavOpen(false);
                    }}
                    className={`relative flex flex-col items-center justify-center gap-1.5 sm:gap-2 rounded-2xl border ${theme.borderColor} bg-gradient-to-b ${theme.quickBg} px-2.5 py-2.5 sm:px-3 sm:py-3 text-center text-xs font-bold text-white transition-all ${
                      allowed ? 'hover:brightness-105 active:scale-[0.98]' : 'opacity-40 grayscale cursor-not-allowed'
                    } ${isActive ? 'ring-2 ring-[#E5B84B] shadow-md' : ''}`}
                  >
                    {!allowed && (
                      <span className="absolute top-2 end-2 rounded-full bg-slate-950/75 p-1">
                        <Lock className="h-3 w-3 text-amber-300" />
                      </span>
                    )}
                    <div className="h-11 w-11 sm:h-12 sm:w-12 overflow-hidden rounded-xl bg-white/95 shadow-sm ring-1 ring-white/40 flex items-center justify-center">
                      <img
                        src={theme.imageUrl}
                        alt={label}
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                      <Icon className="h-5 w-5 text-slate-700 hidden" />
                    </div>
                    <span className="truncate max-w-full drop-shadow-sm">{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Global Overlays */}
      <PrintModal />
      <DeletePasswordModal />
      {isLocked && <LockScreen />}
      <OfflineIndicator lang={lang} />

      {/* Toast Notifications */}
      <div className="no-print fixed bottom-16 md:bottom-4 inset-x-3 sm:inset-x-auto sm:end-4 z-50 flex flex-col gap-2 sm:max-w-sm">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            onClick={() => dismissToast(toast.id)}
            className={`cursor-pointer rounded-lg border px-4 py-2.5 text-xs font-semibold shadow-lg transition-all ${
              toast.type === 'error'
                ? 'border-red-200 bg-red-600 text-white'
                : toast.type === 'warning'
                  ? 'border-amber-200 bg-amber-500 text-white'
                  : 'border-teal-700 bg-slate-900 text-white'
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
};

export default function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}
