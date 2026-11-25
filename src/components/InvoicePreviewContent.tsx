import React from 'react';
import {
  AppSettings,
  InvoiceAlign,
  InvoiceBorderStyle,
  InvoiceLogoShape,
  InvoiceSurfaceBg,
  SaleInvoice,
} from '../types';
import { formatDateTime, formatMoney, getPaymentMethodLabel, getStatusLabel, t } from '../i18n/translations';

export const DEFAULT_INVOICE_LOGO = '/assets/aistudio/image_39bba8ff.png';

export function getInvoiceAlignClass(align: InvoiceAlign): string {
  if (align === 'center') return 'text-center items-center';
  if (align === 'left') return 'text-left items-start';
  return 'text-right items-end';
}

export function getLogoSelfAlignClass(logoAlign: 'inherit' | InvoiceAlign, dir: 'rtl' | 'ltr'): string {
  if (logoAlign === 'inherit') return '';
  if (logoAlign === 'center') return 'self-center';
  if (logoAlign === 'left') return dir === 'rtl' ? 'self-end' : 'self-start';
  return dir === 'rtl' ? 'self-start' : 'self-end';
}

export function getLogoShapeClass(shape: InvoiceLogoShape): string {
  if (shape === 'circle') return 'rounded-full';
  if (shape === 'rounded') return 'rounded-xl';
  return 'rounded-none';
}

export function getSurfaceBgClass(bg: InvoiceSurfaceBg): {
  container: string;
  primaryText: string;
  secondaryText: string;
  mutedText: string;
} {
  switch (bg) {
    case 'navy':
      return {
        container: 'bg-[#0B274D] text-white px-3 rounded-md',
        primaryText: 'text-[#FDE68A]',
        secondaryText: 'text-slate-100',
        mutedText: 'text-slate-300',
      };
    case 'gold':
      return {
        container: 'bg-[#FEF3C7] text-slate-900 px-3 rounded-md',
        primaryText: 'text-slate-950',
        secondaryText: 'text-slate-800',
        mutedText: 'text-slate-700',
      };
    case 'light':
      return {
        container: 'bg-slate-100 text-slate-900 px-3 rounded-md',
        primaryText: 'text-slate-900',
        secondaryText: 'text-slate-700',
        mutedText: 'text-slate-600',
      };
    default:
      return {
        container: 'bg-transparent text-slate-900',
        primaryText: 'text-slate-900',
        secondaryText: 'text-slate-600',
        mutedText: 'text-slate-500',
      };
  }
}

export function getBorderClass(
  position: 'bottom' | 'top',
  style: InvoiceBorderStyle,
  isModernHeader = false
): string {
  if (style === 'none') return '';
  const edge = position === 'bottom' ? 'border-b' : 'border-t';
  if (style === 'double') return `${edge}-4 border-double border-slate-400`;
  if (style === 'solid') {
    return isModernHeader ? `${edge}-2 border-[#0B274D]` : `${edge} border-slate-400`;
  }
  return `${edge} border-dashed border-slate-300`;
}

interface InvoicePreviewProps {
  invoice: SaleInvoice;
  settings: AppSettings;
  format: 'a4' | '80mm' | '58mm';
}

