import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { setupAutoUpdate } from './lib/pwa-update';
import { Providers } from './app/providers';
import './styles/globals.css';

setupAutoUpdate();

// 禁用 iOS 边缘滑动导航（左边缘→后退 / 右边缘→前进）：
// 拦截屏幕左右 20px 内的 touchstart，防止浏览器解释为导航手势。
// 中间区域完全不受影响（滚动/点击/自定义滑动正常）。
const EDGE_PX = 20;
document.addEventListener(
  'touchstart',
  (e) => {
    const touch = e.touches[0];
    if (!touch) return;
    if (touch.clientX <= EDGE_PX || touch.clientX >= window.innerWidth - EDGE_PX) {
      e.preventDefault();
    }
  },
  { passive: false },
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);
