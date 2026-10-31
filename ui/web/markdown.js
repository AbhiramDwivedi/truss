// Markdown for the design panel (ADR-0011 Decision 7). marked is loaded with import('/vendor/marked.js') the
// first time something needs rendering, so the first screen doesn't wait for it. Raw HTML in the markdown is
// escaped, not passed through; a mermaid block shows as its source under a label; images are not fetched
// (the page may load only its own files), so they show as their alt text.

export const MERMAID_LABEL = 'mermaid diagram (source)'

let loading

export function loadMarked() {
  if (!loading) {
    loading = import('/vendor/marked.js').then((mod) => makeParser(mod.Marked)).catch((err) => {
      loading = undefined
      throw err
    })
  }
  return loading
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Only web, mail and in-page or relative links stay links.
function safeHref(href) {
  const h = String(href || '').trim()
  if (/^(https?:|mailto:|#)/i.test(h)) return true
  return !/^[a-z][a-z0-9+.-]*:/i.test(h)
}

function makeParser(Marked) {
  const marked = new Marked({
    gfm: true,
    renderer: {
      html({ text }) {
        return escapeHtml(text)
      },
      code({ text, lang }) {
        const word = String(lang || '').trim().split(/\s+/)[0].toLowerCase()
        if (word === 'mermaid') {
          return '<figure class="md-mermaid"><figcaption>' + MERMAID_LABEL + '</figcaption><pre tabindex="0"><code>' + escapeHtml(text) + '</code></pre></figure>\n'
        }
        return '<pre tabindex="0"><code>' + escapeHtml(text) + '</code></pre>\n'
      },
      link(token) {
        if (!safeHref(token.href)) return this.parser.parseInline(token.tokens)
        return false
      },
      image({ text }) {
        return '<span class="md-image">[image: ' + escapeHtml(text || 'no description') + ']</span>'
      },
    },
  })
  return (markdown) => marked.parse(String(markdown), { async: false })
}

// Renders `markdown` into `target`. Resolves when done; on a load failure the text shows as plain preformatted text.
export async function renderMarkdown(target, markdown) {
  try {
    const parse = await loadMarked()
    target.innerHTML = parse(markdown)
  } catch {
    const pre = document.createElement('pre')
    pre.tabIndex = 0
    pre.textContent = markdown
    target.replaceChildren(pre)
  }
}
