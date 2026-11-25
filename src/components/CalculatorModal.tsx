import React, { useState } from 'react';
import { Calculator, Delete, X } from 'lucide-react';
import { Language } from '../types';
import { t } from '../i18n/translations';

interface CalculatorModalProps {
  open: boolean;
  lang: Language;
  currency: string;
  onClose: () => void;
  onApplyValue?: (value: number) => void;
  applyLabel?: string;
}

export const CalculatorModal: React.FC<CalculatorModalProps> = ({
  open,
  lang,
  currency,
  onClose,
  onApplyValue,
  applyLabel,
}) => {
  const [display, setDisplay] = useState('0');
  const [prevVal, setPrevVal] = useState<number | null>(null);
  const [op, setOp] = useState<'+' | '-' | '*' | '/' | null>(null);
  const [fresh, setFresh] = useState(true);

  if (!open) return null;

  const inputDigit = (d: string) => {
    if (fresh) {
      setDisplay(d === '.' ? '0.' : d);
      setFresh(false);
    } else {
      if (d === '.' && display.includes('.')) return;
      setDisplay(display === '0' && d !== '.' ? d : display + d);
    }
  };

  const compute = (a: number, b: number, operator: '+' | '-' | '*' | '/') => {
    switch (operator) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        return b === 0 ? 0 : a / b;
    }
  };

  const chooseOp = (nextOp: '+' | '-' | '*' | '/') => {
    const current = parseFloat(display) || 0;
    if (prevVal !== null && op && !fresh) {
      const res = Math.round(compute(prevVal, current, op) * 10000) / 10000;
      setDisplay(String(res));
      setPrevVal(res);
    } else {
      setPrevVal(current);
    }
    setOp(nextOp);
    setFresh(true);
  };

  const handleEquals = () => {
    if (prevVal === null || !op) return;
    const current = parseFloat(display) || 0;
    const res = Math.round(compute(prevVal, current, op) * 10000) / 10000;
    setDisplay(String(res));
    setPrevVal(null);
    setOp(null);
    setFresh(true);
  };

  const handleClear = () => {
    setDisplay('0');
    setPrevVal(null);
    setOp(null);
    setFresh(true);
  };

  const handleBackspace = () => {
    if (fresh) return;
    setDisplay((prev) => (prev.length <= 1 ? '0' : prev.slice(0, -1)));
  };

  const handlePercent = () => {
    const curVal = parseFloat(display) || 0;
    setDisplay(String(Math.round((curVal / 100) * 10000) / 10000));
    setFresh(true);
  };

  const numericValue = Math.max(0, Math.round((parseFloat(display) || 0) * 100) / 100);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
      <div className="w-full max-w-xs overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between bg-sky-500 px-4 py-3 text-white">
          <div className="flex items-center gap-2">
            <Calculator className="h-4 w-4" />
            <span className="text-sm font-bold">
              {t(lang, 'الآلة الحاسبة', 'Calculatrice')}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-white/20 p-1 hover:bg-white/30"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3" dir="ltr">
          {/* Display */}
          <div className="rounded-xl border border-slate-200 bg-slate-900 px-4 py-3 text-right text-white">
            <div className="h-4 text-[11px] font-mono text-slate-400">
              {prevVal !== null && op ? `${prevVal} ${op}` : ''}
            </div>
            <div className="truncate font-mono text-2xl font-bold tabular-nums">
              {display}
            </div>
          </div>

          {/* Keys */}
          <div className="grid grid-cols-4 gap-2 text-sm font-bold">
            <button
              type="button"
              onClick={handleClear}
              className="rounded-xl bg-red-100 py-3 text-red-700 hover:bg-red-200"
            >
              C
            </button>
            <button
              type="button"
              onClick={handleBackspace}
              className="flex items-center justify-center rounded-xl bg-slate-100 py-3 text-slate-700 hover:bg-slate-200"
            >
              <Delete className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={handlePercent}
              className="rounded-xl bg-slate-100 py-3 text-slate-700 hover:bg-slate-200"
            >
              %
            </button>
            <button
              type="button"
              onClick={() => chooseOp('/')}
              className="rounded-xl bg-amber-100 py-3 text-amber-900 hover:bg-amber-200"
            >
              ÷
            </button>

            {['7', '8', '9'].map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => inputDigit(k)}
                className="rounded-xl border border-slate-200 bg-white py-3 text-slate-900 hover:bg-slate-50 font-mono"
              >
                {k}
              </button>
            ))}
            <button
              type="button"
              onClick={() => chooseOp('*')}
              className="rounded-xl bg-amber-100 py-3 text-amber-900 hover:bg-amber-200"
            >
              ×
            </button>

            {['4', '5', '6'].map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => inputDigit(k)}
                className="rounded-xl border border-slate-200 bg-white py-3 text-slate-900 hover:bg-slate-50 font-mono"
              >
                {k}
              </button>
            ))}
            <button
              type="button"
              onClick={() => chooseOp('-')}
              className="rounded-xl bg-amber-100 py-3 text-amber-900 hover:bg-amber-200"
            >
              −
            </button>

            {['1', '2', '3'].map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => inputDigit(k)}
                className="rounded-xl border border-slate-200 bg-white py-3 text-slate-900 hover:bg-slate-50 font-mono"
              >
                {k}
              </button>
            ))}
            <button
              type="button"
              onClick={() => chooseOp('+')}
              className="rounded-xl bg-amber-100 py-3 text-amber-900 hover:bg-amber-200"
            >
              +
            </button>

            <button
              type="button"
              onClick={() => inputDigit('0')}
              className="col-span-2 rounded-xl border border-slate-200 bg-white py-3 text-slate-900 hover:bg-slate-50 font-mono"
            >
              0
            </button>
            <button
              type="button"
              onClick={() => inputDigit('.')}
              className="rounded-xl border border-slate-200 bg-white py-3 text-slate-900 hover:bg-slate-50 font-mono"
            >
              .
            </button>
            <button
              type="button"
              onClick={handleEquals}
              className="rounded-xl bg-emerald-600 py-3 text-white hover:bg-emerald-700"
            >
              =
            </button>
          </div>

          {onApplyValue && (
            <button
              type="button"
              onClick={() => {
                onApplyValue(numericValue);
                onClose();
              }}
              className="w-full rounded-xl bg-slate-900 py-2.5 text-xs font-semibold text-white hover:bg-slate-800"
            >
              {applyLabel ??
                t(
                  lang,
                  `تطبيق (${numericValue.toFixed(2)} ${currency}) كمبلغ مدفوع`,
                  `Appliquer (${numericValue.toFixed(2)} ${currency}) au montant payé`
                )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
