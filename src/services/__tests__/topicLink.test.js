import { describe, it, expect } from 'vitest';
import {
  buildTopicLink,
  buildTopicMarkdown,
  parseTopicLink,
  isTopicLink,
  TOPIC_LINK_ORIGIN,
} from '../topicLink.js';

describe('topicLink', () => {
  it('round-trips an open topic descriptor', () => {
    const d = { region: 'eagle', name: 'lobby' };
    const link = buildTopicLink(d);
    expect(link.startsWith(`${TOPIC_LINK_ORIGIN}/#topic=`)).toBe(true);
    const parsed = parseTopicLink(link);
    expect(parsed.region).toBe('eagle');
    expect(parsed.name).toBe('lobby');
    expect(parsed.write).toBe('open');
    expect(parsed.owner).toBeUndefined();
  });

  it('carries owner + write for an owned topic (identity folds into the topic id)', () => {
    const d = { region: 'uknorth', name: 'briefing', owner: 'abc123', write: 'owner' };
    const parsed = parseTopicLink(buildTopicLink(d));
    expect(parsed.region).toBe('uknorth');
    expect(parsed.name).toBe('briefing');
    expect(parsed.owner).toBe('abc123');
    expect(parsed.write).toBe('owner');
  });

  it('preserves a display label distinct from the name', () => {
    const parsed = parseTopicLink(buildTopicLink({ name: 'x', label: 'Fancy Name' }));
    expect(parsed.name).toBe('x');
    expect(parsed.label).toBe('Fancy Name');
  });

  it('handles unicode topic names', () => {
    const parsed = parseTopicLink(buildTopicLink({ name: 'café—münchen ☕' }));
    expect(parsed.name).toBe('café—münchen ☕');
  });

  it('isTopicLink recognizes topic links and rejects others', () => {
    expect(isTopicLink(buildTopicLink({ name: 'lobby' }))).toBe(true);
    expect(isTopicLink('https://example.com/page')).toBe(false);
    expect(isTopicLink('https://axona.chat/')).toBe(false);
    expect(isTopicLink(null)).toBe(false);
    expect(isTopicLink(undefined)).toBe(false);
  });

  it('parses regardless of origin (localhost / testnet links resolve)', () => {
    const token = buildTopicLink({ name: 'lobby' }).split('#topic=')[1];
    expect(parseTopicLink(`http://localhost:5173/#topic=${token}`).name).toBe('lobby');
    expect(parseTopicLink(`http://localhost:5173/?topic=${token}`).name).toBe('lobby');
  });

  it('returns null for malformed tokens', () => {
    expect(parseTopicLink('https://axona.chat/#topic=not-valid-base64!!')).toBe(null);
    expect(parseTopicLink('https://axona.chat/#topic=')).toBe(null);
    expect(parseTopicLink('https://axona.chat/')).toBe(null);
  });

  it('buildTopicMarkdown produces a clickable markdown link', () => {
    const md = buildTopicMarkdown({ name: 'lobby' });
    expect(md).toMatch(/^\[#lobby\]\(https:\/\/axona\.chat\/#topic=/);
  });
});