export const InvoicePreviewContent: React.FC<InvoicePreviewProps> = ({
  invoice,
  settings,
  format,
}) => {
  const isThermal = format !== 'a4';
  const is58 = format === '58mm';
  const cfg = isThermal ? settings.invoiceCustomization.thermal : settings.invoiceCustomization.a4;
  const invLang = settings.invoiceCustomization.invoiceLanguage || 'ar';
  const store = settings.storeInfo;
  const cur = store.currency || 'MAD';
  const dir = invLang === 'ar' ? 'rtl' : 'ltr';

  // Clamp thermal 58mm font size so narrow rolls never wrap awkwardly or clip
  const effectiveFontSize = is58
    ? Math.max(8.5, Math.min(cfg.fontSize - 1.5, 10.5))
    : format === '80mm'
      ? Math.max(9.5, Math.min(cfg.fontSize, 13))
      : cfg.fontSize;

  const headerAlignClass = getInvoiceAlignClass(cfg.headerAlign);
  const footerAlignClass = getInvoiceAlignClass(cfg.footerAlign);
  const headerSurface = getSurfaceBgClass(cfg.headerBgColor);
  const footerSurface = getSurfaceBgClass(cfg.footerBgColor);

  const logoSrc = store.logoDataUrl || DEFAULT_INVOICE_LOGO;
  const effectiveLogoWidth = is58 ? Math.min(cfg.logoWidth, 165) : cfg.logoWidth;
  const effectiveLogoHeight = is58 ? Math.min(cfg.logoHeight, 95) : cfg.logoHeight;
  const effectiveHeaderFontSize = is58
    ? Math.max(11, Math.min(cfg.headerFontSize, 16))
    : cfg.headerFontSize;
  const effectiveFooterFontSize = is58
    ? Math.max(8, Math.min(cfg.footerFontSize, 11))
    : cfg.footerFontSize;

  const containerWidth = is58
    ? 'w-[58mm] max-w-full px-2 py-2.5'
    : format === '80mm'
      ? 'w-[80mm] max-w-full px-3 py-3.5'
      : 'w-full max-w-[780px] p-7 sm:p-8';

  const renderSection = (section: 'header' | 'meta' | 'items' | 'totals' | 'footer') => {
    switch (section) {
      case 'header':
        if (!cfg.showHeader) return null;
        return (
          <div
            key="header"
            style={{
              paddingTop: `${cfg.headerPaddingY}px`,
              paddingBottom: `${cfg.headerPaddingY}px`,
            }}
            className={`flex flex-col ${is58 ? 'gap-0.5' : 'gap-1'} ${headerSurface.container} ${getBorderClass(
              'bottom',
              cfg.headerBorderStyle,
              cfg.template === 'modern'
            )} ${headerAlignClass}`}
          >
            {cfg.showLogo && logoSrc && (
              <img
                src={logoSrc}
                alt={store.storeName}
                referrerPolicy="no-referrer"
                style={{
                  width: `${effectiveLogoWidth}px`,
                  height: `${effectiveLogoHeight}px`,
                  maxWidth: '100%',
                }}
                className={`${cfg.logoKeepAspect ? 'object-contain' : 'object-fill'} ${getLogoShapeClass(
                  cfg.logoShape
                )} ${getLogoSelfAlignClass(cfg.logoAlign, dir)} mb-1 shrink-0`}
              />
            )}
            {cfg.showCustomHeader && settings.invoiceCustomization.customHeaderText && (
              <div className={`font-semibold text-[0.95em] ${headerSurface.secondaryText}`}>
                {settings.invoiceCustomization.customHeaderText}
              </div>
            )}
            {cfg.showStoreName && (
              <div
                style={{ fontSize: `${effectiveHeaderFontSize}px` }}
                className={`font-bold leading-tight ${headerSurface.primaryText}`}
              >
                {store.storeName}
              </div>
            )}
            {cfg.showActivity && store.activityInfo && (
              <div className={`leading-snug ${headerSurface.secondaryText}`}>{store.activityInfo}</div>
            )}
            {cfg.showAddress && store.address && (
              <div className={`leading-snug ${headerSurface.secondaryText}`}>
                {store.address}
                {store.city ? ` · ${store.city}` : ''}
              </div>
            )}
            {cfg.showPhone && store.phone && (
              <div className={`font-mono ${headerSurface.secondaryText}`}>
                {t(invLang, 'الهاتف:', 'Tél :')} {store.phone}
              </div>
            )}
            {cfg.showTaxId && store.taxId && (
              <div className={`font-mono text-[0.9em] ${headerSurface.mutedText}`}>{store.taxId}</div>
            )}
            {cfg.showExtraHeader && store.extraInvoiceInfo && (
              <div className={`text-[0.9em] ${headerSurface.mutedText}`}>{store.extraInvoiceInfo}</div>
            )}
          </div>
        );

      case 'meta':
        return (
          <div
            key="meta"
            className={`${is58 ? 'py-1.5 space-y-0.5' : 'py-2.5'} border-b border-slate-200 ${
              isThermal ? 'space-y-1' : 'grid grid-cols-2 gap-3'
            }`}
          >
            <div>
              <div className="font-semibold text-slate-900">
                {t(invLang, 'فاتورة بيع رقم:', 'Facture N° :')}{' '}
                <span className="font-mono">{invoice.invoiceNumber}</span>
              </div>
              <div className="text-slate-600">
                {t(invLang, 'التاريخ:', 'Date :')} {formatDateTime(invoice.date, invLang)}
              </div>
              {cfg.showSellerName && (
                <div className="text-slate-600">
                  {t(invLang, 'البائع:', 'Vendeur :')} {invoice.sellerName}
                </div>
              )}
            </div>
            {cfg.showCustomerInfo && (
              <div className={isThermal ? '' : 'text-end'}>
                <div className="font-medium text-slate-900">
                  {t(invLang, 'الزبون:', 'Client :')} {invoice.customerName}
                </div>
                <div className="text-slate-600">
                  {t(invLang, 'الحالة:', 'Statut :')} {getStatusLabel(invoice.status, invLang)}
                </div>
                <div className="text-slate-600">
                  {t(invLang, 'طريقة الدفع:', 'Paiement :')}{' '}
                  {getPaymentMethodLabel(invoice.paymentMethod, invLang)}
                </div>
              </div>
            )}
          </div>
        );

      case 'items':
        return (
          <div key="items" className={is58 ? 'py-1.5' : 'py-2.5'}>
            <table className="w-full border-collapse table-fixed">
              <thead>
                <tr
                  className={
                    cfg.template === 'modern'
                      ? 'bg-slate-900 text-white'
                      : 'border-b border-slate-300 text-slate-700'
                  }
                >
                  <th
                    className={`${is58 ? 'py-1 px-0.5 w-[44%]' : 'py-1.5 px-1.5 w-[46%]'} text-start font-semibold`}
                  >
                    {t(invLang, 'المنتج', 'Article')}
                  </th>
                  <th
                    className={`${is58 ? 'py-1 px-0.5 w-[14%]' : 'py-1.5 px-1 w-[14%]'} text-center font-semibold`}
                  >
                    {is58 ? t(invLang, 'ك', 'Q') : t(invLang, 'الكمية', 'Qté')}
                  </th>
                  <th
                    className={`${is58 ? 'py-1 px-0.5 w-[20%]' : 'py-1.5 px-1 w-[20%]'} text-end font-semibold`}
                  >
                    {is58 ? t(invLang, 'ث', 'PU') : t(invLang, 'السعر', 'P.U')}
                  </th>
                  <th
                    className={`${is58 ? 'py-1 px-0.5 w-[22%]' : 'py-1.5 px-1.5 w-[20%]'} text-end font-semibold`}
                  >
                    {is58 ? t(invLang, 'مج', 'Tot') : t(invLang, 'المجموع', 'Total')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {invoice.items.map((item, idx) => (
                  <tr key={`${item.productId}-${idx}`}>
                    <td className={`${is58 ? 'py-1 px-0.5' : 'py-1.5 px-1.5'} break-words`}>
                      <div className="font-medium text-slate-900 leading-tight">{item.productName}</div>
                      {cfg.showBarcode && !isThermal && (
                        <div className="font-mono text-[0.85em] text-slate-400">{item.barcode}</div>
                      )}
                    </td>
                    <td className={`${is58 ? 'py-1 px-0.5' : 'py-1.5 px-1'} text-center font-mono tabular-nums`}>
                      {item.quantity}
                    </td>
                    <td className={`${is58 ? 'py-1 px-0.5' : 'py-1.5 px-1'} text-end font-mono tabular-nums`}>
                      {item.unitPrice.toFixed(2)}
                    </td>
                    <td
                      className={`${is58 ? 'py-1 px-0.5' : 'py-1.5 px-1.5'} text-end font-mono font-medium tabular-nums`}
                    >
                      {item.total.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );

      case 'totals':
        return (
          <div
            key="totals"
            className={`border-t border-slate-300 ${is58 ? 'pt-1.5 space-y-0.5' : 'pt-2.5 space-y-1'}`}
          >
            <div className="flex justify-between gap-2 text-slate-600">
              <span>{t(invLang, 'المجموع الفرعي:', 'Sous-total :')}</span>
              <span className="font-mono tabular-nums">{formatMoney(invoice.subtotal, cur)}</span>
            </div>
            {invoice.discountAmount > 0 && (
              <div className="flex justify-between gap-2 text-slate-600">
                <span>{t(invLang, 'الخصم:', 'Remise :')}</span>
                <span className="font-mono tabular-nums">
                  -{formatMoney(invoice.discountAmount, cur)}
                </span>
              </div>
            )}
            {cfg.showTaxBreakdown && invoice.taxAmount > 0 && (
              <div className="flex justify-between gap-2 text-slate-600">
                <span>
                  {t(invLang, `الضريبة (${invoice.taxRate}%):`, `TVA (${invoice.taxRate}%) :`)}
                </span>
                <span className="font-mono tabular-nums">{formatMoney(invoice.taxAmount, cur)}</span>
              </div>
            )}
            <div
              className={`flex justify-between gap-2 border-t border-slate-300 pt-1.5 font-bold text-slate-900 ${
                is58 ? 'text-[1.08em]' : 'text-[1.15em]'
              }`}
            >
              <span>{t(invLang, 'الإجمالي:', 'Total Net :')}</span>
              <span className="font-mono tabular-nums">{formatMoney(invoice.total, cur)}</span>
            </div>
            {cfg.showPaymentSummary && (
              <div className="pt-1 space-y-0.5 text-slate-600">
                <div className="flex justify-between gap-2">
                  <span>{t(invLang, 'المبلغ المؤدى:', 'Montant payé :')}</span>
                  <span className="font-mono tabular-nums">
                    {formatMoney(invoice.paidAmount, cur)}
                  </span>
                </div>
                {invoice.remainingAmount > 0 && (
                  <div className="flex justify-between gap-2 font-semibold text-red-700">
                    <span>{t(invLang, 'المبلغ المتبقي:', 'Reste à payer :')}</span>
                    <span className="font-mono tabular-nums">
                      {formatMoney(invoice.remainingAmount, cur)}
                    </span>
                  </div>
                )}
                {invoice.changeGiven > 0 && (
                  <div className="flex justify-between gap-2">
                    <span>{t(invLang, 'الباقي للزبون:', 'Monnaie rendue :')}</span>
                    <span className="font-mono tabular-nums">
                      {formatMoney(invoice.changeGiven, cur)}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        );

      case 'footer':
        if (!cfg.showFooter) return null;
        return (
          <div
            key="footer"
            style={{
              paddingTop: `${cfg.footerPaddingY}px`,
              paddingBottom: `${cfg.footerPaddingY}px`,
              fontSize: `${effectiveFooterFontSize}px`,
            }}
            className={`${is58 ? 'mt-2' : 'mt-3'} flex flex-col gap-1 ${footerSurface.container} ${getBorderClass(
              'top',
              cfg.footerBorderStyle
            )} ${footerAlignClass}`}
          >
            {cfg.showThankYou && settings.invoiceCustomization.thankYouMessage && (
              <div className={`font-semibold ${footerSurface.primaryText}`}>
                {settings.invoiceCustomization.thankYouMessage}
              </div>
            )}
            {cfg.showReturnTerms && settings.invoiceCustomization.returnTerms && (
              <div className={footerSurface.secondaryText}>
                {settings.invoiceCustomization.returnTerms}
              </div>
            )}
            {cfg.showSocialContact && settings.invoiceCustomization.socialContact && (
              <div className={footerSurface.secondaryText}>
                {settings.invoiceCustomization.socialContact}
              </div>
            )}
            {cfg.showExtraFooter && settings.invoiceCustomization.extraFooterInfo && (
              <div className={`text-[0.92em] ${footerSurface.mutedText}`}>
                {settings.invoiceCustomization.extraFooterInfo}
              </div>
            )}
            {cfg.showCustomPhrase && settings.invoiceCustomization.customFooterPhrase && (
              <div className={`italic ${footerSurface.secondaryText}`}>
                {settings.invoiceCustomization.customFooterPhrase}
              </div>
            )}
            {cfg.showSignatureLine && (
              <div className={`mt-3 pt-2 border-t border-dotted border-current/40 w-44 max-w-full ${footerSurface.primaryText}`}>
                <div className="font-semibold">
                  {settings.invoiceCustomization.signatureLabel || t(invLang, 'توقيع وختم المتجر', 'Cachet & Signature')}
                </div>
                <div className="h-6" />
              </div>
            )}
          </div>
        );
    }
  };

  return (
    <div
      dir={dir}
      style={{ fontSize: `${effectiveFontSize}px` }}
      className={`mx-auto bg-white text-slate-900 border border-slate-200 shadow-sm print:shadow-none print:border-0 ${containerWidth} ${
        format === 'a4'
          ? 'print-paper-a4'
          : format === '80mm'
            ? 'print-paper-80mm'
            : 'print-paper-58mm'
      }`}
    >
      {cfg.sectionOrder.map((sec) => renderSection(sec))}
    </div>
  );
};
