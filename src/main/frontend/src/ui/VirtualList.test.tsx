// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualList } from './VirtualList';

afterEach(() => {
  render(null, document.body);
  document.body.innerHTML = '';
});

describe('ui/VirtualList', () => {
  it('renders only the visible window of rows plus overscan and keeps the roving tabStop row mounted', () => {
    const onFirst = vi.fn();
    render(
      <VirtualList
        count={1000}
        rowHeight={20}
        overscan={2}
        keepIndex={500}
        ariaLabel="Operations"
        onFirstChange={onFirst}
        renderRow={(i) => <span data-row={i}>Row {i}</span>}
      />,
      document.body,
    );
    const rows = document.querySelectorAll('.rab-n-vrow');
    // Default 400px height -> 21 visible + 2 overscan + 1 kept row = 24 rendered rows out of 1000
    expect(rows.length).toBeLessThan(35);
    expect(document.querySelector('[data-row="0"]')).not.toBeNull();
    expect(document.querySelector('[data-row="500"]')).not.toBeNull();
    expect(document.querySelector('[data-row="999"]')).toBeNull();
  });
});
