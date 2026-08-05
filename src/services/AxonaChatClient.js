import { deriveTopicId, createAuthorIdentity, metricTopic } from '@axona/protocol';
import { makeMessage } from '@axona/protocol/std/message.js';
import { useChatStore } from '../stores/useChatStore.js';
import CryptoService from './CryptoService.js';
// write defaults to 'open' to match the kernel's deriveTopicId — a
// descriptor with and without an explicit write:'open' is the same topic
// and must map to the same store id (must stay in sync with the copy in
// useChatStore.js).
const getTopicId = (descriptor) => {
  if (!descriptor) return '';
  const region = descriptor.region || 'global';
  const owner = descriptor.owner || '';
  const name = descriptor.name || '';
  const write = descriptor.write || 'open';
  return `${region}:${owner}:${name}:${write}`;
};

class AxonaChatClient {
  constructor() {
    this.peer = null;
    this.activeSubscriptions = new Map(); // topicId -> sub handle
    this.presenceInterval = null;
    this.heartbeatTopic = { region: 'eagle', name: 'axona-presence-heartbeats' };
    this.tickerTopic = { region: 'eagle', name: 'advertised-topics' };
    this._authorClassInflight = new Set(); // signers with a getAuthorClass pull in flight
    this._declaredKey = null;              // `${authorId}:${class}` last published, to avoid re-declaring
    this._peerGen = 0;                     // bumped on every peer replacement
    this._seated = Promise.resolve();      // resolves when the current peer's SUBs are seated
    this._seatedTopicIds = new Set();      // topicIds POSITIVELY seated on the current peer
    this._topicKeyByHex = new Map();       // protocol hex id -> store key, so a
                                           // stopped subscription can find the
                                           // seating entry it must retire
  }

  setPeer(peer) {
    // Idempotent for the same peer object. PeerContext calls this on connect
    // and ChatShell's [peer] effect calls it again with the IDENTICAL object.
    // The generation is unchanged, so nothing is cleared — but each call used
    // to start its own reconcileSubscriptions(), and two concurrent
    // reconciliations both observe an empty map while peer.sub is awaiting.
    // Both then subscribe: the map keeps the last handle and the other
    // callback stays live and unreferenced, delivering duplicates forever.
    // Coalesce onto the in-flight seating instead of racing a second one
    // (Aster, CHANGES-REQUIRED 6af3ed6).
    if (this.peer === peer) return this._seated;
    // Peer replacement invalidates every subscription handle — each belongs
    // to the OLD peer's session. Stop and clear them so reconcile re-issues
    // every SUB on the new peer, instead of skipping topics that look
    // already-subscribed but are wired to a dead session. Without this, a
    // recovered session held a map full of dead handles, received no topic
    // traffic, and could never see the echo that confirms a replayed send
    // (Aster, CHANGES-REQUIRED f0a9f88).
    {
      // Clearing the map is not enough on its own. subscribeTo() awaits
      // peer.sub() and then writes the handle; a call that started under the
      // OLD peer can resolve after this clear and insert a dead handle back
      // into the live map — even overwriting the new peer's handle for the
      // same topic — and the next reconcile then treats that topic as seated.
      // The generation counter is what makes a late arrival identifiable
      // (Aster, CHANGES-REQUIRED 8d37e65). Native sub() has several awaited
      // setup steps, so the window is real, not theoretical.
      this._peerGen++;
      for (const [, sub] of this.activeSubscriptions) {
        try { sub.stop?.(); } catch { /* the old session may be half-dead */ }
      }
      this.activeSubscriptions.clear();
      this._seatedTopicIds.clear();   // seating is per-session, like the handles
      this._topicKeyByHex.clear();
    }
    this.peer = peer;
    if (peer) {
      // Re-seating is OBSERVABLE. Recovery must not replay a pending send
      // before the new session's subscription callbacks are registered: the
      // replayed publish would go out with nobody listening for its echo, and
      // on a live-tail subscription that echo never comes again — the send
      // stays pending forever despite having been delivered.
      //
      // The catch keeps a seating failure from becoming an unhandled
      // rejection, and DELIBERATELY does not launder it into success: what
      // counts as seated is _seatedTopicIds, which only a subscription that
      // actually returned a handle can enter. Resolving this promise has never
      // meant "everything seated" — replay asks the set, per topic.
      this._seated = this.reconcileSubscriptions()
        .catch((e) => { console.error('Subscription re-seating failed:', e); });
      this.startPresenceHeartbeat();
    } else {
      this._seated = Promise.resolve();
      this._seatedTopicIds.clear();
      this._topicKeyByHex.clear();
      this.stopPresenceHeartbeat();
    }
    return this._seated;
  }

