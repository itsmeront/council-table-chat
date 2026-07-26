import React, { useState, useEffect, useRef } from 'react';
import TopicTicker from './TopicTicker.jsx';
import StatusFooter from './StatusFooter.jsx';
import ChannelList from './ChannelList.jsx';
import MessagePane from './MessagePane.jsx';
import Composer from './Composer.jsx';
import Modals from './Modals.jsx';
import { usePeer } from '../contexts/PeerContext.jsx';
import { useHandle } from '../contexts/HandleContext.jsx';
import { useChatStore, getTopicId, countUnread } from '../stores/useChatStore.js';
import AxonaChatClient from '../services/AxonaChatClient.js';

const ChatShell = () => {
  const { peer } = usePeer();
  const { activeHandle, declaration } = useHandle();

  const [activeModal, setActiveModal] = useState(null);
  const [replyTarget, setReplyTarget] = useState(null);
  const [privateReplyTarget, setPrivateReplyTarget] = useState(null);
  
  // Mobile layout is a sliding topic drawer over the chat: it OPENS on first
  // load (picking a topic is the first decision), slides aside when a topic is
  // selected, and a floating "☰ Topics" pill brings it back. Desktop keeps the
  // fixed two-column layout.
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 800);
  const [drawerOpen, setDrawerOpen] = useState(window.innerWidth <= 800);

  // Selecting a topic (rail click, ticker join, deep link) closes the drawer —
  // but only on a real CHANGE, never on mount, so the first-load drawer stays
  // open. prev-ref comparison instead of skip-first-run: survives StrictMode's
  // double-invoked effects.
  const activeTopicId = useChatStore(s => s.activeTopicId);
  const prevTopicIdRef = useRef(null);
  useEffect(() => {
    if (prevTopicIdRef.current !== null && prevTopicIdRef.current !== activeTopicId) {
      setDrawerOpen(false);
    }
    prevTopicIdRef.current = activeTopicId;
  }, [activeTopicId]);

  // Total unread across all topics — shown on the drawer pill so a closed
  // drawer still signals waiting conversation.
  const totalUnread = useChatStore(s =>
    s.subscribedTopics.reduce((sum, t) => sum + countUnread(s, getTopicId(t)), 0));

  // Sync peer to AxonaChatClient
  useEffect(() => {
    AxonaChatClient.setPeer(peer);
  }, [peer]);

  // Sync handle metadata to useChatStore
  useEffect(() => {
    useChatStore.setState({
      currentHandle: activeHandle,
      currentDeclaration: declaration
    });
  }, [activeHandle, declaration]);

  // Declare our author-class as a signed kernel attestation so OTHER apps (Axona
  // Minimal, other clients) can resolve it via getAuthorClass. Runs once the peer,
  // handle, and a concrete (human/agent) declaration are all present; the client
  // dedups so this is safe to re-fire on any of those changing.
  useEffect(() => {
    if (peer && activeHandle && (declaration === 'human' || declaration === 'agent')) {
      AxonaChatClient.declareAuthorClass().catch(() => {});
    }
  }, [peer, activeHandle, declaration]);

  // Handle window resizing
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 800);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Parse private invite queries from URL on load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const inviteTopic = params.get('t');
    const inviteKey = params.get('k');

    // Deep link to a public topic: axona.chat?topic=<name>[&region=<region>].
    // URLSearchParams decodes %20/+ so legacy spaced names still reach the
    // right topic when properly encoded; newly created names carry no spaces.
    const linkedTopic = params.get('topic');
    if (linkedTopic && linkedTopic.trim() && !(inviteTopic && inviteKey)) {
      const linkedRegion = params.get('region') || 'eagle';
      window.history.replaceState({}, document.title, window.location.pathname);
      const descriptor = { region: linkedRegion, name: linkedTopic.trim(), write: 'open' };
      useChatStore.getState().addTopic(descriptor);
      useChatStore.getState().setActiveTopic(descriptor);
      AxonaChatClient.reconcileSubscriptions();
      return;
    }

    if (inviteTopic && inviteKey) {
      // Clear query params from the URL so reloading doesn't prompt again
      window.history.replaceState({}, document.title, window.location.pathname);

      // Prompt to name the connection locally
      setTimeout(() => {
        const localName = window.prompt("You received a private channel invitation! Please enter a name for this connection:");
        if (localName && localName.trim()) {
          const descriptor = {
            region: 'eagle',
            name: inviteTopic,
            description: `Private chat with ${localName.trim()}`,
            mode: 'encrypted',
            privateKey: inviteKey,
            write: 'open'
          };
          // Add to subscribedTopics in useChatStore
          useChatStore.getState().addTopic(descriptor);
          useChatStore.getState().setActiveTopic(descriptor);
          
          // Sync subscriptions
          AxonaChatClient.reconcileSubscriptions();
        }
      }, 500); // Small timeout to ensure active handle is fully synced
    }
  }, []);

  const handleOpenModal = (modalName) => {
    setActiveModal(modalName);
  };

  const handleCloseModal = () => {
    setActiveModal(null);
  };

  const handleSetReply = (env) => {
    setPrivateReplyTarget(null);
    setReplyTarget(env);
  };

  const handleSetPrivateReply = (env) => {
    setReplyTarget(null);
    setPrivateReplyTarget(env);
  };

  const clearReplyTargets = () => {
    setReplyTarget(null);
    setPrivateReplyTarget(null);
  };

  // Render responsive layout
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: 'var(--color-bg)',
      overflow: 'hidden'
    }}>
      {/* Ticker at the top */}
      <TopicTicker />

      {/* Main Container */}
      <div style={{
        display: 'flex',
        flex: 1,
        overflow: 'hidden',
        position: 'relative'
      }}>
        
        {/* Left Column: Topics List. Desktop: fixed 260px column. Mobile: a
            DRAWER over the chat — fills most of the screen (a sliver of chat
            stays visible), slides aside when a topic is chosen, and the
            floating "☰ Topics" pill below brings it back. */}
        <div style={isMobile ? {
          position: 'absolute',
          top: 0, left: 0, bottom: 0,
          width: '85%',
          maxWidth: '320px',
          zIndex: 30,
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid var(--border-color)',
          background: 'var(--color-sidebar-bg)',
          padding: '1rem 0.75rem',
          transform: drawerOpen ? 'translateX(0)' : 'translateX(-105%)',
          transition: 'transform 0.25s ease',
          boxShadow: drawerOpen ? '4px 0 24px rgba(0,0,0,0.35)' : 'none'
        } : {
          display: 'flex',
          flexDirection: 'column',
          width: '260px',
          borderRight: '1px solid var(--border-color)',
          background: 'var(--color-sidebar-bg)',
          height: '100%',
          padding: '1rem 0.75rem'
        }}>
          <ChannelList onOpenModal={handleOpenModal} />
        </div>

        {/* Mobile scrim: dims the visible sliver of chat while the drawer is
            open; tapping it closes the drawer without picking a topic. */}
        {isMobile && drawerOpen && (
          <div
            onClick={() => setDrawerOpen(false)}
            title="Close the topic list"
            style={{
              position: 'absolute', inset: 0, zIndex: 25,
              background: 'rgba(0,0,0,0.35)'
            }}
          />
        )}

        {/* Center Column: MessagePane & Composer.
            minWidth 0: without it this flex child refuses to shrink below its
            content's min-width, so one long unbroken string widens the whole
            pane past a phone viewport (which cannot scroll — overflow hidden). */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minWidth: 0,
          height: '100%',
          background: 'var(--color-column-bg)'
        }}>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <MessagePane
              onOpenModal={handleOpenModal}
              setReplyTarget={handleSetReply}
              setPrivateReplyTarget={handleSetPrivateReply}
            />
          </div>
          <Composer
            replyTarget={replyTarget}
            privateReplyTarget={privateReplyTarget}
            clearReplyTargets={clearReplyTargets}
            onOpenModal={handleOpenModal}
          />
        </div>

        {/* Mobile: floating pill to reopen the topic drawer, with the total
            unread count so a closed drawer still signals waiting messages. */}
        {isMobile && !drawerOpen && (
          <button
            onClick={() => setDrawerOpen(true)}
            title="Show your topics — pick a different conversation"
            style={{
              position: 'absolute', top: '8px', left: '8px', zIndex: 20,
              display: 'flex', alignItems: 'center', gap: '0.35rem',
              padding: '0.35rem 0.7rem',
              fontSize: '0.8rem', fontWeight: '600',
              background: 'var(--color-surface)',
              color: 'var(--color-text)',
              border: '1px solid var(--border-color)',
              borderRadius: '999px',
              boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
              cursor: 'pointer'
            }}
          >
            ☰ Topics
            {totalUnread > 0 && (
              <span style={{
                background: 'var(--color-primary)', color: '#fff',
                borderRadius: '999px', fontSize: '0.62rem', fontWeight: '700',
                lineHeight: 1, padding: '3px 6px', minWidth: '18px', textAlign: 'center'
              }}>
                {totalUnread > 99 ? '99+' : totalUnread}
              </span>
            )}
          </button>
        )}
      </div>

      {/* StatusFooter spans full width under the sidebars */}
      <StatusFooter onOpenModal={handleOpenModal} />

      {/* Modals Handler */}
      <Modals activeModal={activeModal} onClose={handleCloseModal} />
    </div>
  );
};

export default ChatShell;
