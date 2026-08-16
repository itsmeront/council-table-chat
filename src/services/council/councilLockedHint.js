// councilLockedHint.js — reader-safe copy for the locked council placeholder.
//
// When a council ciphertext cannot be opened on THIS device (no keyring, wrong
// keyring, rotated epoch, tamper, unknown signer…) the message renders as a
// lock block (Message.jsx) instead of being hidden or shown as jumbled text.
// The raw open-failure reason is developer-speak; this maps it to plain
// language. The ciphertext itself is never rendered anywhere.
const FALLBACK = 'Encrypted — this message can only be read by council members with the current key.';

const RULES = [
  [/no keyring provisioned|keyring not provisioned/i, 'Encrypted — import the council keyring (the \u{1F512} Council button) to read this message.'],
  [/keyring unavailable/i, 'Encrypted — the council keyring isn\u2019t available on this device.'],
  [/no session record for epoch/i, 'Encrypted — a newer council key is required; refresh the keyring (the \u{1F512} Council button).'],
  [/epoch .* consumed/i, 'Encrypted — this message was sealed under a key that has since been rotated.'],
  [/reader is not a member/i, 'Encrypted — this keyring is not a member of the council epoch that sealed it.'],
  [/nonce\+epoch reuse/i, 'Encrypted — this message failed its integrity check and was not opened.'],
  [/decrypt failed/i, 'Encrypted — this message could not be decrypted with the current keyring.'],
  [/signer not in known-hosts/i, 'Encrypted — the sender is not a known council member.'],
  [/registry signature not verified/i, 'Encrypted — the council registry could not be verified.'],
  [/malformed/i, 'Encrypted — this message could not be read.'],
];

export function councilLockedHint(reason) {
  if (!reason) return FALLBACK;
  for (const [re, hint] of RULES) if (re.test(reason)) return hint;
  return FALLBACK;
}
