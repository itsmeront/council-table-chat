import { describe, it, expect } from 'vitest';
import { extractUrls, isImageUrl, isYouTubeUrl } from '../messageUrls.js';

describe('extractUrls — the unfurl must target the same address as the anchor', () => {
  // Joi's report, #general 2026-07-27, verbatim shape.
  it('REGRESSION: markdown link with label == href yields ONE clean url', () => {
    const body = '[https://notes.ito.com/bb8eaaa0edf95830ac1862e0/](https://notes.ito.com/bb8eaaa0edf95830ac1862e0/)';
    expect(extractUrls(body)).toEqual(['https://notes.ito.com/bb8eaaa0edf95830ac1862e0/']);
  });

  it('REGRESSION: the old scan produced a url containing "](" — never again', () => {
    const body = '[https://x.com/a](https://x.com/a)';
    for (const u of extractUrls(body)) {
      expect(u).not.toContain('](');
      expect(u).not.toContain(']');
    }
  });

  it('takes the HREF, not the label, when they differ', () => {
    expect(extractUrls('see [the paper](https://axona.net/whitepaper/Axona-Whitepaper.pdf)'))
      .toEqual(['https://axona.net/whitepaper/Axona-Whitepaper.pdf']);
  });

  it('David\'s whitepaper post (label == href, surrounded by prose)', () => {
    const body = 'It is mentioned in the whitepaper:\n[https://axona.net/whitepaper/Axona-Whitepaper.pdf](https://axona.net/whitepaper/Axona-Whitepaper.pdf)\n\nThe architectural intersection...';
    expect(extractUrls(body)).toEqual(['https://axona.net/whitepaper/Axona-Whitepaper.pdf']);
  });

  it('still finds bare URLs', () => {
    expect(extractUrls('go to https://example.com/x now')).toEqual(['https://example.com/x']);
  });

  it('mixes markdown links and bare URLs without cross-contamination', () => {
    const body = 'a [one](https://a.com/1) then bare https://b.com/2 end';
    expect(extractUrls(body)).toEqual(['https://a.com/1', 'https://b.com/2']);
  });

  it('two markdown links do not bleed into each other', () => {
    const body = '[https://a.com](https://a.com) and [https://b.com](https://b.com)';
    expect(extractUrls(body)).toEqual(['https://a.com', 'https://b.com']);
  });

  it('strips trailing prose/markdown punctuation (pre-existing behaviour kept)', () => {
    expect(extractUrls('see **https://x.com/a** .')).toEqual(['https://x.com/a']);
    expect(extractUrls('quote "https://x.com/b."')).toEqual(['https://x.com/b']);
  });

  it('de-duplicates a url mentioned twice', () => {
    expect(extractUrls('[x](https://a.com) and again https://a.com')).toEqual(['https://a.com']);
  });

  it('is safe on empty / non-string input', () => {
    expect(extractUrls('')).toEqual([]);
    expect(extractUrls(null)).toEqual([]);
    expect(extractUrls(undefined)).toEqual([]);
    expect(extractUrls(42)).toEqual([]);
  });

  it('ignores a markdown link to a non-http target', () => {
    expect(extractUrls('[topic](#topic=abc)')).toEqual([]);
  });
});

describe('classifiers', () => {
  it('images by extension only at the end', () => {
    expect(isImageUrl('https://a.com/x.png')).toBe(true);
    expect(isImageUrl('https://a.com/png/page')).toBe(false);
  });
  it('youtube in either form', () => {
    expect(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isYouTubeUrl('https://a.com/x')).toBe(false);
  });
});
