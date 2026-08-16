import React from 'react';
import { useChatStore, getTopicId, countUnread } from '../stores/useChatStore.js';
import AxonaChatClient from '../services/AxonaChatClient.js';

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

const ChannelList = ({ onOpenModal }) => {
  const { subscribedTopics, activeTopic, setActiveTopic, removeTopic } = useChatStore();
  // Subscribe to the slices unread counts derive from, so badges update live.
  const messages = useChatStore(s => s.messages);
  const lastRead = useChatStore(s => s.lastRead);
  const currentHandle = useChatStore(s => s.currentHandle);

  const handleSelectChannel = (topic) => {
    setActiveTopic(topic);
  };

  const handleUnsubscribe = (e, topic) => {
    e.stopPropagation();
    removeTopic(topic);
    // Sync subscriptions background
    AxonaChatClient.reconcileSubscriptions();
  };

  const getTopicLabel = (topic) => {
    const isOwner = topic.owner && useChatStore.getState().currentHandle?.authorId === topic.owner;
    const name = topic.privateKey && topic.description
      ? `🔒 ${topic.description.replace('Private chat with ', '')}`
      : `#${topic.name}`;

    return (
      <span style={{ display: 'inline-flex', gap: '0.2rem', alignItems: 'center' }}>
        <span>{name}</span>
        {isOwner && <span style={{ fontSize: '0.6rem', color: 'var(--color-primary-light)' }}>★</span>}
      </span>
    );
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%'
    }}>
      {/* Top Brand Logo - Clickable to open About Protocol Modal */}
      <div
        onClick={() => onOpenModal('about')}
        title="What is Axona Chat? Click for a short explanation of the app and the network it runs on"
        style={{
          paddingBottom: '0.65rem', 
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          marginBottom: '1rem',
          cursor: 'pointer',
          transition: 'opacity 0.2s'
        }}
        onMouseEnter={(e) => e.currentTarget.style.opacity = '0.8'}
        onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
      >
        <h2 style={{
          fontFamily: 'Outfit, sans-serif',
          fontSize: '1.25rem',
          fontWeight: '800',
          letterSpacing: '1px',
          color: 'var(--color-primary)',
          margin: 0
        }}>
          AXONA CHAT
        </h2>
        <span style={{ fontSize: '0.65rem', color: 'var(--color-muted)', display: 'block' }}>
          PEER-TO-PEER · v{APP_VERSION}
        </span>
      </div>

      {/* Top section: Title and Channel List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', overflowY: 'auto', flex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '0.25rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 'bold', letterSpacing: '0.5px', color: 'var(--color-muted)' }}>TOPICS</span>
          {/* ONE button, because "Join" and "+ New" were one operation. Axona has
              no topic registry: a descriptor hashes to an address, subscribing IS
              joining, and nothing records who arrived first — so "+ New" on an
              open name produced the very same topicId as "Join" on that name.
              The real choice is the write policy, which is inside. */}
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <button
              onClick={() => onOpenModal('council')}
              style={{ padding: '2px 6px', fontSize: '0.7rem', background: 'rgba(46,204,113,0.15)', color: '#2ecc71', border: '1px solid rgba(46,204,113,0.4)' }}
              title="Council encryption — import your keyring and read/write the sealed OO.Private.Council channel"
            >
              🔒 Council
            </button>
            <button
              onClick={() => onOpenModal('addTopic')}
              style={{ padding: '2px 6px', fontSize: '0.7rem', background: 'var(--color-primary-dark)', color: '#fff' }}
              title="Add a topic — type a name to open or start one, or paste a link or descriptor someone shared"
            >
              + Add topic
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {subscribedTopics.map((topic, idx) => {
            const isActive = activeTopic && activeTopic.name === topic.name && activeTopic.region === topic.region;
            const unread = isActive ? 0 : countUnread({ messages, lastRead, currentHandle }, getTopicId(topic));
            return (
              <div
                key={`${topic.name}-${idx}`}
                onClick={() => handleSelectChannel(topic)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.5rem 0.6rem',
                  borderRadius: 'var(--radius)',
                  background: isActive ? 'var(--color-bg)' : 'transparent',
                  border: isActive ? '1px solid var(--border-color)' : '1px solid transparent',
                  color: isActive ? 'var(--color-primary)' : 'var(--color-text)',
                  cursor: 'pointer',
                  transition: 'background 0.2s, color 0.2s',
                  fontSize: '0.85rem'
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--color-bg)'; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: isActive ? '600' : '400' }}>
                    {getTopicLabel(topic)}
                    <span style={{ 
                      fontSize: '0.55rem', 
                      padding: '1px 4px', 
                      borderRadius: '2px', 
                      background: topic.mode === 'moderated' ? '#e67e22' : topic.mode === 'controlled' ? '#9b59b6' : 'var(--color-bg)',
                      color: (topic.mode === 'open' || !topic.mode) ? 'var(--color-muted)' : '#fff',
                      border: (topic.mode === 'open' || !topic.mode) ? '1px solid var(--border-color)' : 'none',
                      textTransform: 'uppercase',
                      fontWeight: '600'
                    }}>
                      {topic.mode || 'open'}
                    </span>
                  </div>
                  {topic.description && (
                    <span style={{ fontSize: '0.7rem', color: 'var(--color-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '140px' }}>
                      {topic.description}
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                  {unread > 0 && (
                    <span
                      title={`${unread} unread message${unread === 1 ? '' : 's'}`}
                      style={{
                        background: 'var(--color-primary)',
                        color: '#fff',
                        borderRadius: '999px',
                        fontSize: '0.62rem',
                        fontWeight: '700',
                        lineHeight: 1,
                        padding: '3px 6px',
                        minWidth: '18px',
                        textAlign: 'center'
                      }}
                    >
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                  {topic.privateKey && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const currentLabel = topic.description.replace('Private chat with ', '');
                        const nextLabel = window.prompt("Rename local connection name:", currentLabel);
                        if (nextLabel && nextLabel.trim()) {
                          useChatStore.getState().renameTopicLabel(topic, nextLabel.trim());
                        }
                      }}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--color-muted)',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        padding: '2px 4px'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.color = 'var(--color-primary-light)'}
                      onMouseLeave={(e) => e.currentTarget.style.color = 'var(--color-muted)'}
                      title="Rename this private channel — the name is just for you, the other person keeps their own"
                    >
                      ✏️
                    </button>
                  )}

                  {/* Unsubscribe control */}
                  <button
                    onClick={(e) => handleUnsubscribe(e, topic)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--color-muted)',
                      fontSize: '0.8rem',
                      padding: '0.1rem 0.3rem',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      transition: 'color 0.2s, transform 0.2s'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.color = '#ff6b6b'}
                    onMouseLeave={(e) => e.currentTarget.style.color = 'var(--color-muted)'}
                    title="Leave this topic — it disappears from your list, and you can rejoin anytime"
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default ChannelList;
