// The PM's message text as safe markdown (R-45): marked's lexer turned into React elements, so nothing is ever
// written as HTML. Raw HTML shows as the text it is, images as their alt words, links only for http(s) and
// always with rel="noopener noreferrer". Styled with classes only, so the CSP holds (no inline styles).
import { Fragment, type ReactNode } from "react";
import { Lexer, type Token, type Tokens } from "marked";

/** True for a link target the thread may open: http or https only. */
export function safeLink(href: string): boolean {
  return /^https?:\/\//i.test(String(href || "").trim());
}

function inline(tokens: Token[] | undefined, key = ""): ReactNode[] {
  return (tokens ?? []).map((t, i) => {
    const k = `${key}${i}`;
    switch (t.type) {
      case "strong":
        return <strong key={k} className="font-semibold">{inline((t as Tokens.Strong).tokens, k)}</strong>;
      case "em":
        return <em key={k}>{inline((t as Tokens.Em).tokens, k)}</em>;
      case "del":
        return <del key={k}>{inline((t as Tokens.Del).tokens, k)}</del>;
      case "codespan":
        return (
          <code key={k} className="rounded-chip bg-sunken px-1 font-mono text-meta">
            {(t as Tokens.Codespan).text}
          </code>
        );
      case "br":
        return <br key={k} />;
      case "link": {
        const l = t as Tokens.Link;
        if (!safeLink(l.href)) return <Fragment key={k}>{inline(l.tokens, k)}</Fragment>;
        return (
          <a key={k} href={l.href} target="_blank" rel="noopener noreferrer" className="text-brand-strong underline">
            {inline(l.tokens, k)}
          </a>
        );
      }
      case "image":
        return <span key={k}>[image: {(t as Tokens.Image).text || "no description"}]</span>;
      case "text": {
        const x = t as Tokens.Text;
        return <Fragment key={k}>{x.tokens ? inline(x.tokens, k) : x.text}</Fragment>;
      }
      case "escape":
        return <Fragment key={k}>{(t as Tokens.Escape).text}</Fragment>;
      default:
        // html and anything unknown: its source, as text.
        return <Fragment key={k}>{t.raw}</Fragment>;
    }
  });
}

function block(tokens: Token[], key = ""): ReactNode[] {
  const out: ReactNode[] = [];
  tokens.forEach((t, i) => {
    const k = `${key}${i}`;
    switch (t.type) {
      case "space":
        return;
      case "paragraph":
        out.push(<p key={k} className="my-1.5 first:mt-0 last:mb-0">{inline((t as Tokens.Paragraph).tokens, k)}</p>);
        return;
      case "heading":
        out.push(<p key={k} className="my-1.5 font-semibold first:mt-0 last:mb-0">{inline((t as Tokens.Heading).tokens, k)}</p>);
        return;
      case "code":
        out.push(
          <pre key={k} tabIndex={0} className="my-1.5 max-w-full overflow-x-auto rounded-ctl bg-sunken p-2 font-mono text-meta whitespace-pre [overflow-wrap:normal]">
            {(t as Tokens.Code).text}
          </pre>,
        );
        return;
      case "list": {
        const l = t as Tokens.List;
        const Tag = l.ordered ? "ol" : "ul";
        out.push(
          <Tag key={k} className={`my-1.5 pl-5 ${l.ordered ? "list-decimal" : "list-disc"}`}>
            {l.items.map((it, j) => (
              <li key={j} className="my-0.5">{block(it.tokens, `${k}.${j}.`)}</li>
            ))}
          </Tag>,
        );
        return;
      }
      case "blockquote":
        out.push(
          <blockquote key={k} className="my-1.5 border-l-2 border-border-strong pl-3 text-muted">
            {block((t as Tokens.Blockquote).tokens, k)}
          </blockquote>,
        );
        return;
      case "hr":
        out.push(<hr key={k} className="my-2 border-border" />);
        return;
      case "text": {
        // A tight list item's text: inline content with no paragraph around it.
        const x = t as Tokens.Text;
        out.push(<Fragment key={k}>{x.tokens ? inline(x.tokens, k) : x.text}</Fragment>);
        return;
      }
      default:
        // html, table and anything else: the source as plain text, so nothing is lost and nothing is HTML.
        out.push(<p key={k} className="my-1.5 whitespace-pre-wrap first:mt-0 last:mb-0">{t.raw.trim()}</p>);
    }
  });
  return out;
}

export function Markdown({ text }: { text: string }) {
  let tokens: Token[];
  try {
    tokens = new Lexer({ gfm: true }).lex(String(text));
  } catch {
    return <>{text}</>;
  }
  return <div className="min-w-0 whitespace-normal">{block(tokens)}</div>;
}
