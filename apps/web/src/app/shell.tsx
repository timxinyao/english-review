import { BookOpen, Library, Settings, Sun } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { cn } from '../lib/utils';
import { useLogout } from '../features/auth/api';
import { Button } from '../components/ui/button';

const MAIN_NAV = [
  { to: '/today', label: 'Today', icon: Sun },
  { to: '/library', label: 'Library', icon: Library },
  { to: '/read', label: 'Read', icon: BookOpen },
] as const;

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return cn(
    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
    isActive ? 'bg-accent-soft font-medium text-accent' : 'text-muted-foreground hover:bg-muted',
  );
}

function bottomLinkClass({ isActive }: { isActive: boolean }): string {
  return cn(
    'flex flex-1 flex-col items-center gap-1 py-2 text-xs',
    isActive ? 'text-accent' : 'text-muted-foreground',
  );
}

export function AppShell() {
  const logout = useLogout();
  const navigate = useNavigate();

  function onLogout() {
    logout.mutate(undefined, {
      onSettled: () => navigate('/login', { replace: true }),
    });
  }

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[220px_1fr]">
      {/* PC 侧边导航 */}
      <aside className="hidden md:flex md:flex-col md:border-r md:border-border md:px-3 md:py-6">
        <p className="px-3 pb-6 text-sm font-semibold tracking-wide text-foreground">
          English&nbsp;Review
        </p>
        <nav className="space-y-1">
          {MAIN_NAV.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={navLinkClass}>
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-1">
          <NavLink to="/settings" className={navLinkClass}>
            <Settings className="h-4 w-4" aria-hidden />
            Settings
          </NavLink>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onLogout}>
            退出登录
          </Button>
        </div>
      </aside>

      <div className="flex min-h-dvh flex-col">
        {/* 手机顶栏 */}
        <header className="flex h-12 items-center justify-between border-b border-border px-4 md:hidden">
          <p className="text-sm font-semibold text-foreground">English Review</p>
          <NavLink
            to="/settings"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
            aria-label="设置"
          >
            <Settings className="h-4 w-4" />
          </NavLink>
        </header>

        {/* 主内容：PC 限宽 900px（PRODUCT_DESIGN §12）；移动端底部留出导航 + iOS 安全区高度 */}
        <main className="mx-auto w-full max-w-[900px] flex-1 px-4 pb-28 pt-6 md:px-8 md:pb-10">
          <Outlet />
        </main>

        {/* 手机底部导航 */}
        {/* 手机底部导航：pb-safe 避开 iOS home 指示条（globals.css 定义的工具类） */}
        <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-border bg-background pb-safe md:hidden">
          {MAIN_NAV.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={bottomLinkClass}>
              <Icon className="h-5 w-5" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
