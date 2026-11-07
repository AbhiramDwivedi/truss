// The D2 colour check every ui/e2e and ui/contract/e2e spec file runs once (ADR-0023 checklist item 22): it
// reads ui/contract/redesign/tokens.json and asserts that the rendered page paints body with `bg` and the move
// surface with `move`. The move surface is the first article in Your move, or else the composer's send button.
// Not a spec (no .spec.ts), so no project lists it; it imports nothing from ui/e2e, and ui/e2e/harness.ts
// re-exports it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Locator, type Page } from '@playwright/test'

export type D2Theme = 'light' | 'dark'
export const d2Tokens: { colors: Record<string, { light: string; dark: string }> } =
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'redesign', 'tokens.json'), 'utf8'))

/** The CSS colour a browser computes for a tokens.json colour in a theme: rgb(r, g, b). */
export function d2Colour(name: string, theme: D2Theme): string {
  const hex = d2Tokens.colors[name]?.[theme]
  if (!hex) throw new Error(`tokens.json has no colour ${name}`)
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

const SEND = /^(Start run|Send to PM|Add as new goal)$/

/** Asserts body `background-color` is `bg` and the move surface's is `move`, in the theme the page shows. */
export async function expectD2Colours(page: Page, theme: D2Theme, within = { timeout: 5000 }): Promise<void> {
  await expect(page.locator('body'), `body background-color is tokens.json bg (${theme})`).toHaveCSS('background-color', d2Colour('bg', theme), within)
  const cards = page.getByRole('region', { name: 'Your move', exact: true }).getByRole('article')
  const surface: Locator = (await cards.count()) > 0
    ? cards.first()
    : page.getByRole('form', { name: 'Message', exact: true }).getByRole('button', { name: SEND })
  await expect(surface, `the move surface's background-color is tokens.json move (${theme})`).toHaveCSS('background-color', d2Colour('move', theme), within)
}
