import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const raw = error instanceof Error ? error.message : String(error);
    let friendly = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: string; operationType?: string; path?: string };
      if (parsed && typeof parsed.error === 'string') {
        if (parsed.error.toLowerCase().includes('quota exceeded')) {
          friendly =
            'تم بلوغ الحد اليومي المجاني لقاعدة البيانات السحابية. ستتجدد الحصة تلقائياً غداً، ويمكنك متابعة العمل محلياً دون فقدان البيانات.';
        } else if (parsed.error.toLowerCase().includes('permission')) {
          friendly =
            'تعذّر إتمام عملية المزامنة السحابية بسبب صلاحيات الوصول. يرجى التأكد من تفعيل البريد الإلكتروني وتسجيل الدخول مجدداً.';
        } else {
          friendly = parsed.error;
        }
      }
    } catch {
      // Keep raw message if not JSON
    }
    return { hasError: true, errorMessage: friendly };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error('Application ErrorBoundary caught:', error, info);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4" dir="rtl">
        <div className="w-full max-w-md rounded-2xl border border-red-200 bg-white p-6 text-center shadow-lg space-y-4">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-600">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h2 className="text-base font-extrabold text-slate-900">
            حدث خطأ غير متوقع في التطبيق
          </h2>
          <p className="text-xs leading-relaxed text-slate-600 break-words">
            {this.state.errorMessage || 'تعذّر عرض هذه الشاشة. يرجى إعادة التحميل.'}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#0B274D] px-5 py-2.5 text-xs font-bold text-[#FDE68A] hover:bg-[#133A6E]"
          >
            <RefreshCw className="h-4 w-4" />
            <span>إعادة تحميل التطبيق</span>
          </button>
        </div>
      </div>
    );
  }
}
