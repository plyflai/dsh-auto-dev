import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 设计约定「第三条路」: the plugin does not read meaning out of shell or output text.
// A regex applied to a command, its output or an error text is an inference; the
// allowed ones are listed here by file and why. The count ratchets down; never add one
// without deleting one.
const SRC = new URL('../src/', import.meta.url).pathname
const TEXT = /\.(test|exec|match|matchAll)\(\s*(?:[\w.?]*\b(?:command|output|stdout|stderr|errorText)\b)/
const ALLOWED = {
  // A child session's checks, listed for the panel; never a card or a gate.
  'child-sessions.mjs': 1,
  // The plugin's own refusal prefix on its own error: a fact about itself.
  'session-log.mjs': 1,
  // The project's check in its two agreed forms (plain / pipefail + tail): fixed templates the start card asks for.
  'facts.mjs': 1,
}
const BASELINE = Object.values(ALLOWED).reduce((sum, n) => sum + n, 0)

test('no new inference from shell or output text (ratchet)', () => {
  const files = readdirSync(SRC, { recursive: true }).filter(file => /\.mjs$/.test(file))
  const rows = files.flatMap(file => readFileSync(join(SRC, file), 'utf8').split('\n')
    .map((line, index) => ({ file, where: `src/${file}:${index + 1}`, line: line.trim() }))
    .filter(row => TEXT.test(row.line) && !row.line.startsWith('//') && !row.line.startsWith('*')))
  const extra = rows.filter(row => {
    ALLOWED[row.file] = (ALLOWED[row.file] ?? 0) - 1
    return ALLOWED[row.file] < 0
  })
  assert.equal(extra.length, 0, `插件又在猜 shell / 输出文本（第三条路禁止）：\n${extra.map(row => `  ${row.where}  ${row.line.slice(0, 120)}`).join('\n')}\n改成白名单硬事实：一字不差的检查 + 退出码、磁盘指纹、结构化参数。`)
  assert.ok(rows.length <= BASELINE)
})
