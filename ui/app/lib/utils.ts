import { clsx } from 'clsx'
import type { ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// twMerge must know the D2 scale (app/styles/app.css), or it reads `text-meta` as a colour and drops it
// when a `text-fg` follows, and it can't tell that `rounded-ctl` replaces `rounded-chip`.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['micro', 'meta', 'ui', 'body', 'lead', 'title', 'h1', 'ask'],
      radius: ['chip', 'ctl', 'card', 'panel', 'hero'],
      shadow: ['e1', 'e2', 'hero'],
    },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
