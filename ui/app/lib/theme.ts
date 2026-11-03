// The page theme (ADR-0023:157). public/theme.js sets `.dark` on <html> from the OS before first paint and
// follows the OS until toggle() runs; toggle() then overrides the OS for the page's life. Nothing is stored.
import { useSyncExternalStore } from 'react'

const OVERRIDE = 'data-theme-override'

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

const isDark = (): boolean => document.documentElement.classList.contains('dark')

function toggle(): void {
  const root = document.documentElement
  root.setAttribute(OVERRIDE, '')
  root.classList.toggle('dark', !isDark())
}

export function useTheme(): { dark: boolean; toggle(): void } {
  const dark = useSyncExternalStore(subscribe, isDark, () => false)
  return { dark, toggle }
}
