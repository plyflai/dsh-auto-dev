import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_PROJECTS, shareIncidents, teamDir, teamIncidents } from '../src/team.mjs'

const project = (name, text) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'team-')), name)
  mkdirSync(join(dir, '.auto-dev'), { recursive: true })
  if (text !== undefined) writeFileSync(join(dir, '.auto-dev/incidents.md'), text)
  return dir
}

test('the team keeps at most MAX_PROJECTS files; the least recently shared goes first', () => {
  process.env.DSH_AUTO_DEV_HOME = mkdtempSync(join(tmpdir(), 'team-home-'))
  const first = shareIncidents(project('p0', '## a\n'))
  utimesSync(first, new Date(0), new Date(0))
  for (let i = 1; i <= MAX_PROJECTS; i++) shareIncidents(project(`p${i}`, `## e${i}\n`))
  const left = readdirSync(teamDir())
  assert.equal(left.length, MAX_PROJECTS)
  assert.ok(!left.some(name => name.endsWith('-p0.md')), 'the oldest project is retired')
})

test('a project with no postmortems shares nothing; its own file is not read back to it', () => {
  process.env.DSH_AUTO_DEV_HOME = mkdtempSync(join(tmpdir(), 'team-home-'))
  assert.equal(shareIncidents(project('empty')), '')
  const a = project('a', '## old\nx\n\n## newest\ny\n')
  shareIncidents(a)
  assert.deepEqual(teamIncidents(a), [])
  const rows = teamIncidents(project('b'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].project, a)
  assert.match(rows[0].text, /^## newest/)
})

test('the team conventions are the person file verbatim, cut at MAX_CONVENTION_LINES; none means no line', async () => {
  const { MAX_CONVENTION_LINES, conventionsPath, teamConventions } = await import('../src/team.mjs')
  process.env.DSH_AUTO_DEV_HOME = mkdtempSync(join(tmpdir(), 'team-home-'))
  assert.equal(teamConventions(), '')
  writeFileSync(conventionsPath(), '- 实跑配置用 rig- 开头\n')
  assert.equal(teamConventions(), '- 实跑配置用 rig- 开头')
  writeFileSync(conventionsPath(), Array.from({ length: MAX_CONVENTION_LINES + 5 }, (_, i) => `- 第 ${i} 条`).join('\n'))
  assert.match(teamConventions(), /后面还有 5 行没带出）$/)
})
