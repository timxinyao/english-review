import { useState } from 'react';
import { haptic, hapticsEnabled, hapticsSupported, setHapticsEnabled } from '../../../lib/haptics';
import { Button } from '../../../components/ui/button';

export function FeedbackSection() {
  const [enabled, setEnabled] = useState(hapticsEnabled);
  const supported = hapticsSupported();
  return (
    <section className="space-y-3" aria-labelledby="feedback-title">
      <h2 id="feedback-title" className="text-sm font-semibold">
        交互反馈
      </h2>
      <div className="rounded-xl bg-card p-4 space-y-3">
        <label
          htmlFor="haptics"
          className="flex min-h-11 items-center justify-between gap-4 text-sm"
        >
          <span>轻触反馈</span>
          <input
            id="haptics"
            type="checkbox"
            role="switch"
            className="native-switch"
            checked={enabled && supported}
            disabled={!supported}
            onChange={(event) => {
              setHapticsEnabled(event.target.checked);
              setEnabled(hapticsEnabled());
              if (event.target.checked) haptic('selection');
            }}
          />
        </label>
        <p className="text-xs leading-6 text-muted-foreground">
          {supported
            ? '仅此设备。浏览器会尝试请求短震动，实际效果由设备决定；减少动态效果开启时不请求。'
            : '此浏览器不提供可用的震动接口。iPhone Safari / 主屏幕 App 保留视觉反馈，不模拟或承诺震动。'}
        </p>
        {supported && enabled && (
          <Button variant="neutral" size="sm" onClick={() => haptic('confirm')}>
            试一下反馈
          </Button>
        )}
        <p className="text-xs leading-6 text-muted-foreground">
          动画跟随系统的「减少动态效果」设置。
        </p>
      </div>
    </section>
  );
}
