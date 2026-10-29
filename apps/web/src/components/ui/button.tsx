import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'native-button inline-flex shrink-0 items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:pointer-events-none disabled:opacity-50 select-none',
  {
    variants: {
      variant: {
        default: 'bg-accent text-accent-foreground hover:bg-accent-hover active:bg-accent-hover',
        primary: 'bg-accent text-accent-foreground hover:bg-accent-hover active:bg-accent-hover',
        neutral: 'border border-border bg-muted text-foreground hover:bg-muted-hover',
        negative:
          'border border-destructive/15 bg-destructive-soft text-destructive hover:border-destructive/40 hover:bg-destructive/15',
        ghost: 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
        destructive: 'bg-destructive text-accent-foreground hover:brightness-90',
      },
      size: {
        default: 'h-12 px-4 text-base',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-12 px-6 text-base',
        icon: 'h-11 w-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';

export { buttonVariants };
