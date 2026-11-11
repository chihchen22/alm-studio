import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The word a top-bar select pill reads when nothing is selected (Polish 5 T4). App prints it and SelectPill marks a
 * pill that reads it pill-none: one constant, so the two cannot drift apart.
 */
export const PILL_NONE = "none";

/**
 * A selector pill: a button that opens a plain list of links. Escape or an outside click closes it.
 * Where the top bar is tight the value is cut from its start behind an ellipsis, so its end shows (Polish 4 T1); the
 * full value is also the button's title. The value sits in an isolated left-to-right run (bdi dir="ltr"), which the
 * top bar's right-to-left value span needs to keep the characters in reading order. A pill that reads the placeholder
 * PILL_NONE marks its wrapper pill-none, which never shrinks, so the word reads whole (Polish 4 Task 5 fix I1).
 */
export function SelectPill(props: { label: string; value: string; options: Array<{ key: string; href: string; text: ReactNode; selected: boolean }> }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);
  return (
    <div className={props.value === PILL_NONE ? "pill-menu-wrap pill-none" : "pill-menu-wrap"} ref={wrap}>
      <button className="pill pill-select" type="button" title={`${props.label}: ${props.value}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="pill-key">{props.label}</span>
        <span className="mono pill-value"><bdi dir="ltr">{props.value}</bdi></span>
      </button>
      {open && (
        <ul className="pill-menu" aria-label={props.label}>
          {props.options.map((o) => (
            <li key={o.key}>
              <a href={o.href} aria-current={o.selected ? "true" : undefined} onClick={() => setOpen(false)}>{o.text}</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A pill whose list could not be read (Studio Polish 1 F1, Task 8 fix): not a menu, since there is nothing to pick.
 * It reads "Unobservable", so it takes no more width than a value would. It takes keyboard focus, and the reason shows
 * under it while it is focused or the pointer is on it or on the reason. A note takes its name from the author, never
 * from its content, so the sentence is its aria-label and the visible words are hidden from a screen reader: read
 * once, not twice (final review M3). It carries no title: beside aria-label a title becomes the description, and the
 * sentence is read twice (Polish 2 C6).
 */
export function StatusPill(props: { label: string; reason: string }) {
  const name = `${props.label}: Unobservable: ${props.reason}`;
  return (
    <div className="pill-menu-wrap">
      <span className="pill pill-status" role="note" tabIndex={0} aria-label={name}>
        <span className="pill-key" aria-hidden="true">{props.label}</span>
        <span className="mono pill-value" aria-hidden="true">Unobservable</span>
      </span>
      <span className="pill-status-reason" aria-hidden="true">{props.reason}</span>
    </div>
  );
}
