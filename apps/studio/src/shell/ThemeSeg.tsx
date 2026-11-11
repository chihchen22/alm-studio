import { useEffect, useState } from "react";

/**
 * The theme switch (ALM Studio P1; Polish 4 T2). At 1280px and wider it is three buttons, System, Light and Dark;
 * below 1280px CSS shows one cycle button instead, so the select pills get the width. Both read and write one state
 * and the one stored key, so a choice made on either shows on the other after a resize.
 */
export type Theme = "system" | "light" | "dark";
const KEY = "studio-theme";
const OPTIONS: ReadonlyArray<{ id: Theme; label: string }> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function stored(): Theme {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** The cycle button's order: System, Light, Dark, then System again. */
export function nextTheme(t: Theme): Theme {
  return t === "system" ? "light" : t === "light" ? "dark" : "system";
}

const labelOf = (t: Theme): string => OPTIONS.find((o) => o.id === t)!.label;

/** A monitor, a sun or a moon: 16px line icons drawn in the text colour, inline (no icon font, no image file). */
function ThemeIcon(props: { theme: Theme }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {props.theme === "system" ? (
        <>
          <rect x="1.5" y="2.25" width="13" height="9" rx="1.25" />
          <path d="M5.5 14h5M8 11.25V14" />
        </>
      ) : props.theme === "light" ? (
        <>
          <circle cx="8" cy="8" r="2.75" />
          <path d="M8 1.25v1.5M8 13.25v1.5M1.25 8h1.5M13.25 8h1.5M3.23 3.23l1.06 1.06M11.71 11.71l1.06 1.06M3.23 12.77l1.06-1.06M11.71 4.29l1.06-1.06" />
        </>
      ) : (
        <path d="M14 8.53A6 6 0 1 1 7.47 2 4.67 4.67 0 0 0 14 8.53Z" />
      )}
    </svg>
  );
}

/**
 * The one-button theme switch below 1280px. It has no text of its own, so its title is also its accessible name:
 * no aria-label beside it, since beside an aria-label a title becomes the description and is read twice (the
 * StatusPill rule, Polish 2 C6).
 */
export function ThemeCycle(props: { theme: Theme; onCycle: () => void }) {
  const text = `Theme: ${labelOf(props.theme)}. Switch to ${labelOf(nextTheme(props.theme))}`;
  return (
    <button className="theme-cycle" type="button" title={text} onClick={props.onCycle}>
      <ThemeIcon theme={props.theme} />
    </button>
  );
}

export function ThemeSeg() {
  const [theme, setTheme] = useState<Theme>(() => (typeof window === "undefined" ? "system" : stored()));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(KEY, theme);
    } catch {
      /* storage unavailable: the choice lasts for this page only */
    }
  }, [theme]);
  return (
    <>
      <div className="seg" role="group" aria-label="Theme">
        {OPTIONS.map((o) => (
          <button key={o.id} type="button" aria-pressed={theme === o.id} onClick={() => setTheme(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
      <ThemeCycle theme={theme} onCycle={() => setTheme(nextTheme)} />
    </>
  );
}
