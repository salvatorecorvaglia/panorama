/**
 * Behaviour shared by every panel that opens over the table and closes back
 * into it — the detail drawer and the search/install panel: remember what had
 * focus before it opened, restore that on close, and treat Escape as the
 * close gesture.
 */

import type { KeyboardEvent } from 'react';
import { useEffect, useRef } from 'react';

/**
 * @param onClose Called when Escape is pressed inside the overlay.
 * @param onOpenFocus Run once, right after the element to return focus to is
 *   captured — for moving focus somewhere inside the overlay on open. Omit it
 *   when the caller moves focus itself (the drawer does this conditionally,
 *   driven by which section it was asked to reveal).
 * @returns A keydown handler to attach to the overlay's root element.
 */
export function useDismissableOverlay(
  onClose: () => void,
  onOpenFocus?: () => void,
): (event: KeyboardEvent<HTMLElement>) => void {
  const returnFocusRef = useRef<Element | null>(null);

  // Mount/unmount only: re-running this because `onOpenFocus` changed identity
  // would re-focus the overlay and re-capture the wrong "what had focus
  // before this opened" element.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    returnFocusRef.current = document.activeElement;
    onOpenFocus?.();
    return () => {
      const target = returnFocusRef.current;
      if (target instanceof HTMLElement && document.contains(target)) {
        target.focus();
      }
    };
  }, []);

  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onClose();
  };
}