  // Await the current peer's subscription re-seating. Callers that publish
  // and expect to observe their own echo (replay) must await this first.
  whenSeated() { return this._seated; }

  async getActiveAuthor() {
    if (!this.peer) throw new Error('Peer not connected.');
    const store = useChatStore.getState();
    const handle = store.currentHandle;
    if (!handle) {
      throw new Error('No active handle selected.');
    }
    return await createAuthorIdentity({ persistAs: handle.authorRef });
  }

  // The protocol topic id IS the identity — an invalid descriptor must fail
  // loudly, never be silently replaced by a made-up local id (which would
  // diverge this client's bookkeeping from every other peer on the topic).
  async getTopicHexId(descriptor) {
    return await deriveTopicId(descriptor);
  }

  // Resolve a sender's VERIFIED author-class from its Author ID (signerPubkey),
  // the interoperable kernel mechanism — a signed attestation on the author's
  // owner-only profile topic, pulled + verified by peer.getAuthorClass(). This is
  // the source of truth for the HUMAN/AGENT badge, NOT the spoofable in-body
  // `authorClass` string any publisher could type. Cached per signer in the store
  // (one pull per author per session); result is fire-and-forget — the badge
  // paints when it lands. Absence/failure resolves to 'unstated' (unbadged, shown).
  async resolveAuthorClass(signer) {
    if (!this.peer || !signer || typeof signer !== 'string' || signer.length !== 64) return;
    const store = useChatStore.getState();
    if (store.authorClasses[signer] || this._authorClassInflight.has(signer)) return;
    this._authorClassInflight.add(signer);
    store.setAuthorClassResolved(signer, { class: 'pending' });
    try {
      const info = await this.peer.getAuthorClass(signer, { timeoutMs: 4000 });
      useChatStore.getState().setAuthorClassResolved(signer, info || { class: 'unstated' });
    } catch {
      useChatStore.getState().setAuthorClassResolved(signer, { class: 'unstated' });
    } finally {
      this._authorClassInflight.delete(signer);
    }
  }

  // Publish OUR author-class as a signed attestation so any app (Axona Minimal,
  // other chat clients) can resolve it via getAuthorClass — the symmetric half of
  // resolveAuthorClass. Only 'human'/'agent' are declarable here; 'unstated' means
  // "don't declare" (the kernel treats absence as unstated — never a default).
  // Idempotent: re-declares only when the active author or class actually changes.
  async declareAuthorClass() {
    if (!this.peer) return;
    const store = useChatStore.getState();
    const handle = store.currentHandle;
    const cls = store.currentDeclaration;
    if (!handle || (cls !== 'human' && cls !== 'agent')) return;
    const key = `${handle.authorId}:${cls}`;
    if (this._declaredKey === key) return;
    try {
      const author = await this.getActiveAuthor();
      await this.peer.setAuthorClass(cls, { signWith: author });
      this._declaredKey = key;
    } catch (e) {
      console.warn('declareAuthorClass failed (will retry on next change):', e?.message || e);
    }
  }

