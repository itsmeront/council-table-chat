import React, { useState, useRef, useEffect } from 'react';
import CryptoJS from 'crypto-js';
import QRCode from 'qrcode';
import { useChatStore } from '../stores/useChatStore.js';
import { useHandle } from '../contexts/HandleContext.jsx';
import AxonaChatClient from '../services/AxonaChatClient.js';
import { resolveTopicInput, describeDescriptor, POLICY_OPTIONS } from '../services/topicInput.js';
import CryptoService from '../services/CryptoService.js';
import { looksLikeBrowserName } from '../services/handleHints.js';
import IdentityBackupPanel from './IdentityBackupPanel.jsx';
import { CouncilKeyring } from '../services/council/CouncilKeyring.js';
import { loadBestAvailableRegistry, verifyRegistry } from '../services/council/registry.js';

const Modals = ({ activeModal, onClose }) => {
  const { 
    activeTopic, 
    activeTopicId, 
    addTopic, 
    setActiveTopic, 
    currentHandle, 
    moderationQueue,
    removeFromModerationQueue
  } = useChatStore();

  const { createHandle, importHandle, handles, activeHandle, deleteHandle } = useHandle();
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  // Create channel inputs
  const [topicInputRaw, setTopicInputRaw] = useState('');   // name | link | descriptor
  const [chanDesc, setChanDesc] = useState('');
  const [chanMode, setChanMode] = useState('open'); // 'open' | 'controlled' | 'moderated'

  // Join inputs

  // Handle inputs
  const [handleName, setHandleName] = useState('');
  const [handleEnv, setHandleEnv] = useState('');
  const [handleMode, setHandleMode] = useState('create'); // 'create' | 'import'

  // Advertise inputs
  const [adBlurb, setAdBlurb] = useState('');

  // ACL inputs
  const [aclAuthorId, setAclAuthorId] = useState('');
  const [chanAclList, setChanAclList] = useState([]);

  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Share QR/private channel generation
  const [shareUrl, setShareUrl] = useState('');
  const canvasRef = useRef(null);

  // Council keyring provisioning
  const [councilStatus, setCouncilStatus] = useState(null); // { role, authorId, members, sessions } | null
  const [councilInput, setCouncilInput] = useState('');
  const [councilError, setCouncilError] = useState('');
  const [councilJoin, setCouncilJoin] = useState(null); // { payload, msgId }
  const [councilJoinBusy, setCouncilJoinBusy] = useState(false);
  const [councilJoinErr, setCouncilJoinErr] = useState('');
  const [councilRegistry, setCouncilRegistry] = useState(null); // verified registry (roles/handles)

  const refreshCouncilStatus = async () => {
    try {
      const kr = await CouncilKeyring.load();
      setCouncilStatus(kr ? {
        role: kr.role,
        authorId: kr.authorId,
        members: Object.keys(kr.data?.members || {}).length,
        sessions: Object.keys(kr.data?.sessions || {}).length
      } : null);
      // Load the verified registry (topic-delivered preferred over static bundle)
      if (kr) {
        try {
          const bundled = await import('../services/council/known-hosts.json').then((m) => m.default);
          const reg = loadBestAvailableRegistry(bundled);
          const v = await verifyRegistry(reg);
          setCouncilRegistry(v.ok ? reg : null);
        } catch { setCouncilRegistry(null); }
      } else {
        setCouncilRegistry(null);
      }
    } catch {
      setCouncilStatus(null);
      setCouncilRegistry(null);
    }
  };

  useEffect(() => {
    if (activeModal === 'council') refreshCouncilStatus();
  }, [activeModal]);

  const handleImportCouncil = async (e) => {
    e.preventDefault();
    if (!councilInput.trim()) { setCouncilError('Paste a council-keyring JSON payload first.'); return; }
    setIsLoading(true);
    setCouncilError('');
    try {
      await CouncilKeyring.provision(councilInput);
      setCouncilInput('');
      await refreshCouncilStatus();
      onClose();
    } catch (err) {
      setCouncilError(err.message || 'Import failed — is this an export-keyring payload?');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCouncilFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      await CouncilKeyring.provision(text);
      await refreshCouncilStatus();
      onClose();
    } catch (err) {
      setCouncilError(err.message || 'Import failed — is this an export-keyring payload?');
    }
  };

  const handleResetCouncil = async () => {
    if (!window.confirm('Remove this browser\'s council keyring? Your persona and its signed messages are unaffected — you can re-import a fresh export-keyring payload anytime.')) return;
    await CouncilKeyring.reset();
    await refreshCouncilStatus();
  };

  const handleJoinCouncil = async () => {
    setCouncilJoinBusy(true);
    setCouncilJoinErr('');
    setCouncilJoin(null);
    try {
      const author = await AxonaChatClient.getActiveAuthor();
      const handleName = currentHandle?.name || `member-${author.authorId.slice(0, 6)}`;
      const { joinPayload } = await CouncilKeyring.selfMint({
        role: 'council-member', handle: handleName, authorId: author.authorId, signFn: author.sign,
      });
      const msgId = await AxonaChatClient.publishCouncilJoinRequest(joinPayload);
      await refreshCouncilStatus();
      setCouncilJoin({ payload: joinPayload, msgId });
    } catch (err) {
      setCouncilJoinErr(err.message || 'Join failed — is a persona active?');
    } finally {
      setCouncilJoinBusy(false);
    }
  };

  useEffect(() => {
    if (activeModal === 'share') {
      const topic = CryptoService.generatePrivateTopic();
      const key = CryptoJS.lib.WordArray.random(16).toString();
      // origin + pathname (not origin alone) so invite links survive subpath
      // hosting (e.g. GitHub Pages at /axona-chat/).
      const url = `${window.location.origin}${window.location.pathname}?t=${topic}&k=${key}`;
      setShareUrl(url);

      setTimeout(() => {
        if (canvasRef.current) {
          QRCode.toCanvas(canvasRef.current, url, { width: 220, margin: 1 }, (err) => {
            if (err) console.error('QR draw error:', err);
          });
        }
      }, 50);
    }
  }, [activeModal]);

  if (!activeModal) return null;

  // ONE handler. Both old ones ended in the same three lines — the difference
  // was only descriptor construction, which now lives in resolveTopicInput so it
  // can be tested without a DOM and so the resolved address can be SHOWN.
  const resolved = resolveTopicInput(topicInputRaw, {
    policy: chanMode,
    ownerAuthorId: currentHandle?.authorId ?? null,
    description: chanDesc,
  });

  const handleAddTopic = async (e) => {
    e.preventDefault();
    if (!resolved.descriptor) { setError(resolved.error || 'Enter a topic.'); return; }
    setIsLoading(true);
    setError('');
    try {
      addTopic(resolved.descriptor);
      setActiveTopic(resolved.descriptor);
      AxonaChatClient.reconcileSubscriptions();
      onClose();
      setTopicInputRaw('');
      setChanDesc('');
      setChanMode('open');
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddPersona = async (e) => {
    e.preventDefault();
    if (!handleName.trim()) return;
    setIsLoading(true);
    setError('');

    try {
      if (handleMode === 'create') {
        await createHandle(handleName.trim());
      } else {
        await importHandle(handleName.trim(), handleEnv.trim());
      }
      onClose();
      setHandleName('');
      setHandleEnv('');
    } catch (err) {
      setError(err.message || 'Action failed.');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePostAd = async (e) => {
    e.preventDefault();
    if (!adBlurb.trim()) return;
    setIsLoading(true);

    try {
      await AxonaChatClient.advertiseTopic(activeTopic, adBlurb.trim());
      onClose();
      setAdBlurb('');
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddAcl = (e) => {
    e.preventDefault();
    if (!aclAuthorId.trim()) return;
    setChanAclList([...chanAclList, aclAuthorId.trim()]);
    setAclAuthorId('');
  };

  const handleRemoveAcl = (id) => {
    setChanAclList(chanAclList.filter(item => item !== id));
  };

  const handleApproveSubmission = async (envelope) => {
    try {
      await AxonaChatClient.forwardMessage(activeTopic, envelope);
      removeFromModerationQueue(activeTopicId, envelope.msgId);
    } catch (err) {
      alert('Forwarding failed: ' + err.message);
    }
  };

  const handleDiscardSubmission = (msgId) => {
    removeFromModerationQueue(activeTopicId, msgId);
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0,0,0,0.6)',
      backdropFilter: 'blur(4px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 100,
      padding: '1rem'
    }}>
      <div className="glass" style={{
        maxWidth: '500px',
        width: '100%',
        maxHeight: '90vh',
        overflowY: 'auto',
        padding: '2rem',
        animation: 'rise 0.3s ease-out',
        position: 'relative'
      }}>
        {/* Close Button */}
        <button 
          onClick={onClose}
          style={{
            position: 'absolute',
            top: '1rem',
            right: '1rem',
            background: 'transparent',
            border: 'none',
            fontSize: '1rem',
            color: 'var(--color-muted)',
            cursor: 'pointer'
          }}
        >
          ✕
        </button>

        {/* 1. Create Channel Modal */}
        {/* 1+2. Add Topic — replaces the old separate Create and Join dialogs.
            They ran the same three lines and differed only in how they built the
            descriptor; see src/services/topicInput.js for why that split was
            fictional (no registry) and actively harmful (owner+write fold into
            the address, so joining a moderated channel BY NAME silently landed
            you on a different, empty topic — the #393 failure mode). */}
        {activeModal === 'addTopic' && (
          <div>
            <h3 style={{ fontFamily: 'Outfit, sans-serif', marginBottom: '0.35rem' }}>Add Topic</h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--color-muted)', marginTop: 0, marginBottom: '1rem' }}>
              Type a name to open a topic (or start it, if nobody has yet), or paste a link or
              descriptor someone shared.
            </p>
            <form onSubmit={handleAddTopic} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--color-muted)', display: 'block', marginBottom: '0.25rem' }}>
                  Name, link, or descriptor
                </label>
                <textarea
                  placeholder={'retro-gaming\n\n…or https://axona.chat#topic=…\n…or {"region":"eagle","name":"…"}'}
                  value={topicInputRaw}
                  onChange={(e) => setTopicInputRaw(e.target.value)}
                  rows={3}
                  style={{ ...inputStyle, fontFamily: 'monospace', fontSize: '0.75rem', resize: 'none' }}
                  required
                />
              </div>

              {/* The policy control only means anything for a bare NAME. A pasted
                  link or descriptor carries its own, and silently ignoring the
                  control would be the mis-addressing bug all over again — so say so. */}
              {resolved.policyApplies ? (
                <>
                  <div>
                    <label style={{ fontSize: '0.8rem', color: 'var(--color-muted)', display: 'block', marginBottom: '0.25rem' }}>
                      Who can post
                    </label>
                    <select value={chanMode} onChange={(e) => setChanMode(e.target.value)} style={selectStyle}>
                      {POLICY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <div style={{ fontSize: '0.68rem', color: 'var(--color-muted)', marginTop: '0.3rem' }}>
                      This is part of the topic's address — the same name with a different
                      policy is a different topic.
                    </div>
                  </div>
                  <div>
                    <label style={{ fontSize: '0.8rem', color: 'var(--color-muted)', display: 'block', marginBottom: '0.25rem' }}>
                      Description <span style={{ fontWeight: 'normal' }}>(optional, only on your device)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="Short summary of this topic"
                      value={chanDesc}
                      onChange={(e) => setChanDesc(e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                </>
              ) : (
                <div style={{ fontSize: '0.72rem', color: 'var(--color-muted)' }}>
                  This {resolved.source === 'link' ? 'link' : 'descriptor'} sets its own posting
                  policy, so there is nothing to choose.
                </div>
              )}

              {/* Show the ADDRESS before committing to it. */}
              {resolved.descriptor && (
                <div style={{
                  fontSize: '0.72rem', fontFamily: 'monospace', color: 'var(--color-text)',
                  background: 'var(--color-bg)', border: '1px solid var(--border-color)',
                  borderRadius: '4px', padding: '0.45rem 0.6rem', wordBreak: 'break-all'
                }}>
                  {describeDescriptor(resolved.descriptor)}
                </div>
              )}

              {(resolved.error && topicInputRaw.trim()) && (
                <div style={{ color: '#ff6b6b', fontSize: '0.8rem' }}>{resolved.error}</div>
              )}
              {error && <div style={{ color: '#ff6b6b', fontSize: '0.8rem' }}>{error}</div>}

              <button type="submit" disabled={isLoading || !resolved.descriptor} style={btnStyle}>
                {isLoading ? 'Adding…' : 'Add topic'}
              </button>
            </form>
          </div>
        )}

        {/* 3. Council Encryption Modal (TASK-P-0003) */}
        {activeModal === 'council' && (
          <div>
            <h3 style={{ fontFamily: 'Outfit, sans-serif', marginBottom: '0.35rem' }}>🔒 Channel Keyring</h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--color-muted)', marginTop: 0, marginBottom: '1rem' }}>
              This browser's confidential-channel keyring. Messages on encrypted channels are AES-GCM-sealed
              before publish — the relay only ever carries ciphertext, and only a member with the keyring
              can open them. Import a keyring to read, or join to request access.
            </p>

            <div style={{
              background: 'var(--color-bg)', border: '1px solid var(--border-color)',
              borderRadius: '4px', padding: '0.6rem 0.7rem', marginBottom: '1rem',
              fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.15rem'
            }}>
              {councilStatus ? (
                <>
                  <div>Role: <b style={{ color: 'var(--color-primary)' }}>{councilStatus.role}</b></div>
                  <div style={{ fontFamily: 'monospace', fontSize: '0.72rem', color: 'var(--color-muted)' }}>
                    {councilStatus.authorId.slice(0, 16)}…
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--color-muted)' }}>
                    {councilStatus.members} member(s) · {councilStatus.sessions} session(s)
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--color-muted)' }}>
                    Decrypt key is non-extractable — this browser can use it, never read it.
                  </div>
                </>
              ) : (
                <div style={{ color: 'var(--color-muted)', fontStyle: 'italic' }}>
                  No keyring provisioned in this browser yet.
                </div>
              )}
            </div>

            {/* Known-hosts panel — only shown AFTER approval (keyring has an active session/epoch).
                Before approval the keyring exists but sessions is 0 — show pending state instead. */}
            {councilStatus && councilStatus.sessions > 0 && councilRegistry && (
              <div style={{
                marginTop: '0.8rem', padding: '0.6rem 0.7rem',
                background: 'var(--color-bg)', border: '1px solid var(--border-color)',
                borderRadius: '4px', fontSize: '0.78rem'
              }}>
                <div style={{ fontWeight: '600', marginBottom: '0.4rem', fontSize: '0.8rem' }}>
                  Council Members
                </div>
                <div style={{ fontSize: '0.68rem', color: 'var(--color-muted)', marginBottom: '0.4rem' }}>
                  Root-signed registry — {Object.keys(councilRegistry.roles || {}).length} role(s) approved
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  {Object.entries(councilRegistry.roles || {}).map(([role, r]) => (
                    <div key={role} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '0.2rem 0.35rem', borderRadius: '3px',
                      background: r.revoked ? 'rgba(231,76,60,0.08)' : 'transparent',
                      opacity: r.revoked ? 0.5 : 1,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <span style={{
                          fontFamily: 'monospace', fontSize: '0.72rem',
                          color: r.revoked ? '#e74c3c' : 'var(--color-primary)',
                          fontWeight: '600'
                        }}>
                          {r.handle || role}
                        </span>
                        {r.reviewer && (
                          <span style={{
                            fontSize: '0.6rem', padding: '0.05rem 0.3rem',
                            background: 'var(--color-primary)', color: '#fff',
                            borderRadius: '2px', fontWeight: '500'
                          }}>reviewer</span>
                        )}
                        {r.revoked && (
                          <span style={{
                            fontSize: '0.6rem', padding: '0.05rem 0.3rem',
                            background: '#e74c3c', color: '#fff',
                            borderRadius: '2px', fontWeight: '500'
                          }}>revoked</span>
                        )}
                      </div>
                      <span style={{
                        fontFamily: 'monospace', fontSize: '0.65rem',
                        color: 'var(--color-muted)'
                      }}>
                        {r.authorId?.slice(0, 12)}…
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Pending-approval state: keyring provisioned (self-minted) but no epoch yet */}
            {councilStatus && councilStatus.sessions === 0 && (
              <div style={{
                marginTop: '0.8rem', padding: '0.6rem 0.7rem',
                background: 'var(--color-bg)', border: '1px dashed var(--border-color)',
                borderRadius: '4px', fontSize: '0.78rem'
              }}>
                <div style={{ fontWeight: '600', marginBottom: '0.3rem', color: '#e67e22' }}>
                  ⏳ Waiting for approval
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--color-muted)', lineHeight: '1.4' }}>
                  Your request has been sent. The council leader will review it and approve access.
                  Once approved, the session key arrives automatically and messages become readable.
                  No reload needed — the key is installed in the background.
                </div>
              </div>
            )}

            <form onSubmit={handleImportCouncil} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--color-muted)', display: 'block', marginBottom: '0.25rem' }}>
                  Keyring payload (from the platform's <span style={{ fontFamily: 'monospace' }}>export-keyring</span> CLI)
                </label>
                <textarea
                  placeholder='{ "kind": "council-keyring", … }'
                  value={councilInput}
                  onChange={(e) => setCouncilInput(e.target.value)}
                  rows={5}
                  style={{ ...inputStyle, fontFamily: 'monospace', fontSize: '0.7rem', resize: 'none' }}
                />
              </div>
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                <button type="submit" disabled={isLoading || !councilInput.trim()} style={btnStyle}>
                  {isLoading ? 'Importing…' : 'Import keyring'}
                </button>
                <label style={{ fontSize: '0.75rem', color: 'var(--color-muted)', cursor: 'pointer' }}>
                  or
                  <input
                    type="file"
                    accept=".json,application/json"
                    onChange={handleCouncilFile}
                    style={{ marginLeft: '0.35rem', fontSize: '0.7rem' }}
                  />
                </label>
              </div>
            </form>

            {!councilStatus && (
              <div style={{
                marginTop: '1rem', padding: '0.6rem 0.7rem',
                background: 'var(--color-bg)', border: '1px dashed var(--border-color)',
                borderRadius: '4px', fontSize: '0.8rem'
              }}>
                <div style={{ fontWeight: '600', marginBottom: '0.3rem' }}>
                  New to the council? Join with your active persona
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--color-muted)', marginBottom: '0.5rem', lineHeight: '1.4' }}>
                  This browser generates its own decrypt key — the private key never leaves the page.
                  Your request carries only public material and is signed by your persona; an admin
                  approves it, and the key then arrives here automatically.
                </div>
                <button
                  onClick={handleJoinCouncil}
                  disabled={councilJoinBusy}
                  style={{
                    ...btnStyle, background: 'var(--color-primary)', color: '#fff',
                    border: 'none'
                  }}
                >
                  {councilJoinBusy ? 'Joining…' : 'Join the council'}
                </button>
                {councilJoinErr && (
                  <div style={{ color: '#ff6b6b', fontSize: '0.75rem', marginTop: '0.4rem' }}>{councilJoinErr}</div>
                )}
              </div>
            )}

            {councilJoin && (
              <div style={{
                marginTop: '1rem', padding: '0.6rem 0.7rem',
                background: 'var(--color-bg)', border: '1px solid var(--color-success)',
                borderRadius: '4px', fontSize: '0.78rem'
              }}>
                <div style={{ fontWeight: '600', marginBottom: '0.3rem' }}>
                  ✅ Join request sent{currentHandle ? ` as ${currentHandle.name}` : ''} — pending approval
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--color-muted)', lineHeight: '1.4' }}>
                  Your request carries only your public key + signed binding — your private key stayed in this
                  browser. The council leader will review and approve it. Once approved, the session key
                  arrives automatically (via a signed epoch announcement) and sealed messages become readable.
                  No reload needed — backlog replay catches you up on the next load.
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem' }}>
                  <button
                    onClick={() => {
                      if (navigator.clipboard?.writeText) {
                        navigator.clipboard.writeText(JSON.stringify(councilJoin.payload, null, 2))
                          .then(() => setCouncilError('Join request copied — send it to an admin.')).catch(() => {});
                      } else {
                        window.prompt('Copy this join request:', JSON.stringify(councilJoin.payload));
                      }
                    }}
                    style={{ ...btnStyle, fontSize: '0.7rem', padding: '0.25rem 0.6rem' }}
                  >
                    Copy join request
                  </button>
                  <span style={{ fontSize: '0.68rem', color: 'var(--color-muted)' }}>
                    msgId {councilJoin.msgId?.slice(0, 16)}…
                  </span>
                </div>
              </div>
            )}

            <div style={{ fontSize: '0.7rem', color: 'var(--color-muted)', marginTop: '0.7rem', lineHeight: '1.4' }}>
              To provision from the platform: run{' '}
              <span style={{ fontFamily: 'monospace' }}>node council/scripts/private-council.mjs export-keyring --role=&lt;role&gt; --out=council-keyring.json</span>{' '}
              and import the file here. The keyring is scoped to THIS device (IndexedDB, 0600-era trust
              boundary) — import the same payload on every browser that should read the council.
              Session rotations are delivered automatically (a signed epoch announcement installs the
              newest key without a re-export).
            </div>

            {councilError && <div style={{ color: '#ff6b6b', fontSize: '0.8rem', marginTop: '0.5rem' }}>{councilError}</div>}

            {councilStatus && (
              <button
                onClick={handleResetCouncil}
                style={{
                  marginTop: '1rem', background: 'transparent', color: '#e74c3c',
                  border: '1px solid #e74c3c', borderRadius: '3px', padding: '0.35rem 0.8rem',
                  fontSize: '0.72rem', cursor: 'pointer'
                }}
              >
                Remove keyring from this browser
              </button>
            )}
          </div>
        )}

        {/* 4. Manage Handles Modal */}
        {activeModal === 'handles' && (
          <div>
            <h3 style={{ fontFamily: 'Outfit, sans-serif', marginBottom: '1rem' }}>Manage Personas</h3>

            {/* Existing personas, with permanent delete */}
            <div style={{ marginBottom: '1.25rem' }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 'bold', color: 'var(--color-muted)', textTransform: 'uppercase', marginBottom: '0.4rem' }}>
                Your personas
              </div>
              {handles.map(h => (
                <div key={h.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0.45rem 0.5rem', borderRadius: '4px',
                  border: '1px solid var(--border-color)', marginBottom: '0.35rem'
                }}>
                  <div>
                    <div style={{ fontWeight: 'bold', fontSize: '0.85rem' }}>
                      {h.name}{activeHandle?.id === h.id && <span style={{ color: 'var(--color-primary)', fontSize: '0.65rem', marginLeft: '0.4rem' }}>ACTIVE</span>}
                    </div>
                    <div style={{ fontSize: '0.62rem', color: 'var(--color-muted)', fontFamily: 'monospace' }}>{h.authorId.slice(0, 16)}…</div>
                  </div>
                  {confirmDeleteId === h.id ? (
                    <span style={{ display: 'inline-flex', gap: '0.35rem', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.65rem', color: 'var(--color-muted)' }}>Delete key forever?</span>
                      <button
                        onClick={async () => { await deleteHandle(h.id); setConfirmDeleteId(null); }}
                        style={{ background: '#e74c3c', color: '#fff', border: 'none', borderRadius: '3px', padding: '2px 8px', fontSize: '0.7rem', cursor: 'pointer', fontWeight: '600' }}
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        style={{ background: 'transparent', color: 'var(--color-text)', border: '1px solid var(--border-color)', borderRadius: '3px', padding: '1px 8px', fontSize: '0.7rem', cursor: 'pointer' }}
                      >
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(h.id)}
                      title="Permanently delete this persona and its signing key"
                      style={{ background: 'transparent', color: '#e74c3c', border: '1px solid #e74c3c', borderRadius: '3px', padding: '2px 8px', fontSize: '0.7rem', cursor: 'pointer' }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              ))}
              <div style={{ fontSize: '0.68rem', color: 'var(--color-muted)', marginTop: '0.3rem' }}>
                Deleting a persona destroys its signing key permanently. Messages it already
                published remain on the network, and you lose the ability to retract them.
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <button 
                onClick={() => { setHandleMode('create'); setError(''); }} 
                style={{ flex: 1, background: handleMode === 'create' ? 'var(--color-primary)' : 'rgba(255,255,255,0.05)' }}
              >
                Create New
              </button>
              <button 
                onClick={() => { setHandleMode('import'); setError(''); }} 
                style={{ flex: 1, background: handleMode === 'import' ? 'var(--color-primary)' : 'rgba(255,255,255,0.05)' }}
              >
                Import Key
              </button>
            </div>

            <form onSubmit={handleAddPersona} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--color-muted)', display: 'block', marginBottom: '0.25rem' }}>Persona Name</label>
                <input
                  type="text"
                  placeholder="e.g. Satoshi"
                  value={handleName}
                  onChange={(e) => setHandleName(e.target.value)}
                  style={inputStyle}
                  required
                />
                {looksLikeBrowserName(handleName) && (
                  <div style={{ fontSize: '0.72rem', color: '#f1c40f', marginTop: '0.25rem' }}>
                    ⚠ “{handleName.trim()}” looks like a browser name. Others will see it as <i>you</i>,
                    not this browser — consider the name you actually go by.
                  </div>
                )}
              </div>

              {handleMode === 'import' && (
                <div>
                  <label style={{ fontSize: '0.8rem', color: 'var(--color-muted)', display: 'block', marginBottom: '0.25rem' }}>Key Envelope (JSON)</label>
                  <textarea
                    placeholder='Paste key JSON'
                    value={handleEnv}
                    onChange={(e) => setHandleEnv(e.target.value)}
                    rows={4}
                    style={{ ...inputStyle, fontFamily: 'monospace', fontSize: '0.75rem', resize: 'none' }}
                    required
                  />
                </div>
              )}

              {error && <div style={{ color: '#ff6b6b', fontSize: '0.8rem' }}>{error}</div>}

              <button type="submit" disabled={isLoading} style={btnStyle}>
                {isLoading ? 'Processing...' : handleMode === 'create' ? 'Generate Persona' : 'Import'}
              </button>
            </form>

            <IdentityBackupPanel />
          </div>
        )}

        {/* 4. Advertise Modal */}
        {activeModal === 'advertise' && (
          <div>
            <h3 style={{ fontFamily: 'Outfit, sans-serif', marginBottom: '1rem' }}>Invite others to this topic</h3>
            <p style={{ color: 'var(--color-muted)', fontSize: '0.8rem', marginBottom: '1rem' }}>
              This shares your topic on the DISCOVER ticker that everyone on the network sees, so people can find it and join the conversation. Write a short blurb saying what the topic is about. You can take the invitation back later (the ✕ next to your ad in DISCOVER), and it naturally expires after a day or two.
            </p>
            <form onSubmit={handlePostAd} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--color-muted)', display: 'block', marginBottom: '0.25rem' }}>Blurb (max 100 chars)</label>
                <input
                  type="text"
                  placeholder="Short, catchy summary of the topic."
                  value={adBlurb}
                  onChange={(e) => setAdBlurb(e.target.value)}
                  maxLength={100}
                  style={inputStyle}
                  required
                />
              </div>
              <button type="submit" disabled={isLoading} style={btnStyle}>Publish Ad</button>
            </form>
          </div>
        )}

        {/* 5. ACL Editor Modal */}
        {activeModal === 'acl' && (
          <div>
            <h3 style={{ fontFamily: 'Outfit, sans-serif', marginBottom: '0.5rem' }}>Edit Channel ACL</h3>
            <span style={{ color: 'var(--color-muted)', fontSize: '0.75rem', display: 'block', marginBottom: '1rem' }}>
              Manage whitelisted Author IDs approved to publish to this controlled channel.
            </span>

            <form onSubmit={handleAddAcl} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <input
                type="text"
                placeholder="Paste Author ID (64-hex)"
                value={aclAuthorId}
                onChange={(e) => setAclAuthorId(e.target.value)}
                style={{ ...inputStyle, flex: 1 }}
              />
              <button type="submit" style={{ padding: '0.5rem 1rem' }}>Add</button>
            </form>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '200px', overflowY: 'auto' }}>
              {chanAclList.length === 0 ? (
                <span style={{ fontSize: '0.8rem', color: 'var(--color-muted)', fontStyle: 'italic' }}>No whitelisted authors yet.</span>
              ) : (
                chanAclList.map(id => (
                  <div key={id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.02)', padding: '0.4rem 0.6rem', borderRadius: '4px' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{id.slice(0, 16)}...</span>
                    <button onClick={() => handleRemoveAcl(id)} style={{ background: 'transparent', padding: '2px 6px', color: '#ff6b6b' }}>Remove</button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* 6. Moderation Queue Modal */}
        {activeModal === 'moderation' && (
          <div>
            <h3 style={{ fontFamily: 'Outfit, sans-serif', marginBottom: '0.5rem' }}>Pending Submissions</h3>
            <span style={{ color: 'var(--color-muted)', fontSize: '0.75rem', display: 'block', marginBottom: '1rem' }}>
              Review messages submitted to the raw channel. Approved messages are forwarded to the public channel.
            </span>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxHeight: '300px', overflowY: 'auto' }}>
              {(!moderationQueue[activeTopicId] || moderationQueue[activeTopicId].length === 0) ? (
                <span style={{ fontSize: '0.8rem', color: 'var(--color-muted)', fontStyle: 'italic', textAlign: 'center', padding: '2rem' }}>
                  No pending submissions.
                </span>
              ) : (
                moderationQueue[activeTopicId].map(env => (
                  <div key={env.msgId} style={{ background: 'rgba(255,255,255,0.03)', padding: '0.8rem', borderRadius: 'var(--radius)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                      <span style={{ fontWeight: 'bold' }}>{env.message?.handle || 'Anonymous'} ({env.message?.authorClass})</span>
                      <span style={{ color: 'var(--color-muted)' }}>{env.signerPubkey?.slice(0, 8)}...</span>
                    </div>
                    <p style={{ fontSize: '0.85rem', margin: 0 }}>{env.message?.text || env.message?.md}</p>
                    <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.2rem' }}>
                      <button 
                        onClick={() => handleDiscardSubmission(env.msgId)} 
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.7rem', background: 'rgba(255, 107, 107, 0.1)', color: '#ff6b6b' }}
                      >
                        Discard
                      </button>
                      <button 
                        onClick={() => handleApproveSubmission(env)} 
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.7rem', background: 'rgba(46, 204, 113, 0.15)', color: '#2ecc71' }}
                      >
                        Approve & Forward
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeModal === 'about' && (
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <h3 style={{ fontFamily: 'Outfit, sans-serif', fontSize: '1.25rem', color: 'var(--color-primary-light)' }}>
              About Axona Chat
            </h3>
            <p style={{ fontSize: '0.9rem', lineHeight: '1.5', color: 'var(--color-text)' }}>
              Axona Chat is a decentralized, peer-to-peer, serverless messaging application built on top of the <b>Axona Protocol</b>.
            </p>
            <p style={{ fontSize: '0.85rem', lineHeight: '1.5', color: 'var(--color-muted)' }}>
              All user accounts exist as cryptographic keypairs (handles). Operator classes (Human or Agent) are self-declared. Topic metrics and message feeds are loaded directly from the distributed peer-to-peer mesh.
            </p>
            <div style={{ marginTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '1.25rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--color-muted)', display: 'block', marginBottom: '0.5rem' }}>
                Explore the protocol specification:
              </span>
              <a 
                href="https://axona.net" 
                target="_blank" 
                rel="noopener noreferrer" 
                style={{
                  color: 'var(--color-primary-light)',
                  fontWeight: 'bold',
                  textDecoration: 'none',
                  fontSize: '0.95rem'
                }}
              >
                axona.net ➔
              </a>
            </div>
          </div>
        )}

        {activeModal === 'share' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.8rem', textAlign: 'center' }}>
            <h3 style={{ fontFamily: 'Outfit, sans-serif', color: 'var(--color-primary-light)' }}>
              Share Private Connection
            </h3>
            <p style={{ fontSize: '0.82rem', color: 'var(--color-muted)', margin: 0 }}>
              Scan this QR code or copy the link below to invite a friend into a secure, end-to-end symmetrically encrypted private channel.
            </p>
            
            <div style={{ background: '#fff', padding: '0.5rem', borderRadius: '8px', display: 'flex', margin: '0.5rem 0' }}>
              <canvas ref={canvasRef} />
            </div>

            <div style={{ width: '100%' }}>
              <input 
                type="text" 
                readOnly 
                value={shareUrl} 
                style={{
                  ...inputStyle,
                  textAlign: 'center',
                  background: 'rgba(255,255,255,0.03)',
                  fontSize: '0.75rem',
                  fontFamily: 'monospace'
                }}
              />
              <button
                onClick={() => {
                  navigator.clipboard.writeText(shareUrl);
                  alert('Link copied to clipboard!');
                }}
                style={{
                  ...btnStyle,
                  marginTop: '0.4rem',
                  padding: '0.4rem 1rem',
                  fontSize: '0.75rem'
                }}
              >
                Copy Link
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Common styles
const inputStyle = {
  width: '100%',
  background: 'var(--color-surface)',
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius)',
  padding: '0.6rem 0.75rem',
  color: 'var(--color-text)',
  outline: 'none',
  fontSize: '0.85rem'
};

const selectStyle = {
  ...inputStyle,
  cursor: 'pointer'
};

const btnStyle = {
  background: 'var(--color-primary)',
  color: '#fff',
  padding: '0.75rem',
  fontWeight: '600',
  borderRadius: 'var(--radius)',
  border: 'none',
  cursor: 'pointer',
  marginTop: '0.5rem',
  fontSize: '0.85rem'
};

export default Modals;
