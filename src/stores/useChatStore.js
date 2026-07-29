import { create } from 'zustand';

// Helper to compute stable IDs for topics.
// write defaults to 'open' to MATCH THE KERNEL: deriveTopicId treats a
// missing write policy as 'open', so {name:'lobby'} and {name:'lobby',
// write:'open'} are the same topic on the network and must be the same
// row here (an ad carries write explicitly; the defaults omit it).
export const getTopicId = (descriptor) => {
  if (!descriptor) return '';
  const region = descriptor.region || 'global';
  const owner = descriptor.owner || '';
  const name = descriptor.name || '';
  const write = descriptor.write || 'open';
  return `${region}:${owner}:${name}:${write}`;
};

// Subscribed topics persist locally so a returning user's full list is
// resurrected on rejoin. Descriptors are plain JSON (including any private
// channel's local key — consistent with handles' keys living in local
// storage). Falls back to the four default rooms on first run.
const AXONA_TOPIC = { region: 'eagle', name: 'axona', description: 'talk to us' };
const DEFAULT_TOPICS = [
  AXONA_TOPIC,
  { region: 'eagle', name: 'lobby', description: 'Public lobby for everyone' },
  { region: 'eagle', name: 'tech', description: 'Tech discussions' },
  { region: 'eagle', name: 'general', description: 'General chat' }
];

const loadPersistedTopics = () => {
  try {
    const raw = localStorage.getItem('axona-topics');
    const parsed = raw ? JSON.parse(raw) : null;
    let parsedDeduped = parsed;
    if (Array.isArray(parsed)) {
      // Heal duplicates persisted before write-policy normalization
      // (same kernel topic under two descriptor spellings).
      const seen = new Set();
      parsedDeduped = parsed.filter(t => {
        const id = getTopicId(t);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (parsedDeduped.length !== parsed.length) persistTopics(parsedDeduped);
    }
    if (Array.isArray(parsedDeduped) && parsedDeduped.length > 0 && parsedDeduped.every(t => t && t.name)) {
      // One-time seed: existing users get the axona topic prepended once.
      // The flag keeps a deliberate unsubscribe from being re-added.
      if (!localStorage.getItem('axona-topic-seeded')) {
        localStorage.setItem('axona-topic-seeded', '1');
        if (!parsedDeduped.some(t => getTopicId(t) === getTopicId(AXONA_TOPIC))) {
          const seeded = [AXONA_TOPIC, ...parsedDeduped];
          persistTopics(seeded);
          return seeded;
        }
      }
      return parsedDeduped;
    }
  } catch { /* corrupted or unavailable storage → defaults */ }
  try { localStorage.setItem('axona-topic-seeded', '1'); } catch { /* ignore */ }
  return DEFAULT_TOPICS;
};

const persistTopics = (topics) => {
  try {
    localStorage.setItem('axona-topics', JSON.stringify(topics));
  } catch { /* private mode — in-memory only */ }
};

// Last-read watermarks: topicId -> newest envelope ts the user has SEEN.
// Persisted so a returning session counts replayed history it never displayed
// as unread, rather than everything or nothing.
const loadLastRead = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem('axona-last-read') || '{}');
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch { return {}; }
};
const persistLastRead = (map) => {
  try { localStorage.setItem('axona-last-read', JSON.stringify(map)); } catch { /* */ }
};

// Last channel the user was reading. Restored on load so a returning session
// opens where it left off instead of always at #lobby.
//
// The stored topic is VALIDATED against the subscribed list rather than
// trusted. A topic the user has since left would otherwise reopen as a
// channel that is not in the sidebar — visible, unleaveable, and receiving
// nothing, because nothing subscribed it. Falling back to the default is the
// only safe reading of a stale pointer.
const DEFAULT_TOPIC = { region: 'eagle', name: 'lobby' };

export const loadLastTopic = (subscribed) => {
  try {
    const raw = localStorage.getItem('axona-last-topic');
    if (!raw) return DEFAULT_TOPIC;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || !saved.name) return DEFAULT_TOPIC;
    const savedId = getTopicId(saved);
    // Compare by derived id, not by name: owner and write policy fold into the
    // id, so two topics can share a name and be different channels.
    return subscribed.some(t => getTopicId(t) === savedId) ? saved : DEFAULT_TOPIC;
  } catch { return DEFAULT_TOPIC; }
};

const persistLastTopic = (topic) => {
  try { localStorage.setItem('axona-last-topic', JSON.stringify(topic)); } catch { /* */ }
};