  /**
   * Sync subscriptions with the subscribed topics list from the store.
   */
  async reconcileSubscriptions() {
    if (!this.peer) return;

    const store = useChatStore.getState();
    const topics = store.subscribedTopics;

    // Build set of expected topic IDs
    const expectedIds = new Set();
    const idToTopic = new Map();

    // Add normal channels
    for (const t of topics) {
      let id;
      try {
        id = await this.getTopicHexId(t);
      } catch (e) {
        console.error('Skipping invalid topic descriptor:', t, e);
        continue;
      }
      expectedIds.add(id);
      idToTopic.set(id, t);

      // If it is moderated and we are the owner, we also subscribe to the raw channel
      const isOwner = store.currentHandle && t.owner === store.currentHandle.authorId;
      if (t.mode === 'moderated' && isOwner) {
        const rawTopic = { region: t.region, name: t.name + ':raw', write: 'open' };
        const rawId = await this.getTopicHexId(rawTopic);
        expectedIds.add(rawId);
        idToTopic.set(rawId, rawTopic);
      }
    }

    // Add Ticker topic (always subscribed to in background)
    const tickerId = await this.getTopicHexId(this.tickerTopic);
    expectedIds.add(tickerId);
    idToTopic.set(tickerId, this.tickerTopic);

    // Add presence heartbeat topic
    const presenceId = await this.getTopicHexId(this.heartbeatTopic);
    expectedIds.add(presenceId);
    idToTopic.set(presenceId, this.heartbeatTopic);

    // Unsubscribe from removed topics
    for (const [id, sub] of this.activeSubscriptions.entries()) {
      const isMetrics = id.startsWith('metrics-');
      const baseId = isMetrics ? id.replace('metrics-', '') : id;
      if (!expectedIds.has(baseId)) {
        sub.stop();
        this.activeSubscriptions.delete(id);
        // Seating dies with the handle. Leaving the entry behind would let a
        // LATER pending send replay against a topic with no live callback —
        // "seated" would mean "was seated once", which is the same
        // stale-bookkeeping error as the dead-handle map (Aster, 14e949b).
        // The store key comes from _topicKeyByHex, NOT from idToTopic: a topic
        // being removed is by construction absent from the expected set, so
        // idToTopic cannot describe it.
        const goneKey = this._topicKeyByHex.get(baseId);
        if (goneKey) { this._seatedTopicIds.delete(goneKey); }
        this._topicKeyByHex.delete(id);
      }
    }

    // Subscribe to new topics. AWAITED as a set: this function's completion is
    // what whenSeated() reports, and a fire-and-forget loop would report
    // "seated" while every SUB was still in flight.
    const seating = [];
    for (const id of expectedIds) {
      if (!this.activeSubscriptions.has(id)) {
        const topic = idToTopic.get(id);
        seating.push(this.subscribeTo(id, topic));
      }
    }
    await Promise.all(seating);
  }

