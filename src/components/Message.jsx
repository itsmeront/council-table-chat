import React, { useState, useRef, useLayoutEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { useChatStore } from '../stores/useChatStore.js';
import AxonaChatClient from '../services/AxonaChatClient.js';
import LinkPreview from './LinkPreview.jsx';
import TopicLinkChip from './TopicLinkChip.jsx';
import { isTopicLink, isAxonaName } from '../services/topicLink.js';
import { extractUrls, isImageUrl, isYouTubeUrl, isAxonaNameUrl } from '../services/messageUrls.js';

// Long-message panel height: comfortably smaller than the viewport so a
// single message can never dominate the list.
const PANEL_H = Math.min(360, Math.round(window.innerHeight * 0.45));
// A message only a little over the panel height isn't worth capping.
const PANEL_TOL = 60;
// How far the arrow buttons advance per press — most of a panel, with overlap
// so no line is ever skipped across a step.
const ARROW_STEP = Math.round(PANEL_H * 0.8);

const Message = ({ envelope, activeTopic, onReply, onPrivateReply, level = 0 }) => {
  const { msgId, signerPubkey, ts } = envelope;
  const payload = envelope.message;
  const { currentHandle } = useChatStore();
  // VERIFIED author-class from the kernel's signed attestation (getAuthorClass),
  // keyed by the authenticated signerPubkey — NOT the spoofable in-body string.
  const resolvedClass = useChatStore(s => s.authorClasses[signerPubkey]?.class);
  const [showConfirm, setShowConfirm] = useState(false);
  const [copied, setCopied] = useState(false);

  // Long-message handling: content taller than PANEL_H renders inside a
  // fixed-height panel that scrolls — but ONLY once the reader clicks it.
  //
  // This replaces the Previous/Next paging (v0.45), whose page offsets were
  // measured once and then falsified by late-loading embeds: pages overlapped,
  // spilled past the panel edge, or left a near-empty last page. A plain inner
  // scrollbar was rejected back then for a real reason — it traps the wheel,
  // so scrolling the LIST stalls whenever the pointer crosses a long message
  // (issue #405). The click-to-arm scheme keeps both behaviours: while the
  // panel is unarmed its overflow is hidden, wheel events find nothing to
  // scroll and fall through to the list; a click arms it (overflow:auto with
  // overscroll-behavior:contain, so hitting its end doesn't yank the list);
  // the pointer leaving the tile disarms it again. Wherever the pointer is,
  // the thing under it scrolls the way the reader expects.
  //
  // Affordances: fade gradients show clipped content above/below, and an
  // arrow button appears at each edge only while that direction can actually
  // scroll. The arrows work without arming first — pressing one arms the
  // panel and steps it by ARROW_STEP.
  const contentRef = useRef(null);
  const panelRef = useRef(null);
  const [isLong, setIsLong] = useState(false);
  const [armed, setArmed] = useState(false);
  const [canUp, setCanUp] = useState(false);
  const [canDown, setCanDown] = useState(false);

  const updateEdges = () => {
    const panel = panelRef.current;
    if (!panel) return;
    // 4px slack: fractional scroll positions on zoomed displays never quite
    // reach the exact limit, and an arrow that won't disappear reads as broken.
    setCanUp(panel.scrollTop > 4);
    setCanDown(panel.scrollTop + panel.clientHeight < panel.scrollHeight - 4);
  };

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => {
      setIsLong(content.scrollHeight > PANEL_H + PANEL_TOL);
      updateEdges();
    };
    measure();
    const ro = new ResizeObserver(measure);   // re-measure as embeds load
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // The measure above runs BEFORE the render that applies the maxHeight clamp,
  // so its edge check sees an unclamped panel (clientHeight === scrollHeight)
  // and reads "nothing below". Re-check once the clamp is actually in effect.
  useLayoutEffect(() => { updateEdges(); }, [isLong, armed]);

  // Arm on click — but not when the click was really something else: a link
  // or button doing its own job, or the mouseup end of a text selection.
  const handlePanelClick = (e) => {
    if (!isLong) return;
    if (e.target.closest('a, button, iframe')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    setArmed(a => !a);
  };

  const scrollStep = (dir) => {
    setArmed(true);
    panelRef.current?.scrollBy({ top: dir * ARROW_STEP, behavior: 'smooth' });
  };

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

    // URL extraction lives in services/messageUrls.js — a pure function with its
    // own regression tests, because this is exactly where the unfurl and the
    // rendered anchor used to disagree (Joi, #general 2026-07-27): the anchor
    // came from ReactMarkdown's parsed href while the preview came from a raw
    // text scan that ran through the markdown syntax. Both now agree by
    // construction — link syntax is parsed for its href, never scanned.
    const candidates = extractUrls(text);

    const imgMatches = candidates.filter(isImageUrl);

    // Match youtube links
    const ytRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;
    const ytMatch = text.match(ytRegex);

    // Topic links render as their own chip (and would 404 a link-preview fetch).
    // isAxonaNameUrl: a pasted `[Axona.bot](http://Axona.bot)` reaches here as a
    // REAL href, so suppressing the autolink in the renderer was not enough —
    // it still built a preview card (and a favicon fetch) for a host that does
    // not exist. Bare axona.* hosts get no card; axona.net WITH a path still does.
    const previewUrls = candidates.filter(
      (url) => !isImageUrl(url) && !isYouTubeUrl(url) && !isTopicLink(url) && !isAxonaNameUrl(url)
    );

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

  // Copy the WHOLE message source — especially useful for long messages,
  // where only part of the text is on screen at once.
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

      <div
        onClick={handlePanelClick}
        onMouseLeave={() => setArmed(false)}
        title={isLong && !armed ? 'Long message — click to scroll it in place' : undefined}
        style={isLong ? { position: 'relative', cursor: armed ? 'auto' : 'pointer' } : undefined}
      >
        <div
          ref={panelRef}
          onScroll={updateEdges}
          style={isLong ? {
            maxHeight: `${PANEL_H}px`,
            overflowY: armed ? 'auto' : 'hidden',
            // Hitting the panel's end must not chain into the list — the
            // reader armed THIS tile, not the page behind it.
            overscrollBehavior: 'contain',
            borderRadius: '4px',
            // A quiet ring while armed, so it's visible which surface the
            // wheel now drives.
            boxShadow: armed ? '0 0 0 1px var(--color-primary) inset' : 'none',
            transition: 'box-shadow 0.15s ease'
          } : undefined}
        >
        <div
          ref={contentRef}
          className="message-content"
          style={{
            fontSize: '0.9rem', lineHeight: '1.4', wordBreak: 'break-word', color: 'var(--color-text)'
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
                isAxonaName(href, children) ? (
                  // An axona.* NAME, not an address — render as plain text.
                  <>{children}</>
                ) : isTopicLink(href) ? (
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

        {/* Edge affordances: each fade says "there is more this way", each
            arrow steps it. Both exist only while that direction can move, so
            their absence is the completion signal. pointerEvents:none on the
            fades keeps text under them selectable and clickable. */}
        {isLong && canUp && (
          <>
            <div style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: '2.2rem',
              background: 'linear-gradient(to bottom, var(--color-surface), transparent)',
              pointerEvents: 'none', borderRadius: '4px 4px 0 0'
            }} />
            <button
              onClick={(e) => { e.stopPropagation(); scrollStep(-1); }}
              title="Scroll this message up"
              aria-label="Scroll this message up"
              style={{
                position: 'absolute', top: '0.25rem', left: '50%', transform: 'translateX(-50%)',
                width: '1.6rem', height: '1.6rem', borderRadius: '50%', cursor: 'pointer',
                border: '1px solid var(--border-color)', background: 'var(--color-surface)',
                color: 'var(--color-primary)', fontSize: '0.7rem', lineHeight: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 1px 4px rgba(0,0,0,0.25)'
              }}
            >
              ▲
            </button>
          </>
        )}
        {isLong && canDown && (
          <>
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0, height: '2.2rem',
              background: 'linear-gradient(to top, var(--color-surface), transparent)',
              pointerEvents: 'none', borderRadius: '0 0 4px 4px'
            }} />
            <button
              onClick={(e) => { e.stopPropagation(); scrollStep(1); }}
              title="Scroll this message down"
              aria-label="Scroll this message down"
              style={{
                position: 'absolute', bottom: '0.25rem', left: '50%', transform: 'translateX(-50%)',
                width: '1.6rem', height: '1.6rem', borderRadius: '50%', cursor: 'pointer',
                border: '1px solid var(--border-color)', background: 'var(--color-surface)',
                color: 'var(--color-primary)', fontSize: '0.7rem', lineHeight: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 1px 4px rgba(0,0,0,0.25)'
              }}
            >
              ▼
            </button>
          </>
        )}
      </div>

      {/* Action Footer */}
      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.2rem', justifyContent: 'flex-end', fontSize: '0.7rem' }}>
        <span
          onClick={handleCopy}
          title="Copy the full message text — grabs the whole message, not just the visible part"
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
