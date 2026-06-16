import { useEffect } from 'react';

// In-app confirmation modal, replacing the browser's native confirm() dialog
// (which shows the host URL + "says" and offers no styling). Renders the app
// name as a small header, then leaves generous room above the message/question.
// `danger` styles the confirm button red for destructive actions.
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Allow Esc to cancel while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !busy && onCancel()}
    >
      <div
        className="w-full max-w-md bg-white rounded-xl shadow-xl dark:bg-slate-900 dark:border dark:border-slate-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-5 pb-6">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Newsletter Console
          </p>
          <h2 className="mt-3 text-lg font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
          <p className="mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{message}</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-6 py-3 dark:border-slate-800">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="text-sm rounded-lg px-4 py-2 border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            autoFocus
            disabled={busy}
            onClick={onConfirm}
            className={`text-sm rounded-lg px-4 py-2 text-white disabled:opacity-50 ${
              danger ? 'bg-red-600 hover:bg-red-700' : 'bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