  async subscribeTo(topicId, descriptor) {
    // Capture BOTH the peer and the generation. Everything below must act on
    // the session that was live when this call started — reading this.peer
    // after an await can silently address a different session.
    const peer = this.peer;
    const gen = this._peerGen;
    if (!peer) return;

    try {
      const isTicker = descriptor.name === this.tickerTopic.name;
      const isPresence = descriptor.name === this.heartbeatTopic.name;

      const sub = await peer.sub(descriptor, (envelope) => {
        // Send confirmation: our own envelope arriving counts as delivered
        // ONLY while the session has peers. On a zero-peer island the local
        // node roots the topic itself and echoes the publish straight back —
        // an echo that proves nothing about the network (see pendingSends in
        // the store). With peers, the echo passed through a real root.
        if (useChatStore.getState().pendingSends[envelope.msgId]) {
          const meshPeers = this.peer?.peers ? this.peer.peers().length : 0;
          if (meshPeers > 0) useChatStore.getState().confirmSend(envelope.msgId);
        }
        if (envelope.deleted) {
          // A retracted ad must disappear from DISCOVER live on every
          // client, not linger until the ticker's hold time expires.
          if (isTicker) {
            useChatStore.getState().removeAdvertisement(envelope.msgId);
          } else {
            useChatStore.getState().killMessage(getTopicId(descriptor), envelope.msgId);
          }
          return;
        }

        const payload = envelope.message;
        const senderId = envelope.signerPubkey;

        let processedPayload = payload;
        
        // Check if this topic has a privateKey for symmetric decryption
        const topic = useChatStore.getState().subscribedTopics.find(t => getTopicId(t) === getTopicId(descriptor));
        if (topic && topic.privateKey && payload && payload.ciphertext) {
          const decrypted = CryptoService.decryptSymmetric(payload.ciphertext, topic.privateKey);
          if (decrypted) {
            processedPayload = {
              ...payload,
              isEncrypted: true,
              decryptedText: decrypted
            };
          } else {
            return; // Hide ciphertext if decryption fails
          }
        }

        // Update presence / author cache. lastSeen must come from the
        // envelope's publish timestamp — replayed history (since:'all')
        // arrives NOW but was published hours ago; stamping arrival time
        // would resurrect long-gone users as "online".
        if (processedPayload && processedPayload.authorClass) {
          useChatStore.getState().updatePresence(senderId, {
            handle: processedPayload.handle || 'Anonymous',
            declaration: processedPayload.authorClass,
            lastSeen: envelope.ts
          });
        }

        // Ticker delivery. Carry the envelope's msgId + signer with the ad:
        // retraction needs the msgId to kill and the signer to know whose
        // key may kill it — the payload alone has neither.
        if (isTicker) {
          if (processedPayload && processedPayload.type === 'topic.ad') {
            useChatStore.getState().addAdvertisement({ ...processedPayload, msgId: envelope.msgId, signer: senderId });
          }
          return;
        }

        // Presence delivery
        if (isPresence) {
          if (processedPayload && processedPayload.type === 'heartbeat') {
            useChatStore.getState().updatePresence(senderId, {
              handle: processedPayload.handle,
              declaration: processedPayload.declaration,
              lastSeen: envelope.ts
            });
          }
          return;
        }

        // Private Encrypted Reply delivery
        if (processedPayload && processedPayload.kind === 'encrypted-reply') {
          const currentHandle = useChatStore.getState().currentHandle;
          if (currentHandle) {
            const decrypted = CryptoService.decryptAsRecipient(processedPayload.ciphertext, currentHandle.authorId);
            if (decrypted) {
              const reply = JSON.parse(decrypted);
              this.resolveAuthorClass(senderId);
              // Store as decrypted message
              useChatStore.getState().addEnvelope(getTopicId(descriptor), {
                ...envelope,
                message: {
                  ...processedPayload,
                  isEncrypted: true,
                  decryptedText: reply.text,
                  privateTopic: reply.privateTopic,
                  privateKey: reply.privateKey
                }
              });

              // If a private continuation topic was handed off, subscribe to it!
              if (reply.privateTopic && reply.privateKey) {
                useChatStore.getState().addPrivateConversation(senderId, reply.privateTopic, reply.privateKey);
                this.subscribeToPrivateContinuation(reply.privateTopic, reply.privateKey, senderId);
              }
            }
          }
          return; // Hide ciphertext from others entirely
        }

        // Moderated raw submission delivery
        const isRaw = descriptor.name.endsWith(':raw');
        if (isRaw) {
          // Add to moderation queue of the output channel
          const outputName = descriptor.name.replace(':raw', '');
          const outputTopic = useChatStore.getState().subscribedTopics.find(t => t.name === outputName);
          if (outputTopic) {
            const outputStoreId = getTopicId(outputTopic);
            useChatStore.getState().addToModerationQueue(outputStoreId, {
              ...envelope,
              message: processedPayload
            });
          }
          return;
        }

        // Normal delivery. Kick off (cached) resolution of the sender's signed
        // author-class so the HUMAN/AGENT badge paints — independent of whether
        // the body happens to carry an authorClass string.
        this.resolveAuthorClass(senderId);
        useChatStore.getState().addEnvelope(getTopicId(descriptor), {
          ...envelope,
          message: processedPayload
        });
      // Presence is ephemeral — replaying up to 48h of stale heartbeats is
      // pure noise; everything else wants history.
      }, { since: isPresence ? 'latest' : 'all' });

      // The session may have been replaced while sub() was resolving. A handle
      // belonging to a dead peer must be STOPPED, never recorded: recording it
      // reinstates the exact stale-map failure the generation guard exists to
      // prevent, and can overwrite the live handle for this same topic.
      if (gen !== this._peerGen) {
        try { sub.stop?.(); } catch { /* already dead */ }
        return;
      }
      this.activeSubscriptions.set(topicId, sub);
      // POSITIVELY seated: a handle exists on the live peer for this topic.
      // Only this line may add to the set. A sub() that threw lands in the
      // catch below and adds nothing, so replay can tell "listening" from
      // "we tried" (Aster, CHANGES-REQUIRED 6af3ed6).
      //
      // Keyed by the STORE key, not by topicId. topicId here is the protocol
      // hex id; pendingSends records getTopicId(descriptor). Adding the hex id
      // made `has(rec.topicId)` false for every record, so v0.47.3 held EVERY
      // replay forever — the gate meant to protect recovery disabled it
      // instead. One canonical id on both sides, and it must be the one the
      // pending record already carries (Aster, CHANGES-REQUIRED 14e949b).
      this._seatedTopicIds.add(getTopicId(descriptor));
      this._topicKeyByHex.set(topicId, getTopicId(descriptor));

      const isSpecial = isTicker || isPresence || descriptor.name.endsWith(':raw') || descriptor.name.startsWith('axona:metric:');
      
      if (!isSpecial) {
        try {
          const hexId = await this.getTopicHexId(descriptor);
          const metricsDescriptor = metricTopic(hexId);
          const metricsSub = await peer.sub(metricsDescriptor, (env) => {
            try {
              const m = typeof env.message === 'string' ? JSON.parse(env.message) : env.message;
              if (m) {
                const storeId = getTopicId(descriptor);
                useChatStore.getState().updateTopicMetrics(storeId, {
                  current_count: m.current_count,
                  subscribers: m.subscribers,
                  bytes: m.bytes
                });
              }
            } catch (err) {
              console.error('Failed to parse metrics:', err);
            }
          }, { since: 'all' });
          if (gen !== this._peerGen) {
            try { metricsSub.stop?.(); } catch { /* already dead */ }
            return;
          }
          this.activeSubscriptions.set('metrics-' + topicId, metricsSub);
        } catch (err) {
          console.error('Failed to subscribe to metrics for ' + descriptor.name, err);
        }
      }
    } catch (e) {
      console.error(`Failed to subscribe to ${descriptor.name}:`, e);
    }
  }

