import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { skillDescription } from '../src/skill.mjs'

const SKILL_DIR = fileURLToPath(new URL('../skills/auto-dev/', import.meta.url))
const index = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8')

test('every craft page is reachable from the skill index, and every index link exists', () => {
  const pages = readdirSync(join(SKILL_DIR, 'references/craft')).filter(name => name.endsWith('.md'))
  for (const page of pages) assert.ok(index.includes(`(references/craft/${page})`), `SKILL.md 索引里没有 references/craft/${page}`)
  for (const [, link] of index.matchAll(/\]\((references\/[^)]+)\)/g)) assert.ok(existsSync(join(SKILL_DIR, link)), `SKILL.md 指向不存在的 ${link}`)
})

test('the description the host shows is the one in SKILL.md frontmatter', () => {
  const own = index.match(/^description:\s*(.+)$/m)[1].trim()
  assert.equal(skillDescription(), own)
  assert.match(skillDescription('/nonexistent/SKILL.md'), /Auto Dev/)
})
