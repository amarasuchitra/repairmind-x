import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";

export interface Cmd {
  id: string;
  label: string;
  /** shown on the right, like a menu: the group or the key that does it */
  hint?: string;
  run: () => void;
}

/**
 * The command bar: Ctrl+K (⌘K on a Mac) opens it, typing narrows the list, arrows move, Enter runs. Every action in
 * the workspace is one search away, the way engineering tools work.
 */
export function CommandBar({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: Cmd[] }) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => words.every((w) => `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(w)));
  }, [q, commands]);

  useEffect(() => { if (open) { setQ(""); setAt(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => setAt(0), [q]);
  if (!open) return null;

  const go = (c?: Cmd) => { if (!c) return; onClose(); c.run(); };
  return (
    <div className="cmd-scrim" onMouseDown={onClose}>
      <div className="cmd" role="dialog" aria-modal="true" aria-label={t("cmd.title")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="cmd-in">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("cmd.ph")} aria-label={t("cmd.ph")}
            role="combobox" aria-expanded aria-controls="cmd-list" aria-activedescendant={list[at] ? `cmd-${list[at].id}` : undefined}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(list.length - 1, i + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); go(list[at]); }
              else if (e.key === "Escape") { e.preventDefault(); onClose(); }
            }} />
          <kbd>Esc</kbd>
        </div>
        <ul id="cmd-list" role="listbox">
          {list.map((c, i) => (
            <li key={c.id} id={`cmd-${c.id}`} role="option" aria-selected={i === at} className={i === at ? "on" : ""}
              onMouseEnter={() => setAt(i)} onClick={() => go(c)}>
              <span>{c.label}</span>{c.hint && <kbd>{c.hint}</kbd>}
            </li>
          ))}
          {!list.length && <li className="cmd-none">{t("cmd.none")}</li>}
        </ul>
        <div className="cmd-foot"><span><kbd>↑</kbd><kbd>↓</kbd> {t("cmd.move")}</span><span><kbd>↵</kbd> {t("cmd.run")}</span></div>
      </div>
    </div>
  );
}

/** True when a key press is meant for a text box rather than for a shortcut. */
export const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};
