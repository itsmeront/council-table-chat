// Message.jsx MOUNTED — the long-message panel arms for a mouse and never for
// a finger.
//
// Why this file exists (Aster, CHANGES-REQUIRED 8d37e65): the previous guard
// classified the DEVICE at module load via '(hover: none)'. That covers a
// phone and misses every hybrid — an iPad with a keyboard case, a Surface, a
// touchscreen laptop. Those report hover:hover because a mouse exists, so the
// guard let a finger tap arm the tile, and there is no mouseleave from a
// finger to disarm it: #405's scroll trap, permanent, on exactly the devices
// the media query said were safe.
//
// The fix classifies the POINTER that produced the event. This test mounts the
// real component and drives real pointer events, because that is the only way
// to observe the distinction — the previous round shipped with NO test that
// mounted Message.jsx at all, which is how the hybrid case survived review.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

import Message from '../Message.jsx';
import { useChatStore } from '../../stores/useChatStore.js';

// jsdom ships no ResizeObserver, and the panel measures itself with one.
// A no-op is the right stub: this test drives layout through the property
// overrides below, so re-measure callbacks have nothing to add.
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

// jsdom has no PointerEvent either. Real browsers deliver one; the only field
// this behaviour depends on is pointerType, so a MouseEvent subclass carrying
// it is a faithful stand-in — React reads pointerType straight off the native
// event.
if (typeof globalThis.PointerEvent === 'undefined') {
  globalThis.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? '';
      this.pointerId = init.pointerId ?? 1;
    }
  };
}

// The panel only exists for a message long enough to be clamped, and isLong is
// measured from the rendered height — which jsdom reports as 0 for everything.
// Force the measurement to say "long" by stubbing the layout properties the
// component reads.
const forceLongLayout = () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight',
    { configurable: true, get() { return 5000; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight',
    { configurable: true, get() { return 300; } });
};

// The tile IS the element carrying the click handler — the one the component
// gives `position: relative` when the message is long. Do NOT reach for its
// parent: dispatching there makes the parent the event target, the handler
// never runs, and every NEGATIVE assertion below then passes for the wrong
// reason. (It did, on the first run of this file. A guard that cannot fail is
// not a guard, so `arms` is asserted positively here to keep the rest honest.)
const tile = () => {
  const el = document.querySelector('[style*="position: relative"]');
  if (!el) throw new Error('long-message tile not rendered — the fixture is wrong');
  return el;
};

const envelope = {
  msgId: 'm1',
  signerPubkey: 'a'.repeat(64),
  ts: Date.now(),
  message: { v: 1, text: 'x\n'.repeat(400), handle: 'someone' },
};

const armedNow = () => !!document.querySelector('[style*="overflow-y: auto"]');

describe('Message long-panel arming is decided by the POINTER, not the device', () => {
  beforeEach(() => {
    cleanup();
    forceLongLayout();
    useChatStore.setState({ currentHandle: null, authorClasses: {} });
    // Hybrid device: a mouse EXISTS, so hover:hover matches — the case the
    // old media-query guard classified as safe and got wrong.
    window.matchMedia = vi.fn().mockImplementation(q => ({
      matches: q.includes('hover: hover'),
      media: q, addEventListener() {}, removeEventListener() {},
    }));
  });

  it('a FINGER tap does not arm the panel, even on a hover-capable device', () => {
    render(<Message envelope={envelope} activeTopic={{ region: 'eagle', name: 'lobby' }} />);
    const el = tile();
    expect(el).toBeTruthy();
    fireEvent.pointerDown(el, { pointerType: 'touch' });
    fireEvent.click(el);
    expect(armedNow()).toBe(false);
  });

  it('a MOUSE click arms it, and a second click disarms', () => {
    render(<Message envelope={envelope} activeTopic={{ region: 'eagle', name: 'lobby' }} />);
    const el = tile();
    fireEvent.pointerDown(el, { pointerType: 'mouse' });
    fireEvent.click(el);
    expect(armedNow()).toBe(true);
    fireEvent.pointerDown(el, { pointerType: 'mouse' });
    fireEvent.click(el);
    expect(armedNow()).toBe(false);
  });

  it('a PEN tap does not arm — mouse is the only arming pointer', () => {
    render(<Message envelope={envelope} activeTopic={{ region: 'eagle', name: 'lobby' }} />);
    const el = tile();
    fireEvent.pointerDown(el, { pointerType: 'pen' });
    fireEvent.click(el);
    expect(armedNow()).toBe(false);
  });

  it('a click with no preceding pointerdown does not arm', () => {
    render(<Message envelope={envelope} activeTopic={{ region: 'eagle', name: 'lobby' }} />);
    fireEvent.click(tile());
    expect(armedNow()).toBe(false);
  });
});
