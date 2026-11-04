/**
 * The hard facts every flow is allowed to speak from (设计约定「第三条路」).
 *
 * Nothing here reads meaning out of text. A run is the project's check only when
 * its command is, character for character, the command the project declares; its
 * result is the exit status the host reported. `cd elsewhere && npm test` or
 * `npm test | tail` is not the project's check — the plugin misses it rather than
 * guess. The start brief asks the model to run the check plainly.
 *
 * The rest is what the plugin holds in its own hands: a check it ran itself, the
 * agreed files on disk and the time they last changed.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { executionFailed } from './session-log.mjs'

export const INCIDENTS_FILE = '.auto-dev/incidents.md'
// Retirement (大原则 8): the plugin trims the oldest entries at hand-in.
export const MAX_INCIDENTS = 30

const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The agreed way to shorten a check's output: pipefail keeps the check's own exit code. */
export const trimmedCheck = command => `set -o pipefail; ${command} 2>&1 | tail -40`

/**
 * True when `command` is the project's declared check, run plainly or in the one agreed
 * shortened form (set -o pipefail; <check> 2>&1 | tail -N). Two fixed templates, not a
 * guess: anything else (no pipefail, head, cd, &&) is not counted (宁可漏). Without
 * pipefail a pipe reports tail's exit code, so counting it would turn a red green.
 * `head` is left out too: closing the pipe early can fail a passing check.
 */
export const exactCheck = (command, verifier) => {
  if (typeof command !== 'string' || typeof verifier?.command !== 'string') return false
  const check = verifier.command.trim()
  const run = command.trim()
  return run === check || new RegExp(`^set -o pipefail; ${escaped(check)} 2>&1 \\| tail -\\d+$`).test(run)
}

const textOf = row => Array.isArray(row?.content)
  ? row.content.filter(block => block?.type === 'text').map(block => block.text).join('\n').trim()
  : String(row?.content ?? row?.errorText ?? '').trim()

/** The last `lines` lines of a run's output, verbatim. */
export const tailOf = (text, lines = 20) => String(text ?? '').split('\n').slice(-lines).join('\n').trim()

/** The project's check runs in `rows`, oldest first: `{ seq, callId, time, command, ok, output }`. */
export const checkRuns = (rows, verifier) => (Array.isArray(rows) ? rows : [])
  .filter(row => exactCheck(row?.command, verifier))
  .map(row => ({ seq: row.seq, callId: row.callId, time: row.time, command: row.command.trim(), ok: !executionFailed(row), output: textOf(row) }))

/** Failed runs since the last passing one, oldest first. */
export const redStreak = runs => {
  const out = []
  for (const run of runs) if (run.ok) out.length = 0; else out.push(run)
  return out
}

/**
 * The fixes in `runs`: a passing run that came after two or more failing ones.
 * `{ green, reds }` per fix, oldest first. Whether it was a bug is the model's
 * call; the plugin only knows red, red, green.
 */
export const fixesIn = runs => fixes(runs, 2)

/** A passing run right after exactly one failing one: fixed on the first try. */
export const quickFixesIn = runs => fixes(runs, 1, 1)

const fixes = (runs, min, max = Infinity) => {
  const out = []
  let reds = []
  for (const run of runs) {
    if (!run.ok) { reds.push(run); continue }
    if (reds.length >= min && reds.length <= max) out.push({ green: run, reds })
    reds = []
  }
  return out
}

/** Run the declared check in the project, as the plugin's own act. */
export function runCheck(project, verifier, { timeoutMs = 600_000 } = {}) {
  return new Promise(resolve => {
    let output = ''
    let child
    try {
      // A parent `node --test` would otherwise swallow a child runner's failures.
      const { NODE_TEST_CONTEXT, ...env } = process.env
      child = spawn('sh', ['-c', verifier.command], { cwd: project, env: { ...env, CI: '1' } })
    } catch (error) {
      resolve({ ok: false, output: String(error?.message ?? error) })
      return
    }
    const keep = chunk => { output = (output + chunk).slice(-64_000) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => { child.kill('SIGKILL'); keep(`\n[超时 ${Math.round(timeoutMs / 1000)}s]`) }, timeoutMs)
    child.on('error', error => keep(`\n${error.message}`))
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, output }) })
  })
}

/** When the incidents file last changed (ms), or 0 when it does not exist. */
export function incidentsChangedAt(project) {
  try { return statSync(join(project, INCIDENTS_FILE)).mtimeMs } catch { return 0 }
}

const sectionsOf = text => {
  const parts = text.split(/\n(?=## )/)
  return parts[0].startsWith('## ') ? parts : parts.slice(1)
}

/** The newest `count` entries of the incidents file, verbatim, newest last. */
export function recentIncidents(project, count = 3, max = 1600) {
  let text = ''
  try { text = readFileSync(join(project, INCIDENTS_FILE), 'utf8') } catch { return '' }
  const sections = sectionsOf(text)
  const picked = sections.length ? sections.slice(-count).join('\n').trim() : tailOf(text, 30)
  return picked.length > max ? picked.slice(-max) : picked
}

/** Keep the newest MAX_INCIDENTS entries; returns how many were dropped. */
export function trimIncidents(project, keep = MAX_INCIDENTS) {
  const path = join(project, INCIDENTS_FILE)
  if (!existsSync(path)) return 0
  const text = readFileSync(path, 'utf8')
  const parts = text.split(/\n(?=## )/)
  const head = parts[0].startsWith('## ') ? '' : parts.shift()
  if (parts.length <= keep) return 0
  const dropped = parts.length - keep
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, [head, ...parts.slice(-keep)].filter(Boolean).join('\n'))
  return dropped
}
