import React, { useEffect, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import { Check, Printer, X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { updateSettingsSection } from '../db/operations';
import {
  DEFAULT_INVOICE_LOGO,
  InvoicePreviewContent,
  getBorderClass,
  getInvoiceAlignClass,
  getLogoShapeClass,
  getSurfaceBgClass,
} from './InvoicePreviewContent';
import { formatDateTime, formatMoney, getPaymentMethodLabel, t } from '../i18n/translations';

const BarcodeSvg: React.FC<{ value: string; width?: number; height?: number }> = ({
  value,
  width = 1.6,
  height = 42,
}) => {
  const ref = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    if (!ref.current || !value) return;
    try {
      JsBarcode(ref.current, value, {
        format: 'CODE128',
        width,
        height,
        displayValue: true,
        fontSize: 11,
        margin: 2,
      });
    } catch {
      // Fallback handled silently
    }
  }, [value, width, height]);
  return <svg ref={ref} className="mx-auto max-w-full" />;
};

export const PrintModal: React.FC = () => {
  const { printDoc, closePrint, settings, currentUser, notify, lang } = useApp();
  const [format, setFormat] = useState<'a4' | '80mm' | '58mm'>('a4');
  const autoPrintedDocRef = useRef<object | null>(null);

  useEffect(() => {
    if (!printDoc) {
      autoPrintedDocRef.current = null;
      return;
    }
    if (printDoc.type === 'sale_invoice') {
      setFormat(printDoc.format ?? settings.printing.salesFormat);
    } else if (printDoc.type === 'purchase_invoice') {
      setFormat(printDoc.format ?? settings.printing.purchasesFormat);
    } else if (printDoc.type === 'customer_payment' || printDoc.type === 'supplier_payment') {
      setFormat(printDoc.format ?? settings.printing.receiptsFormat);
    } else {
      setFormat('a4');
    }
  }, [printDoc, settings.printing]);

  // If "previewBeforePrint" is disabled in settings, trigger browser print immediately with the configured @page format
  useEffect(() => {
    if (!printDoc) return;
    if (
      printDoc.type === 'sale_invoice' &&
      !printDoc.format &&
      !settings.printing.previewBeforePrint &&
      autoPrintedDocRef.current !== printDoc
    ) {
      autoPrintedDocRef.current = printDoc;
      const timer = window.setTimeout(() => {
        window.print();
      }, 180);
      return () => window.clearTimeout(timer);
    }
  }, [printDoc, settings.printing.previewBeforePrint, format]);

  if (!printDoc) return null;

  const cur = settings.storeInfo.currency || 'MAD';
  const store = settings.storeInfo;
  const copies = Math.max(1, Math.min(5, settings.printing.copies || 1));
  const marginMm = Math.max(0, Math.min(25, settings.printing.marginMm ?? 4));
  const docCfg = format === 'a4' ? settings.invoiceCustomization.a4 : settings.invoiceCustomization.thermal;
  const docLogoSrc = store.logoDataUrl || DEFAULT_INVOICE_LOGO;
  const docHeaderSurface = getSurfaceBgClass(docCfg.headerBgColor);
  const docFooterSurface = getSurfaceBgClass(docCfg.footerBgColor);
  const docLogoWidth = format === '58mm' ? Math.min(docCfg.logoWidth, 155) : docCfg.logoWidth;
  const docLogoHeight = format === '58mm' ? Math.min(docCfg.logoHeight, 90) : docCfg.logoHeight;

  const renderDocFooter = () => {
    if (!docCfg.showFooter) return null;
    const invCust = settings.invoiceCustomization;
    return (
      <div
        style={{
          paddingTop: `${docCfg.footerPaddingY}px`,
          paddingBottom: `${docCfg.footerPaddingY}px`,
          fontSize: `${docCfg.footerFontSize}px`,
        }}
        className={`mt-4 flex flex-col gap-1 ${docFooterSurface.container} ${getBorderClass(
          'top',
          docCfg.footerBorderStyle
        )} ${getInvoiceAlignClass(docCfg.footerAlign)}`}
      >
        {docCfg.showThankYou && invCust.thankYouMessage && (
          <div className={`font-semibold ${docFooterSurface.primaryText}`}>{invCust.thankYouMessage}</div>
        )}
        {docCfg.showReturnTerms && invCust.returnTerms && (
          <div className={docFooterSurface.secondaryText}>{invCust.returnTerms}</div>
        )}
        {docCfg.showSocialContact && invCust.socialContact && (
          <div className={docFooterSurface.secondaryText}>{invCust.socialContact}</div>
        )}
        {docCfg.showExtraFooter && invCust.extraFooterInfo && (
          <div className={docFooterSurface.mutedText}>{invCust.extraFooterInfo}</div>
        )}
        {docCfg.showCustomPhrase && invCust.customFooterPhrase && (
          <div className={`italic ${docFooterSurface.secondaryText}`}>{invCust.customFooterPhrase}</div>
        )}
        {docCfg.showSignatureLine && (
          <div className={`mt-3 pt-2 border-t border-dotted border-current/40 w-44 max-w-full ${docFooterSurface.primaryText}`}>
            <div className="font-semibold">
              {invCust.signatureLabel || t(lang, 'توقيع وختم المتجر', 'Cachet & Signature')}
            </div>
            <div className="h-6" />
          </div>
        )}
      </div>
    );
  };

  const pageCssRule =
    format === '58mm'
      ? `@page { size: 58mm auto; margin: ${Math.min(marginMm, 3)}mm; }`
      : format === '80mm'
        ? `@page { size: 80mm auto; margin: ${Math.min(marginMm, 4)}mm; }`
        : `@page { size: A4 portrait; margin: ${marginMm}mm; }`;

  const savedDefaultFormat: 'a4' | '80mm' | '58mm' | null =
    printDoc.type === 'sale_invoice'
      ? settings.printing.salesFormat
      : printDoc.type === 'purchase_invoice'
        ? settings.printing.purchasesFormat
        : printDoc.type === 'customer_payment' || printDoc.type === 'supplier_payment'
          ? settings.printing.receiptsFormat
          : null;

  const handleSaveAsDefaultFormat = async () => {
    if (!currentUser || !savedDefaultFormat || format === savedDefaultFormat) return;
    const field =
      printDoc.type === 'sale_invoice'
        ? 'salesFormat'
        : printDoc.type === 'purchase_invoice'
          ? 'purchasesFormat'
          : 'receiptsFormat';
    await updateSettingsSection(
      (prev) => ({
        ...prev,
        printing: { ...prev.printing, [field]: format },
      }),
      currentUser,
      `تحديث حجم ورق الطباعة الافتراضي إلى ${format.toUpperCase()}`
    );
    notify(
      t(
        lang,
        `تم حفظ ${format.toUpperCase()} كحجم ورق افتراضي بنجاح`,
        `Format ${format.toUpperCase()} enregistré par défaut`
      )
    );
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/70 p-2 sm:p-6 overflow-y-auto print:static print:bg-white print:p-0 print:block">
      {/* Dynamic @page geometry synchronized with selected A4 / 80mm / 58mm size */}
      <style>{pageCssRule}</style>

      <div className="no-print mx-auto mb-3 sm:mb-4 flex w-full max-w-4xl flex-wrap items-center justify-between gap-2.5 sm:gap-3 rounded-xl border border-slate-200 bg-white px-3 sm:px-4 py-2.5 sm:py-3 shadow-lg">
        <div className="flex items-center gap-2">
          <Printer className="h-4 w-4 text-teal-700" />
          <span className="text-xs sm:text-sm font-semibold text-slate-900">
            {t(lang, 'معاينة قبل الطباعة', 'Aperçu avant impression')}
          </span>
          <span className="text-xs font-mono font-bold text-teal-700">
            · {format.toUpperCase()}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {(printDoc.type === 'sale_invoice' ||
            printDoc.type === 'customer_payment' ||
            printDoc.type === 'supplier_payment' ||
            printDoc.type === 'purchase_invoice') && (
            <>
              <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
                {(['a4', '80mm', '58mm'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFormat(f)}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                      format === f
                        ? 'bg-teal-700 text-white shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
              {savedDefaultFormat && format !== savedDefaultFormat && (
                <button
                  type="button"
                  onClick={handleSaveAsDefaultFormat}
                  className="inline-flex items-center gap-1 rounded-lg border border-teal-300 bg-teal-50 px-2.5 py-1.5 text-[11px] font-semibold text-teal-800 hover:bg-teal-100"
                >
                  <Check className="h-3.5 w-3.5" />
                  {t(lang, 'تثبيت كافتراضي', 'Définir par défaut')}
                </button>
              )}
            </>
          )}

          <button
            type="button"
            onClick={handlePrint}
            className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3.5 sm:px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800"
          >
            <Printer className="h-3.5 w-3.5" />
            {t(lang, `طباعة (${copies} نسخة)`, `Imprimer (${copies}x)`)}
          </button>

          <button
            type="button"
            onClick={closePrint}
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-4xl overflow-x-auto pb-4 print:overflow-visible print:pb-0 print:max-w-none print:w-full">
        {printDoc.type === 'sale_invoice' && (
          <>
            <InvoicePreviewContent invoice={printDoc.invoice} settings={settings} format={format} />
            {copies > 1 &&
              Array.from({ length: copies - 1 }).map((_, idx) => (
                <div key={idx} className="hidden print:block print-page-break">
                  <InvoicePreviewContent invoice={printDoc.invoice} settings={settings} format={format} />
                </div>
              ))}
          </>
        )}

        {printDoc.type === 'purchase_invoice' && (
          <div
            className={`mx-auto bg-white border border-slate-200 p-6 text-slate-900 ${
              format === 'a4'
                ? 'print-paper-a4 max-w-[780px]'
                : format === '80mm'
                  ? 'print-paper-80mm w-[80mm]'
                  : 'print-paper-58mm w-[58mm]'
            }`}
          >
            {docCfg.showHeader && (
              <div
                style={{
                  paddingTop: `${docCfg.headerPaddingY}px`,
                  paddingBottom: `${docCfg.headerPaddingY}px`,
                }}
                className={`flex justify-between items-start gap-4 ${docHeaderSurface.container} ${getBorderClass(
                  'bottom',
                  docCfg.headerBorderStyle,
                  true
                )}`}
              >
                <div className="flex items-start gap-3">
                  {docCfg.showLogo && docLogoSrc && (
                    <img
                      src={docLogoSrc}
                      alt={store.storeName}
                      style={{ width: `${docLogoWidth}px`, height: `${docLogoHeight}px`, maxWidth: '100%' }}
                      className={`${docCfg.logoKeepAspect ? 'object-contain' : 'object-fill'} ${getLogoShapeClass(
                        docCfg.logoShape
                      )} shrink-0`}
                    />
                  )}
                  <div>
                    {docCfg.showCustomHeader && settings.invoiceCustomization.customHeaderText && (
                      <p className={`text-xs font-semibold ${docHeaderSurface.secondaryText}`}>
                        {settings.invoiceCustomization.customHeaderText}
                      </p>
                    )}
                    {docCfg.showStoreName && (
                      <h2
                        style={{ fontSize: `${docCfg.headerFontSize}px` }}
                        className={`font-bold leading-tight ${docHeaderSurface.primaryText}`}
                      >
                        {store.storeName}
                      </h2>
                    )}
                    {docCfg.showAddress && (
                      <p className={`text-xs ${docHeaderSurface.secondaryText}`}>{store.address}</p>
                    )}
                    {docCfg.showPhone && (
                      <p className={`text-xs font-mono ${docHeaderSurface.secondaryText}`}>{store.phone}</p>
                    )}
                  </div>
                </div>
                <div className="text-end">
                  <div className={`text-sm font-bold ${docCfg.headerBgColor === 'navy' ? 'text-[#FDE68A]' : 'text-teal-800'}`}>
                    {t(lang, 'فاتورة مشتريات', 'Facture d’achat')}
                  </div>
                  <div className={`font-mono text-sm font-semibold ${docHeaderSurface.primaryText}`}>
                    {printDoc.invoice.invoiceNumber}
                  </div>
                  <div className={`text-xs ${docHeaderSurface.mutedText}`}>
                    {formatDateTime(printDoc.invoice.date, lang)}
                  </div>
                </div>
              </div>
            )}
            <div className="my-3 text-sm">
              <span className="text-slate-500">{t(lang, 'المورد:', 'Fournisseur :')}</span>{' '}
              <span className="font-semibold">{printDoc.invoice.supplierName}</span>
            </div>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-300 bg-slate-50">
                  <th className="p-2 text-start">{t(lang, 'المنتج', 'Produit')}</th>
                  <th className="p-2 text-center">{t(lang, 'الكمية', 'Qté')}</th>
                  <th className="p-2 text-end">{t(lang, 'التكلفة', 'Coût U.')}</th>
                  <th className="p-2 text-end">{t(lang, 'المجموع', 'Total')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {printDoc.invoice.items.map((it, idx) => (
                  <tr key={idx}>
                    <td className="p-2 font-medium">{it.productName}</td>
                    <td className="p-2 text-center font-mono">{it.quantity}</td>
                    <td className="p-2 text-end font-mono">{it.unitCost.toFixed(2)}</td>
                    <td className="p-2 text-end font-mono">{it.total.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4 border-t border-slate-300 pt-3 space-y-1 text-sm">
              <div className="flex justify-between font-bold">
                <span>{t(lang, 'الإجمالي:', 'Total :')}</span>
                <span className="font-mono">{formatMoney(printDoc.invoice.total, cur)}</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>{t(lang, 'المدفوع:', 'Payé :')}</span>
                <span className="font-mono">{formatMoney(printDoc.invoice.paidAmount, cur)}</span>
              </div>
              <div className="flex justify-between text-red-700 font-semibold">
                <span>{t(lang, 'المتبقي للمورد:', 'Reste fournisseur :')}</span>
                <span className="font-mono">{formatMoney(printDoc.invoice.remainingAmount, cur)}</span>
              </div>
            </div>
            {renderDocFooter()}
          </div>
        )}

        {(printDoc.type === 'customer_payment' || printDoc.type === 'supplier_payment') && (
          <div
            className={`mx-auto bg-white border border-slate-200 p-6 text-slate-900 ${
              format === 'a4'
                ? 'print-paper-a4 max-w-[540px]'
                : format === '80mm'
                  ? 'print-paper-80mm w-[80mm]'
                  : 'print-paper-58mm w-[58mm]'
            }`}
          >
            {docCfg.showHeader && (
              <div
                style={{
                  paddingTop: `${docCfg.headerPaddingY}px`,
                  paddingBottom: `${docCfg.headerPaddingY}px`,
                }}
                className={`flex flex-col gap-1 ${docHeaderSurface.container} ${getBorderClass(
                  'bottom',
                  docCfg.headerBorderStyle
                )} ${getInvoiceAlignClass(docCfg.headerAlign)}`}
              >
                {docCfg.showLogo && docLogoSrc && (
                  <img
                    src={docLogoSrc}
                    alt={store.storeName}
                    style={{ width: `${docLogoWidth}px`, height: `${docLogoHeight}px`, maxWidth: '100%' }}
                    className={`${docCfg.logoKeepAspect ? 'object-contain' : 'object-fill'} ${getLogoShapeClass(
                      docCfg.logoShape
                    )} mb-1 shrink-0`}
                  />
                )}
                {docCfg.showCustomHeader && settings.invoiceCustomization.customHeaderText && (
                  <div className={`text-xs font-semibold ${docHeaderSurface.secondaryText}`}>
                    {settings.invoiceCustomization.customHeaderText}
                  </div>
                )}
                {docCfg.showStoreName && (
                  <div
                    style={{ fontSize: `${docCfg.headerFontSize}px` }}
                    className={`font-bold leading-tight ${docHeaderSurface.primaryText}`}
                  >
                    {store.storeName}
                  </div>
                )}
                {docCfg.showPhone && (
                  <div className={`text-xs font-mono ${docHeaderSurface.secondaryText}`}>{store.phone}</div>
                )}
                <div className={`mt-1.5 text-sm font-semibold ${docCfg.headerBgColor === 'navy' ? 'text-[#FDE68A]' : 'text-teal-800'}`}>
                  {printDoc.type === 'customer_payment'
                    ? t(lang, 'وصل أداء زبون', 'Reçu de paiement client')
                    : t(lang, 'وصل أداء مورد', 'Reçu de paiement fournisseur')}
                </div>
                <div className={`font-mono text-xs ${docHeaderSurface.mutedText}`}>
                  {t(lang, 'رقم المرجع:', 'Réf N° :')} #{printDoc.payment.refNumber}
                </div>
              </div>
            )}
            <div className="my-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">{t(lang, 'التاريخ:', 'Date :')}</span>
                <span>{formatDateTime(printDoc.payment.date, lang)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">
                  {printDoc.type === 'customer_payment'
                    ? t(lang, 'الزبون:', 'Client :')
                    : t(lang, 'المورد:', 'Fournisseur :')}
                </span>
                <span className="font-semibold">
                  {printDoc.type === 'customer_payment'
                    ? printDoc.payment.customerName
                    : printDoc.payment.supplierName}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">{t(lang, 'طريقة الدفع:', 'Mode :')}</span>
                <span>{getPaymentMethodLabel(printDoc.payment.paymentMethod, lang)}</span>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold">
                <span>{t(lang, 'المبلغ المؤدى:', 'Montant payé :')}</span>
                <span className="font-mono text-emerald-700">
                  {formatMoney(printDoc.payment.amount, cur)}
                </span>
              </div>
              <div className="flex justify-between text-slate-700">
                <span>{t(lang, 'المبلغ المتبقي:', 'Solde restant :')}</span>
                <span className="font-mono">{formatMoney(printDoc.payment.remainingAfter, cur)}</span>
              </div>
              {printDoc.payment.notes && (
                <div className="pt-2 text-xs text-slate-500">{printDoc.payment.notes}</div>
              )}
            </div>
            {renderDocFooter()}
          </div>
        )}

        {printDoc.type === 'supplier_return' && (
          <div className="print-paper-a4 mx-auto max-w-[780px] bg-white border border-slate-200 p-8 text-slate-900">
            <div className="flex justify-between border-b border-slate-300 pb-4">
              <div>
                <h2 className="text-lg font-bold">{store.storeName}</h2>
                <p className="text-xs text-slate-600">{store.address}</p>
              </div>
              <div className="text-end">
                <div className="text-base font-bold text-red-700">
                  {t(lang, 'وثيقة إرجاع للمورد', 'Bon de retour fournisseur')}
                </div>
                <div className="font-mono text-sm">{printDoc.ret.returnNumber}</div>
                <div className="text-xs text-slate-500">
                  {formatDateTime(printDoc.ret.date, lang)}
                </div>
              </div>
            </div>
            <div className="my-4 grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-slate-500">{t(lang, 'المورد:', 'Fournisseur :')}</span>{' '}
                <span className="font-semibold">{printDoc.ret.supplierName}</span>
              </div>
              <div className="text-end">
                <span className="text-slate-500">
                  {t(lang, 'فاتورة الشراء الأصلية:', 'Facture d’origine :')}
                </span>{' '}
                <span className="font-mono font-semibold">{printDoc.ret.purchaseInvoiceNumber}</span>
              </div>
            </div>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-slate-100 border-b border-slate-300">
                  <th className="p-2 text-start">{t(lang, 'المنتج', 'Produit')}</th>
                  <th className="p-2 text-center">{t(lang, 'الكمية المرتجعة', 'Qté retournée')}</th>
                  <th className="p-2 text-end">{t(lang, 'التكلفة', 'Coût U.')}</th>
                  <th className="p-2 text-end">{t(lang, 'القيمة', 'Montant')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {printDoc.ret.items.map((it, i) => (
                  <tr key={i}>
                    <td className="p-2">{it.productName}</td>
                    <td className="p-2 text-center font-mono">{it.quantity}</td>
                    <td className="p-2 text-end font-mono">{it.unitCost.toFixed(2)}</td>
                    <td className="p-2 text-end font-mono font-semibold">{it.total.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4 flex justify-between border-t border-slate-300 pt-3 text-base font-bold">
              <span>{t(lang, 'إجمالي قيمة المرتجع:', 'Total retour :')}</span>
              <span className="font-mono">{formatMoney(printDoc.ret.totalAmount, cur)}</span>
            </div>
            <p className="mt-2 text-xs text-slate-600">
              {t(lang, 'السبب:', 'Motif :')} {printDoc.ret.reason}
            </p>
          </div>
        )}

        {printDoc.type === 'customer_statement' && (
          <div className="print-paper-a4 mx-auto max-w-[780px] bg-white border border-slate-200 p-8 text-slate-900">
            <div className="flex justify-between border-b border-slate-300 pb-4">
              <div>
                <h2 className="text-lg font-bold">{store.storeName}</h2>
                <p className="text-xs text-slate-600">{store.phone}</p>
              </div>
              <div className="text-end">
                <h3 className="text-base font-bold text-teal-800">
                  {t(lang, 'كشف حساب الزبون', 'Relevé de compte client')}
                </h3>
                <p className="text-sm font-semibold">{printDoc.customer.fullName}</p>
                <p className="text-xs text-slate-500">{printDoc.customer.phone}</p>
              </div>
            </div>
            <h4 className="mt-4 mb-2 text-sm font-semibold">
              {t(lang, 'سجل الفواتير', 'Historique des factures')}
            </h4>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-slate-100 border-b border-slate-300">
                  <th className="p-2 text-start">{t(lang, 'رقم الفاتورة', 'N° Facture')}</th>
                  <th className="p-2 text-start">{t(lang, 'التاريخ', 'Date')}</th>
                  <th className="p-2 text-end">{t(lang, 'الإجمالي', 'Total')}</th>
                  <th className="p-2 text-end">{t(lang, 'المدفوع', 'Payé')}</th>
                  <th className="p-2 text-end">{t(lang, 'المتبقي', 'Reste')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {printDoc.invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td className="p-2 font-mono">{inv.invoiceNumber}</td>
                    <td className="p-2">{formatDateTime(inv.date, lang)}</td>
                    <td className="p-2 text-end font-mono">{inv.total.toFixed(2)}</td>
                    <td className="p-2 text-end font-mono">{inv.paidAmount.toFixed(2)}</td>
                    <td className="p-2 text-end font-mono font-semibold text-red-700">
                      {inv.remainingAmount.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4 border-t border-slate-300 pt-3 flex justify-between text-sm font-bold">
              <span>{t(lang, 'إجمالي الدين المتبقي:', 'Solde total dû :')}</span>
              <span className="font-mono text-red-700">
                {formatMoney(
                  printDoc.invoices
                    .filter((i) => i.status !== 'cancelled')
                    .reduce((s, i) => s + i.remainingAmount, 0) +
                    (printDoc.customer.openingBalance || 0),
                  cur
                )}
              </span>
            </div>
          </div>
        )}

        {printDoc.type === 'supplier_statement' && (
          <div className="print-paper-a4 mx-auto max-w-[780px] bg-white border border-slate-200 p-8 text-slate-900">
            <div className="flex justify-between border-b border-slate-300 pb-4">
              <div>
                <h2 className="text-lg font-bold">{store.storeName}</h2>
                <p className="text-xs text-slate-600">{store.phone}</p>
              </div>
              <div className="text-end">
                <h3 className="text-base font-bold text-teal-800">
                  {t(lang, 'كشف حساب المورد', 'Relevé de compte fournisseur')}
                </h3>
                <p className="text-sm font-semibold">{printDoc.supplier.businessName}</p>
                <p className="text-xs text-slate-500">{printDoc.supplier.phone}</p>
              </div>
            </div>
            <table className="mt-4 w-full text-xs border-collapse">
              <thead>
                <tr className="bg-slate-100 border-b border-slate-300">
                  <th className="p-2 text-start">{t(lang, 'رقم الفاتورة', 'N° Achat')}</th>
                  <th className="p-2 text-start">{t(lang, 'التاريخ', 'Date')}</th>
                  <th className="p-2 text-end">{t(lang, 'الإجمالي', 'Total')}</th>
                  <th className="p-2 text-end">{t(lang, 'المدفوع', 'Payé')}</th>
                  <th className="p-2 text-end">{t(lang, 'المتبقي', 'Reste')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {printDoc.purchases.map((p) => (
                  <tr key={p.id}>
                    <td className="p-2 font-mono">{p.invoiceNumber}</td>
                    <td className="p-2">{formatDateTime(p.date, lang)}</td>
                    <td className="p-2 text-end font-mono">{p.total.toFixed(2)}</td>
                    <td className="p-2 text-end font-mono">{p.paidAmount.toFixed(2)}</td>
                    <td className="p-2 text-end font-mono font-semibold text-red-700">
                      {p.remainingAmount.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4 border-t border-slate-300 pt-3 flex justify-between text-sm font-bold">
              <span>{t(lang, 'إجمالي المستحقات للمورد:', 'Solde dû fournisseur :')}</span>
              <span className="font-mono text-red-700">
                {formatMoney(
                  printDoc.purchases
                    .filter((i) => i.status !== 'cancelled')
                    .reduce((s, i) => s + i.remainingAmount, 0) +
                    (printDoc.supplier.openingBalance || 0),
                  cur
                )}
              </span>
            </div>
          </div>
        )}

        {printDoc.type === 'barcode_labels' && (
          <div className="print-paper-a4 mx-auto max-w-[780px] bg-white border border-slate-200 p-6">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {printDoc.products.flatMap(({ product, copies }) =>
                Array.from({ length: Math.max(1, Math.min(30, copies)) }).map((_, idx) => (
                  <div
                    key={`${product.id}-${idx}`}
                    className="flex flex-col items-center justify-center rounded-md border border-dashed border-slate-300 p-2.5 text-center"
                  >
                    <div className="text-[11px] font-bold text-slate-900 truncate max-w-full">
                      {product.name}
                    </div>
                    <div className="my-1 w-full">
                      <BarcodeSvg value={product.barcode || product.sku || String(product.id)} />
                    </div>
                    <div className="font-mono text-xs font-bold text-slate-900">
                      {formatMoney(product.salePrice, cur)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {printDoc.type === 'generic_report' && (
          <div className="print-paper-a4 mx-auto max-w-[920px] bg-white border border-slate-200 p-8 text-slate-900">
            {docCfg.showHeader && (
              <div
                style={{
                  paddingTop: `${docCfg.headerPaddingY}px`,
                  paddingBottom: `${docCfg.headerPaddingY}px`,
                }}
                className={`flex justify-between items-start gap-4 ${docHeaderSurface.container} ${getBorderClass(
                  'bottom',
                  docCfg.headerBorderStyle,
                  true
                )}`}
              >
                <div className="flex items-start gap-3">
                  {docCfg.showLogo && docLogoSrc && (
                    <img
                      src={docLogoSrc}
                      alt={store.storeName}
                      style={{ width: `${docLogoWidth}px`, height: `${docLogoHeight}px`, maxWidth: '100%' }}
                      className={`${docCfg.logoKeepAspect ? 'object-contain' : 'object-fill'} ${getLogoShapeClass(
                        docCfg.logoShape
                      )} shrink-0`}
                    />
                  )}
                  <div>
                    {docCfg.showCustomHeader && settings.invoiceCustomization.customHeaderText && (
                      <div className={`text-xs font-semibold ${docHeaderSurface.secondaryText}`}>
                        {settings.invoiceCustomization.customHeaderText}
                      </div>
                    )}
                    {docCfg.showStoreName && (
                      <div
                        style={{ fontSize: `${docCfg.headerFontSize}px` }}
                        className={`font-bold leading-tight ${docHeaderSurface.primaryText}`}
                      >
                        {store.storeName}
                      </div>
                    )}
                    <div className={`text-xs ${docHeaderSurface.secondaryText}`}>
                      {docCfg.showAddress ? store.address : ''}
                      {docCfg.showAddress && docCfg.showPhone ? ' · ' : ''}
                      {docCfg.showPhone ? store.phone : ''}
                    </div>
                  </div>
                </div>
                <div className="text-end">
                  <h2 className={`text-base font-bold ${docCfg.headerBgColor === 'navy' ? 'text-[#FDE68A]' : 'text-teal-800'}`}>
                    {printDoc.title}
                  </h2>
                  <p className={`text-xs ${docHeaderSurface.mutedText}`}>{printDoc.subtitle}</p>
                </div>
              </div>
            )}

            {printDoc.summaryItems && printDoc.summaryItems.length > 0 && (
              <div className="my-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                {printDoc.summaryItems.map((s, i) => (
                  <div key={i} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="text-[11px] text-slate-500">{s.label}</div>
                    <div className="mt-1 font-mono text-sm font-bold text-slate-900">{s.value}</div>
                  </div>
                ))}
              </div>
            )}

            <table className="mt-4 w-full text-xs border-collapse">
              <thead>
                <tr className="bg-slate-900 text-white">
                  {printDoc.columns.map((c, i) => (
                    <th key={i} className="p-2 text-start font-semibold">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {printDoc.rows.map((row, rIdx) => (
                  <tr key={rIdx} className={rIdx % 2 === 1 ? 'bg-slate-50/70' : ''}>
                    {row.map((cell, cIdx) => (
                      <td key={cIdx} className="p-2 font-mono tabular-nums">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {renderDocFooter()}
          </div>
        )}
      </div>
    </div>
  );
};
