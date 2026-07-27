import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  AlertTriangle,
  ClipboardCheck,
  FilePlus2,
  FileText,
  Landmark,
  Mail,
  LayoutDashboard,
  Scale,
  Settings2,
  ScanSearch,
} from 'lucide-react';
import ImportDialog from './ImportDialog';

export type LayoutContext = { openImport: () => void };

const navItems = [
  { to: '/bill-recognition', label: '结算单识别', icon: ScanSearch },
  { to: '/', label: '总览', icon: LayoutDashboard },
  { to: '/jobs', label: '对账任务', icon: ClipboardCheck },
  { to: '/collections', label: '回款管理', icon: Landmark },
  { to: '/email-intake', label: '邮件接入', icon: Mail },
  { to: '/vouchers', label: '记账准备', icon: FileText },
  { to: '/issues', label: '异常工作台', icon: AlertTriangle },
  { to: '/rules', label: '合同规则', icon: Settings2 },
];

const titles: Record<string, string> = {
  '/bill-recognition': '结算单智能识别',
  '/': '财务对账总览',
  '/jobs': '对账任务',
  '/collections': '回款管理',
  '/email-intake': '邮件接入',
  '/vouchers': '记账准备',
  '/issues': '异常工作台',
  '/rules': '合同规则',
};

export default function Layout() {
  const [importOpen, setImportOpen] = useState(false);
  const location = useLocation();
  const title = location.pathname.startsWith('/jobs/')
    ? '任务详情'
    : (titles[location.pathname] ?? '商场结算对账');

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand-block">
          <span className="brand-mark">
            <Scale size={18} />
          </span>
          <span className="brand-copy">
            <strong>衡账</strong>
            <small>商场结算工作台</small>
          </span>
        </div>
        <nav className="app-nav" aria-label="主导航">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                isActive ? 'nav-item active' : 'nav-item'
              }
            >
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="environment-dot" />
          <span>开发环境</span>
        </div>
      </aside>

      <section className="app-main">
        <header className="topbar">
          <div>
            <p className="topbar-kicker">结算管理</p>
            <h1>{title}</h1>
          </div>
          <button
            className="button primary"
            onClick={() => setImportOpen(true)}
          >
            <FilePlus2 size={17} />
            导入对账
          </button>
        </header>
        <main className="page-content">
          <Outlet
            context={
              { openImport: () => setImportOpen(true) } satisfies LayoutContext
            }
          />
        </main>
      </section>

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
