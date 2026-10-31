/**
 * What this project is, in the few facts somebody keeps asking.
 *
 * The old `.autodev/path.md` grew without limit and without expiry: a fact written
 * a year ago read exactly like a fact written yesterday, and nobody could tell a
 * command that had been run from a command somebody once typed. This file keeps the
 * same idea with two properties that file lacked:
 *
 *   - every fact names its source and whether it is observed or confirmed by the person;
 *   - the list has a ceiling, and a fact that keeps failing goes stale instead of
 *     quietly poisoning every later start.
 *
 * `blocked` is separated from `facts` because it is not knowledge, it is a promise:
 * the irreversible-call gate reads it, so a project can say "never touch this" once
 * and mean it.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { commandsOf } from './risk.mjs'

export const ENV_FILE = '.auto-dev/runtime.json'
export const MAX_FACTS = 40
export const FACT_KINDS = ['fact', 'lock', 'blocked', 'release', 'gui']

const EMPTY = () => ({ version: 1, facts: [], lock: [], blocked: [], release: [], gui: [], candidates: [] })

const text = value => (typeof value === 'string' ? value.trim() : '')

const sanitize = row => {
  if (!row || typeof row !== 'object') return undefined
  const entry = {
    id: text(row.id) || undefined,
    key: text(row.key),
    ...(FACT_KINDS.includes(row.kind) ? { kind: row.kind } : {}),
    ...(Array.isArray(row.history) ? { history: row.history } : {}),
    ...(row.staleSource ? { staleSource: row.staleSource } : {}),
    value: text(row.value),
    ...(text(row.command) ? { command: text(row.command) } : {}),
    ...(text(row.note) ? { note: text(row.note) } : {}),
    status: row.status === 'confirmed' || row.status === 'stale' ? row.status : 'observed',
    ...(row.source && typeof row.source === 'object' ? { source: row.source } : {}),
    ...(text(row.at) ? { at: text(row.at) } : {}),
  }
  return entry.key && entry.value ? entry : undefined
}

/** Read the record; a missing or broken file is an empty record, never an error. */
export async function readEnv(project) {
  if (typeof project !== 'string' || project === '') return EMPTY()
  try {
    const raw = await readFile(join(project, ENV_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    const row = parsed && typeof parsed === 'object' ? parsed : {}
    const section = name => (Array.isArray(row[name]) ? row[name].map(sanitize).filter(Boolean) : [])
    return { version: 1, facts: section('facts'), lock: section('lock'), blocked: section('blocked'), release: section('release'), gui: section('gui'), candidates: section('candidates') }
  } catch {
    return EMPTY()
  }
}

export async function writeEnv(project, env) {
  const dir = join(project, '.auto-dev')
  await mkdir(dir, { recursive: true })
  const body = JSON.stringify({ version: 1, facts: env.facts ?? [], lock: env.lock ?? [], blocked: env.blocked ?? [], release: env.release ?? [], gui: env.gui ?? [], candidates: env.candidates ?? [] }, null, 2)
  await writeFile(join(project, ENV_FILE), `${body}\n`, 'utf8')
}

/** The line the model gets at the top of a task: what this project is, in one paragraph. */
export function envDigest(env) {
  const confirmed = (env.facts ?? []).filter(row => row.status === 'confirmed')
  const observed = (env.facts ?? []).filter(row => row.status === 'observed')
  const stale = (env.facts ?? []).filter(row => row.status === 'stale')
  const usable = [...confirmed, ...observed]
  const named = usable.slice(0, 6).map(row => `${row.key}: ${row.value}（${row.status}; ${row.source?.by ?? 'unknown'}; ${row.at ?? 'time unknown'}）`)
  return {
    confirmed: confirmed.length,
    usable: usable.length,
    observations: [...usable, ...(env.gui ?? []).filter(row => row.status !== 'stale')].map(row => ({ key: row.key, value: row.value, status: row.status, source: row.source, at: row.at })),
    observed: observed.length,
    stale: stale.length,
    blocked: (env.blocked ?? []).filter(row => row.status === 'confirmed').length,
    // Release and GUI are the same mechanism as a start command: a command somebody
    // ran, a URL somebody opened. They stay separate only so the board can name them.
    release: (env.release ?? []).filter(row => row.status === 'confirmed').map(row => `${row.key}: ${row.value}`),
    gui: (env.gui ?? []).filter(row => row.status === 'confirmed' || row.status === 'observed').map(row => `${row.key}: ${row.value}（${row.status}; ${row.source?.by ?? 'unknown'}; ${row.at ?? 'time unknown'}）`),
    lock: (env.lock ?? []).filter(row => row.status === 'confirmed').map(row => row.key),
    lines: named,
    pending: (env.candidates ?? []).length,
  }
}

/** One line for the model's context, or nothing when there is nothing worth saying. */
export function envLine(digest) {
  if (!digest || (!digest.lines.length && !digest.gui?.length)) return ''
  const head = [...digest.lines, ...(digest.gui ?? [])].slice(0, 3).join('；')
  const tail = digest.confirmed > 3 ? `（还有 ${digest.confirmed - 3} 条，读 ${ENV_FILE}）` : ''
  return `这个项目记过：${head}${tail}`
}

/**
 * The fragments of a blocked row worth matching against a path: its key, and
 * path-like words in its value. "不许改 migrations/ 下的历史文件" → ["migrations"].
 */
export function needlesOf(row) {
  const words = String(row?.value ?? '').split(/[\s，。、；;:：()（）"'“”]+/)
  return [row?.key, ...words]
    .map(word => String(word ?? '').trim().toLowerCase().replace(/\/+$/, ''))
    .filter(word => word.length >= 2 && (word.includes('/') || /^[a-z0-9._-]+$/.test(word)))
}

/** The first live blocked row one of `paths` falls under (G3), or undefined. Paths only, never command text. */
export function blockedBy(env, paths = []) {
  const lower = paths.map(path => String(path).toLowerCase())
  for (const row of env?.blocked ?? []) {
    if (row.status === 'stale') continue
    const path = lower.find(path => needlesOf(row).some(needle => path.split('/').includes(needle) || path.includes(`${needle}/`) || path.endsWith(needle)))
    if (path) return { row, path: paths[lower.indexOf(path)] }
  }
  return undefined
}

/**
 * The first live blocked row whose value is a command the person wrote, run as
 * one of the simple commands on this line: its words, in order, at the start.
 * "psql prod" blocks `psql prod -c …`, never `echo psql prod`.
 */
export function blockedCommand(env, command) {
  const runs = commandsOf(command ?? '')
  for (const row of env?.blocked ?? []) {
    if (row.status === 'stale') continue
    const words = String(row.value ?? '').trim().split(/\s+/).filter(Boolean)
    if (!words.length || !/^[\w.-]+$/.test(words[0])) continue
    if (runs.some(run => words.every((word, index) => run[index] === word))) return { row, command }
  }
  return undefined
}
