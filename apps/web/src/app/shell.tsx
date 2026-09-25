import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, Library, RotateCw, Settings, Sun } from 'lucide-react';
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
    'flex flex-1 flex-col items-center gap-1 py-2.5 text-xs',
    isActive ? 'text-accent' : 'text-muted-foreground',
  );
}

export function AppShell() {
  const logout = useLogout();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  function onLogout() {
    logout.mutate(undefined, {
      onSettled: () => navigate('/login', { replace: true }),
    });
  }

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[220px_1fr]">
      {/* PC 侧边导航：菜单项贴近顶部（用户偏好），标题与菜单间距收紧 */}
      <aside className="hidden md:flex md:flex-col md:border-r md:border-border md:px-3 md:pt-4 md:pb-6 md:sticky md:top-0 md:h-dvh md:overflow-y-auto">
        <p className="px-3 pb-2 text-sm font-semibold tracking-wide text-foreground">
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
        {/* 手机顶栏：安全区 + 适度呼吸（用户校准：0 太贴、14px 太松，取 8px） */}
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border bg-background px-5 pb-3 pt-safe-lg md:hidden">
          <p className="text-base font-semibold text-foreground">English Review</p>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-muted-foreground"
              aria-label="刷新"
              onClick={() => void queryClient.invalidateQueries()}
            >
              <RotateCw className="h-4 w-4" aria-hidden />
            </Button>
            <NavLink
              to="/settings"
              className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
              aria-label="设置"
            >
              <Settings className="h-4 w-4" aria-hidden />
            </NavLink>
          </div>
        </header>

        {/* 主内容：PC 限宽 900px（PRODUCT_DESIGN §12）；移动端底部大留白（iOS 惯例）+ 覆盖导航与指示条 */}
        <main className="mx-auto w-full max-w-[900px] flex-1 px-5 pb-40 pt-3 md:px-8 md:pb-10 md:pt-6">
          <Outlet />
        </main>

        {/* 手机底部导航：pb-safe 避开 iOS home 指示条（globals.css 定义的工具类） */}
        <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-border bg-background pb-safe-tight md:hidden">
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
