import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { entriesOf, incidentIndex, searchIncidents } from '../src/incidents.mjs'

test('entries are ## sections titled by their heading; a file without headings is one entry, never refused', () => {
  assert.deepEqual(entriesOf(''), [])
  assert.deepEqual(entriesOf('前言\n\n## a：b\nx\n## c\ny').map(row => row.title), ['a：b', 'c'])
  const one = entriesOf('修了 add 的重复 id，根因是 length+1\n更多')
  assert.equal(one.length, 1)
  assert.equal(one[0].title, '修了 add 的重复 id，根因是 length+1')
  assert.ok(entriesOf(`## ${'长'.repeat(80)}\nx`)[0].title.endsWith('…'))
})

test('search keeps entries holding the words, most words first, case-insensitive; no words lists titles', () => {
  process.env.DSH_AUTO_DEV_HOME = mkdtempSync(join(tmpdir(), 'kb-home-'))
  const project = mkdtempSync(join(tmpdir(), 'kb-'))
  mkdirSync(join(project, '.auto-dev'))
  writeFileSync(join(project, '.auto-dev/incidents.md'), '## 一\nFoo bar\n\n## 二\nfoo\n\n## 三\nbaz\n')
  assert.deepEqual(incidentIndex(project).here, ['三', '二', '一'])
  assert.equal(searchIncidents(project, '').titles.length, 3)
  const hits = searchIncidents(project, 'FOO bar').hits
  assert.deepEqual(hits.map(row => row.title), ['一', '二'])
  assert.equal(hits[0].words, '2/2')
  assert.equal(searchIncidents(project, 'nothing').matched, 0)
})
