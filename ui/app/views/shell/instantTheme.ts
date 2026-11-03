// A theme switch repaints every colour at once (ADR-0023:157). Controls ease their colours on hover and on
// state, and without this a switch would ease them too: for a moment a control's text keeps the old theme's
// colour on the new theme's background, too faint to read. When `.dark` changes on <html>, a constructed
// stylesheet (CSSOM, which the CSP allows) turns transitions off until the new colours have painted.
// The MutationObserver callback runs as a microtask straight after the class changes, before the browser
// next computes styles, so no transition starts.
import { useEffect } from 'react'

const OFF = '*, *::before, *::after { transition: none !important; }'

export function useInstantThemeSwitch(): void {
  useEffect(() => {
    const root = document.documentElement
    if (typeof CSSStyleSheet === 'undefined' || !('adoptedStyleSheets' in document)) return
    let sheet: CSSStyleSheet
    try {
      sheet = new CSSStyleSheet()
      sheet.replaceSync(OFF)
    } catch {
      return
    }
    let dark = root.classList.contains('dark')
    let frame = 0
    const drop = () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet)
    }
    const observer = new MutationObserver(() => {
      const now = root.classList.contains('dark')
      if (now === dark) return
      dark = now
      if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
      cancelAnimationFrame(frame)
      // Two frames: the first paints the new colours with transitions off, the second turns them back on.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(drop)
      })
    })
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      drop()
    }
  }, [])
}
