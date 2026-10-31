import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GateError, InvariantError, invariant } from '../src/gate.mjs'

const SRC = new URL('../src/', import.meta.url).pathname
// Host wiring: the plugin's own config, validated before any model can call a tool.
const HOST = new Set(['index.js', 'client.js'])
// A throw is allowed only as a gate, an invariant, or a rethrow of something caught.
const ALLOWED = /throw new (GateError|InvariantError)\(|throw (error|err)\b/
// Bare throws still to be digested. Ratchets down to 0; never raise it.
const BASELINE = 0

function bareThrows() {
  const files = readdirSync(SRC, { recursive: true }).filter(file => /\.(mjs|js)$/.test(file) && !HOST.has(file))
  return files.flatMap(file => readFileSync(join(SRC, file), 'utf8').split('\n')
    .map((line, index) => ({ where: `src/${file}:${index + 1}`, line: line.trim() }))
    .filter(row => /\bthrow\b/.test(row.line) && !row.line.startsWith('*') && !row.line.startsWith('//') && !ALLOWED.test(row.line)))
}

test('no Error is built to be thrown later: a refusal is a gate, a broken record an invariant', () => {
  const files = readdirSync(SRC, { recursive: true }).filter(file => /\.(mjs|js)$/.test(file) && !HOST.has(file))
  const built = files.flatMap(file => readFileSync(join(SRC, file), 'utf8').split('\n')
    .map((line, index) => ({ where: `src/${file}:${index + 1}`, line: line.trim() }))
    .filter(row => /\bnew (Type|Range)?Error\(/.test(row.line) && !row.line.startsWith('//') && !row.line.startsWith('*')))
  assert.deepEqual(built, [], `先 new Error 再 throw 能绕过上面的棘轮：\n${built.map(row => `  ${row.where}  ${row.line.slice(0, 120)}`).join('\n')}`)
})

test('a gate names one of the three signed-off gates, its rule and how to pass', () => {
  const error = new GateError('G1', '交付前最后一次改动之后没有跑通的检查', '跑一次检查')
  assert.equal(error.gate, 'G1')
  assert.match(error.message, /^交付前.*\n过关：跑一次检查$/)
  assert.throws(() => new GateError('G9', 'x'), InvariantError)
})

test('an invariant is the plugin breaking, not a refusal', () => {
  assert.doesNotThrow(() => invariant(true, 'fine'))
  assert.throws(() => invariant(false, 'record torn'), /^InvariantError: dsh-auto-dev: record torn$|dsh-auto-dev: record torn/)
})

test('no bare throw outside the three gates and the invariants (ratchet)', () => {
  const rows = bareThrows()
  assert.ok(rows.length <= BASELINE, `裸 throw ${rows.length} 处，超过基线 ${BASELINE}——消化它（默认值 / 丢掉坏条目 / 回答现有什么），或者它真是 G1–G3 / invariant：\n${rows.map(row => `  ${row.where}  ${row.line.slice(0, 120)}`).join('\n')}`)
  if (rows.length < BASELINE) console.log(`# gate ratchet: ${rows.length} bare throws left (baseline ${BASELINE}) — lower BASELINE`)
})
