import { BarChart3, BookOpen, Library, RotateCw, Settings, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '../lib/utils';
import { stopSpeaking } from '../lib/tts';
import { toggleKeyboardDebug, useKeyboardPhase } from '../lib/keyboard-inset';
import { useLogout } from '../features/auth/api';
import { Button } from '../components/ui/button';
import { useTodayImmersiveSession } from '../lib/today-chrome';

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

/** 顶栏标题随路由切换：logo + Today/Library/Read/Settings/Stats */
function headerTitle(pathname: string): string {
  if (pathname.startsWith('/library')) return 'Library';
  if (pathname.startsWith('/read')) return 'Read';
  if (pathname.startsWith('/settings')) return 'Settings';
  if (pathname.startsWith('/stats')) return 'Stats';
  return 'Today'; // / 与 /today
}

export function AppShell() {
  const logout = useLogout();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [refreshed, setRefreshed] = useState(false);
  const logoTaps = useRef<number[]>([]);
  const keyboardPhase = useKeyboardPhase(); // 常驻订阅：几何由 CSS 变量更新，仅阶段变化重渲染
  // Today 沉浸式会话（§5.1 一题一屏）：主内容不留移动端大留白，卡自身贴底部导航；
  // 其余页面保留 iOS 惯例的底部大留白
  const immersiveToday = pathname === '/' || pathname.startsWith('/today');
  const todayKeyboardAnchored = immersiveToday && keyboardPhase !== 'idle';
  const todayKeyboardOpen = immersiveToday && keyboardPhase === 'open';
  const todayImmersive = useTodayImmersiveSession();

  // 路由切换时停止正在播放的发音
  useEffect(() => {
    stopSpeaking();
  }, [pathname]);

  function onRefresh() {
    setRefreshed(true);
    setTimeout(() => window.location.reload(), 300);
  }

  function onLogout() {
    logout.mutate(undefined, {
      onSettled: () => navigate('/login', { replace: true }),
    });
  }

  function onLogoTap() {
    const now = Date.now();
    logoTaps.current = [...logoTaps.current.filter((at) => now - at < 3000), now];
    if (logoTaps.current.length < 5) return;
    logoTaps.current = [];
    toggleKeyboardDebug();
  }

  return (
    <div
      className="min-h-dvh md:grid md:grid-cols-[220px_1fr]"
      data-today-route={immersiveToday ? '' : undefined}
      data-keyboard-anchored={todayKeyboardAnchored ? '' : undefined}
      data-keyboard-open={todayKeyboardOpen ? '' : undefined}
    >
      {/* PC 侧边导航：菜单项贴近顶部（用户偏好），标题与菜单间距收紧 */}
      <aside className="hidden md:flex md:flex-col md:border-r md:border-border md:px-3 md:pt-4 md:pb-6 md:sticky md:top-0 md:h-dvh md:overflow-y-auto">
        <div className="flex items-center gap-2 px-3 pb-2">
          <img src="/icon.svg" alt="Foxi" className="h-5 w-5 rounded" />
          <p className="text-sm font-semibold tracking-wide text-foreground">Foxi</p>
        </div>
        <nav className="space-y-1">
          {MAIN_NAV.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={navLinkClass}>
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-1">
          <NavLink to="/stats" className={navLinkClass}>
            <BarChart3 className="h-4 w-4" aria-hidden />
            Stats
          </NavLink>
          <NavLink to="/settings" className={navLinkClass}>
            <Settings className="h-4 w-4" aria-hidden />
            Settings
          </NavLink>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onLogout}>
            退出登录
          </Button>
        </div>
      </aside>

      <div className="flex min-h-dvh flex-col pt-header-space md:pt-0">
        {/* 手机顶栏：安全区 + 适度呼吸（用户校准：0 太贴、14px 太松，取 8px） */}
        <header className="fixed inset-x-0 top-0 z-header flex items-center justify-between gap-3 border-b border-border bg-background px-5 pb-3 pt-safe-lg md:hidden">
          <button type="button" className="flex min-w-0 items-center gap-2" onClick={onLogoTap}>
            <img src="/icon.svg" alt="" className="h-6 w-6 rounded-md" />
            <span className="text-sm font-semibold tracking-wide text-foreground">Foxi</span>
          </button>
          {/* 页名绝对居中（不受左右两段宽度差影响） */}
          <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-base font-semibold text-foreground">
            {headerTitle(pathname)}
          </span>
          <div className="flex items-center gap-1">
            {/* 会话一题一屏时藏刷新/Stats，给 ProgressRow 让出顶栏空间；Settings 保留 */}
            {!todayImmersive && (
              <>
                <NavLink
                  to="/stats"
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
                  aria-label="统计"
                >
                  <BarChart3 className="h-4 w-4" aria-hidden />
                </NavLink>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 text-muted-foreground"
                  aria-label="刷新"
                  onClick={onRefresh}
                >
                  <RotateCw className={refreshed ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
                </Button>
              </>
            )}
            <NavLink
              to="/settings"
              className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
              aria-label="设置"
            >
              <Settings className="h-4 w-4" aria-hidden />
            </NavLink>
          </div>
        </header>

        {/* 主内容：PC 限宽 900px（PRODUCT_DESIGN §12）；移动端底部大留白（iOS 惯例）+ 覆盖导航与指示条。
            Today 活动卡改由页面自身贴导航（pb 由 TodayPage 按会话态接管） */}
        <main
          className={cn(
            'mx-auto w-full max-w-[900px] flex-1 px-5 pt-3 md:px-8 md:pb-10 md:pt-6',
            immersiveToday ? 'pb-0' : 'pb-40',
          )}
        >
          <Outlet />
        </main>

        {/* 手机底部导航：pb-safe 避开 iOS home 指示条（globals.css 定义的工具类） */}
        <nav
          className={cn(
            'fixed inset-x-0 bottom-0 z-nav flex border-t border-border bg-background pb-safe-tight md:hidden',
            todayKeyboardAnchored && 'hidden',
          )}
        >
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
