import React, { useState } from 'react';
import { KERNEL_VERSION } from '@axona/protocol';
import { useChatStore } from '../stores/useChatStore.js';
import { useHandle } from '../contexts/HandleContext.jsx';
import { usePeer } from '../contexts/PeerContext.jsx';
import { useNetwork } from '../contexts/NetworkContext.jsx';
import { useCompactLayout } from '../hooks/useCompactLayout.js';
import { isCouncilTopic } from '../services/council/councilChannel.js';

// Injected by Vite from package.json at build time.
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

const StatusFooter = ({ onOpenModal }) => {
  const { handles, activeHandle, setActiveHandleId, declaration, setDeclaration } = useHandle();
  const { status } = usePeer();
  const { bridgeUrl } = useNetwork();
  const { theme, toggleTheme, activeTopic } = useChatStore();
  const [showHandlesList, setShowHandlesList] = useState(false);

  // Compact footer: drop the informational text (connection words, bridge host,
  // version string) so the interactive controls fit on one row. Shared with
  // ChatShell so the two cannot disagree, and height-aware so a landscape phone
  // counts as compact too.
  const isMobile = useCompactLayout();

  const toggleDeclaration = () => {
    setDeclaration(declaration === 'human' ? 'agent' : 'human');
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-start',
      flexWrap: 'wrap',
      rowGap: '0.3rem',
      minHeight: '42px',
      padding: '0.25rem 1rem',
      background: 'var(--color-surface)',
      borderTop: '1px solid var(--border-color)',
      fontSize: '0.78rem',
      position: 'relative',
      zIndex: 10,
      color: 'var(--color-text)'
    }}>
      {/* Left side: Mesh status, active persona dropdown, declaration, theme toggle, QR code */}
      <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '0.4rem' : '0.8rem', position: 'relative', minWidth: 0 }}>
        {/* Connection Dot */}
        <div
          title="Your connection to the Axona network — green means you're online and messages flow"
          style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
        >
          <span style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: status.ready ? '#2ecc71' : '#f1c40f',
            display: 'inline-block'
          }} />
          {!isMobile && (
            <span style={{ color: 'var(--color-text)', fontWeight: '500' }}>
              {status.reason === 'connecting' ? 'Connecting...'
                : status.reason === 'recovering' ? 'Reconnecting…'
                : status.ready ? 'Online' : 'Seeking Peers'}
            </span>
          )}
          {!isMobile && (
            <span style={{ color: 'var(--color-muted)', fontSize: '0.7rem' }}>
              ({bridgeUrl.replace('wss://', '').replace('https://', '')})
            </span>
          )}
          {/* The comment above this block has claimed since it was written that
              the version string is dropped on phones. It never was — this span
              rendered unconditionally, and with whiteSpace:nowrap it is the
              widest thing in the row, which is what pushed the persona,
              human/agent and QR controls into a heap in the corner. Gated now.
              The version is still one tap away in the About/share modal. */}
          {!isMobile && (
            <span
              title="Application version · Axona protocol kernel version"
              style={{ color: 'var(--color-muted)', fontSize: '0.68rem', fontFamily: 'monospace', whiteSpace: 'nowrap' }}
            >
              v{APP_VERSION} · kernel {KERNEL_VERSION}
            </span>
          )}
        </div>

        {/* Encrypted-channel indicator: the active topic is the confidential council
            channel — end-to-end encrypted before publish, decrypted only with the
            member keyring on this device. */}
        {isCouncilTopic(activeTopic) && (
          <span
            title="You are in the confidential council channel — messages are end-to-end encrypted before they leave this device and can only be read by council members (OO.Private.Council)"
            style={{
              fontSize: '0.66rem',
              padding: '2px 6px',
              borderRadius: '3px',
              background: 'rgba(243, 156, 18, 0.14)',
              color: '#e67e22',
              fontWeight: '700',
              letterSpacing: '0.03em',
              whiteSpace: 'nowrap'
            }}
          >
            🔒 ENCRYPTED
          </span>
        )}

        {!isMobile && <span style={{ color: 'var(--border-color)', opacity: 0.5 }}>|</span>}

        {/* Persona Dropdown Trigger */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowHandlesList(!showHandlesList)}
            title="Your persona — the name and signing key your messages are sent under. Click to switch personas or create a new one"
            style={{
              padding: '0.2rem 0.5rem',
              fontSize: '0.75rem',
              fontWeight: '600',
              background: 'var(--color-bg)',
              border: '1px solid var(--border-color)',
              borderRadius: '4px',
              cursor: 'pointer',
              color: 'var(--color-text)',
              maxWidth: isMobile ? '110px' : 'none',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            👤 {activeHandle ? activeHandle.name : 'Persona'} <span style={{ fontSize: '0.6rem' }}>▼</span>
          </button>

          {showHandlesList && (
            <div className="glass" style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              zIndex: 30,
              background: 'var(--color-surface)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius)',
              overflow: 'hidden',
              marginBottom: '6px',
              minWidth: '170px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
              color: 'var(--color-text)'
            }}>
              {handles.map(h => (
                <div
                  key={h.id}
                  onClick={() => {
                    setActiveHandleId(h.id);
                    setShowHandlesList(false);
                  }}
                  style={{
                    padding: '0.5rem 0.75rem',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    background: activeHandle?.id === h.id ? 'var(--color-bg)' : 'transparent',
                    borderBottom: '1px solid var(--border-color)'
                  }}
                >
                  <div style={{ fontWeight: 'bold' }}>{h.name}</div>
                  <div style={{ fontSize: '0.6rem', color: 'var(--color-muted)' }}>{h.authorId.slice(0, 10)}...</div>
                </div>
              ))}
              <div 
                onClick={() => {
                  setShowHandlesList(false);
                  onOpenModal('handles');
                }}
                style={{
                  padding: '0.5rem 0.75rem',
                  fontSize: '0.75rem',
                  color: 'var(--color-primary-light)',
                  textAlign: 'center',
                  background: 'var(--color-bg)',
                  cursor: 'pointer',
                  fontWeight: '600'
                }}
              >
                + Manage Personas
              </div>
            </div>
          )}
        </div>

        {/* Declaration Switcher */}
        <button
          onClick={toggleDeclaration}
          style={{
            padding: '0.2rem 0.5rem',
            fontSize: '0.72rem',
            fontWeight: '600',
            background: declaration === 'human' ? 'rgba(52, 152, 219, 0.15)' : 'rgba(155, 89, 182, 0.15)',
            color: declaration === 'human' ? '#3498db' : '#9b59b6',
            borderRadius: '4px',
            border: 'none',
            cursor: 'pointer'
          }}
          title="Are you a human or an AI agent? Your choice is shown on every message you send, so others know who they're talking to — click to switch"
        >
          {declaration === 'human' ? '🙋‍♂️ Human' : '🤖 Agent'}
        </button>

        {/* Theme Toggle */}
        <button
          onClick={toggleTheme}
          style={{
            padding: '0.2rem 0.4rem',
            fontSize: '0.75rem',
            background: 'var(--color-bg)',
            border: '1px solid var(--border-color)',
            borderRadius: '4px',
            cursor: 'pointer',
            color: 'var(--color-text)'
          }}
          title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Theme`}
        >
          {theme === 'dark' ? '🌙' : '☀️'}
        </button>

        {/* Share/QR button */}
        <button
          onClick={() => onOpenModal('share')}
          style={{
            padding: '0.2rem 0.4rem',
            fontSize: '0.75rem',
            background: 'var(--color-bg)',
            border: '1px solid var(--border-color)',
            borderRadius: '4px',
            cursor: 'pointer',
            color: 'var(--color-text)'
          }}
          title="Start a private conversation: shows a QR code and link that open an encrypted one-to-one channel with whoever uses it"
        >
          🔗{!isMobile && ' QR Link'}
        </button>
      </div>

      {/* The "Members: N Humans | M Agents" readout was REMOVED in 0.43.0.
          It did not mean what its label said. presence is fed by a single
          network-wide heartbeat topic (axona-presence-heartbeats, region
          eagle — AxonaChatClient.js:23), not by the channel you are looking
          at, so it counted everyone anywhere on Axona who had published a
          heartbeat, under a label that reads like channel membership. Worse,
          the 90-second freshness window was evaluated against a Date.now()
          captured at render time with nothing re-rendering on a timer, so a
          peer going quiet never aged out of the count — it only ever moved
          when some unrelated state change happened to re-render this footer.
          A number that is both mislabelled and frozen is worse than no
          number. Presence data itself is untouched and still drives the
          per-message live/ghost indicators. */}
    </div>
  );
};

export default StatusFooter;
