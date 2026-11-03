// Spec test for the floor-shell primitives in ui/app/components/ui, rendered through Vite's SSR loader.
// No JSX: React.createElement only. A class token matches when it equals X or ends in `:X` (a variant prefix).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { createRenderer, type Renderer } from './render.ts'

let r: Renderer
let M: Record<string, Record<string, any>> = {}
const FILES = [
  'button', 'badge', 'dot', 'card', 'tabs', 'radio-group', 'checkbox', 'input', 'textarea',
  'input-group', 'label', 'collapsible', 'hint', 'notice', 'skeleton',
]

before(async () => {
  r = await createRenderer()
  for (const f of FILES) M[f] = await r.load(`components/ui/${f}.tsx`)
})
after(async () => {
  await r?.close()
})

const html = (el: any) => r.render(el)
const openTag = (markup: string, re: RegExp) => {
  const m = re.exec(markup)
  assert.ok(m, `no element matching ${re} in ${markup}`)
  return m[0]
}
const tokensOf = (tag: string) => (/\bclass="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/).filter(Boolean)
const allTokens = (markup: string) => [...markup.matchAll(/\bclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean)
// X matches a token equal to X or ending in `:X`.
const has = (toks: string[], x: string) => toks.some((t) => t === x || t.endsWith(':' + x))
const exact = (toks: string[], x: string) => toks.includes(x)
function expectAll(toks: string[], want: string[], what: string) {
  const miss = want.filter((x) => !has(toks, x))
  assert.deepEqual(miss, [], `${what} lacks ${miss.join(' ')}; has: ${toks.join(' ')}`)
}
const btnTag = (markup: string) => openTag(markup, /<button\b[^>]*>/)

// ---- Button ----

test('Button renders <button type="button"> with the label in a min-w-0 truncate span', () => {
  const out = html(h(M.button.Button, null, 'Send it'))
  const tag = btnTag(out)
  assert.match(tag, /\btype="button"/)
  const span = openTag(out, /<span\b[^>]*>Send it<\/span>/)
  expectAll(tokensOf(span), ['min-w-0', 'truncate'], 'the label span')
})

test('Button variants carry their D2 tokens', () => {
  const want: Record<string, string[]> = {
    primary: ['bg-primary', 'text-primary-foreground', 'shadow-e1'],
    secondary: ['bg-surface', 'border-border', 'text-fg'],
    ghost: ['text-muted'],
    danger: ['bg-fail', 'text-surface'],
    'danger-soft': ['bg-fail-soft', 'text-fail-text'],
    'on-move': ['bg-move-fg', 'text-move'],
  }
  for (const [variant, toks] of Object.entries(want)) {
    const t = tokensOf(btnTag(html(h(M.button.Button, { variant }, 'Go'))))
    expectAll(t, [...toks, 'rounded-ctl', 'font-semibold'], `Button ${variant}`)
    assert.ok(!has(t, 'bg-brand'), `Button ${variant} uses bg-brand`)
  }
})

test('Button sizes: sm h-8, md h-9, lg h-10, icon size-9; sm grows on coarse pointers', () => {
  const tok = (props: any) => tokensOf(btnTag(html(h(M.button.Button, props, props.size === 'icon' ? undefined : 'Go'))))
  const sm = tok({ size: 'sm' })
  assert.ok(exact(sm, 'h-8') && has(sm, 'px-3') && has(sm, 'pointer-coarse:h-10') && has(sm, 'text-meta'), sm.join(' '))
  const md = tok({ size: 'md' })
  assert.ok(exact(md, 'h-9') && has(md, 'px-3.5') && has(md, 'text-meta'), md.join(' '))
  const lg = tok({ size: 'lg' })
  assert.ok(exact(lg, 'h-10') && has(lg, 'px-4') && has(lg, 'text-ui'), lg.join(' '))
  const icon = tok({ size: 'icon', 'aria-label': 'Close' })
  assert.ok(has(icon, 'size-9'), icon.join(' '))
  for (const t of [sm, md, lg, icon]) expectAll(t, ['rounded-ctl', 'font-semibold'], 'a Button size')
})

test('buttonVariants is exported and returns classes', () => {
  assert.equal(typeof M.button.buttonVariants, 'function')
  assert.match(M.button.buttonVariants({ variant: 'primary', size: 'md' }), /bg-primary/)
})

function fakeEvent(key?: string) {
  return { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {} }
}

test('Button without aria-disabled passes the click through (control)', () => {
  let n = 0
  const el: any = M.button.Button({ onClick: () => n++, children: 'Go' })
  el.props.onClick(fakeEvent())
  assert.equal(n, 1)
})

test('Button aria-disabled stays focusable, looks dim and ignores click and Enter', () => {
  let n = 0
  const props = { 'aria-disabled': true, onClick: () => n++, children: 'Pause' }
  const el: any = M.button.Button(props)
  el.props.onClick?.(fakeEvent())
  el.props.onKeyDown?.(fakeEvent('Enter'))
  el.props.onKeyUp?.(fakeEvent('Enter'))
  assert.equal(n, 0, 'onClick ran on an aria-disabled button')
  const tag = btnTag(html(h(M.button.Button, props)))
  assert.match(tag, /aria-disabled="true"/)
  assert.doesNotMatch(tag, /\sdisabled(=|\s|>)/, 'aria-disabled must not set the disabled attribute')
  assert.doesNotMatch(tag, /tabindex="-1"/)
  expectAll(tokensOf(tag), ['opacity-50', 'cursor-not-allowed'], 'aria-disabled Button')
})

test('Button busy sets aria-busy, keeps the label, spins the icon and ignores clicks', () => {
  let n = 0
  const props = { busy: true, onClick: () => n++, children: 'Sending' }
  const el: any = M.button.Button(props)
  el.props.onClick?.(fakeEvent())
  el.props.onKeyDown?.(fakeEvent('Enter'))
  assert.equal(n, 0, 'onClick ran on a busy button')
  const out = html(h(M.button.Button, props))
  assert.match(btnTag(out), /aria-busy="true"/)
  assert.match(out, /Sending/)
  assert.ok(has(allTokens(out), 'motion-safe:animate-spin'), 'no motion-safe:animate-spin')
})

// ---- Badge, ModelBadge, Dot, LivePing ----

test('Badge tones', () => {
  const want: Record<string, string[]> = {
    neutral: ['bg-secondary', 'text-muted'],
    brand: ['bg-brand-soft', 'text-brand-strong'],
    signal: ['bg-signal-soft', 'text-signal-text'],
    fail: ['bg-fail-soft', 'text-fail-text'],
    ok: ['bg-ok-soft', 'text-fg'],
    move: ['bg-move', 'text-move-fg'],
    'fail-solid': ['bg-fail', 'text-surface'],
  }
  for (const [tone, toks] of Object.entries(want)) {
    const out = html(h(M.badge.Badge, { tone }, 'Label'))
    const t = allTokens(out)
    expectAll(t, toks, `Badge ${tone}`)
    for (const bad of ['text-ok', 'text-signal', 'text-sonnet']) assert.ok(!exact(t, bad), `Badge ${tone} uses ${bad}`)
    if (tone === 'ok') {
      assert.match(out, /aria-hidden="true"/)
      assert.ok(has(t, 'bg-ok'), 'ok badge has no bg-ok Dot')
    }
  }
})

test('Badge sizes, shapes, title and truncation', () => {
  const sm = tokensOf(openTag(html(h(M.badge.Badge, { size: 'sm' }, 'x')), /<(span|div|a)\b[^>]*>/))
  assert.ok(exact(sm, 'h-5') && has(sm, 'px-1.5'), sm.join(' '))
  const md = tokensOf(openTag(html(h(M.badge.Badge, { size: 'md' }, 'x')), /<(span|div|a)\b[^>]*>/))
  assert.ok(exact(md, 'h-6') && has(md, 'px-2.5'), md.join(' '))
  assert.ok(has(tokensOf(openTag(html(h(M.badge.Badge, { shape: 'chip' }, 'x')), /<(span|div|a)\b[^>]*>/)), 'rounded-chip'))
  assert.ok(has(tokensOf(openTag(html(h(M.badge.Badge, { shape: 'pill' }, 'x')), /<(span|div|a)\b[^>]*>/)), 'rounded-full'))
  const long = 'a'.repeat(80)
  const out = html(h(M.badge.Badge, { title: long }, long))
  assert.match(out, new RegExp(`title="${long}"`))
  const t = allTokens(out)
  assert.ok(has(t, 'max-w-full') && has(t, 'truncate'), t.join(' '))
})

test('ModelBadge is text-fg with a border and colours only a Dot', () => {
  for (const m of ['opus', 'sonnet']) {
    const out = html(h(M.badge.ModelBadge, { model: m }, m))
    const t = allTokens(out)
    expectAll(t, ['text-fg', 'border-border', `bg-${m}`], `ModelBadge ${m}`)
    assert.ok(!t.some((x) => x.endsWith(`text-${m}`)), `ModelBadge ${m} uses the model colour as text`)
    assert.match(out, /aria-hidden="true"/)
  }
  const other = allTokens(html(h(M.badge.ModelBadge, { model: 'haiku' }, 'haiku')))
  assert.ok(!has(other, 'bg-opus') && !has(other, 'bg-sonnet'))
  expectAll(other, ['text-fg', 'border-border'], 'ModelBadge haiku')
})

test('Dot and LivePing are aria-hidden 6px marks', () => {
  for (const [name, props] of [['Dot', { tone: 'ok' }], ['LivePing', { tone: 'ok' }]] as const) {
    const out = html(h(M.dot[name], props))
    assert.match(out, /aria-hidden="true"/, name)
    assert.ok(has(allTokens(out), 'size-1.5'), `${name} is not size-1.5`)
  }
  assert.ok(has(allTokens(html(h(M.dot.Dot, { tone: 'ok' }))), 'bg-ok'))
})

// ---- Card ----

test('Card variants', () => {
  const want: Record<string, string[]> = {
    default: ['bg-card', 'border-border', 'rounded-card', 'shadow-e1'],
    panel: ['rounded-panel'],
    sunken: ['bg-secondary'],
    'alert-fail': ['bg-fail-soft', 'border-fail/40'],
    'alert-signal': ['bg-signal-soft', 'border-signal/40'],
    hero: ['bg-move', 'text-move-fg', 'rounded-hero', 'shadow-hero', 'p-6', 'max-lg:p-4'],
  }
  for (const [variant, toks] of Object.entries(want)) {
    const out = html(h(M.card.Card, { variant }, 'x'))
    const t = tokensOf(openTag(out, /<[a-z]+\b[^>]*>/))
    expectAll(t, toks, `Card ${variant}`)
    assert.equal(has(t, 'shadow-hero'), variant === 'hero', `shadow-hero on Card ${variant}`)
    assert.equal(/data-surface="move"/.test(openTag(out, /<[a-z]+\b[^>]*>/)), variant === 'hero', `data-surface on Card ${variant}`)
  }
})

test('Card hero asChild renders the given <section>', () => {
  const out = html(h(M.card.Card, { variant: 'hero', asChild: true }, h('section', null, 'Your move')))
  assert.match(out, /^<section\b[^>]*data-surface="move"/)
  assert.ok(has(allTokens(out), 'shadow-hero'))
})

// ---- Tabs ----

const tabs = () =>
  html(
    h(M.tabs.Tabs, { defaultValue: 'a' },
      h(M.tabs.TabsList, null, h(M.tabs.TabsTrigger, { value: 'a' }, 'One'), h(M.tabs.TabsTrigger, { value: 'b' }, 'Two')),
      h(M.tabs.TabsContent, { value: 'a' }, 'Body')))

test('Tabs list and trigger carry the D2 look', () => {
  const out = tabs()
  const list = tokensOf(openTag(out, /<[a-z]+\b[^>]*role="tablist"[^>]*>/))
  expectAll(list, ['bg-secondary', 'rounded-ctl', 'p-0.5', 'overflow-x-auto', 'no-scrollbar'], 'TabsList')
  const trig = tokensOf(openTag(out, /<button\b[^>]*role="tab"[^>]*>/))
  assert.ok(exact(trig, 'h-7'), trig.join(' '))
  expectAll(trig, ['rounded-chip', 'px-2.5', 'text-meta', 'font-medium', 'text-muted', 'pointer-coarse:h-9'], 'TabsTrigger')
  for (const x of ['bg-surface', 'text-fg', 'shadow-e1', 'ring-1', 'ring-border']) {
    assert.ok(trig.includes(`data-[state=active]:${x}`), `active trigger lacks data-[state=active]:${x}; has ${trig.join(' ')}`)
  }
  assert.match(out, /role="tabpanel"/)
})

// ---- RadioGroup, Checkbox ----

const radio = (look: string) =>
  html(h(M['radio-group'].RadioGroup, { defaultValue: 'a' }, h(M['radio-group'].RadioGroupItem, { value: 'a', look }, 'Alpha')))

test('RadioGroupItem: role radio inside a label of at least 24px', () => {
  for (const look of ['dot', 'segment']) {
    const out = radio(look)
    assert.match(out, /role="radiogroup"/)
    assert.match(out, /role="radio"/)
    const label = tokensOf(openTag(out, /<label\b[^>]*>/))
    assert.ok(has(label, 'min-h-6'), `${look}: label lacks min-h-6; has ${label.join(' ')}`)
    assert.match(out, /Alpha/)
  }
})

test('RadioGroupItem dot look and segment look', () => {
  const dot = allTokens(radio('dot'))
  expectAll(dot, ['border-2', 'border-subtle', 'border-brand', 'bg-brand', 'border-move-muted'], 'dot look')
  const seg = allTokens(radio('segment'))
  assert.ok(exact(seg, 'h-7'), seg.join(' '))
  expectAll(seg, ['rounded-chip', 'px-2.5', 'text-meta'], 'segment look')
})

test('Checkbox: role checkbox in a label of at least 24px, checked bg-primary', () => {
  const out = html(h(M.checkbox.Checkbox, { defaultChecked: true }, 'Agree'))
  assert.match(out, /role="checkbox"/)
  assert.match(out, /Agree/)
  assert.ok(has(tokensOf(openTag(out, /<label\b[^>]*>/)), 'min-h-6'))
  assert.ok(has(allTokens(out), 'bg-primary'))
})

// ---- Input, Textarea, InputGroup, Label ----

test('Input default surface', () => {
  const t = tokensOf(openTag(html(h(M.input.Input, { 'aria-label': 'Name' })), /<input\b[^>]*>/))
  expectAll(t, ['bg-surface', 'border-input', 'rounded-ctl', 'text-body', 'px-3', 'placeholder:text-subtle', 'border-brand', 'border-fail'], 'Input')
  assert.ok(exact(t, 'h-10'), t.join(' '))
  assert.ok(!has(t, 'text-move-fg'))
})

test('Input invalid and move surface', () => {
  const tag = openTag(html(h(M.input.Input, { 'aria-label': 'Name', 'aria-invalid': true, 'aria-describedby': 'e' })), /<input\b[^>]*>/)
  assert.match(tag, /aria-invalid="true"/)
  assert.match(tag, /aria-describedby="e"/)
  const mv = tokensOf(openTag(html(h(M.input.Input, { 'aria-label': 'Name', surface: 'move' })), /<input\b[^>]*>/))
  expectAll(mv, ['border-move-line', 'placeholder:text-move-muted', 'text-move-fg'], 'Input move')
})

test('Textarea mirrors Input; bare is legal only inside InputGroup', () => {
  const t = tokensOf(openTag(html(h(M.textarea.Textarea, { 'aria-label': 'Say' })), /<textarea\b[^>]*>/))
  expectAll(t, ['bg-surface', 'border-input', 'rounded-ctl', 'text-body', 'placeholder:text-subtle', 'border-brand', 'border-fail'], 'Textarea')
  const mv = tokensOf(openTag(html(h(M.textarea.Textarea, { 'aria-label': 'Say', surface: 'move' })), /<textarea\b[^>]*>/))
  expectAll(mv, ['border-move-line', 'placeholder:text-move-muted'], 'Textarea move')
  assert.throws(() => html(h(M.textarea.Textarea, { 'aria-label': 'Say', variant: 'bare' })))
  const out = html(
    h(M['input-group'].InputGroup, null,
      h(M.textarea.Textarea, { 'aria-label': 'Say', variant: 'bare' }),
      h(M['input-group'].InputGroupAction, null, 'Send')))
  assert.match(out, /<textarea/)
  assert.match(out, /Send/)
  const bare = tokensOf(openTag(out, /<textarea\b[^>]*>/))
  assert.ok(!exact(bare, 'border') && !has(bare, 'border-input'), `bare Textarea draws a border: ${bare.join(' ')}`)
})

test('InputGroup owns the border and the focus-within outline', () => {
  const out = html(h(M['input-group'].InputGroup, null, h(M.textarea.Textarea, { 'aria-label': 'Say', variant: 'bare' })))
  const root = tokensOf(openTag(out, /<[a-z]+\b[^>]*>/))
  assert.ok(exact(root, 'border'), root.join(' '))
  expectAll(root, ['focus-within:outline-2', 'outline-(--focus)', 'rounded-ctl'], 'InputGroup')
})

test('Label', () => {
  const t = tokensOf(openTag(html(h(M.label.Label, null, 'Name')), /<label\b[^>]*>/))
  expectAll(t, ['text-meta', 'font-medium', 'text-fg'], 'Label')
})

// ---- Collapsible, Hint, Notice, Skeleton ----

test('CollapsibleTrigger is a button with aria-expanded and a ChevronDown', () => {
  const out = html(h(M.collapsible.Collapsible, null, h(M.collapsible.CollapsibleTrigger, null, 'More'), h(M.collapsible.CollapsibleContent, null, 'Body')))
  assert.match(btnTag(out), /aria-expanded="false"/)
  assert.match(out, /<svg\b[^>]*lucide-chevron-down/)
  assert.match(out, /More/)
})

test('Hint is a visible <p id> with an aria-hidden icon', () => {
  const out = html(h(M.hint.Hint, { id: 'pause-tip' }, 'Pause works after the next step'))
  const p = openTag(out, /<p\b[^>]*>/)
  assert.match(p, /\bid="pause-tip"/)
  expectAll(tokensOf(p), ['text-meta', 'text-muted'], 'Hint')
  assert.match(openTag(out, /<svg\b[^>]*>/), /aria-hidden="true"/)
  assert.match(out, /Pause works after the next step/)
})

test('Notice live regions, tones and text', () => {
  const polite = html(h(M.notice.Notice, { tone: 'signal', live: 'polite' }, 'Reconnecting…'))
  assert.match(polite, /role="status"/)
  assert.match(polite, /Reconnecting…/)
  expectAll(allTokens(polite), ['bg-signal-soft', 'text-signal-text'], 'Notice signal')
  const off = html(h(M.notice.Notice, { tone: 'fail', live: 'off' }, 'It failed'))
  assert.doesNotMatch(off, /role="status"/)
  assert.match(off, /It failed/)
  expectAll(allTokens(off), ['bg-fail-soft', 'text-fail-text'], 'Notice fail')
  const info = html(h(M.notice.Notice, { tone: 'info', live: 'polite' }, 'Note'))
  assert.ok(has(allTokens(info), 'text-muted'))
})

test('Skeleton is a pulsing secondary block with no default height', () => {
  const t = tokensOf(openTag(html(h(M.skeleton.Skeleton)), /<[a-z]+\b[^>]*>/))
  expectAll(t, ['bg-secondary', 'rounded-chip', 'motion-safe:animate-pulse'], 'Skeleton')
  assert.ok(!t.some((x) => /(^|:)(min-|max-)?(h|size)-/.test(x)), `Skeleton has a default height: ${t.join(' ')}`)
  assert.ok(has(tokensOf(openTag(html(h(M.skeleton.Skeleton, { className: 'h-4' })), /<[a-z]+\b[^>]*>/)), 'h-4'))
})
