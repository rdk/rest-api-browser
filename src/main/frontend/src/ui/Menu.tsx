import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { tipProps, type UiTipSpec } from '../core/uitips';
import { ESCAPE_PRIORITY, isInsideInert, useEscape } from '../lib/overlay';

export interface MenuChoice {
  id: string;
  label: string;
  icon: ComponentChildren;
  checked: boolean;
  onSelect: () => void;
  testId?: string;
  tip?: UiTipSpec;
}

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
  /** A row of small choices with icons instead of one item; label and onSelect are unused. */
  choices?: MenuChoice[];
}

/**
 * One button that opens a menu below it. The keyboard works as in any menu: Up/Down moves vertically (treating
 * a horizontal choices strip as a single row), Left/Right steps inside a choices row, Home/End jump to first/last,
 * Enter and Space pick, Escape closes and focuses the trigger button, and Tab closes gracefully from the trigger.
 */
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const verticalStops = (): HTMLElement[] => {
    const root = menu.current;
    if (!root) return [];
    const stops: HTMLElement[] = [];
    for (const child of Array.from(root.children)) {
      if (child.classList.contains('rab-n-menu-choices')) {
        const picked = (child.querySelector('[role=menuitemradio][aria-checked=true]:not([aria-disabled=true])')
          ?? child.querySelector('[role=menuitemradio]:not([aria-disabled=true])')) as HTMLElement | null;
        if (picked) stops.push(picked);
      } else if (
        (child.getAttribute('role') === 'menuitem' || child.getAttribute('role') === 'menuitemradio')
        && child.getAttribute('aria-disabled') !== 'true'
      ) {
        stops.push(child as HTMLElement);
      }
    }
    return stops;
  };

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  useEscape(open, () => {
    if (isInsideInert(button.current)) return false;
    close();
    return true;
  }, ESCAPE_PRIORITY.MENU);

  useEffect(() => {
    if (!open) return;
    verticalStops()[0]?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const activeEl = document.activeElement as HTMLElement | null;
    const choiceRow = activeEl?.closest('.rab-n-menu-choices');
    const stops = verticalStops();
    const currentStop = choiceRow
      ? stops.find((s) => choiceRow.contains(s)) ?? null
      : activeEl;
    const i = currentStop ? stops.indexOf(currentStop) : -1;

    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && choiceRow) {
      e.preventDefault();
      const row = [...choiceRow.querySelectorAll<HTMLElement>('[role=menuitemradio]:not([aria-disabled=true])')];
      const j = activeEl ? row.indexOf(activeEl) : 0;
      if (row.length) row[(j + (e.key === 'ArrowRight' ? 1 : row.length - 1)) % row.length]?.focus();
    } else if (e.key === ' ' && activeEl?.tagName === 'A') {
      e.preventDefault();
      activeEl.click();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = stops.length;
      if (!n) return;
      const next = i < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      stops[next]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      stops[e.key === 'Home' ? 0 : stops.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
      button.current?.focus();
    }
  };

  return (
    <div class="rab-n-menu-wrap">
      <button
        ref={button}
        class={'rab-n-menu-button' + (open ? ' open' : '')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        {...tipProps({
          title: label,
          body: 'Reset layout sizes, rebuild the REST catalog, change colour mode or header skin, or report an issue.',
        })}
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
          <circle cx="3" cy="8" r="1.6" />
          <circle cx="8" cy="8" r="1.6" />
          <circle cx="13" cy="8" r="1.6" />
        </svg>
      </button>
      {open && (
        <div ref={menu} id={menuId} class="rab-n-menu" role="menu" aria-label={label} onKeyDown={onKey} data-testid="menu">
          {items.map((it) => (
            <Fragment key={it.id}>
              {it.group && <div class="rab-n-menu-sep" role="separator" />}
              {it.section && <div class="rab-n-menu-section" role="presentation">{it.section}</div>}
              {it.choices ? (
                <div class="rab-n-menu-choices" role="group" aria-label={it.label}>
                  {it.choices.map((c) => (
                    <button key={c.id} role="menuitemradio" aria-checked={c.checked} tabIndex={-1}
                            class={'rab-n-menu-choice' + (c.checked ? ' checked' : '')}
                            {...tipProps(c.tip ?? { title: c.label, body: `Select ${c.label}.` })}
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
