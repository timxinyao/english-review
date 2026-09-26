# 会话自动发音开关 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Today 会话卡片到达/切换时自动播一次单词发音，页内图标开关可关（localStorage 持久化，默认开）。

**Architecture:** ActiveSession 持 `autoSpeak` 状态 + taskId 变化 effect 调 `speak(target)`；ProgressRow 加 Volume 图标开关；localStorage 键 `el:auto-pronounce`。

**Tech Stack:** React 18 + TS + Tailwind v4、vitest + @testing-library。

**规格：** `docs/superpowers/specs/2026-09-27-auto-pronounce-design.md`

## Global Constraints

- 仓库根：`/var/www/english-review`；web 单测：`pnpm --filter @el/web run test`（全过）；typecheck：`pnpm --filter @el/web run typecheck`。
- e2e 冒烟：`E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "Today"`。
- localStorage 键 `el:auto-pronounce`，`'0'`=关，缺省为开。
- 提交信息末尾加：
  ```
  via [HAPI](https://hapi.run)

  Co-Authored-By: HAPI <noreply@hapi.run>
  ```
- 不要 push、不要部署（编排者统一做）。

---

### Task 1: 自动发音开关

**Files:**
- Modify: `apps/web/src/features/today/components/ActiveSession.tsx`
- Test: `apps/web/tests/today-autospeak.test.tsx`（新建）

**Interfaces:**
- Consumes: `speak` from `../../../lib/tts`；lucide `Volume2`/`VolumeX`；ProgressRow 现有 props（新增 `autoSpeak: boolean; onToggleAutoSpeak: () => void`）。

- [ ] **Step 1: 写失败单测（today-autospeak.test.tsx）**

沿用 `today-helpers.tsx` 的 stubApi/renderTodayApp 模式（t1 done/t2 wrong/t3 当前/t4 未做 的 fixture 与 today-navigation.test.tsx 相同构造），文件顶部：

```tsx
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeActive, makeChoiceTask, makeCorrectAnswer, makeSessionEntry, makeTasksResponse, makeWrongAnswer, renderTodayApp, stubApi } from './today-helpers';

afterEach(cleanup);
vi.mock('../src/lib/tts', () => ({ speak: vi.fn(), stopSpeaking: vi.fn() }));

const { speak } = await import('../src/lib/tts');
```

（若顶层 await 不合 vitest 配置，改为测试内 `const tts = await import(...)` 或 `import * as tts from '../src/lib/tts'` 配合 `vi.mocked`——以文件内可编译为准。）

t1/t2/t3/t4 fixture 同 today-navigation.test.tsx 第 20-35 行（直接照抄构造）。

```tsx
describe('会话自动发音', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('el:auto-pronounce');
  });

  it('默认开：当前卡到达自动读词一次', async () => {
    stubSession(); // 同 today-navigation 的 stubSession
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    await waitFor(() => expect(vi.mocked(speak)).toHaveBeenCalledWith('gamma'));
    expect(vi.mocked(speak)).toHaveBeenCalledTimes(1);
  });

  it('localStorage 预置 0：不自动读', async () => {
    localStorage.setItem('el:auto-pronounce', '0');
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    await new Promise((r) => setTimeout(r, 100));
    expect(vi.mocked(speak)).not.toHaveBeenCalled();
  });

  it('开关按钮：点击关闭后切换不读，再开恢复；aria-pressed 反映状态', async () => {
    stubSession();
    renderTodayApp();
    await screen.findByText('第 3 / 4');
    await waitFor(() => expect(vi.mocked(speak)).toHaveBeenCalledTimes(1));

    const btn = screen.getByRole('button', { name: '自动发音' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem('el:auto-pronounce')).toBe('0');

    // 关闭后切换（列表点 alpha 回看）不触发
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    fireEvent.click(screen.getByRole('dialog', { name: '任务列表' }).querySelector('button')!);
    await screen.findByText('第 1 / 4');
    await new Promise((r) => setTimeout(r, 100));
    expect(vi.mocked(speak)).toHaveBeenCalledTimes(1);

    // 再开：下一次切换（列表点"当前"回 gamma）恢复自动读
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole('button', { name: '查看任务列表' }));
    // 点 gamma（当前）条目——用 within(dialog).getByRole('button', { name: /gamma/ })
    await screen.findByText('第 3 / 4');
    await waitFor(() => expect(vi.mocked(speak)).toHaveBeenCalledWith('gamma'));
  });
});
```

