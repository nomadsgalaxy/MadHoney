// Regression test for compromised-account fan-out detection. Run: node test-compromised.mjs
import assert from 'node:assert';
import { compromisedSettings, normalizeContent, messageSignature, recordAndCheck, sweep } from '../src/compromised.js';

// --- settings defaults + clamping ---
const d = compromisedSettings(undefined);
assert.deepEqual([d.enabled, d.channels, d.windowSec, d.action, d.deleteMessages], [true, 3, 5, 'kick', true]);
assert.equal(compromisedSettings({ compromised: { enabled: false } }).enabled, false);
assert.equal(compromisedSettings({ compromised: { channels: 99 } }).channels, 10);   // clamp hi
assert.equal(compromisedSettings({ compromised: { channels: 1 } }).channels, 2);     // clamp lo
assert.equal(compromisedSettings({ compromised: { windowSec: 999 } }).windowSec, 60);
assert.equal(compromisedSettings({ compromised: { action: 'nope' } }).action, 'kick'); // invalid -> default
assert.equal(compromisedSettings({ compromised: { action: 'ban' } }).action, 'ban');

// --- normalization: case / spacing / mentions / links collapse to the same sig ---
assert.equal(normalizeContent('FREE  Nitro  <@123> https://scam.tld/x'), 'free nitro');
assert.equal(messageSignature({ content: '' }), '');                       // nothing to compare (intent off)
assert.equal(messageSignature({ content: '', attachmentNames: ['spam.png'] }), 'spam.png'); // image-only blast
assert.equal(
  messageSignature({ content: 'Free NITRO here <@9>' }),
  messageSignature({ content: 'free nitro    here <@42>' }),               // same blast, different ping
);

const cfg = { channels: 3, windowMs: 5000 };
const post = (ch, id) => ({ channelId: ch, messageId: id });

// --- trips on the 3rd distinct channel within the window ---
{
  const store = new Map();
  const sig = messageSignature({ content: 'gift for you' });
  assert.equal(recordAndCheck(store, 'g:u', sig, post('c1', 'm1'), 1000, cfg), null);
  assert.equal(recordAndCheck(store, 'g:u', sig, post('c2', 'm2'), 2000, cfg), null);
  const blast = recordAndCheck(store, 'g:u', sig, post('c3', 'm3'), 3000, cfg);
  assert.ok(blast && blast.length === 3, 'blast should list all 3 messages to delete');
  assert.deepEqual(blast.map((b) => b.messageId).sort(), ['m1', 'm2', 'm3']);
  // fired once: the signature is cleared, so the next post starts a fresh count
  assert.equal(store.has('g:u'), false);
  assert.equal(recordAndCheck(store, 'g:u', sig, post('c4', 'm4'), 3100, cfg), null);
}

// --- reposting the SAME channel is not extra fan-out ---
{
  const store = new Map();
  const sig = messageSignature({ content: 'spam' });
  recordAndCheck(store, 'g:u', sig, post('c1', 'm1'), 1000, cfg);
  recordAndCheck(store, 'g:u', sig, post('c1', 'm2'), 1500, cfg);       // same channel again
  assert.equal(recordAndCheck(store, 'g:u', sig, post('c1', 'm3'), 1800, cfg), null, '1 channel != fan-out');
}

// --- a slow human spread across > window never trips ---
{
  const store = new Map();
  const sig = messageSignature({ content: 'announcement' });
  assert.equal(recordAndCheck(store, 'g:u', sig, post('c1', 'm1'), 0, cfg), null);
  assert.equal(recordAndCheck(store, 'g:u', sig, post('c2', 'm2'), 4000, cfg), null);
  assert.equal(recordAndCheck(store, 'g:u', sig, post('c3', 'm3'), 8000, cfg), null, 'c1 aged out, only 2 fresh');
}

// --- different content in different channels doesn't correlate ---
{
  const store = new Map();
  recordAndCheck(store, 'g:u', messageSignature({ content: 'hi' }), post('c1', 'm1'), 100, cfg);
  recordAndCheck(store, 'g:u', messageSignature({ content: 'bye' }), post('c2', 'm2'), 200, cfg);
  assert.equal(recordAndCheck(store, 'g:u', messageSignature({ content: 'yo' }), post('c3', 'm3'), 300, cfg), null);
}

// --- sweep clears stale entries ---
{
  const store = new Map();
  recordAndCheck(store, 'g:u', messageSignature({ content: 'x' }), post('c1', 'm1'), 1000, cfg);
  sweep(store, 1000 + 6000, 5000);
  assert.equal(store.size, 0, 'stale user pruned');
}

console.log('ok');
