import { Fragment } from 'preact';
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
}

/**
 * One button that opens a menu below it. The keyboard works as in any menu: the arrows, Home and End move,
 * Enter picks, Escape and Tab close; a click outside closes it too.
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
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    const list = enabled();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // Escape also cancels a running request; here it only closes the menu
      close();
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
              {it.href ? (
                <a role="menuitem" class="rab-n-menu-item" href={it.href} tabIndex={-1} data-testid={it.testId}
                   target={it.newTab ? '_blank' : undefined} rel={it.newTab ? 'noopener noreferrer' : undefined}
                   onClick={() => setOpen(false)}>
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
                    close();
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
