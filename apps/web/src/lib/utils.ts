import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并 tailwind 类名（shadcn 约定） */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