  async subscribeToPrivateContinuation(topicName, key, partnerId) {
    // Same capture-and-check as subscribeTo: this path awaits sub() and writes
    // a handle, so it has the identical late-arrival hazard.
    const peer = this.peer;
    const gen = this._peerGen;
    if (!peer) return;

    const descriptor = { region: 'eagle', name: topicName, write: 'open' };
    const id = await this.getTopicHexId(descriptor);

    if (this.activeSubscriptions.has(id)) return;

    try {
      const sub = await peer.sub(descriptor, (envelope) => {
        const payload = envelope.message;
        if (payload && payload.ciphertext) {
          const decrypted = CryptoService.decryptSymmetric(payload.ciphertext, key);
          if (decrypted) {
            useChatStore.getState().addPrivateMessage(partnerId, {
              id: envelope.msgId,
              sender: payload.handle || 'Anonymous',
              text: decrypted,
              ts: envelope.ts
            });
          }
        }
      }, { since: 'all' });

      if (gen !== this._peerGen) {
        try { sub.stop?.(); } catch { /* already dead */ }
        return;
      }
      this.activeSubscriptions.set(id, sub);
    } catch (e) {
      console.error('Failed private continuation sub:', e);
    }
  }

  async publish(descriptor, text, options = {}) {
    if (!this.peer) throw new Error('Peer not connected.');

    const store = useChatStore.getState();
    const handle = store.currentHandle;
    const declaration = store.currentDeclaration;

    if (!handle) throw new Error('No active handle selected.');

    // Load active author identity
    const activeAuthor = await this.getActiveAuthor();

    let targetDescriptor = descriptor;
    let payload;

    // Check if this is a symmetrically encrypted channel
    if (descriptor.privateKey) {
      const encryptedText = CryptoService.encryptSymmetric(text, descriptor.privateKey);
      payload = {
        kind: 'encrypted-channel',
        handle: handle.name,
        authorClass: declaration,
        ciphertext: encryptedText,
        replyTo: options.replyTo || undefined
      };
    } else {
      payload = makeMessage(text, {
        handle: handle.name,
        authorClass: declaration,
        replyTo: options.replyTo || undefined
      });
    }

    // 1. Private Encrypted Reply (§9)
    if (options.encryptToRecipient) {
      const encryptedText = CryptoService.encryptToAuthor(
        JSON.stringify({
          text,
          privateTopic: options.privateTopic || undefined,
          privateKey: options.privateKey || undefined
        }),
        options.encryptToRecipient,
        handle.authorId
      );

      payload = {
        kind: 'encrypted-reply',
        handle: handle.name,
        authorClass: declaration,
        ciphertext: encryptedText,
        replyTo: options.replyTo || undefined
      };
    }

    // 2. Moderation Funnel Routing
    const isOwner = descriptor.owner === handle.authorId;
    if (descriptor.mode === 'moderated' && !isOwner) {
      // Route reply to the open raw companion channel instead
      targetDescriptor = {
        region: descriptor.region,
        name: descriptor.name + ':raw',
        write: 'open'
      };
    }

    // Publish on the protocol peer
    const msgId = await this.peer.pub(targetDescriptor, payload, { signWith: activeAuthor });

    // Record as pending until the envelope echoes back with peers>0. Store the
    // EXACT payload object and the signing handle's authorRef: a replay must
    // re-publish the same bytes under the same author, or it mints a different
    // msgId and stops being idempotent.
    const meshPeers = this.peer?.peers ? this.peer.peers().length : 0;
    useChatStore.getState().markPendingSend(msgId, {
      topicId: getTopicId(targetDescriptor),
      descriptor: targetDescriptor,
      payload,
      authorRef: handle.authorRef,
      at: Date.now(),
      island: meshPeers === 0
    });
    return msgId;
  }

