// messageUrls.js — which URLs in a message body deserve an embed / link preview.
//
// WHY THIS IS ITS OWN MODULE: it used to be a regex inline in Message.jsx, and it
// was wrong in a way nothing could catch — the rendered anchor came from
// ReactMarkdown's parsed href (always correct) while the PREVIEW came from a
// separate scan of the raw text (sometimes not). The two disagreed silently.
// Joi reported the symptom on #general 2026-07-27: "the URL in the unfurl is
// wrong but works in the body of the message."
//
// THE BUG: /https?:\/\/[^\s<>"]+/ allows ] ( ) inside the match, so on
//   [https://notes.ito.com/x](https://notes.ito.com/x)
// the match ran straight through the markdown syntax and yielded
//   https://notes.ito.com/x](https://notes.ito.com/x)
// Trailing-punctuation stripping then removed the final paren and the preview
// fetched  https://notes.ito.com/x](https://notes.ito.com/x  — a real request to
// a mangled address. The damage is mid-string, so no amount of trailing cleanup
// reaches it.
//
// THE FIX: markdown link syntax is parsed, not scanned. Take the href out of
// [label](href) first, blank the whole span, and only then look for bare URLs —
// with ] ( ) excluded so a bare match can never span link syntax either.

// [label](href "optional title")  — also tolerates <href> angle form.
const MD_LINK = /\[[^\]]*\]\(\s*(<?)([^)\s]+)\1\s*(?:"[^"]*")?\)/g;
const BARE_URL = /https?:\/\/[^\s<>"()\[\]]+/gi;

// A URL at the end of a sentence or inside emphasis picks up punctuation that
// isn't part of the address: **https://x** , (https://x) , "https://x." .
const cleanUrl = (u) => u.replace(/[*_~`)\]}>.,;:!?'"]+$/, '');

/**
 * Every URL a message refers to, in document order, hrefs first.
 * @param {string} text raw message body (markdown)
 * @returns {string[]} de-duplicated, punctuation-trimmed URLs
 */
export const extractUrls = (text) => {
  if (typeof text !== 'string' || !text) return [];
  const hrefs = [];
  const bare = text.replace(MD_LINK, (_m, _b, href) => {
    hrefs.push(href);
    return ' ';                       // the span is consumed; don't rescan it
  });
  const urls = [...hrefs, ...(bare.match(BARE_URL) || [])]
    .map(cleanUrl)
    .filter((u) => /^https?:\/\/\S+$/i.test(u));
  return [...new Set(urls)];
};

export const isImageUrl = (u) => /\.(?:png|jpg|jpeg|gif|webp|svg)$/i.test(u);
export const isYouTubeUrl = (u) => /(?:youtube\.com\/watch\?v=|youtu\.be\/)/i.test(u);

/**
 * True for a URL that is really one of OUR NAMES pointing at nothing —
 * `http://Axona.bot`, `https://axona.dev/`. Suppressing the autolink in the
 * markdown renderer was not enough: a name can still reach here as a real href
 * when someone pastes text the client already linkified, e.g.
 * `[Axona.bot](http://Axona.bot)`. That produced a link-preview card for a
 * host that does not exist (and a favicon fetch for domain=axona.bot).
 *
 * A PATH means the author meant a real address — https://axona.net/whitepaper/…
 * previews normally. Only the bare host is suppressed.
 */
export const isAxonaNameUrl = (u) => {
  try {
    const { hostname, pathname, search } = new URL(u);
    if (!/^axona\.[a-z0-9][a-z0-9-]*$/i.test(hostname)) return false;
    return (pathname === '' || pathname === '/') && !search;
  } catch { return false; }
};