（第三用例中弹层条目定位用 `within` 正规写法，勿用 querySelector；写测试时按 today-navigation.test.tsx 的 within 模式落地。）

- [ ] **Step 2: 跑单测确认 RED**

Run: `cd apps/web && pnpm exec vitest run today-autospeak`
Expected: FAIL（无开关按钮 / 不自动读）。

- [ ] **Step 3: 实现**

3a. `ActiveSession.tsx`：
- import 追加：`import { speak } from '../../../lib/tts';`、lucide 行补 `Volume2, VolumeX`（`Check, X` 保留）。
- 组件内（cursor 声明附近）：

```ts
  /** 切卡自动读词（设备本地偏好）：缺省开，'0'=关 */
  const [autoSpeak, setAutoSpeak] = useState(() => localStorage.getItem('el:auto-pronounce') !== '0');
```

- 自动读 effect（放在 shownTask 计算之后、return 之前；依赖 taskId 而非对象）：

```ts
  // 切到某词（到达/回看/回当前）自动读一次；关闭时不读
  useEffect(() => {
    if (!autoSpeak || !shownTask) return;
    void speak(shownTask.item.target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在换卡时读，不随 result 变化重读
  }, [shownTask?.taskId, autoSpeak]);
```

（若项目 eslint 配置无该规则则去掉注释行；以 lint 实际通过为准。）
- ProgressRow 调用处追加 props：

```tsx
        autoSpeak={autoSpeak}
        onToggleAutoSpeak={() => {
          setAutoSpeak((v) => {
            const next = !v;
            localStorage.setItem('el:auto-pronounce', next ? '1' : '0');
            return next;
          });
        }}
```

3b. `ProgressRow`（同文件内组件）：Props 接口加 `autoSpeak: boolean; onToggleAutoSpeak: () => void;`，右侧"列表 ▾"同一行改为：

```tsx
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="自动发音"
            aria-pressed={autoSpeak}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            onClick={onToggleAutoSpeak}
          >
            {autoSpeak ? (
              <Volume2 className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <VolumeX className="h-3.5 w-3.5" aria-hidden />
            )}
          </button>
          <p className="text-xs text-muted-foreground/60">列表 ▾</p>
        </div>
```

（外层 button 的 `flex w-full items-center justify-between` 布局不变，右侧整体替换为上述容器。）

- [ ] **Step 4: 跑单测确认 GREEN + 全量**

Run: `cd apps/web && pnpm exec vitest run today-autospeak` → 3 passed。
Run: `pnpm --filter @el/web run test` → 全过（注意 today-navigation 等既有用例不读 tts——它们未 mock tts，effect 会真的调 speak → fetch /api/tts！**需要检查**：jsdom fetch 对 /api/tts 相对路径会失败进 catch 静默，无碍；但为确定性，ActiveSession 的 effect 对 jsdom 无妨。若既有用例因该 effect 出现告警/失败，在受影响测试文件顶部加同一 `vi.mock('../src/lib/tts', ...)`。）

- [ ] **Step 5: typecheck + e2e 冒烟 + Commit**

Run: `pnpm --filter @el/web run typecheck`；`E2E_API_PORT=5175 pnpm --filter @el/web exec playwright test -g "Today"` → 全过。

```bash
git add apps/web/src/features/today/components/ActiveSession.tsx apps/web/tests/today-autospeak.test.tsx apps/web/tests
git commit -m "feat(web): 会话切卡自动读词——页内音量开关（localStorage 持久化，默认开）

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>"
```
