import { describe, it, expect, beforeEach } from 'vitest';
import { loadHistory, appendHistory, clearHistory, stepHistory, historyAt } from '../messageHistory.js';

// Node has no localStorage. Same shim approach as the lastTopic tests: without it
// every case here would throw on import and the file would report "0 tests", which
// reads as "nothing to see" rather than "the suite could not run".
beforeEach(() => {
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
});

describe('stepHistory — shell cursor arithmetic', () => {
  it('Up from the live draft lands on the newest entry', () => {
    expect(stepHistory(-1, 'up', 3)).toBe(0);
  });

  it('Up walks backwards and STOPS at the oldest rather than wrapping', () => {
    expect(stepHistory(0, 'up', 3)).toBe(1);
    expect(stepHistory(1, 'up', 3)).toBe(2);
    expect(stepHistory(2, 'up', 3)).toBe(2);   // oldest: stay put, no wrap
  });

  it('Down past the newest returns to -1, the live draft', () => {
    expect(stepHistory(1, 'down', 3)).toBe(0);
    expect(stepHistory(0, 'down', 3)).toBe(-1);
    expect(stepHistory(-1, 'down', 3)).toBe(-1);
  });

  it('an empty buffer never leaves the draft', () => {
    expect(stepHistory(-1, 'up', 0)).toBe(-1);
    expect(stepHistory(-1, 'down', 0)).toBe(-1);
  });
});

describe('historyAt — index counts back from the newest', () => {
  const h = ['oldest', 'middle', 'newest'];
  it('0 is the newest, not the oldest', () => {
    expect(historyAt(h, 0)).toBe('newest');
    expect(historyAt(h, 2)).toBe('oldest');
  });
  it('-1 and out-of-range mean "restore the draft"', () => {
    expect(historyAt(h, -1)).toBeNull();
    expect(historyAt(h, 3)).toBeNull();
  });
});

describe('appendHistory', () => {
  it('records a sent message and persists it across a reload', () => {
    appendHistory('hello');
    expect(loadHistory()).toEqual(['hello']);
  });

  it('keeps oldest → newest ordering', () => {
    appendHistory('one');
    appendHistory('two');
    expect(loadHistory()).toEqual(['one', 'two']);
  });

  it('NEVER stores a private reply — the plaintext must not reach disk', () => {
    appendHistory('public');
    appendHistory('secret for your eyes only', { private: true });
    expect(loadHistory()).toEqual(['public']);
    expect(JSON.stringify(loadHistory())).not.toContain('secret');
  });

  it('drops a consecutive duplicate so Up does not stutter', () => {
    appendHistory('same');
    appendHistory('same');
    expect(loadHistory()).toEqual(['same']);
  });

  it('allows a repeat that is not consecutive', () => {
    appendHistory('a');
    appendHistory('b');
    appendHistory('a');
    expect(loadHistory()).toEqual(['a', 'b', 'a']);
  });

  it('ignores empty and whitespace-only sends', () => {
    appendHistory('');
    appendHistory('   \n  ');
    expect(loadHistory()).toEqual([]);
  });

  it('trims, so recall does not reintroduce stray trailing newlines', () => {
    appendHistory('  padded  ');
    expect(loadHistory()).toEqual(['padded']);
  });

  it('caps entries at 50, discarding the oldest', () => {
    for (let i = 0; i < 60; i++) appendHistory(`msg-${i}`);
    const h = loadHistory();
    expect(h).toHaveLength(50);
    expect(h[0]).toBe('msg-10');
    expect(h[49]).toBe('msg-59');
  });

  it('caps total bytes, and always keeps the newest even if it alone is huge', () => {
    const big = 'x'.repeat(200 * 1024);
    appendHistory('small');
    appendHistory(big);
    const h = loadHistory();
    expect(h[h.length - 1]).toBe(big);
    expect(JSON.stringify(h).length).toBeLessThanOrEqual(256 * 1024 + big.length);
  });

  it('survives a corrupt stored value instead of throwing', () => {
    localStorage.setItem('axona-sent-history', '{not json');
    expect(loadHistory()).toEqual([]);
    appendHistory('after corruption');
    expect(loadHistory()).toEqual(['after corruption']);
  });

  it('filters non-string junk out of a hand-edited array', () => {
    localStorage.setItem('axona-sent-history', JSON.stringify(['ok', 42, null, { a: 1 }, '']));
    expect(loadHistory()).toEqual(['ok']);
  });

  it('does not throw when storage itself is unavailable', () => {
    global.localStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('quota'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(() => appendHistory('into the void')).not.toThrow();
    expect(loadHistory()).toEqual([]);
  });
});

describe('clearHistory', () => {
  it('empties the buffer', () => {
    appendHistory('gone');
    expect(clearHistory()).toEqual([]);
    expect(loadHistory()).toEqual([]);
  });
});
