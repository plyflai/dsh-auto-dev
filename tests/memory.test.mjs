import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_FILE, memoryBrief, memoryPath, readMemory, remember } from '../src/memory.mjs'

const project = () => mkdtempSync(join(tmpdir(), 'v3-memory-'))

test('a project with no memory file simply knows nothing yet', () => {
  const memory = readMemory(project())
  assert.deepEqual(memory, { version: 1, facts: [], incidents: [] })
})

test('a fact is written where a person can read and diff it', () => {
  const root = project()
  const stored = remember(root, { kind: 'fact', text: 'tests run with npm test from the workspace root' })
  assert.equal(stored.stored, true)
  const onDisk = JSON.parse(readFileSync(memoryPath(root), 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.equal(onDisk.facts.length, 1)
  assert.match(onDisk.facts[0].text, /npm test/)
  assert.equal(memoryPath(root).endsWith(MEMORY_FILE), true)
})

test('the same fact twice is not stored twice', () => {
  const root = project()
  remember(root, { kind: 'fact', text: 'the deploy script is scripts/deploy.sh' })
  const again = remember(root, { kind: 'fact', text: 'the deploy script is scripts/deploy.sh' })
  assert.equal(again.stored, false)
  assert.equal(readMemory(root).facts.length, 1)
})

test('an incident without a mechanism stays an observation', () => {
  const root = project()
  const stored = remember(root, { kind: 'incident', symptom: 'the page went blank' })
  assert.equal(stored.status, 'observation')
  assert.equal(stored.mechanism, undefined)
})

test('an incident keeps symptom, mechanism and repair together', () => {
  const root = project()
  const stored = remember(root, { kind: 'incident', symptom: 'blank page after login', mechanism: 'the session cookie was set without SameSite', repair: 'explicit SameSite=Lax' })
  assert.equal(stored.stored, true)
  const brief = memoryBrief(readMemory(root))
  assert.deepEqual(brief.incidents, [{ symptom: 'blank page after login', mechanism: 'the session cookie was set without SameSite', repair: 'explicit SameSite=Lax', status: 'recorded-mechanism' }])
})

test('unknown or tentative causes stay hypotheses even inside a sentence', () => {
  const root = project()
  const causes = ['目前根因未知', '缓存问题，原因未知', 'we do not know yet', 'the cause may be cache']
  for (const [index, mechanism] of causes.entries()) {
    const saved = remember(root, { kind: 'incident', symptom: `cache issue ${index}`, mechanism })
    assert.equal(saved.status, 'observation')
    assert.equal(saved.mechanism, undefined)
    assert.equal(saved.hypothesis, mechanism)
  }
  for (const mechanism of ['缓存键遗漏租户 ID', '此前未知，现已确认缓存键遗漏租户 ID', 'previously unknown; now confirmed the cache key omitted tenant ID']) {
    const saved = remember(root, { kind: 'incident', symptom: mechanism, mechanism })
    assert.equal(saved.status, 'recorded-mechanism')
    assert.equal(saved.mechanism, mechanism)
    assert.equal(saved.hypothesis, undefined)
  }
})

test('the brief stays short: a handful of the most recent entries, plus the totals', () => {
  const root = project()
  for (let index = 0; index < 9; index += 1) remember(root, { kind: 'fact', text: `fact ${index}` })
  const brief = memoryBrief(readMemory(root), { facts: 3 })
  assert.deepEqual(brief.facts, ['fact 6', 'fact 7', 'fact 8'])
  assert.deepEqual(brief.counts, { facts: 9, incidents: 0 })
})

test('an unreadable memory file does not stop the task, and does not get clobbered', () => {
  const root = project()
  mkdirSync(join(root, '.auto-dev'), { recursive: true })
  writeFileSync(memoryPath(root), '{ not json')
  assert.equal(readMemory(root).unreadable, true)
  assert.deepEqual(memoryBrief(readMemory(root)).facts, [])
})
