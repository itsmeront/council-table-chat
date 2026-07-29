// =====================================================================
// messageHistory.js — a shell-style recall buffer for messages you have sent.
//
// Up/Down in the composer walks back and forward through what you sent before,
// the way a terminal does. That needs the sent messages to outlive the tab, so
// they live in localStorage.
//
// THREE DELIBERATE LIMITS, because "save what the user typed" is not a free action:
//
//  1. PRIVATE REPLIES ARE NEVER STORED. A private reply is encrypted so that only
//     the recipient's key can open it. Keeping the plaintext in localStorage would
//     leave the one copy on disk that the encryption exists to avoid — on a shared
//     or unlocked machine, in a browser profile that syncs, in a backup. The recall
//     buffer is a convenience; it does not get to quietly undo a privacy choice.
//     Callers pass { private: true } and the entry is dropped.
//
//  2. BOUNDED, by entries AND by bytes. A message may be 15 KB, so a naive 100-entry
//     ring is 1.5 MB of a ~5 MB origin quota — enough that an unrelated setItem
//     elsewhere in the app starts throwing QuotaExceededError. Oldest-out on both.
//
//  3. NO DUPLICATE OF THE PREVIOUS ENTRY. Sending the same text twice in a row
//     should not make you press Up twice to get past it (bash HISTCONTROL=ignoredups).
//
// Storage failures are non-fatal by design: history is a nicety, and a browser in
// private mode or at quota must not be able to break sending a message.
// =====================================================================

const KEY = 'axona-sent-history';
const MAX_ENTRIES = 50;
const MAX_BYTES = 256 * 1024;      // ~5% of a typical 5 MB origin budget

/** @returns {string[]} oldest → newest. Never throws. */
export const loadHistory = () => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Tolerate junk: a hand-edited or half-written value must not break the composer.
    return parsed.filter((e) => typeof e === 'string' && e.length > 0);
  } catch {
    return [];
  }
};

const persist = (list) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Quota or private mode. Try once more with a much shorter tail rather than
    // silently keeping a list we could not save.
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(-10))); } catch { /* give up */ }
  }
};

/**
 * Record a sent message. Returns the new history (oldest → newest) so the caller
 * can update its own state without a re-read.
 *
 * @param {string} text
 * @param {{ private?: boolean }} [opts] — private:true is dropped on the floor (see header)
 * @returns {string[]}
 */
export const appendHistory = (text, opts = {}) => {
  const current = loadHistory();
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return current;
  if (opts.private) return current;                       // limit 1
  if (current[current.length - 1] === value) return current;  // limit 3

  let next = [...current, value].slice(-MAX_ENTRIES);      // limit 2 (entries)
  // limit 2 (bytes) — drop from the OLD end until under budget, but always keep
  // at least the newest entry, or a single oversized message would empty the list.
  while (next.length > 1 && JSON.stringify(next).length > MAX_BYTES) next = next.slice(1);
  persist(next);
  return next;
};

/** Wipe the buffer (used by the composer's clear-history affordance). */
export const clearHistory = () => {
  try { localStorage.removeItem(KEY); } catch { /* */ }
  return [];
};

/**
 * Shell-style cursor arithmetic, kept out of the component so it can be tested
 * without a DOM.
 *
 * `index` is a position from the END: -1 means "not navigating, showing the live
 * draft", 0 means the newest entry, 1 the one before it, and so on.
 *
 * Going DOWN past the newest returns to -1, which the caller restores as the
 * draft the user was in the middle of typing — the behaviour that makes history
 * navigation safe to try. Going UP past the oldest stays put rather than wrapping;
 * wrapping loses your place with no visible cue.
 *
 * @param {number} index   current position (-1 = live draft)
 * @param {'up'|'down'} dir
 * @param {number} length  history length
 * @returns {number} the new index, or -1 for "back to the draft"
 */
export const stepHistory = (index, dir, length) => {
  if (length <= 0) return -1;
  if (dir === 'up') return Math.min(index + 1, length - 1);
  return index <= 0 ? -1 : index - 1;
};

/**
 * Resolve an index to its text. -1 (or out of range) yields null, meaning
 * "the caller should restore the saved draft".
 *
 * @param {string[]} history oldest → newest
 * @param {number} index     position from the END
 * @returns {string|null}
 */
export const historyAt = (history, index) => {
  if (index < 0 || index >= history.length) return null;
  return history[history.length - 1 - index];
};
