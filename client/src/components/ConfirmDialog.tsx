import { AlertTriangle, X } from 'lucide-react';

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop">
      <section className="confirm-dialog" role="alertdialog" aria-modal="true">
        <header className="dialog-header">
          <div>
            <p className="eyebrow">请确认操作</p>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="confirm-body">
          <span>
            <AlertTriangle size={22} />
          </span>
          <p>{description}</p>
        </div>
        <footer className="dialog-footer">
          <button className="button secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="button danger-solid"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? '正在删除...' : confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