  // Re-publish every unconfirmed send on the (fresh) peer. Called after a
  // session recovery: anything published while the old session sat on a
  // zero-peer island exists nowhere but the dead node's memory. Safe to call
  // repeatedly — payloads carry no timestamps, so the content-addressed msgId
  // is identical on every attempt; a message that DID land is deduped at the
  // root and simply confirms on its echo.
  async replayPendingSends() {
    if (!this.peer) return;
    const pending = useChatStore.getState().pendingSends;
    for (const [msgId, rec] of Object.entries(pending)) {
      // Replay ONLY onto a topic this session positively seated. whenSeated()
      // resolving is not that guarantee: subscribeTo catches its own sub()
      // rejection, so a topic whose subscription failed still lets the batch
      // resolve. Publishing there reproduces the missed-echo bug through the
      // error path instead of the race — delivered, and marked NOT DELIVERED
      // forever, because nothing is listening for the echo that clears it.
      // Leaving the record pending is correct: the watchdog rebuilds again,
      // and content-addressed msgIds make a later replay idempotent
      // (Aster, CHANGES-REQUIRED 6af3ed6).
      if (!this._seatedTopicIds.has(rec.topicId)) {
        console.warn(`[axona-chat] replay HELD for ${msgId.slice(0, 10)}… — its topic is not seated on this session`);
        continue;
      }
      try {
        const author = await createAuthorIdentity({ persistAs: rec.authorRef });
        await this.peer.pub(rec.descriptor, rec.payload, { signWith: author });
        console.info(`[axona-chat] replayed pending send ${msgId.slice(0, 10)}…`);
      } catch (err) {
        console.warn(`[axona-chat] replay failed for ${msgId.slice(0, 10)}…: ${err.message}`);
      }
    }
  }

