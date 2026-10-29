/**
 * Both halves of the card channel, checked against each other.
 *
 * The host half stamps `source.kind` (`NOTICE_KIND`) on the messages it queues;
 * the browser half claims `user/message` events by that same string. Nothing in
 * the runtime ties the two together — when they drifted apart the cards were
 * silently un-claimed and every row fell back into the Turn's process fold, which
 * looks exactly like "the plugin draws nothing". The host constant is imported;
 * the browser half runs only in a page, so its literal is read as text.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { NOTICE_KIND } from '../src/mailbox.mjs'

const client = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

/** The built bundle must carry both literals: it is what the browser actually runs. */
function bundleKind(source) {
  const match = /source\.kind !== ["']([^"']+)["']/.exec(source)
  assert.ok(match, 'the compiled half should test source.kind')
  return match[1]
}

/** The `source.kind` the browser half accepts in its match function. */
function clientKind(source) {
  const match = /source\.kind !== '([^']+)'/.exec(source)
  assert.ok(match, 'the card definition should test source.kind')
  return match[1]
}

test('both halves agree on the message source kind', () => {
  assert.equal(NOTICE_KIND, clientKind(client))
})

test('the shipped bundle was rebuilt from the same source', () => {
  // A stale bundle is how a fixed matcher silently stops shipping; compare the
  // literal the browser will run with the one the host half writes.
  assert.equal(bundleKind(bundle), NOTICE_KIND)
})

test('the claim is exclusive, so a claimed message is never drawn twice', () => {
  assert.match(client, /role: 'start', exclusive: true/)
})

test('the card node declares the exchange level instead of the process fold', () => {
  // groupTree: 'exchange' is outside the Turn's process group; without it the
  // message is still in the log but only visible after opening the fold.
  assert.match(client, /groupTree: 'exchange'/)
})
