// One chat message (R-45): the client on the right, the PM on the left, errors on fail-soft. The corner nearest
// the sender is the small one, so who is talking never rests on colour alone. Consecutive messages from one
// sender drop the avatar and name but keep the time, and say who spoke in hidden text.
import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "../../lib/utils.ts";
import { PmAvatar } from "./PmAvatar.tsx";

export interface BubbleProps {
  who: "you" | "pm" | "error";
  time: string;
  grouped: boolean;
  queued?: boolean;
  /** Set when a card has asked for this message: shows the focus ring. */
  lit?: boolean;
  id: string;
  /** The dashed first-use line from an empty thread. */
  hint?: boolean;
  children: ReactNode;
}

const NAME = { you: "You", pm: "PM", error: "Error" } as const;
const SAID = { you: "You said", pm: "PM said", error: "Error" } as const;

export const QUEUED_LABEL = "Queued: sends when the PM finishes its turn";

export function Bubble({
  who,
  time,
  grouped,
  queued,
  lit,
  id,
  hint,
  children,
}: BubbleProps) {
  const mine = who === "you";
  // An error carries its label inside the fail-soft bubble, so the word and icon travel with the colour.
  const inside = who === "error";
  const head = (
    <p
      className={cn(
        "flex items-center gap-2 text-meta",
        "mb-1",
        mine && "flex-row-reverse",
      )}
    >
      {grouped ? (
        <span className="sr-only">{SAID[who]}</span>
      ) : (
        <>
          {who === "pm" && <PmAvatar />}
          {who === "error" && (
            <TriangleAlert
              aria-hidden="true"
              className="size-3.5 shrink-0 text-fail"
            />
          )}
          <span
            className={cn(
              "font-semibold",
              who === "error" ? "text-fail-text" : "text-fg",
            )}
          >
            {NAME[who]}
          </span>
        </>
      )}
      {time && (
        <span className="font-mono text-micro tabular-nums text-muted">
          {time}
        </span>
      )}
    </p>
  );
  return (
    <li
      id={id}
      tabIndex={-1}
      className={cn(
        "min-w-0 outline-offset-2 transition-[outline-color,opacity] duration-(--duration-quick) ease-out [content-visibility:auto] [contain-intrinsic-size:auto_3rem] motion-reduce:transition-none starting:opacity-0",
        grouped ? "mt-2" : "mt-4 first:mt-0",
        lit ? "outline-2 outline-(--focus)" : "outline-0 outline-transparent",
      )}
    >
      <article
        aria-label={SAID[who]}
        className={cn(
          "flex min-w-0 flex-col",
          mine ? "items-end" : "items-start",
        )}
      >
        {!inside && head}
        <div
          className={cn(
            "min-w-0 max-w-[85%] rounded-card border px-3 py-2 text-ui leading-normal text-fg whitespace-pre-wrap [overflow-wrap:anywhere] max-[30rem]:max-w-[90%]",
            mine && "rounded-br-chip border-brand-line bg-brand-soft",
            who === "pm" &&
              "max-w-[92%] rounded-bl-chip border-border bg-surface max-[30rem]:max-w-[90%]",
            who === "error" &&
              "max-w-[92%] rounded-bl-chip border-fail bg-fail-soft max-[30rem]:max-w-[90%]",
            hint && "border-dashed border-border-strong",
            queued && "border-dashed opacity-70",
          )}
        >
          {inside && head}
          {children}
        </div>
        {queued && <p className="mt-1 text-meta text-muted">{QUEUED_LABEL}</p>}
      </article>
    </li>
  );
}
