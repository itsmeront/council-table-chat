// topicLink.js — shareable topic links.
//
// A topic link is a full URL that carries the SAME identity an advertisement
// carries (region · name · write policy · owner), encoded into the URL hash so
// it survives static hosting (GitHub Pages, no server routes). Opening the link
// launches the app and opens the topic; pasting the link into a message renders
// it as a topic-link chip that, when clicked in-app, adds the topic to the
// user's list and opens it — no full page load.
//
// Shape (base64url of JSON, short keys to keep the URL compact):
//   { v:1, r:region, n:name, w:write, o:owner?, net:network?, l:label? }
// The four identity fields (region, name, write, owner) fold into the kernel
// topic id exactly as they do in a topic.ad — a link to an owned channel must
// carry owner+write or it points at a different (empty) topic.

// Canonical origin for links we GENERATE — always the production app, so a
// shared link works for anyone regardless of where it was created. PARSING is
// deliberately origin-agnostic (below) so localhost/testnet links also resolve.
export const TOPIC_LINK_ORIGIN = 'https://axona.chat';
const HASH_KEY = 'topic';

// Unicode-safe base64url.
const b64urlEncode = (obj) => {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlDecode = (s) => {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
};

/** A human-readable label for a topic (used as the chip caption). */
export const topicLabel = (descriptor) => {
  if (!descriptor) return 'topic';
  return descriptor.label || descriptor.name || 'topic';
};

/**
 * Build a shareable link for a topic descriptor.
 * @param {{region?:string,name:string,write?:string,owner?:string,network?:string,label?:string}} descriptor
 * @returns {string} full https URL
 */
export const buildTopicLink = (descriptor) => {
  if (!descriptor || !descriptor.name) return '';
  const payload = { v: 1, r: descriptor.region || 'eagle', n: descriptor.name };
  const write = descriptor.write || (descriptor.owner ? 'owner' : 'open');
  if (write && write !== 'open') payload.w = write;      // omit the default to shorten
  if (descriptor.owner) payload.o = descriptor.owner;
  if (descriptor.network && descriptor.network !== 'production') payload.net = descriptor.network;
  const label = descriptor.label || descriptor.name;
  if (label && label !== descriptor.name) payload.l = label;
  return `${TOPIC_LINK_ORIGIN}/#${HASH_KEY}=${b64urlEncode(payload)}`;
};

/** Markdown form for pasting into a message: renders as a topic-link chip. */
export const buildTopicMarkdown = (descriptor) =>
  descriptor && descriptor.name ? `[#${descriptor.name}](${buildTopicLink(descriptor)})` : '';

// Pull the encoded token out of any URL string, origin-agnostic. Accepts the
// token in the hash (`#topic=…`, optionally after a path/router hash) or the
// query string, so links created on localhost / testnet still resolve.
const extractToken = (url) => {
  if (typeof url !== 'string') return null;
  const m = url.match(new RegExp(`[#?&]${HASH_KEY}=([A-Za-z0-9\\-_]+)`));
  return m ? m[1] : null;
};

/** True if the href looks like an Axona topic link. */
export const isTopicLink = (href) => extractToken(href) != null;

// ── axona.* names are NAMES, not addresses ────────────────────────────────────
// Our own vocabulary is shaped like domains: the bot handle is `axona.bot`, the
// channels are `axona.dev` / `axona.chat`, and `.bot` / `.dev` / `.chat` are all
// real TLDs. GFM autolink literals therefore turn every mention of a handle or a
// channel into a link to a host that does not exist (`Axona.bot` ->
// `http://Axona.bot`). Reported live on #general 2026-07-27.
//
// SCOPE (deliberate): this suppresses only what the user typed BARE, i.e. what
// the autolinker invented. An explicit `https://axona.net/whitepaper/...`, or a
// markdown link with its own label, is a real address the author meant — those
// still render as links. So `axona.net` mentioned in prose is text, while a
// pasted axona.net URL still works.
const AXONA_NAME = /^axona\.[a-z0-9][a-z0-9-]*$/i;

const linkText = (children) => {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(linkText).join('');
  if (children && typeof children === 'object' && 'props' in children) return linkText(children.props?.children);
  return '';
};

/**
 * True when an anchor is really a bare `axona.<something>` name that the GFM
 * autolinker promoted to a link. Requires BOTH that the visible text is such a
 * name with no scheme of its own, AND that the href is merely that text with a
 * scheme bolted on — so a deliberate `[axona.bot](https://…)` is left alone.
 */
export const isAxonaName = (href, children) => {
  const text = linkText(children).trim();
  if (!text || !AXONA_NAME.test(text)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return false;      // author wrote a scheme → meant an address
  if (typeof href !== 'string') return true;                 // no href at all → plain text
  const bare = href.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return bare.toLowerCase() === text.toLowerCase();          // href is just the autolinked text
};

/**
 * Decode a topic link into a topic descriptor.
 * @returns {{region:string,name:string,write:string,owner?:string,network:string,label:string}|null}
 */
export const parseTopicLink = (href) => {
  const token = extractToken(href);
  if (!token) return null;
  try {
    const p = b64urlDecode(token);
    if (!p || typeof p.n !== 'string' || !p.n) return null;
    const write = p.w || (p.o ? 'owner' : 'open');
    const descriptor = {
      region: p.r || 'eagle',
      name: p.n,
      write,
      network: p.net || 'production',
      label: p.l || p.n,
    };
    if (p.o) descriptor.owner = p.o;
    return descriptor;
  } catch {
    return null;
  }
};

/** Read a topic link from the current window location (deep-link on launch). */
export const readTopicFromLocation = () => {
  if (typeof window === 'undefined' || !window.location) return null;
  const { hash, search } = window.location;
  return parseTopicLink(hash) || parseTopicLink(search);
};

/** Strip a consumed topic link from the URL bar without a reload. */
export const clearTopicFromLocation = () => {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const { pathname, search, hash } = window.location;
  const cleanHash = hash.replace(new RegExp(`[#&]?${HASH_KEY}=[A-Za-z0-9\\-_]+`), '');
  const cleanSearch = search.replace(new RegExp(`[?&]${HASH_KEY}=[A-Za-z0-9\\-_]+`), '');
  window.history.replaceState(null, '', pathname + cleanSearch + (cleanHash && cleanHash !== '#' ? cleanHash : ''));
};
