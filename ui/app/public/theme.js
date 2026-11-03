// Sets the page theme from the OS before first paint (ADR-0023:157). A classic blocking script, so the
// CSP's default-src 'self' allows it and no light frame shows in dark mode. It stores nothing.
// It follows OS changes until the Dark theme toggle (app/lib/theme.ts) sets data-theme-override on <html>.
;(function () {
  var root = document.documentElement
  var media = window.matchMedia('(prefers-color-scheme: dark)')
  root.classList.toggle('dark', media.matches)
  media.addEventListener('change', function (e) {
    if (!root.hasAttribute('data-theme-override')) root.classList.toggle('dark', e.matches)
  })
})()
