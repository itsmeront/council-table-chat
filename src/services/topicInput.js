import { isTopicLink, parseTopicLink } from './topicLink.js';

// =====================================================================
// topicInput.js — turn whatever the user pasted or typed into ONE descriptor.
//
// WHY THIS REPLACES TWO DIALOGS. "Join" and "+ New" ran the same three lines
// (addTopic / setActiveTopic / reconcileSubscriptions) and differed only in how
// they built the descriptor. That is because Axona has no topic registry: a
// descriptor hashes to a topicId, subscribing IS joining, and nothing records
// who arrived first. So "+ New" with mode open and name "foo" produced exactly
// the same topicId as "Join" with the name "foo" — two buttons, one outcome,
// and a create/join distinction the protocol does not have.
//
// What IS real is the write policy, because owner and write FOLD INTO THE
// ADDRESS. That made the old split actively harmful: typing the NAME of a
// moderated channel into Join produced write:'open', owner:null — a DIFFERENT
// topic that looks empty and works fine. Same class of silent mis-addressing as
// #393, where axona.bot posted to the bare topic instead of the owned one and
// its messages were invisible.
//
// So: one input, three accepted forms, and the caller renders the resolved
// descriptor before committing — the address is shown, not assumed.
//
//   link  — a shared axona.chat topic link. Carries its own write/owner, so the
//           policy control is IGNORED. Previously the Join box advertised link
//           paste in its tooltip and never implemented it: anything not starting
//           with '{' became a literal name, so a pasted URL joined a topic
//           *named* "https://axona.chat?topic=foo".
//   json  — a raw descriptor someone sent. Also self-describing; policy ignored.
//   name  — a bare name. The ONLY form where the policy control means anything,
//           because here we are choosing the address rather than reading it.
// =====================================================================

/** Policy → the two address-bearing fields. `mode` is app-local and never hashed. */
const POLICY = {
  open:       { write: 'open',  owned: false },
  controlled: { write: 'owner', owned: true },
  moderated:  { write: 'owner', owned: true },
};

export const POLICY_OPTIONS = [
  { value: 'open',       label: 'Open — anyone can post' },
  { value: 'controlled', label: 'Controlled — only people you allow can post' },
  { value: 'moderated',  label: 'Moderated — posts wait for your approval' },
];

/** Names go into links, so spaces would have to be escaped. Dash them. */
export const normaliseName = (s) => String(s ?? '').trim().replace(/\s+/g, '-');

/**
 * @param {string} raw            what the user typed or pasted
 * @param {object} opts
 * @param {'open'|'controlled'|'moderated'} [opts.policy='open']
 * @param {string|null} [opts.ownerAuthorId]  the active persona; required to own a topic
 * @param {string} [opts.description]         local-only label
 * @returns {{descriptor:object|null, source:'link'|'json'|'name'|null, error:string|null,
 *            policyApplies:boolean}}
 *   policyApplies is false for link/json, so the UI can say the pasted
 *   descriptor decides rather than silently ignoring the control.
 */
export const resolveTopicInput = (raw, opts = {}) => {
  const { policy = 'open', ownerAuthorId = null, description = '' } = opts;
  const text = String(raw ?? '').trim();
  const fail = (error) => ({ descriptor: null, source: null, error, policyApplies: true });

  if (!text) return fail('Enter a topic name, or paste a topic link or descriptor.');

  // ── a shared link ────────────────────────────────────────────────────────
  if (isTopicLink(text)) {
    const d = parseTopicLink(text);
    if (!d) return fail('That looks like a topic link, but it could not be decoded.');
    return { descriptor: d, source: 'link', error: null, policyApplies: false };
  }

  // ── a raw descriptor ─────────────────────────────────────────────────────
  // '[' as well as '{': the old code tested only '{', so a pasted JSON array
  // fell through to the name branch and became a topic literally called
  // "[1,2]" — the same silent-garbage-name failure as the pasted-URL case.
  // Anything that OPENS like JSON is a paste attempt and must fail loudly.
  if (text.startsWith('{') || text.startsWith('[')) {
    let d;
    try { d = JSON.parse(text); } catch { return fail('That is not valid JSON.'); }
    if (!d || typeof d !== 'object' || Array.isArray(d)) return fail('A descriptor must be a JSON object.');
    const name = normaliseName(d.name);
    if (!name) return fail('The descriptor has no `name`.');
    // Trust what it declares; only fill in what addressing requires.
    const descriptor = { ...d, name, region: d.region || 'eagle', write: d.write || (d.owner ? 'owner' : 'open') };
    return { descriptor, source: 'json', error: null, policyApplies: false };
  }

  // ── a bare name: the policy control is the address decision ──────────────
  const name = normaliseName(text);
  if (!name) return fail('Enter a topic name.');
  if (/^https?:/i.test(name)) {
    // A URL that carries no topic token. Treating it as a name would create a
    // topic literally called "https://…", which is the old bug.
    return fail('That URL carries no topic — check the link, or type a topic name instead.');
  }
  const { write, owned } = POLICY[policy] ?? POLICY.open;
  if (owned && !ownerAuthorId) {
    return fail('Pick or create a persona first — an owned topic has to be signed by someone.');
  }
  const descriptor = {
    region: 'eagle',
    name,
    mode: policy,
    owner: owned ? ownerAuthorId : null,
    write,
  };
  if (description.trim()) descriptor.description = description.trim();
  return { descriptor, source: 'name', error: null, policyApplies: true };
};

/** One-line human summary of where a descriptor actually points. */
export const describeDescriptor = (d) => {
  if (!d) return '';
  const policy = d.write === 'owner' ? (d.mode === 'controlled' ? 'controlled' : 'moderated') : 'open';
  const who = d.owner ? ` · owner ${String(d.owner).slice(0, 10)}…` : '';
  return `#${d.name} · ${d.region || 'eagle'} · ${policy}${who}`;
};
