// councilLockedHint.test.js — locked-placeholder copy mapping.
import { describe, it, expect } from 'vitest';
import { councilLockedHint } from '../councilLockedHint.js';

describe('councilLockedHint', () => {
  it('maps the common unreadable-reasons to reader-safe copy', () => {
    expect(councilLockedHint('keyring not provisioned')).toMatch(/import the council keyring/i);
    expect(councilLockedHint('no session record for epoch 20260101-0000-abc')).toMatch(/newer council key is required/i);
    expect(councilLockedHint('epoch 20260101-0000-abc consumed')).toMatch(/has since been rotated/i);
    expect(councilLockedHint('reader is not a member of this epoch')).toMatch(/not a member/i);
    expect(councilLockedHint('nonce+epoch reuse')).toMatch(/integrity check/i);
    expect(councilLockedHint('decrypt failed')).toMatch(/could not be decrypted/i);
    expect(councilLockedHint('signer not in known-hosts')).toMatch(/not a known council member/i);
    expect(councilLockedHint('registry signature not verified')).toMatch(/could not be verified/i);
  });

  it('falls back to a generic explanation for unknown reasons and missing reasons', () => {
    expect(councilLockedHint()).toMatch(/only be read by council members/i);
    expect(councilLockedHint('some other failure')).toMatch(/only be read by council members/i);
  });

  it('never reveals internals in the copy', () => {
    for (const hint of [
      councilLockedHint('nonce+epoch reuse'),
      councilLockedHint('no session record for epoch x'),
      councilLockedHint(),
    ]) {
      expect(hint).not.toMatch(/^error|signerPubkey|wrapped|epoch/i);
    }
  });
});