// A message counts toward unread if it's not the user's own and was published
// after the watermark. Envelope ts is publish time, so replayed history older
// than the watermark stays read. Author-class is provenance, NOT a read gate —
// undeclared messages are shown (unbadged) and so also count as unread.
export const countUnread = (state, topicId) => {
  const mark = state.lastRead[topicId] || 0;
  const own = state.currentHandle?.authorId;
  return (state.messages[topicId] || []).filter(m =>
    m.ts > mark &&
    m.signerPubkey !== own
  ).length;
};

export const useChatStore = create((set, get) => {
  // Resolved once, in order: the topic list must exist before the last-open
  // topic can be validated against it.
  const initialTopics = loadPersistedTopics();
  const initialTopic  = loadLastTopic(initialTopics);

  return {
  // Active states
  activeTopic: initialTopic,
  activeTopicId: getTopicId(initialTopic),

  // Channels/Topics list
  subscribedTopics: initialTopics,

  // Ticker (advertised topics)
  tickerVisible: true,
  advertisedTopics: [], // list of topic.ad payloads

  // Messages: map of topicId -> array of envelopes
  messages: {},

  // Unread tracking: topicId -> ts of the newest message the user has seen
  lastRead: loadLastRead(),

  // Moderation: queue for channel owners
  // Map of outputTopicId -> array of raw channel envelopes awaiting approval
  moderationQueue: {},

  // Private continuations: map of partnerAuthorId -> { topic, key, messages: [] }
  privateConversations: {},

  // Presence: map of authorId -> { handle, declaration, lastSeen }
  presence: {},
  topicMetrics: {},

  // Author-class cache: signerPubkey (Author ID) -> resolved, VERIFIED class from
  // the kernel's signed attestation (peer.getAuthorClass), NOT the in-body string.
  // Shape: { class:'human'|'agent'|'service'|'bridge'|'relay'|'unstated'|'pending',
  //          operatorVerified, label }. Absence/'unstated' renders UNBADGED, never
  //          hidden (§6.5) — author-class is provenance, not a gate.
  authorClasses: {},

  // Active handle and declaration (mirrored from HandleContext for easy store access)
  currentHandle: null,
  currentDeclaration: 'human',
  theme: (() => {
    try {
      return localStorage.getItem('axona-theme') || 'light';
    } catch {
      return 'light';
    }
  })(),

  // Actions
  updateTopicMetrics: (storeId, metrics) => set((state) => ({
    topicMetrics: {
      ...state.topicMetrics,
      [storeId]: metrics
    }
  })),
  toggleTheme: () => set((state) => {
    const nextTheme = state.theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem('axona-theme', nextTheme);
    } catch (e) {
      console.warn('Failed to persist theme:', e);
    }
    document.body.className = nextTheme + '-theme';
    return { theme: nextTheme };
  }),

  setActiveTopic: async (topic) => {
    // Topic can be a descriptor
    const id = getTopicId(topic);
    set({ activeTopic: topic, activeTopicId: id });
    persistLastTopic(topic);
    get().markTopicRead(id);
  },

  // Advance the topic's watermark to its newest message ts (the user has now
  // seen everything displayed). Newest-message ts, NOT Date.now(): replay can
  // deliver old-ts history late, and a wall-clock watermark would mark those
  // never-displayed messages read.
  markTopicRead: (topicId) => {
    set(state => {
      const msgs = state.messages[topicId] || [];
      const newest = msgs.reduce((mx, m) => (m.ts > mx ? m.ts : mx), 0);
      const mark = newest || Date.now();
      if ((state.lastRead[topicId] || 0) >= mark) return {};
      const lastRead = { ...state.lastRead, [topicId]: mark };
      persistLastRead(lastRead);
      return { lastRead };
    });
  },

  setSubscribedTopics: (topics) => {
    persistTopics(topics);
    set({ subscribedTopics: topics });
  },

  addTopic: (topic) => {
    const exists = get().subscribedTopics.some(t => getTopicId(t) === getTopicId(topic));
    if (!exists) {
      const next = [...get().subscribedTopics, topic];
      persistTopics(next);
      set({ subscribedTopics: next });
    }
  },

  renameTopicLabel: (topic, nextLabel) => set((state) => {
    const updated = state.subscribedTopics.map(t => {
      if (getTopicId(t) === getTopicId(topic)) {
        return {
          ...t,
          description: `Private chat with ${nextLabel}`
        };
      }
      return t;
    });
    persistTopics(updated);
    return { subscribedTopics: updated };
  }),

  removeTopic: (topic) => {
    set(state => {
      const next = state.subscribedTopics.filter(t => getTopicId(t) !== getTopicId(topic));
      persistTopics(next);
      return { subscribedTopics: next };
    });
  },

  setTickerVisible: (visible) => set({ tickerVisible: visible }),

  addAdvertisement: (ad) => {
    // ad = { name, blurb, topicId, network, region, mode, postedAt }
    // Sunset policy: spaced topic names break plain-text links and are
    // deprecated — drop their ads at ingest so neither the ticker nor the
    // browse panel resurfaces them. (Ads can't be retracted by anyone but
    // their signer; this is the app-side lever.)
    if (/\s/.test(ad?.name || '')) return;
    set(state => {
      const filtered = state.advertisedTopics.filter(item => item.topicId !== ad.topicId);
      return { advertisedTopics: [...filtered, ad] };
    });
  },

  // A retracted ad's deletion marker arrives with the ad's msgId.
  removeAdvertisement: (msgId) => {
    set(state => ({
      advertisedTopics: state.advertisedTopics.filter(item => item.msgId !== msgId)
    }));
  },

  addEnvelope: (topicId, envelope) => {
    set(state => {
      const topicMsgs = state.messages[topicId] || [];
      // Prevent duplicates
      if (topicMsgs.some(m => m.msgId === envelope.msgId)) return {};
      const next = {
        messages: {
          ...state.messages,
          [topicId]: [...topicMsgs, envelope]
        }
      };
      // A message arriving on the topic the user is LOOKING AT is read on
      // arrival — but only if the tab is actually visible; otherwise it stays
      // unread until they come back (MessagePane marks read on re-focus).
      const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
      if (topicId === state.activeTopicId && visible && envelope.ts > (state.lastRead[topicId] || 0)) {
        next.lastRead = { ...state.lastRead, [topicId]: envelope.ts };
        persistLastRead(next.lastRead);
      }
      return next;
    });
  },

  killMessage: (topicId, msgId) => {
    set(state => {
      const topicMsgs = state.messages[topicId] || [];
      return {
        messages: {
          ...state.messages,
          [topicId]: topicMsgs.filter(m => m.msgId !== msgId)
        }
      };
    });
  },

  addToModerationQueue: (outputTopicId, envelope) => {
    set(state => {
      const queue = state.moderationQueue[outputTopicId] || [];
      if (queue.some(m => m.msgId === envelope.msgId)) return {};
      return {
        moderationQueue: {
          ...state.moderationQueue,
          [outputTopicId]: [...queue, envelope]
        }
      };
    });
  },

  removeFromModerationQueue: (outputTopicId, msgId) => {
    set(state => {
      const queue = state.moderationQueue[outputTopicId] || [];
      return {
        moderationQueue: {
          ...state.moderationQueue,
          [outputTopicId]: queue.filter(m => m.msgId !== msgId)
        }
      };
    });
  },

  updatePresence: (authorId, data) => {
    set(state => {
      const prev = state.presence[authorId];
      // Publish-time recency (data.lastSeen = envelope.ts) — never let a
      // replayed older heartbeat roll a fresher sighting backwards.
      const lastSeen = data.lastSeen ?? Date.now();
      if (prev && prev.lastSeen > lastSeen) return {};
      return {
        presence: {
          ...state.presence,
          [authorId]: {
            ...prev,
            ...data,
            lastSeen
          }
        }
      };
    });
  },

  // Record the resolved, verified author-class for a signer. Called by
  // AxonaChatClient.resolveAuthorClass after a peer.getAuthorClass() pull.
  setAuthorClassResolved: (signer, info) => {
    if (!signer) return;
    set(state => ({
      authorClasses: { ...state.authorClasses, [signer]: info }
    }));
  },

  addPrivateConversation: (partnerId, topic, key) => {
    set(state => ({
      privateConversations: {
        ...state.privateConversations,
        [partnerId]: { topic, key, messages: [] }
      }
    }));
  },

  addPrivateMessage: (partnerId, msg) => {
    set(state => {
      const conv = state.privateConversations[partnerId];
      if (!conv) return {};
      return {
        privateConversations: {
          ...state.privateConversations,
          [partnerId]: {
            ...conv,
            messages: [...conv.messages, msg]
          }
        }
      };
    });
  }
  };
});

// Dev builds only: expose the store so layout/regression checks can inject
// synthetic envelopes from the console without a live network.
// `typeof window` guard, not just the DEV flag: DEV is also true under vitest,
// which runs in Node where `window` does not exist — without this the whole
// module throws on import and any test that touches the store collects zero
// tests, which reads as "no tests here" rather than "the import failed".
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.useChatStore = useChatStore;
}
