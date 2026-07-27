import type { ReactNode } from 'react';
import { Inbox, LoaderCircle } from 'lucide-react';

export function PageIntro({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-intro">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function LoadingState() {
  return (
    <div className="state-panel">
      <LoaderCircle className="spin" size={24} />
      <p>正在读取数据</p>
    </div>
  );
}

export function ErrorState({ message }: { message?: string }) {
  return (
    <div className="state-panel error">
      <strong>数据读取失败</strong>
      <p>{message ?? '请稍后重试'}</p>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span>
        <Inbox size={24} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Money({
  value,
  signed = false,
}: {
  value: number | string;
  signed?: boolean;
}) {
  const number = Number(value ?? 0);
  const prefix = signed && number > 0 ? '+' : '';
  return (
    <>
      {prefix}
      {new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: 'CNY',
        minimumFractionDigits: 2,
      }).format(number)}
    </>
  );
}

export function formatDate(value: string) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}
