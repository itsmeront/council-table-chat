import React, { useState, useEffect, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import CryptoJS from 'crypto-js';
import { useChatStore } from '../stores/useChatStore.js';
import { useHandle } from '../contexts/HandleContext.jsx';
import AxonaChatClient from '../services/AxonaChatClient.js';
import CryptoService from '../services/CryptoService.js';
import { loadHistory, appendHistory, stepHistory, historyAt } from '../services/messageHistory.js';

// Simple toolbar button
const ToolbarButton = ({ onClick, label, active = false }) => (
  <button
    onMouseDown={(e) => {
      e.preventDefault();
      onClick();
    }}
    style={{
      background: active ? 'var(--color-bg)' : 'transparent',
      border: active ? '1px solid var(--border-color)' : '1px solid transparent',
      color: active ? 'var(--color-primary)' : 'var(--color-text)',
      cursor: 'pointer',
      padding: '0.25rem 0.5rem',
      borderRadius: '3px',
      fontSize: '0.8rem',
      fontWeight: '600'
    }}
  >
    {label}
  </button>
);

const Composer = ({ replyTarget, privateReplyTarget, clearReplyTargets, onOpenModal }) => {
  const { activeTopic } = useChatStore();
  const { declaration, activeHandle } = useHandle();

  // Controlled (owner-write) topic: only the owner's key can publish — the
  // network enforces this at the roots, so don't offer an editor that can
  // only end in a rejection.
  const ownerLocked = (activeTopic?.write === 'owner' || activeTopic?.mode === 'controlled')
    && !!activeTopic?.owner
    && activeTopic.owner !== activeHandle?.authorId;
  const [isExpanded, setIsExpanded] = useState(false);
  const [rawMarkdown, setRawMarkdown] = useState('');
  const [isRawView, setIsRawView] = useState(false);

  // ── shell-style recall of what you have sent before ────────────────────────
  // histIndex counts back from the newest: -1 = "not navigating, this is my live
  // draft", 0 = newest sent, 1 = the one before it. draftRef holds the draft that
  // was on screen when navigation STARTED, so pressing Down past the newest puts
  // the user's own unsent text back — the thing that makes trying Up feel safe.
  const [history, setHistory] = useState(() => loadHistory());
  const [histIndex, setHistIndex] = useState(-1);
  const draftRef = useRef('');
  const rawRef = useRef(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Markdown.configure({
        html: false,
        transformCopiedText: true,
        transformPastedText: true
      })
    ],
    content: '',
    editorProps: {
      attributes: {
        class: 'focus:outline-none',
      },
    },
    onUpdate: ({ editor }) => {
      setRawMarkdown(editor.getMarkdown());
    }
  });

  // Switching onto a locked topic while composing closes the editor
  useEffect(() => {
    if (ownerLocked) setIsExpanded(false);
  }, [ownerLocked]);

  // Autofocus when modal expands
  useEffect(() => {
    if (isExpanded && editor) {
      setTimeout(() => {
        editor.commands.focus('end');
      }, 50);
    }
  }, [isExpanded, editor]);

  const handleRawChange = (e) => {
    setRawMarkdown(e.target.value);
  };

  // Drag & drop of text / markdown files: read each file and append its
  // content to the draft. Works on the compact bar too (dropping expands
  // the composer). Non-text files are ignored.
  const handleFileDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = [...(e.dataTransfer?.files || [])].filter(f =>
      /\.(md|markdown|txt)$/i.test(f.name) || (f.type && f.type.startsWith('text/')));
    if (files.length === 0) return;
    let dropped = '';
    for (const f of files) {
      try { dropped += (dropped ? '\n\n' : '') + await f.text(); }
      catch { /* unreadable file — skip */ }
    }
    if (!dropped.trim()) return;
    const current = isRawView ? rawMarkdown : (editor?.getMarkdown() || '');
    const next = current.trim() ? current + '\n\n' + dropped : dropped;
    if (next.length > 15000) {
      alert('Dropped content would exceed the 15 KB message limit.');
      return;
    }
    setRawMarkdown(next);
    editor?.commands.setContent(next, { contentType: 'markdown' });
    setIsExpanded(true);
  };
  const handleDragOver = (e) => { e.preventDefault(); };

  const handleToggleRaw = (checked) => {
    if (checked) {
      setRawMarkdown(editor?.getMarkdown() || '');
    } else {
      editor?.commands.setContent(rawMarkdown, { contentType: 'markdown' });
    }
    setIsRawView(checked);
  };

  const handleSend = async () => {
    if (!editor) return;
    const textToSend = isRawView ? rawMarkdown : editor.getMarkdown();
    const plainText = textToSend.trim();
    if (!plainText) return;

    // Enforce 15 KB limit (approx characters)
    if (textToSend.length > 15000) {
      alert('Message exceeds 15 KB limit. Please shorten it.');
      return;
    }
    if (declaration === 'unstated') {
      alert('Please declare yourself as Human or Agent before sending.');
      return;
    }

    try {
      const options = {};
      
      if (replyTarget) {
        options.replyTo = replyTarget.msgId;
      }

      if (privateReplyTarget) {
        // Alice encrypts to Bob's Author ID (privateReplyTarget.signerPubkey)
        const privateTopic = CryptoService.generatePrivateTopic();
        const privateKey = CryptoJS.lib.WordArray.random(16).toString(); // Generate AES session key
        
        options.encryptToRecipient = privateReplyTarget.signerPubkey;
        options.privateTopic = privateTopic;
        options.privateKey = privateKey;
      }

      // Publish using AxonaChatClient
      await AxonaChatClient.publish(activeTopic, textToSend, options);

      // Recall buffer: only AFTER the publish resolves, so a failed send does not
      // leave a phantom in history. Private replies are excluded inside
      // appendHistory — their plaintext must not be written to disk.
      setHistory(appendHistory(plainText, { private: !!privateReplyTarget }));
      setHistIndex(-1);
      draftRef.current = '';

      editor.commands.setContent('');
      setRawMarkdown('');
      setIsRawView(false);
      clearReplyTargets();
    } catch (err) {
      alert('Publish failed: ' + err.message);
    }
  };

  // Put `value` in the editor and remember where we are in the buffer. A null
  // resolution means "past the newest" → restore the draft we set aside.
  const applyHistory = (idx) => {
    const recalled = historyAt(history, idx);
    const value = recalled === null ? draftRef.current : recalled;
    if (isRawView) setRawMarkdown(value);
    else editor?.commands.setContent(value || '', { contentType: 'markdown' });
    setHistIndex(idx);
  };

  const navigateHistory = (dir) => {
    if (!history.length) return false;
    // First step out of the live draft: stash it so Down can bring it back.
    if (histIndex === -1) draftRef.current = isRawView ? rawMarkdown : (editor?.getMarkdown() || '');
    const next = stepHistory(histIndex, dir, history.length);
    if (next === histIndex) return true;   // already at the oldest: consume, don't wrap
    applyHistory(next);
    return true;
  };

  // Up/Down are LEGITIMATE caret movement in a multi-line markdown editor, so
  // history recall only takes over at the edge — Up on the FIRST line, Down on
  // the LAST. That is the shell convention, and it lets a recalled multi-line
  // message be edited normally: you step further back only once the caret has
  // reached the top.
  //
  // LINE, not position. The first cut compared caret position against the document
  // start (`from <= 1`), which looked equivalent and was not: after a recall the
  // caret sits at the end of the restored text, so on single-line content — the
  // common case, and the only case a terminal has — position was never 1 and Up
  // silently stopped walking after the first step. Browser-verified. Comparing
  // COORDINATES is what "at the top" actually means, and it gets soft-wrapped
  // long lines right too, which a newline count would not.
  const LINE_EPS = 4;                                   // px slack for line-box rounding
  const atEdge = (dir) => {
    if (isRawView) {
      const el = rawRef.current;
      if (!el) return true;
      const v = el.value ?? '';
      // Logical lines are the honest reading for a monospace raw pane.
      return dir === 'up' ? v.lastIndexOf('\n', el.selectionStart - 1) === -1
                          : v.indexOf('\n', el.selectionEnd) === -1;
    }
    if (!editor?.view) return false;
    try {
      const { state, view } = editor;
      const here = view.coordsAtPos(state.selection.head);
      if (dir === 'up') return here.top - view.coordsAtPos(1).top < LINE_EPS;
      const endPos = Math.max(1, state.doc.content.size - 1);
      return view.coordsAtPos(endPos).bottom - here.bottom < LINE_EPS;
    } catch {
      return false;   // coordsAtPos can throw on a detached view — never hijack the key then
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
      setIsExpanded(false);
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    // Leave modified arrows alone — those are select-to-line, word jumps, and
    // OS-level shortcuts, none of which should mean "recall a message".
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    const dir = e.key === 'ArrowUp' ? 'up' : 'down';
    if (!atEdge(dir)) return;                // caret has somewhere to go: let it
    if (navigateHistory(dir)) e.preventDefault();
  };

  // Helper to apply inline marks (Bold, Italic)
  const applyInlineCommand = (command) => {
    if (!editor) return;
    command();
  };

  // Helper to apply block-level nodes (Headings, Quote, CodeBlock)
  const applyBlockCommand = (type, attrs = {}) => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    
    if (from === to) {
      // Toggle formatting on the current cursor position block
      if (type === 'heading') {
        editor.chain().focus().toggleHeading(attrs).run();
      } else if (type === 'blockquote') {
        editor.chain().focus().toggleBlockquote().run();
      } else if (type === 'codeBlock') {
        editor.chain().focus().toggleCodeBlock().run();
      } else if (type === 'bulletList') {
        editor.chain().focus().toggleBulletList().run();
      } else if (type === 'orderedList') {
        editor.chain().focus().toggleOrderedList().run();
      }
      return;
    }

    // Split block at selection to format ONLY the selected text
    const selectedText = editor.state.doc.textBetween(from, to, ' ');
    if (type === 'heading') {
      editor.chain()
        .focus()
        .deleteSelection()
        .insertContent({ type: 'heading', attrs, content: [{ type: 'text', text: selectedText }] })
        .run();
    } else if (type === 'blockquote') {
      editor.chain()
        .focus()
        .deleteSelection()
        .insertContent({ type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: selectedText }] }] })
        .run();
    } else if (type === 'codeBlock') {
      editor.chain()
        .focus()
        .deleteSelection()
        .insertContent({ type: 'codeBlock', content: [{ type: 'text', text: selectedText }] })
        .run();
    } else {
      // Fallback for list types
      if (type === 'bulletList') {
        editor.chain().focus().toggleBulletList().run();
      } else if (type === 'orderedList') {
        editor.chain().focus().toggleOrderedList().run();
      }
    }
  };

  return (
    <>
      {/* Collapsed Compact Preview Bar */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.4rem',
        background: 'var(--color-surface)',
        padding: '0.6rem 1.2rem',
        borderTop: '1px solid var(--border-color)',
        position: 'relative'
      }}>
        {/* Target status bar (Reply / Private Reply Indicator) */}
        {(replyTarget || privateReplyTarget) && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: privateReplyTarget ? 'var(--color-success-bg)' : 'rgba(52, 152, 219, 0.08)',
            borderLeft: privateReplyTarget ? '3px solid var(--color-success)' : '3px solid #3498db',
            padding: '0.35rem 0.6rem',
            borderRadius: '4px',
            fontSize: '0.75rem',
            marginBottom: '0.4rem'
          }}>
            <div>
              {replyTarget && (
                <span>Replying to <b>{replyTarget.message?.handle || 'Anonymous'}</b>: "{replyTarget.message?.text?.slice(0, 30)}..."</span>
              )}
              {privateReplyTarget && (
                <span style={{ color: '#2ecc71' }}>
                  🔒 <b>Private Reply</b> to {privateReplyTarget.message?.handle || 'Anonymous'} (ciphertext only readable by them)
                </span>
              )}
            </div>
            <button 
              onClick={clearReplyTargets}
              style={{ background: 'transparent', border: 'none', color: 'var(--color-muted)', cursor: 'pointer', fontSize: '0.8rem' }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Fake input + "posting as" chip in one row. The chip is the
            you-appear-as-X-in-this-browser indicator: per-browser identity is
            by design, so a stale handle in one browser must be noticed where
            the user is about to post, not discovered later on the wire. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
          <div
            onClick={ownerLocked ? undefined : () => setIsExpanded(true)}
            onDragOver={ownerLocked ? undefined : handleDragOver}
            onDrop={ownerLocked ? undefined : handleFileDrop}
            title={ownerLocked ? 'Only this topic’s owner can publish here' : undefined}
            style={{
              flex: 1,
              minWidth: 0,
              padding: '0.55rem 0.8rem',
              background: 'var(--color-surface)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius)',
              cursor: ownerLocked ? 'not-allowed' : 'pointer',
              opacity: ownerLocked ? 0.75 : 1,
              minHeight: '38px',
              display: 'flex',
              alignItems: 'center',
              color: 'var(--color-muted)',
              fontSize: '0.85rem',
              transition: 'border-color 0.2s',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis'
            }}
            onMouseEnter={ownerLocked ? undefined : (e) => e.currentTarget.style.borderColor = 'var(--color-primary)'}
            onMouseLeave={ownerLocked ? undefined : (e) => e.currentTarget.style.borderColor = 'var(--border-color)'}
          >
            {ownerLocked
              ? <span>🔒 Controlled topic — posting is not enabled.</span>
              : editor && editor.getText().trim()
                ? <span style={{ color: 'var(--color-text)' }}>{editor.getText().slice(0, 100)}...</span>
                : <span>Type a message... (Click to open markdown formatting composer)</span>
            }
          </div>
          {!ownerLocked && activeHandle && (
            <button
              onClick={() => onOpenModal?.('handles')}
              title={`You appear as “${activeHandle.name}” in this browser — every message you send here is signed and shown under this name. Click to switch or manage personas.`}
              style={{
                flexShrink: 1,
                minWidth: 0,
                maxWidth: '38%',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                padding: '0.35rem 0.7rem',
                fontSize: '0.75rem',
                background: 'var(--color-bg)',
                border: '1px solid var(--border-color)',
                borderRadius: '999px',
                cursor: 'pointer',
                color: 'var(--color-muted)',
                whiteSpace: 'nowrap',
                overflow: 'hidden'
              }}
            >
              as {declaration === 'agent' ? '🤖' : '🙋'}
              <span style={{
                fontWeight: '700',
                color: 'var(--color-text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}>
                {activeHandle.name}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Expanded Modal Overlay */}
      {isExpanded && (
        <div 
          onClick={() => setIsExpanded(false)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.65)',
            backdropFilter: 'blur(4px)',
            zIndex: 100,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            animation: 'fadeIn 0.2s ease-out'
          }}
        >
          <div 
            onClick={(e) => e.stopPropagation()} // Prevent close on click inside
            onKeyDown={handleKeyDown}
            className="glass"
            style={{
              width: '80%',
              maxWidth: '850px',
              height: '75%',
              maxHeight: '650px',
              background: 'var(--color-surface)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius)',
              boxShadow: '0 24px 64px rgba(0, 0, 0, 0.3)',
              display: 'flex',
              flexDirection: 'column',
              padding: '1.25rem',
              gap: '0.8rem',
              animation: 'rise 0.25s ease-out'
            }}
          >
            {/* Header: Title and Collapse/Close Button */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
              <span style={{ fontWeight: 'bold', fontSize: '0.95rem', color: 'var(--color-primary)' }}>
                Composer Editor — Rich Markdown
              </span>
              <button 
                onClick={() => setIsExpanded(false)}
                style={{ 
                  background: 'var(--color-bg)', 
                  border: '1px solid var(--border-color)', 
                  color: 'var(--color-text)', 
                  cursor: 'pointer', 
                  fontSize: '0.75rem',
                  padding: '4px 8px',
                  borderRadius: '4px'
                }}
              >
                Collapse To Draft ✕
              </button>
            </div>

            {/* Target status bar (Reply / Private Reply Indicator) */}
            {(replyTarget || privateReplyTarget) && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: privateReplyTarget ? 'var(--color-success-bg)' : 'rgba(52, 152, 219, 0.08)',
                borderLeft: privateReplyTarget ? '3px solid var(--color-success)' : '3px solid #3498db',
                padding: '0.35rem 0.6rem',
                borderRadius: '4px',
                fontSize: '0.75rem'
              }}>
                <div>
                  {replyTarget && (
                    <span>Replying to <b>{replyTarget.message?.handle || 'Anonymous'}</b>: "{replyTarget.message?.text?.slice(0, 30)}..."</span>
                  )}
                  {privateReplyTarget && (
                    <span style={{ color: '#2ecc71' }}>
                      🔒 <b>Private Reply</b> to {privateReplyTarget.message?.handle || 'Anonymous'} (ciphertext only readable by them)
                    </span>
                  )}
                </div>
                <button 
                  onClick={clearReplyTargets}
                  style={{ background: 'transparent', border: 'none', color: 'var(--color-muted)', cursor: 'pointer', fontSize: '0.8rem' }}
                >
                  ✕
                </button>
              </div>
            )}

            {/* Toolbar Buttons */}
            <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.4rem', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
              <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                {!isRawView && (
                  <>
                    <ToolbarButton 
                      label="B" 
                      active={editor?.isActive('bold')} 
                      onClick={() => applyInlineCommand(() => editor.chain().focus().toggleBold().run())} 
                    />
                    <ToolbarButton 
                      label="I" 
                      active={editor?.isActive('italic')} 
                      onClick={() => applyInlineCommand(() => editor.chain().focus().toggleItalic().run())} 
                    />
                    <ToolbarButton 
                      label="H1" 
                      active={editor?.isActive('heading', { level: 1 })} 
                      onClick={() => applyBlockCommand('heading', { level: 1 })} 
                    />
                    <ToolbarButton 
                      label="H2" 
                      active={editor?.isActive('heading', { level: 2 })} 
                      onClick={() => applyBlockCommand('heading', { level: 2 })} 
                    />
                    <ToolbarButton 
                      label="•" 
                      active={editor?.isActive('bulletList')} 
                      onClick={() => applyBlockCommand('bulletList')} 
                    />
                    <ToolbarButton 
                      label="1." 
                      active={editor?.isActive('orderedList')} 
                      onClick={() => applyBlockCommand('orderedList')} 
                    />
                    <ToolbarButton 
                      label="Quote" 
                      active={editor?.isActive('blockquote')} 
                      onClick={() => applyBlockCommand('blockquote')} 
                    />
                    <ToolbarButton 
                      label="Code Block" 
                      active={editor?.isActive('codeBlock')} 
                      onClick={() => applyBlockCommand('codeBlock')} 
                    />
                  </>
                )}
              </div>

              {/* Raw View Toggle */}
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem', color: 'var(--color-muted)', cursor: 'pointer', userSelect: 'none' }}>
                <input 
                  type="checkbox" 
                  checked={isRawView} 
                  onChange={(e) => handleToggleRaw(e.target.checked)} 
                  style={{ cursor: 'pointer' }}
                />
                💻 Raw Markdown
              </label>
            </div>

            {/* Editor Content Area — accepts dropped .md / .txt files */}
            <div
              onDragOver={handleDragOver}
              onDrop={handleFileDrop}
              style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
            >
              {isRawView ? (
                <textarea
                  ref={rawRef}
                  value={rawMarkdown}
                  onChange={handleRawChange}
                  placeholder="Type raw markdown..."
                  style={{
                    flex: 1,
                    background: 'var(--color-bg)',
                    color: 'var(--color-text)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius)',
                    padding: '0.75rem',
                    fontFamily: 'Courier New, Courier, monospace',
                    fontSize: '0.85rem',
                    resize: 'none',
                    outline: 'none'
                  }}
                />
              ) : (
                <EditorContent 
                  editor={editor} 
                  style={{ 
                    flex: 1, 
                    display: 'flex', 
                    flexDirection: 'column' 
                  }} 
                />
              )}
            </div>

            {/* Bottom Actions Bar */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '0.6rem' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                <span
                  title="Every message you send here is signed and shown under this persona"
                  style={{ fontSize: '0.72rem', color: 'var(--color-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  Sending as {declaration === 'agent' ? '🤖' : '🙋'} <b style={{ color: 'var(--color-text)' }}>{activeHandle?.name || '(no persona)'}</b>
                </span>
                <span style={{ fontSize: '0.72rem', color: 'var(--color-muted)' }}>
                  Tip: <b>Ctrl + Enter</b> to send | <b>↑ / ↓</b> recalls messages you sent | Max size: 15 KB
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
                <button
                  onClick={() => setIsExpanded(false)}
                  title="Close the editor without sending — your draft is kept and reopens where you left off"
                  style={{
                    padding: '0.4rem 1rem',
                    background: 'rgba(255,255,255,0.04)',
                    color: 'var(--color-text)',
                    fontWeight: '600',
                    borderRadius: 'var(--radius)',
                    border: 'none',
                    cursor: 'pointer'
                  }}
                >
                  Draft
                </button>
                <button
                  title="Publish your message to this topic (Ctrl+Enter)"
                  onClick={async () => {
                    await handleSend();
                    setIsExpanded(false); // Auto collapse after send
                  }}
                  style={{
                    padding: '0.4rem 1.2rem',
                    background: 'var(--color-primary)',
                    color: '#fff',
                    fontWeight: '600',
                    borderRadius: 'var(--radius)',
                    border: 'none',
                    cursor: 'pointer'
                  }}
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default Composer;
