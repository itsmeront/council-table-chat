import React, { useRef, useEffect, useState } from 'react';
import { useChatStore } from '../stores/useChatStore.js';
import { useCompactLayout } from '../hooks/useCompactLayout.js';
import Message from './Message.jsx';
import AxonaChatClient from '../services/AxonaChatClient.js';
import { usePeer } from '../contexts/PeerContext.jsx';
import { buildTopicLink } from '../services/topicLink.js';
import { isCouncilTopic, hasCouncilKeyring } from '../services/council/councilChannel.js';

const MessagePane = ({ onOpenModal, setReplyTarget, setPrivateReplyTarget }) => {
  const { activeTopic, activeTopicId, messages, currentHandle, moderationQueue, topicMetrics } = useChatStore();
  const { status } = usePeer();
  const advertisedTopics = useChatStore(s => s.advertisedTopics);
  const listRef = useRef(null);
  const contentRef = useRef(null);
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  const scrollToBottom = (behavior = 'smooth') => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  };

  // ONE advertisement per topic. Ads carry the kernel-derived hex topic id,
  // so compare against the active topic's hex id (same derivation the network
  // uses — immune to region-name spelling like eagle vs its canonical name).
  // Retracting/expiring the ad removes it from the store → button re-enables.
  // Compact: the floating "☰ Topics" pill sits over the header's top-left, so
  // indent the header content past it. MUST use the same predicate as the
  // component that RENDERS the pill (ChatShell) — this was a third independent
  // copy of `innerWidth <= 800`, and the moment ChatShell became height-aware
  // they disagreed: a landscape phone (812x375) is compact by height, so
  // ChatShell drew the pill while this file still thought "desktop" and skipped
  // the indent, parking the pill squarely on top of the channel name.
  const isMobile = useCompactLayout();

  const [copied, setCopied] = useState(false);
  const [activeHexId, setActiveHexId] = useState(null);
  const [noKeyring, setNoKeyring] = useState(false);

  // Check for keyring when switching to an encrypted topic
  useEffect(() => {
    if (!isCouncilTopic(activeTopic)) { setNoKeyring(false); return; }
    let stale = false;
    hasCouncilKeyring().then((has) => { if (!stale) setNoKeyring(!has); });
    return () => { stale = true; };
  }, [activeTopicId]);
  useEffect(() => {
    let stale = false;
    setActiveHexId(null);
    AxonaChatClient.getTopicHexId(activeTopic)
      .then((id) => { if (!stale) setActiveHexId(id); })
      .catch(() => { if (!stale) setActiveHexId(null); });
    return () => { stale = true; };
  }, [activeTopicId]);
  const alreadyAdvertised = !!activeHexId && advertisedTopics.some(ad => ad.topicId === activeHexId);

  // Get envelopes for active topic
  const activeEnvelopes = messages[activeTopicId] || [];

  // Scroll to bottom when messages change
  useEffect(() => {
    pinnedRef.current = true;
    scrollToBottom();
  }, [activeEnvelopes.length, activeTopicId]);

  // The tile's content (markdown, link previews, images) finishes laying out
  // AFTER the scroll above computes its target, which left the last tile
  // slightly cut off. Re-pin on any content-height change while the user is
  // at the bottom; a reader scrolled up is never yanked down.
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (pinnedRef.current) scrollToBottom('auto'); });
    ro.observe(el);
    if (contentRef.current) ro.observe(contentRef.current);
    return () => ro.disconnect();
  }, [activeEnvelopes.length > 0]);

  // Unread bookkeeping. Arrivals while the tab is VISIBLE are marked read by
  // the store as they land; this covers the remaining case — messages that
  // arrived on the active topic while the tab was hidden become read when the
  // user returns to it.
  useEffect(() => {
    const markIfVisible = () => {
      if (document.visibilityState === 'visible') {
        useChatStore.getState().markTopicRead(activeTopicId);
      }
    };
    document.addEventListener('visibilitychange', markIfVisible);
    return () => document.removeEventListener('visibilitychange', markIfVisible);
  }, [activeTopicId]);

  // Nests replies under their parent
  const buildThreadTree = (envelopes) => {
    const map = new Map();
    const roots = [];

    // Initialize map
    envelopes.forEach(env => {
      map.set(env.msgId, { ...env, children: [] });
    });

    // Populate children or roots
    envelopes.forEach(env => {
      const item = map.get(env.msgId);
      const parentId = env.message?.replyTo;
      if (parentId && map.has(parentId)) {
        map.get(parentId).children.push(item);
      } else {
        roots.push(item);
      }
    });

    // Bubble active threads
    // Sort root threads by the timestamp of their latest message (parent or child)
    const getLatestTimestamp = (node) => {
      let latest = node.ts;
      node.children.forEach(child => {
        const childLatest = getLatestTimestamp(child);
        if (childLatest > latest) latest = childLatest;
      });
      return latest;
    };

    roots.sort((a, b) => getLatestTimestamp(a) - getLatestTimestamp(b));

    return roots;
  };

  const threadTree = buildThreadTree(activeEnvelopes);

  // Render tree recursively
  const renderThreadNodes = (nodes, level = 0) => {
    return nodes.map(node => (
      <div key={node.msgId} style={{ display: 'flex', flexDirection: 'column' }}>
        <Message
          envelope={node}
          activeTopic={activeTopic}
          onReply={(env) => setReplyTarget(env)}
          onPrivateReply={(env) => setPrivateReplyTarget(env)}
          level={level}
        />
        {node.children.length > 0 && renderThreadNodes(node.children, level + 1)}
      </div>
    ));
  };

  const isOwner = activeTopic.owner && currentHandle && activeTopic.owner === currentHandle.authorId;
  const queueCount = (moderationQueue[activeTopicId] || []).length;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      flex: 1,
      minWidth: 0,
      overflow: 'hidden'
    }}>
      {/* Header Info */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0.6rem 1rem',
        paddingLeft: isMobile ? '7rem' : '1rem',
        background: 'var(--color-surface)',
        borderBottom: '1px solid var(--border-color)',
        gap: '1rem',
        flexWrap: 'wrap'
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <h3 style={{ fontFamily: 'Outfit, sans-serif', fontSize: '1.05rem', fontWeight: '700', color: 'var(--color-text)', margin: 0 }}>
              #{activeTopic.name}
            </h3>
            {(() => {
              const mode = activeTopic.mode || (activeTopic.write === 'owner' ? 'controlled' : 'open');
              return (
                <span style={{
                  fontSize: '0.6rem',
                  padding: '1px 5px',
                  borderRadius: '3px',
                  background: mode === 'moderated' ? '#e67e22' : mode === 'controlled' ? '#9b59b6' : 'var(--color-bg)',
                  color: mode === 'open' ? 'var(--color-muted)' : '#fff',
                  border: mode === 'open' ? '1px solid var(--border-color)' : 'none',
                  fontWeight: '600',
                  textTransform: 'uppercase'
                }}>
                  {mode}
                </span>
              );
            })()}
            {/* Encrypted-channel indicator: this is the confidential council channel —
                sealed before publish, opened only with the member keyring. */}
            {isCouncilTopic(activeTopic) && (
              <span
                onClick={() => onOpenModal('council')}
                title="Encrypted channel — click to manage keyring or request access"
                style={{
                  fontSize: '0.6rem',
                  padding: '1px 5px',
                  borderRadius: '3px',
                  background: 'rgba(243, 156, 18, 0.14)',
                  color: '#e67e22',
                  border: 'none',
                  fontWeight: '600',
                  letterSpacing: '0.03em',
                  cursor: 'pointer'
                }}
              >
                🔒 ENCRYPTED
              </span>
            )}
            <span
              title="How many messages this topic currently holds on the network ('…' means the count hasn't arrived yet)"
              style={{
              fontSize: '0.65rem',
              padding: '1px 5px',
              borderRadius: '3px',
              background: 'var(--color-bg)',
              color: 'var(--color-muted)',
              border: '1px solid var(--border-color)',
              fontWeight: '500'
            }}>
              📊 {topicMetrics[activeTopicId] && topicMetrics[activeTopicId].current_count !== undefined && topicMetrics[activeTopicId].current_count !== null
                ? `${topicMetrics[activeTopicId].current_count} messages`
                : '… messages'
              }
            </span>
          </div>
          <span style={{ fontSize: '0.7rem', color: 'var(--color-muted)' }}>
            Region: {activeTopic.region || 'global'} · Owner: {activeTopic.owner ? `${activeTopic.owner.slice(0, 16)}...` : 'None'}
          </span>
        </div>

        {/* Header Controls */}
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          {/* Copy topic link — a shareable URL that opens this topic, and pastes
              into any message as a topic-link chip. */}
          {activeTopic.name !== 'advertised-topics' && (
            <button
              onClick={() => {
                const link = buildTopicLink({
                  region: activeTopic.region,
                  name: activeTopic.name,
                  owner: activeTopic.owner,
                  write: activeTopic.write || (activeTopic.owner ? 'owner' : 'open'),
                  label: activeTopic.name,
                });
                const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1600); };
                if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(done).catch(done);
                else { window.prompt('Copy this topic link:', link); }
              }}
              title="Copy a shareable link to this topic — paste it into any conversation (it becomes a clickable topic chip) or share it anywhere; opening it launches the app on this topic"
              style={{
                fontSize: '0.75rem',
                padding: '0.3rem 0.6rem',
                background: copied ? 'var(--color-success-bg)' : 'var(--color-bg)',
                border: '1px solid var(--border-color)',
                color: copied ? 'var(--color-success)' : 'var(--color-text)',
                cursor: 'pointer',
                borderRadius: '4px'
              }}
            >
              🔗 {copied ? 'Copied!' : 'Copy link'}
            </button>
          )}

          {/* Advertise Button (not on the ticker itself) */}
          {activeTopic.name !== 'advertised-topics' && (
            <button
              onClick={() => { if (!alreadyAdvertised) onOpenModal('advertise'); }}
              disabled={alreadyAdvertised}
              title={alreadyAdvertised
                ? 'This topic is already on the DISCOVER ticker — one advertisement per topic. If the ad is yours, retract it there first to re-advertise'
                : 'Invite others in: this shares the topic on the DISCOVER ticker so anyone on the network can find it and join the conversation'}
              style={{
                fontSize: '0.75rem',
                padding: '0.3rem 0.6rem',
                background: 'var(--color-bg)',
                border: '1px solid var(--border-color)',
                color: alreadyAdvertised ? 'var(--color-muted)' : 'var(--color-text)',
                opacity: alreadyAdvertised ? 0.55 : 1,
                cursor: alreadyAdvertised ? 'default' : 'pointer',
                borderRadius: '4px'
              }}
            >
              📢 {alreadyAdvertised ? 'Advertised' : 'Advertise'}
            </button>
          )}

          {/* ACL editor (controlled & owner) */}
          {activeTopic.mode === 'controlled' && isOwner && (
            <button
              onClick={() => onOpenModal('acl')}
              title="Manage who is allowed to post in this topic"
              style={{
                fontSize: '0.75rem',
                padding: '0.3rem 0.6rem',
                background: 'var(--color-primary-dark)',
                color: '#fff',
                borderRadius: '4px'
              }}
            >
              ⚙️ Manage ACL
            </button>
          )}

          {/* Moderation queue (moderated & owner) */}
          {activeTopic.mode === 'moderated' && isOwner && (
            <button
              onClick={() => onOpenModal('moderation')}
              title="Review messages people have submitted to this moderated topic — approve the ones to publish"
              style={{
                fontSize: '0.75rem',
                padding: '0.3rem 0.6rem',
                background: '#e67e22',
                color: '#fff',
                borderRadius: '4px',
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem'
              }}
            >
              <span>Queue</span>
              {queueCount > 0 && (
                <span style={{
                  background: '#c0392b',
                  color: '#fff',
                  fontSize: '0.65rem',
                  fontWeight: 'bold',
                  padding: '1px 5px',
                  borderRadius: '10px'
                }}>
                  {queueCount}
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Request-access overlay: shown when the channel is encrypted but no keyring is provisioned */}
      {isCouncilTopic(activeTopic) && noKeyring ? (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '2rem', gap: '0.8rem'
        }}>
          <span style={{ fontSize: '2.5rem' }}>🔒</span>
          <div style={{
            fontSize: '1rem', fontWeight: '600',
            color: 'var(--color-text)', textAlign: 'center'
          }}>
            Private channel
          </div>
          <div style={{
            fontSize: '0.82rem', color: 'var(--color-muted)',
            textAlign: 'center', maxWidth: '340px', lineHeight: '1.5'
          }}>
            This channel is end-to-end encrypted. Only approved members can read or write messages.
          </div>
          <button
            onClick={() => onOpenModal('council')}
            style={{
              marginTop: '0.5rem',
              padding: '0.5rem 1.4rem',
              background: 'var(--color-primary)', color: '#fff',
              border: 'none', borderRadius: '4px',
              fontSize: '0.85rem', fontWeight: '600',
              cursor: 'pointer'
            }}
          >
            🔑 Request access
          </button>
          <div style={{
            fontSize: '0.7rem', color: 'var(--color-muted)',
            textAlign: 'center', maxWidth: '300px', lineHeight: '1.4'
          }}>
            If you've already been approved, import your keyring to read messages.
          </div>
        </div>
      ) : (
      {/* Message List area */}
      <div ref={listRef} onScroll={() => {
        const el = listRef.current;
        if (!el) return;
        // Only an UPWARD scroll unpins — a smooth scroll-to-bottom animation
        // passes through far-from-bottom positions and must not unpin itself.
        if (el.scrollTop < lastScrollTopRef.current - 4) pinnedRef.current = false;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) pinnedRef.current = true;
        lastScrollTopRef.current = el.scrollTop;
      }} style={{
        flex: 1,
        overflowY: 'auto',
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column'
      }}>
        {activeEnvelopes.length === 0 ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 1,
            color: 'var(--color-muted)',
            fontSize: '0.9rem',
            gap: '0.5rem'
          }}>
            {/* An empty pane has three very different meanings; conflating them
                as "Be the first to speak!" is what made a whole list of
                reconnecting/timed-out topics read as broken after a reload.
                Disambiguate: still connecting → history can't arrive yet; the
                topic reports messages on the network but none have replayed
                locally → history is still loading (or its holders are
                unreachable); the topic genuinely holds nothing → truly empty. */}
            {(() => {
              const metrics = topicMetrics[activeTopicId];
              const networkCount = metrics && metrics.current_count != null ? metrics.current_count : null;
              if (!status?.ready) {
                return (<>
                  <span>Connecting to the network…</span>
                  <span style={{ fontSize: '0.8rem' }}>This channel’s history loads once you’re online.</span>
                </>);
              }
              if (networkCount > 0) {
                return (<>
                  <span>Loading history…</span>
                  <span style={{ fontSize: '0.8rem' }}>
                    {networkCount} message{networkCount === 1 ? '' : 's'} on the network — fetching from the mesh.
                  </span>
                </>);
              }
              if (networkCount === 0) {
                return (<>
                  <span>No messages in this channel yet.</span>
                  <span style={{ fontSize: '0.8rem' }}>Be the first to speak!</span>
                </>);
              }
              return (<>
                <span>No messages loaded yet.</span>
                <span style={{ fontSize: '0.8rem' }}>Any history for this channel appears here as it syncs.</span>
              </>);
            })()}
          </div>
        ) : (
          <div ref={contentRef}>
            {renderThreadNodes(threadTree)}
          </div>
        )}
      </div>
      )}
    </div>
  );
};

export default MessagePane;
