import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  onSelect?: () => void;
  href?: string;
  /** Opens href in a new tab. */
  newTab?: boolean;
  disabled?: boolean;
  testId?: string;
  /** Starts a new group: a line above it. */
  group?: boolean;
  /** A small heading above the item (the first of a group of choices). */
  section?: string;
  /** One of a set of choices: shown with a check mark when chosen (a menu item radio). */
  checked?: boolean;
  /** Choosing it leaves the menu open (a skin, to compare them), like the choices row. */
  keepOpen?: boolean;
  /** A row of small choices with icons instead of one item (light, dark, system); label and onSelect are unused. */
  choices?: { id: string; label: string; icon: ComponentChildren; checked: boolean; onSelect: () => void; testId?: string }[];
}

/**
 * One button that opens a menu below it. The keyboard works as in any menu: the arrows, Home and End move (Left and
 * Right inside a row of choices), Enter and Space pick, Escape and Tab close; a click outside closes it too.
 */
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const enabled = () => [...(menu.current?.querySelectorAll<HTMLElement>(':is([role=menuitem], [role=menuitemradio]):not([aria-disabled=true])') ?? [])];

  useEffect(() => {
    if (!open) return;
    enabled()[0]?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation(); // it only closes the menu, nothing behind it
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // the browser's shortcuts (Alt+Left is Back)
    const list = enabled();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const inRow = !!(document.activeElement as HTMLElement | null)?.closest('.rab-n-menu-choices');
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // Escape also cancels a running request; here it only closes the menu
      close();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && inRow) {
      e.preventDefault();
      const row = [...(document.activeElement as HTMLElement).closest('.rab-n-menu-choices')!.querySelectorAll<HTMLElement>('[role=menuitemradio]')];
      const j = row.indexOf(document.activeElement as HTMLElement);
      row[(j + (e.key === 'ArrowRight' ? 1 : row.length - 1)) % row.length]?.focus();
    } else if (e.key === ' ' && (document.activeElement as HTMLElement | null)?.tagName === 'A') {
      e.preventDefault(); // a link item picks with Space too, like the buttons
      (document.activeElement as HTMLElement).click();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = list.length;
      const next = i < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      list[next]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      list[e.key === 'Home' ? 0 : list.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div class="rab-n-menu-wrap">
      <button
        ref={button}
        class={'rab-n-menu-button' + (open ? ' open' : '')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          } else if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        data-testid="menu-button"
      >
        <svg class="rab-n-svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="8" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="13" cy="8" r="1.5" />
        </svg>
      </button>
      {open && (
        <div ref={menu} class="rab-n-menu" role="menu" aria-label={label} onKeyDown={onKey} data-testid="menu">
          {items.map((it) => (
            <Fragment key={it.id}>
              {it.group && <div class="rab-n-menu-sep" role="separator" />}
              {it.section && <div class="rab-n-menu-section" role="presentation">{it.section}</div>}
              {it.choices ? (
                <div class="rab-n-menu-choices" role="group" aria-label={it.label}>
                  {it.choices.map((c) => (
                    <button key={c.id} role="menuitemradio" aria-checked={c.checked} tabIndex={-1}
                            class={'rab-n-menu-choice' + (c.checked ? ' checked' : '')} title={c.label}
                            onClick={() => c.onSelect()} data-testid={c.testId}>
                      {c.icon}
                      <span>{c.label}</span>
                    </button>
                  ))}
                </div>
              ) : it.href ? (
                <a role="menuitem" class="rab-n-menu-item" href={it.href} tabIndex={-1} data-testid={it.testId}
                   target={it.newTab ? '_blank' : undefined} rel={it.newTab ? 'noopener noreferrer' : undefined}
                   onClick={close}>
                  <span class="rab-n-menu-label">{it.label}</span>
                  {it.hint && <span class="rab-n-menu-hint">{it.hint}</span>}
                </a>
              ) : (
                <button
                  role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
                  aria-checked={it.checked === undefined ? undefined : it.checked}
                  class={'rab-n-menu-item' + (it.checked ? ' checked' : '')}
                  tabIndex={-1}
                  aria-disabled={it.disabled || undefined}
                  onClick={() => {
                    if (it.disabled) return;
                    if (!it.keepOpen) close();
                    it.onSelect?.();
                  }}
                  data-testid={it.testId}
                >
                  <span class="rab-n-menu-label">
                    {it.label}
                    {it.checked && (
                      <svg class="rab-n-svg rab-n-menu-check" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M3.2 8.4l3 3 6.6-6.6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  {it.hint && <span class="rab-n-menu-hint">{it.hint}</span>}
                </button>
              )}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