  async publishPrivateContinuation(partnerId, text) {
    if (!this.peer) return;

    const store = useChatStore.getState();
    const conv = store.privateConversations[partnerId];
    if (!conv) return;

    const handle = store.currentHandle;
    const activeAuthor = await this.getActiveAuthor();

    const descriptor = { region: 'eagle', name: conv.topic, write: 'open' };
    const ciphertext = CryptoService.encryptSymmetric(text, conv.key);

    const payload = {
      handle: handle ? handle.name : 'Anonymous',
      ciphertext
    };

    await this.peer.pub(descriptor, payload, { signWith: activeAuthor });

    // Instantly append local copy for fast feedback
    useChatStore.getState().addPrivateMessage(partnerId, {
      id: Math.random().toString(),
      sender: handle ? handle.name : 'You',
      text,
      ts: Date.now()
    });
  }

  async forwardMessage(outputTopicDescriptor, originalEnvelope) {
    if (!this.peer) return;
    const activeAuthor = await this.getActiveAuthor();
    
    // Republish approved content under the owner key on the output channel
    const originalPayload = originalEnvelope.message;
    const payload = {
      ...originalPayload,
      forwardedFrom: originalEnvelope.signerPubkey,
      forwardedAt: Date.now()
    };

    await this.peer.pub(outputTopicDescriptor, payload, { signWith: activeAuthor });
  }

  async deleteOwnMessage(topicDescriptor, msgId) {
    if (!this.peer) return;
    const activeAuthor = await this.getActiveAuthor();
    await this.peer.kill(topicDescriptor, msgId, { signWith: activeAuthor });
  }

  async advertiseTopic(targetDescriptor, blurb) {
    if (!this.peer) return;
    const activeAuthor = await this.getActiveAuthor();
    const targetId = await this.getTopicHexId(targetDescriptor);

    // Prevent recursive self-ads
    const tickerId = await this.getTopicHexId(this.tickerTopic);
    if (targetId === tickerId) {
      alert("Cannot advertise the ticker topic itself!");
      return;
    }

    // The FULL descriptor identity must travel with the ad: {region, owner,
    // name, write} all fold into the topic id, so an ad without owner/write
    // would send joiners of an owned channel to a different (empty) topic.
    const payload = {
      type: 'topic.ad',
      name: targetDescriptor.name,
      blurb,
      topicId: targetId,
      network: 'production',
      region: targetDescriptor.region || 'eagle',
      mode: targetDescriptor.mode || 'open',
      owner: targetDescriptor.owner || null,
      write: targetDescriptor.write || (targetDescriptor.owner ? 'owner' : 'open'),
      postedAt: Date.now()
    };

    await this.peer.pub(this.tickerTopic, payload, { signWith: activeAuthor });
  }

  /** Retract an advertisement the ACTIVE persona published: owner-signed kill
   *  on the ticker topic. Other clients drop the ad via the deletion marker. */
  async retractAdvertisement(ad) {
    if (!this.peer || !ad?.msgId) throw new Error('ad has no msgId (received before v0.13.0 — it will age out on its own)');
    const activeAuthor = await this.getActiveAuthor();
    if (!activeAuthor || activeAuthor.authorId !== ad.signer) {
      throw new Error('only the persona that published an ad can retract it');
    }
    await this.peer.kill(this.tickerTopic, ad.msgId, { signWith: activeAuthor });
    useChatStore.getState().removeAdvertisement(ad.msgId);   // optimistic local removal
  }

  startPresenceHeartbeat() {
    this.stopPresenceHeartbeat();
    const beat = async () => {
      if (!this.peer) return;
      const store = useChatStore.getState();
      const handle = store.currentHandle;
      const decl = store.currentDeclaration;
      if (!handle) return;

      try {
        const activeAuthor = await this.getActiveAuthor();
        const payload = {
          type: 'heartbeat',
          handle: handle.name,
          declaration: decl
        };
        await this.peer.pub(this.heartbeatTopic, payload, { signWith: activeAuthor });
      } catch {
        // Suppress heartbeat publish errors
      }
    };

    beat();
    this.presenceInterval = setInterval(beat, 30000);
  }

  stopPresenceHeartbeat() {
    if (this.presenceInterval) {
      clearInterval(this.presenceInterval);
      this.presenceInterval = null;
    }
  }
}

export default new AxonaChatClient();
