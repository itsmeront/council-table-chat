import React, { useState, useRef, useLayoutEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { useChatStore } from '../stores/useChatStore.js';
import AxonaChatClient from '../services/AxonaChatClient.js';
import LinkPreview from './LinkPreview.jsx';
import TopicLinkChip from './TopicLinkChip.jsx';
import { isTopicLink } from '../services/topicLink.js';

// Long-message panel height: comfortably smaller than the viewport so a
// single message can never dominate the list.
const PAGE_H = Math.min(360, Math.round(window.innerHeight * 0.45));
// A message only a little over the panel height isn't worth paging.
const PAGE_TOL = 60;

const Message = ({ envelope, activeTopic, onReply, onPrivateReply, level = 0 }) => {
  const { msgId, signerPubkey, ts } = envelope;
  const payload = envelope.message;
  const { currentHandle } = useChatStore();
  // VERIFIED author-class from the kernel's signed attestation (getAuthorClass),
  // keyed by the authenticated signerPubkey — NOT the spoofable in-body string.
  const resolvedClass = useChatStore(s => s.authorClasses[signerPubkey]?.class);
  const [showConfirm, setShowConfirm] = useState(false);
  const [copied, setCopied] = useState(false);

  // Long-message paging: content taller than PAGE_H renders inside a
  // fixed-height panel stepped with Previous/Next — deliberately NOT an
  // inner scrollbar, which would fight the message list's own scrolling.
  //
  // Pages break ONLY at block boundaries (paragraphs, headings, list items,
  // tables), never on a fixed pixel step. A blind step used to slice through
  // whatever line straddled the panel edge and only restore it if it was
  // shorter than a fixed overlap — so headings, list items, and table rows
  // (taller than that overlap) stayed clipped and unreadable. Snapping to the
  // top of the first block that would overflow guarantees no page ever cuts a
  // block in half. pageOffsets[i] is the translateY (in px) for page i.
  const contentRef = useRef(null);
  const [pageOffsets, setPageOffsets] = useState([0]);
  const [page, setPage] = useState(0);
  const pageCount = pageOffsets.length;
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => {
      if (content.scrollHeight <= PAGE_H + PAGE_TOL) {
        setPageOffsets([0]);
        setPage(0);
        return;
      }
      // The block list is the content's direct children (markdown blocks plus
      // the trailing embeds container). If markdown ever renders under a single
      // wrapper, descend one level so we still break on real blocks.
      let blocks = Array.from(content.children);
      if (blocks.length <= 1 && blocks[0]) blocks = Array.from(blocks[0].children);
      const offsets = [0];
      let start = 0;
      for (const b of blocks) {
        const top = b.offsetTop;
        const bottom = top + b.offsetHeight;
        // This block spills past the current page and doesn't itself begin it:
        // start a fresh page at its top. (A lone block taller than the panel
        // still gets its own page — unavoidable, and rare: a huge code block.)
        if (bottom - start > PAGE_H && top > start) {
          start = top;
          offsets.push(start);
        }
      }
      setPageOffsets(offsets);
      setPage(p => Math.min(p, offsets.length - 1));
    };
    measure();
    const ro = new ResizeObserver(measure);   // re-measure as embeds load
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // Resolve the sender's signed author-class on demand (cached in the store, one
  // pull per author) so the badge paints even for messages that arrived before
  // the client-side resolver ran (e.g. replayed history).
  useLayoutEffect(() => {
    if (signerPubkey) AxonaChatClient.resolveAuthorClass(signerPubkey);
  }, [signerPubkey]);

  if (!payload) return null;

  // Author-class is provenance, NOT a read gate (kernel: "absence means
  // UNSTATED, never a default"). Undeclared authors render normally, just
  // WITHOUT a class badge — they are never hidden. Only 'human'/'agent' badge.
  const badgeClass = resolvedClass === 'human' || resolvedClass === 'agent' ? resolvedClass : null;

  const isOwn = currentHandle && signerPubkey === currentHandle.authorId;

  // DATE + time, never time alone (user-reported 2026-07-25). A time-only stamp is
  // actively misleading on this network: replayed history arrives interleaved with
  // live traffic, so a message from YESTERDAY renders next to one from a minute ago
  // and a bare "14:32" reads as today. That cost real debugging time — a stamp two
  // hours "in the future" turned out to be the previous day.
  //
  // Rendered in the VIEWER's local zone (kernel `ts` is epoch ms, i.e. UTC), which
  // is what a reader expects. The full weekday/date/time/zone goes in `title` so
  // hovering disambiguates absolutely, including the zone.
  const when = new Date(ts);
  const formattedTime = Number.isFinite(when.getTime())
    ? when.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  const fullTimestamp = Number.isFinite(when.getTime())
    ? when.toLocaleString([], {
        weekday: 'short', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
      })
    : 'no timestamp';

  // Handle Delete (Kill message)
  const handleDelete = async () => {
    try {
      await AxonaChatClient.deleteOwnMessage(activeTopic, msgId);
      // Optimistic removal
      useChatStore.getState().killMessage(useChatStore.getState().activeTopicId, msgId);
    } catch (err) {
      console.error('Retraction failed traceback:', err);
      alert('retraction failed: ' + err.message);
    }
  };

  // Helper to detect and render embedded URLs
  const renderEmbeds = (text) => {
    if (typeof text !== 'string') return null;

    // URLs in markdown bodies arrive wrapped in punctuation the regex can't
    // know isn't part of the URL — **https://x** captures the trailing
    // asterisks, (https://x) the paren, "https://x." the period — and the
    // preview then fetches a mangled address. Strip trailing markdown/prose
    // punctuation from every match.
    const cleanUrl = (u) => u.replace(/[*_~`)\]}>.,;:!?'"]+$/, '');

    // Match image extensions
    const imgRegex = /(https?:\/\/\S*\.(?:png|jpg|jpeg|gif|webp|svg))/gi;
    const imgMatches = (text.match(imgRegex) || []).map(cleanUrl);

    // Match youtube links
    const ytRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;
    const ytMatch = text.match(ytRegex);

    // Match general HTTP/HTTPS URLs (and exclude direct images/youtube links)
    const urlRegex = /https?:\/\/[^\s<>\"]+/gi;
    const allUrls = (text.match(urlRegex) || []).map(cleanUrl);
    const previewUrls = [...new Set(allUrls.filter(url => {
      const isImg = /\.(?:png|jpg|jpeg|gif|webp|svg)/i.test(url);
      const isYt = /(?:youtube\.com\/watch\?v=|youtu\.be\/)/i.test(url);
      // Topic links render as their own chip (and would 404 a link-preview fetch).
      return !isImg && !isYt && !isTopicLink(url);
    }))];

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
        {imgMatches && imgMatches.map((url, idx) => (
          <div key={idx} style={{ maxWidth: '100%', maxHeight: '300px', overflow: 'hidden', borderRadius: '4px' }}>
            <img 
              src={url} 
              alt="Embedded" 
              style={{ maxWidth: '100%', height: 'auto', display: 'block', objectFit: 'contain' }} 
              onError={(e) => e.target.style.display = 'none'}
            />
          </div>
        ))}
        {ytMatch && (
          <div style={{ position: 'relative', paddingBottom: '56.25%', height: 0, overflow: 'hidden', borderRadius: '6px', maxWidth: '400px' }}>
            <iframe
              src={`https://www.youtube.com/embed/${ytMatch[1]}`}
              title="YouTube video player"
              frameBorder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
            />
          </div>
        )}
        {previewUrls.map((url, idx) => (
          <LinkPreview key={`link-${idx}`} url={url} />
        ))}
      </div>
    );
  };

  const displayText = payload.isEncrypted ? payload.decryptedText : payload.md || payload.text || '';

  // Copy the WHOLE message source — especially useful for long/paged messages,
  // where the reader can only ever see one page at a time.
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(displayText || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context / permissions) — leave it silent;
      // the text is still on screen.
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '0.25rem',
      padding: '0.75rem',
      borderRadius: 'var(--radius)',
      background: payload.isEncrypted 
        ? 'var(--color-success-bg)' 
        : 'var(--color-surface)',
      border: '1px solid var(--border-color)',
      borderLeft: payload.isEncrypted 
        ? '3px solid var(--color-success)' 
        : isOwn ? '3px solid var(--color-primary)' : '1px solid var(--border-color)',
      marginBottom: '0.5rem',
      marginLeft: `${level * 1.2}rem`,
      animation: 'rise 0.25s ease-out'
    }}>
      {/* Sender Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 'bold', color: isOwn ? 'var(--color-primary)' : 'var(--color-text)', fontSize: '0.85rem' }}>
            {payload.handle || 'Anonymous'}
          </span>
          
          {/* Badge the VERIFIED author-class (signed attestation), when declared.
              Undeclared authors simply get no badge — never hidden. */}
          {badgeClass && (
            <span style={{
              fontSize: '0.6rem',
              padding: '1px 5px',
              borderRadius: '10px',
              background: badgeClass === 'human' ? 'rgba(52, 152, 219, 0.15)' : 'rgba(155, 89, 182, 0.15)',
              color: badgeClass === 'human' ? '#3498db' : '#9b59b6',
              fontWeight: '600'
            }}>
              {badgeClass === 'human' ? 'HUMAN' : 'AGENT'}
            </span>
          )}

          {payload.isEncrypted && (
            <span style={{
              fontSize: '0.6rem',
              padding: '1px 5px',
              borderRadius: '10px',
              background: 'var(--color-success-bg)',
              color: 'var(--color-success)',
              fontWeight: '600',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '2px'
            }}>
              🔒 PRIVATE
            </span>
          )}

          <span style={{ fontSize: '0.65rem', color: 'var(--color-muted)' }}>
            {signerPubkey?.slice(0, 10)}...
          </span>
        </div>

        <span style={{ fontSize: '0.7rem', color: 'var(--color-muted)', whiteSpace: 'nowrap' }} title={fullTimestamp}>
          {formattedTime}
        </span>
      </div>

      <div style={pageCount > 1 ? { height: `${PAGE_H}px`, overflow: 'hidden' } : undefined}>
        <div
          ref={contentRef}
          className="message-content"
          style={{
            // position:relative makes this the offsetParent, so each block's
            // offsetTop (used for page boundaries above) is measured from here.
            position: 'relative',
            fontSize: '0.9rem', lineHeight: '1.4', wordBreak: 'break-word', color: 'var(--color-text)',
            transform: pageCount > 1 ? `translateY(-${pageOffsets[page] || 0}px)` : undefined,
            transition: 'transform 0.2s ease'
          }}
        >
          <ReactMarkdown
            // GFM: tables, strikethrough, task lists, autolinks — a pasted
            // markdown document must render whole, not a subset (§7.2).
            // remark-breaks: a single newline becomes a hard line break, so
            // pasted multi-line text keeps its line structure instead of
            // Markdown collapsing single newlines into spaces (§6.3).
            remarkPlugins={[remarkGfm, remarkBreaks]}
            components={{
              a: ({ href, children }) =>
                isTopicLink(href) ? (
                  <TopicLinkChip href={href}>{children}</TopicLinkChip>
                ) : (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ),
              // Wide tables scroll inside their own container instead of
              // stretching the message pane.
              table: ({ children }) => (
                <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                  <table>{children}</table>
                </div>
              )
            }}
          >
            {displayText}
          </ReactMarkdown>
          {renderEmbeds(displayText)}
        </div>
      </div>

      {pageCount > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.75rem', marginTop: '0.35rem', fontSize: '0.72rem' }}>
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            title="This message is long — page back up through it"
            style={{
              padding: '0.15rem 0.6rem', borderRadius: '4px', cursor: page === 0 ? 'default' : 'pointer',
              border: '1px solid var(--border-color)', background: 'transparent',
              color: page === 0 ? 'var(--color-muted)' : 'var(--color-primary)', fontWeight: '600'
            }}
          >
            ▲ Previous
          </button>
          <span style={{ color: 'var(--color-muted)' }}>{page + 1} / {pageCount}</span>
          <button
            onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
            disabled={page >= pageCount - 1}
            title="This message is long — page down through it"
            style={{
              padding: '0.15rem 0.6rem', borderRadius: '4px', cursor: page >= pageCount - 1 ? 'default' : 'pointer',
              border: '1px solid var(--border-color)', background: 'transparent',
              color: page >= pageCount - 1 ? 'var(--color-muted)' : 'var(--color-primary)', fontWeight: '600'
            }}
          >
            Next ▼
          </button>
        </div>
      )}

      {/* Action Footer */}
      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.2rem', justifyContent: 'flex-end', fontSize: '0.7rem' }}>
        <span
          onClick={handleCopy}
          title="Copy the full message text — grabs the whole message, not just the visible page"
          style={{ color: copied ? 'var(--color-success)' : 'var(--color-muted)', cursor: 'pointer', transition: 'color 0.2s' }}
          onMouseEnter={(e) => { if (!copied) e.target.style.color = 'var(--color-primary)'; }}
          onMouseLeave={(e) => { if (!copied) e.target.style.color = 'var(--color-muted)'; }}
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </span>

        <span
          onClick={() => onReply(envelope)}
          title="Reply publicly — your reply appears nested under this message"
          style={{ color: 'var(--color-muted)', cursor: 'pointer', transition: 'color 0.2s' }}
          onMouseEnter={(e) => e.target.style.color = 'var(--color-primary)'}
          onMouseLeave={(e) => e.target.style.color = 'var(--color-muted)'}
        >
          Reply
        </span>

        {/* Can private-reply if not own message */}
        {!isOwn && (
          <span
            onClick={() => onPrivateReply(envelope)}
            title="Reply privately — only this message's author can read it, and it can open a private channel between you"
            style={{ color: 'var(--color-muted)', cursor: 'pointer', transition: 'color 0.2s' }}
            onMouseEnter={(e) => e.target.style.color = 'var(--color-success)'}
            onMouseLeave={(e) => e.target.style.color = 'var(--color-muted)'}
          >
            Private Reply
          </span>
        )}

        {/* Retraction option (Kill own message) */}
        {isOwn && (
          showConfirm ? (
            <span style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}>
              <span style={{ color: 'var(--color-muted)', fontSize: '0.68rem' }}>Confirm retract?</span>
              <button 
                onClick={handleDelete}
                style={{
                  background: 'var(--color-primary)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '3px',
                  padding: '1px 6px',
                  fontSize: '0.65rem',
                  cursor: 'pointer',
                  fontWeight: '600'
                }}
              >
                Yes
              </button>
              <button 
                onClick={() => setShowConfirm(false)}
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  color: 'var(--color-text)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '3px',
                  padding: '0px 6px',
                  fontSize: '0.65rem',
                  cursor: 'pointer'
                }}
              >
                No
              </button>
            </span>
          ) : (
            <span
              onClick={() => setShowConfirm(true)}
              title="Take back your message — it is removed for everyone, not just you"
              style={{ color: '#e74c3c', cursor: 'pointer' }}
            >
              Retract (✕)
            </span>
          )
        )}
      </div>
    </div>
  );
};

export default Message;
