import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn('field-control flex w-full px-3.5 py-3 leading-relaxed', className)}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

interface AutoGrowTextareaProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'rows'
> {
  value: string;
}

/** 隐藏镜像负责排版测量，兼容没有 field-sizing 的 iOS；无需逐字读写 DOM 高度。 */
export const AutoGrowTextarea = forwardRef<HTMLTextAreaElement, AutoGrowTextareaProps>(
  ({ value, className, ...props }, ref) => (
    <div className="auto-grow-textarea" data-value={value}>
      <Textarea
        {...props}
        ref={ref}
        rows={1}
        value={value}
        className={cn('auto-grow-textarea-field', className)}
      />
    </div>
  ),
);
AutoGrowTextarea.displayName = 'AutoGrowTextarea';
