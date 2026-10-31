import test from 'node:test'
import assert from 'node:assert/strict'
import { deliveryCard, deliveryLines } from '../src/craft.mjs'

test('hand-in asks to map the request item by item only when the person never spoke since the start', () => {
  const silent = deliveryLines([], undefined, { spoke: false })
  assert.ok(silent.some(line => /逐条对照原话/.test(line)))
  assert.equal(deliveryLines([], undefined, { spoke: true }).some(line => /逐条对照原话/.test(line)), false)
  assert.equal(deliveryLines([]).some(line => /逐条对照原话/.test(line)), false, 'unknown is not silence')
})

test('the 口径 line needs the person to have spoken; the hand-in card is a capsule the person sees', () => {
  assert.equal(deliveryLines([], undefined, { spoke: false }).some(line => /口径/.test(line)), false)
  assert.ok(deliveryLines([], undefined, { spoke: true }).some(line => /口径/.test(line)))
  const [, , meta] = deliveryCard(['a'])
  assert.equal(meta.form, 'read-doc')
})
