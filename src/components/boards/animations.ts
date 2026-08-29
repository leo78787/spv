/**
 * Small shared animejs helpers for the Boards feature. Kept deliberately
 * minimal — purposeful entrance/feedback motion, not decoration for its own
 * sake, and always driven by a mount-effect so it fires once per genuinely
 * new element (React re-renders reuse the same DOM node via `key`, so this
 * never re-triggers on ordinary data refreshes).
 *
 * Every helper clears its own inline `transform` once the animation
 * completes. animejs otherwise leaves the final keyframe value (even an
 * identity `scale(1)`) sitting on the element forever, and ANY non-`none`
 * CSS transform on an ancestor becomes the containing block for descendant
 * `position: fixed` elements — which is exactly what @dnd-kit's
 * `DragOverlay` uses (it renders in place, not via a portal). A lingering
 * `transform: scale(1)` on the Boards modal panel was silently breaking the
 * drag overlay's cursor-tracking (it was positioning relative to the
 * modal's box instead of the viewport) — hence clearing it back to `none`
 * once each entrance settles, everywhere, not just on that one panel.
 */

import { animate, stagger, type JSAnimation } from 'animejs';

function clearTransform(el: unknown) {
  if (el instanceof HTMLElement) el.style.transform = '';
}

/** Modal panel entrance: scale + fade in. Use on mount of a popup's outer panel. */
export function animateModalIn(el: Element | null) {
  if (!el) return;
  animate(el, {
    opacity: [0, 1],
    scale: [0.96, 1],
    duration: 220,
    ease: 'outQuad',
    onComplete: () => clearTransform(el),
  });
}

/** Card/column entrance: fade + slide up. Use on mount of a new task card or section column. */
export function animateItemIn(el: Element | null) {
  if (!el) return;
  animate(el, {
    opacity: [0, 1],
    translateY: [10, 0],
    duration: 260,
    ease: 'outQuad',
    onComplete: () => clearTransform(el),
  });
}

/** Staggered list entrance — e.g. the board sidebar's first load. */
export function animateListIn(selectorOrEls: string | Element[] | NodeListOf<Element>) {
  animate(selectorOrEls, {
    opacity: [0, 1],
    translateX: [-8, 0],
    duration: 240,
    delay: stagger(40),
    ease: 'outQuad',
    onComplete: (anim: JSAnimation) => {
      for (const target of anim.targets) clearTransform(target);
    },
  });
}

/** Quick scale "pop" — used for the done-checkbox toggle feedback. */
export function animatePop(el: Element | null) {
  if (!el) return;
  animate(el, {
    scale: [1, 1.35, 1],
    duration: 280,
    ease: 'outElastic(1, .6)',
    onComplete: () => clearTransform(el),
  });
}
