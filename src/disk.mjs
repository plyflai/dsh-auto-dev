/**
 * The project's working tree as a fingerprint, taken only at the moments a flow
 * needs one (设计约定「第三条路」): when a task starts, when the project's own
 * check passes, and at hand-in. Never per call, never from shell text.
 *
 * Tracked files are hashed into a tree object through a private index copied
 * from the real one, so the person's index, HEAD and branches never move; only
 * the changes to tracked files reach the object store (the size of a `git stash`,
 * unreachable, collected by `git gc`). Untracked files are fingerprinted by
 * (path, size, mtime) in memory and never written as objects — a repository with
 * thousands of untracked files must not grow by their contents (大原则 8).
 *
 * Retirement: the private index is one file per project, overwritten each time;
 * the marks below are capped at MARKS tasks, oldest dropped.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative } from 'node:path'
import { incidentsChangedAt } from './facts.mjs'

const run = promisify(execFile)
const MARKS = 200
const marks = new Map()
const roots = new Map()
const OWN = '.auto-dev'

async function git(project, args, env) {
  try {
    const { stdout } = await run('git', ['-C', project, ...args], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}) })
    return stdout
  } catch {
    return undefined
  }
}

async function rootOf(project) {
  if (!roots.has(project)) roots.set(project, (await git(project, ['rev-parse', '--show-toplevel']))?.trim() || null)
  return roots.get(project)
}

/** Where git's paths start, in the project's own spelling (/tmp/x, not /private/tmp/x). */
async function baseOf(project) {
  const root = await rootOf(project)
  let real = project
  try { real = realpathSync(project) } catch { /* keep the spelling given */ }
  return relative(real, root) === '' ? project : root
}

/**
 * `{ id, tree, untracked }` for the project right now, or undefined outside a
 * git repository. `untracked` maps git-relative path → "size:mtime".
 */
export async function fingerprint(project) {
  if (typeof project !== 'string' || project === '' || !await rootOf(project)) return undefined
  const dir = join(tmpdir(), 'dsh-auto-dev-index')
  const index = join(dir, createHash('sha1').update(project).digest('hex').slice(0, 16))
  mkdirSync(dir, { recursive: true })
  // A fresh copy each time: the real index's stat cache keeps `add -u` a stat walk,
  // and files the person staged or committed since are tracked here too.
  const real = (await git(project, ['rev-parse', '--git-path', 'index']))?.trim()
  const path = real && (isAbsolute(real) ? real : join(project, real))
  try { if (path && existsSync(path)) copyFileSync(path, index); else rmSync(index, { force: true }) } catch { /* an empty index only costs a full hash */ }
  const env = { ...process.env, GIT_INDEX_FILE: index }
  if (await git(project, ['add', '-u', '--', '.', `:(exclude)${OWN}`], env) === undefined) return undefined
  const tree = (await git(project, ['write-tree'], env))?.trim()
  if (!tree) return undefined
  const base = await baseOf(project)
  const listed = await git(project, ['ls-files', '-o', '--exclude-standard', '-z', '--', '.', `:(exclude)${OWN}`], env) ?? ''
  const untracked = new Map()
  for (const name of listed.split('\0')) {
    if (!name) continue
    try {
      const stat = statSync(join(base, name))
      untracked.set(name, `${stat.size}:${stat.mtimeMs}`)
    } catch { /* gone between the listing and the stat */ }
  }
  const hash = createHash('sha1').update(tree)
  for (const name of [...untracked.keys()].sort()) hash.update(`\0${name}\0${untracked.get(name)}`)
  return { id: hash.digest('hex'), tree, untracked }
}

/** Files present in `before` and gone in `after`, absolute. Tracked and untracked. */
export async function vanished(project, before, after) {
  if (!before || !after || before.id === after.id) return []
  const base = await baseOf(project)
  const gone = []
  if (before.tree !== after.tree) {
    const out = await git(project, ['diff-tree', '-r', '--no-renames', '--name-status', before.tree, after.tree]) ?? ''
    for (const line of out.split('\n')) {
      const [status, path] = line.split('\t')
      if (status === 'D' && path) gone.push(join(base, path))
    }
  }
  for (const name of before.untracked.keys()) if (!after.untracked.has(name)) gone.push(join(base, name))
  return gone
}

/** Files added, changed or removed between two fingerprints, absolute. */
export async function changedPaths(project, before, after) {
  if (!before || !after || before.id === after.id) return []
  const base = await baseOf(project)
  const out = new Set()
  if (before.tree !== after.tree) {
    const listed = await git(project, ['diff-tree', '-r', '--no-renames', '--name-only', before.tree, after.tree]) ?? ''
    for (const path of listed.split('\n')) if (path) out.add(join(base, path))
  }
  for (const [name, stamp] of after.untracked) if (before.untracked.get(name) !== stamp) out.add(join(base, name))
  for (const name of before.untracked.keys()) if (!after.untracked.has(name)) out.add(join(base, name))
  return [...out]
}

// A stored fingerprint keeps at most this many untracked stamps; past it the
// untracked side is dropped and only tracked changes are told (宁可漏).
const STORED_UNTRACKED = 500

/** A fingerprint as plain data for a task record (it outlives the process). */
export const storedPrint = print => print && {
  tree: print.tree,
  ...(print.untracked.size <= STORED_UNTRACKED ? { untracked: [...print.untracked] } : {}),
}

/**
 * Files changed since a stored fingerprint, git-relative, sorted; undefined when
 * either side cannot be read (then nobody may say "nothing changed").
 */
export async function changedSinceStored(project, stored) {
  const now = typeof stored?.tree === 'string' ? await fingerprint(project) : undefined
  if (!now) return undefined
  const out = new Set()
  if (now.tree !== stored.tree) {
    const listed = await git(project, ['diff-tree', '-r', '--no-renames', '--name-only', stored.tree, now.tree])
    if (listed === undefined) return undefined
    for (const path of listed.split('\n')) if (path) out.add(path)
  }
  if (Array.isArray(stored.untracked)) {
    const before = new Map(stored.untracked)
    for (const [name, stamp] of now.untracked) if (before.get(name) !== stamp) out.add(name)
    for (const name of before.keys()) if (!now.untracked.has(name)) out.add(name)
  }
  return [...out].sort()
}

const markOf = taskId => {
  if (!marks.has(taskId)) {
    marks.set(taskId, {})
    if (marks.size > MARKS) marks.delete(marks.keys().next().value)
  }
  return marks.get(taskId)
}

/** The tree when the task first acted in this process. Once per task. */
export async function markStart(project, taskId) {
  const mark = markOf(taskId)
  if (!mark.start) {
    mark.start = await fingerprint(project)
    mark.incidentsAt = incidentsChangedAt(project)
  }
  return mark.start
}

/** The project's check just passed here: this is the tree it covers. */
export async function markGreen(project, taskId, seq) {
  const print = await fingerprint(project)
  if (print) markOf(taskId).green = { print, seq }
  return print
}

/** What this process knows about a task: `{ start?, incidentsAt?, green?: { print, seq } }`. */
export const marksOf = taskId => marks.get(taskId) ?? {}

/** Tests set marks directly. */
export function setMarks(taskId, value) {
  marks.set(taskId, { ...value })
  if (marks.size > MARKS) marks.delete(marks.keys().next().value)
}
