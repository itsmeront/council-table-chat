import { describe, it, expect } from 'vitest';
import { resolveTopicInput, normaliseName, describeDescriptor } from '../topicInput.js';
import { buildTopicLink } from '../topicLink.js';

const ME = 'a'.repeat(64);

describe('resolveTopicInput — bare name', () => {
  it('defaults to an OPEN topic with no owner', () => {
    const { descriptor, source, error } = resolveTopicInput('retro-gaming');
    expect(error).toBeNull();
    expect(source).toBe('name');
    expect(descriptor).toMatchObject({ region: 'eagle', name: 'retro-gaming', write: 'open', owner: null });
  });

  it('dashes spaces, so the name survives a link round-trip', () => {
    expect(resolveTopicInput('retro gaming club').descriptor.name).toBe('retro-gaming-club');
  });

  it('moderated/controlled make YOU the owner and flip write to owner', () => {
    for (const policy of ['moderated', 'controlled']) {
      const { descriptor } = resolveTopicInput('secret', { policy, ownerAuthorId: ME });
      expect(descriptor).toMatchObject({ write: 'owner', owner: ME, mode: policy });
    }
  });

  it('controlled and moderated share an ADDRESS and differ only in mode', () => {
    const c = resolveTopicInput('x', { policy: 'controlled', ownerAuthorId: ME }).descriptor;
    const m = resolveTopicInput('x', { policy: 'moderated', ownerAuthorId: ME }).descriptor;
    // owner + write + region + name are what fold into the topicId
    expect([c.owner, c.write, c.region, c.name]).toEqual([m.owner, m.write, m.region, m.name]);
    expect(c.mode).not.toBe(m.mode);
  });

  it('refuses to own a topic with no persona to sign it', () => {
    const { descriptor, error } = resolveTopicInput('x', { policy: 'moderated', ownerAuthorId: null });
    expect(descriptor).toBeNull();
    expect(error).toMatch(/persona/i);
  });

  it('carries a description only when one was given', () => {
    expect(resolveTopicInput('a', { description: ' hi ' }).descriptor.description).toBe('hi');
    expect(resolveTopicInput('a').descriptor.description).toBeUndefined();
  });

  it('rejects empty and whitespace input', () => {
    for (const v of ['', '   ', null, undefined]) {
      expect(resolveTopicInput(v).error).toBeTruthy();
    }
  });
});

describe('resolveTopicInput — pasted link', () => {
  it('decodes a shared link instead of joining a topic NAMED like the URL', () => {
    const shared = { region: 'eagle', name: 'from-a-friend', write: 'open' };
    const { descriptor, source, error } = resolveTopicInput(buildTopicLink(shared));
    expect(error).toBeNull();
    expect(source).toBe('link');
    expect(descriptor.name).toBe('from-a-friend');
  });

  it('preserves an OWNED topic exactly — the bug that made name-joins land elsewhere', () => {
    const owned = { region: 'eagle', name: 'board', write: 'owner', owner: ME };
    const { descriptor, policyApplies } = resolveTopicInput(buildTopicLink(owned), { policy: 'open' });
    // The policy control said "open"; the link says owner. The link must win,
    // or we would silently address a different topic with the same name.
    expect(descriptor.write).toBe('owner');
    expect(descriptor.owner).toBe(ME);
    expect(policyApplies).toBe(false);
  });

  it('a URL with no topic token is an error, not a topic named after the URL', () => {
    const { descriptor, error } = resolveTopicInput('https://axona.chat/somewhere');
    expect(descriptor).toBeNull();
    expect(error).toMatch(/carries no topic/i);
  });
});

describe('resolveTopicInput — pasted descriptor JSON', () => {
  it('accepts a descriptor and infers write from owner', () => {
    const { descriptor, source, policyApplies } =
      resolveTopicInput(JSON.stringify({ name: 'ops', owner: ME }));
    expect(source).toBe('json');
    expect(descriptor).toMatchObject({ name: 'ops', owner: ME, write: 'owner', region: 'eagle' });
    expect(policyApplies).toBe(false);
  });

  it('honours an explicit write over the owner inference', () => {
    expect(resolveTopicInput(JSON.stringify({ name: 'n', owner: ME, write: 'open' })).descriptor.write)
      .toBe('open');
  });

  it('rejects malformed JSON, arrays, and a descriptor with no name', () => {
    expect(resolveTopicInput('{oops').error).toMatch(/valid JSON/i);
    expect(resolveTopicInput('[1,2]').error).toMatch(/JSON object/i);
    expect(resolveTopicInput('{"region":"eagle"}').error).toMatch(/no `name`/i);
  });
});

describe('describeDescriptor — the address, shown before committing', () => {
  it('names the policy so an owned topic cannot be mistaken for an open one', () => {
    expect(describeDescriptor({ name: 'a', region: 'eagle', write: 'open' })).toBe('#a · eagle · open');
    const owned = describeDescriptor({ name: 'a', region: 'eagle', write: 'owner', owner: ME, mode: 'controlled' });
    expect(owned).toContain('controlled');
    expect(owned).toContain('owner aaaaaaaaaa…');
  });
  it('is empty for nothing', () => { expect(describeDescriptor(null)).toBe(''); });
});

describe('normaliseName', () => {
  it('trims and collapses whitespace runs to single dashes', () => {
    expect(normaliseName('  a   b  ')).toBe('a-b');
    expect(normaliseName(undefined)).toBe('');
  });
});
