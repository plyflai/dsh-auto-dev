/**
 * Checkpoints: keep a restorable copy of the working tree without ever moving
 * HEAD, a branch, the index or the staging area.
 *
 * `git stash create` builds a commit object from the current working tree and
 * exits — it does not touch HEAD, does not stash anything, and does not change
 * the index. The object is unreachable until we point a ref at it, which is
 * exactly what a checkpoint is: a name for a state that already exists on disk.
 *
 * A checkpoint is not a backup of the machine: it captures tracked files (and
 * the untracked ones git was told about) inside the repository, not a database,
 * not a running service, not something a script wrote outside the repo.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

async function git(project, args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await run('git', ['-C', project, ...args], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })
    return { ok: true, out: stdout.trim() }
  } catch (error) {
    if (!allowFailure) throw error
    // git sometimes refuses with an empty stderr (a killed run, a lock, a hook
    // writing to the tty). Reporting `checkpoint failed: ` with nothing after the
    // colon tells a reader nothing, so fall through the candidates and name the
    // argv that failed when even those are empty.
    const detail = [String(error?.stderr ?? '').trim(), String(error?.message ?? '').trim(), String(error?.code ?? '').trim()]
      .find(candidate => candidate !== '')
    return { ok: false, reason: detail ?? `git ${args[0]} exited without a message` }
  }
}

/** The last few commits with the files they touched; empty outside a repository. */
export async function recentCommits(project, count = 5) {
  if (typeof project !== 'string' || project === '') return []
  const listed = await git(project, ['log', `-${count}`, '--name-only', '--format=%x00%h %s'], { allowFailure: true })
  if (!listed.ok) return []
  return listed.out.split('\0').map(chunk => chunk.trim()).filter(Boolean).map(chunk => {
    const [head, ...files] = chunk.split('\n').map(line => line.trim()).filter(Boolean)
    return { head, files }
  })
}

/**
 * Files still naming what was deleted: `git grep -w` on each path's stem, in
 * tracked files. Empty outside a repository or for a stem too short to mean anything.
 */
export async function referencesTo(project, paths = []) {
  if (typeof project !== 'string' || project === '') return []
  const found = []
  for (const path of paths.slice(0, 5)) {
    const base = path.split('/').pop() ?? ''
    const stem = base.replace(/\.[^.]+$/, '')
    if (stem.length < 3 || /^(index|main|test|tests|src|lib|utils?)$/i.test(stem)) continue
    const listed = await git(project, ['grep', '-l', '-w', '-F', '-e', stem], { allowFailure: true })
    if (!listed.ok) continue
    for (const file of listed.out.split('\n').map(line => line.trim()).filter(Boolean)) {
      if (!path.endsWith(file) && !found.some(row => row.file === file)) found.push({ file, name: stem })
    }
  }
  return found
}

/**
 * Capture the current working tree of `project` under a checkpoint ref.
 *
 * @param project absolute repository path
 * @param {object} options
 * @param {string} options.slug short task slug used in the ref name
 * @param {string} options.tag `before`, `after` or `auto`, kept in the ref name
 *   so a person reading `git for-each-ref` can tell which side of a submission
 *   it is — and which ones are the rotating background copies
 * @param {(prefix: string) => string} options.newId id factory for the sequence
 * @returns {Promise<{ok: boolean, skipped?: string, ref?: string, commit?: string, at?: string}>}
 */
export async function captureCheckpoint(project, { slug, tag, seq }) {
  const inside = await git(project, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true })
  if (!inside.ok || inside.out !== 'true') return { ok: false, skipped: 'not a git repository' }
  const head = await git(project, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true })
  if (!head.ok) return { ok: false, skipped: 'no commits yet' }
  const created = await git(project, ['stash', 'create'], { allowFailure: true })
  if (!created.ok) return { ok: false, skipped: `checkpoint failed: ${created.reason}` }
  if (created.out === '') return { ok: false, skipped: 'no writes since the last commit' }
  const commit = created.out
  const ref = `refs/dsh-auto-dev/${slug}/${seq}-${tag}`
  const written = await git(project, ['update-ref', ref, commit], { allowFailure: true })
  if (!written.ok) return { ok: false, skipped: `checkpoint failed: ${written.reason}` }
  return { ok: true, ref, commit, at: new Date().toISOString() }
}

/**
 * Restore the working tree (never the index, never HEAD) from a checkpoint.
 *
 * This overwrites uncommitted work inside the repository, so the caller must
 * have recorded the owner's agreement first — a restore is the one action in
 * this plugin that can destroy something a person typed.
 *
 * @param project absolute repository path
 * @param commit checkpoint commit object
 * @returns {Promise<{ok: boolean, reason?: string, restored?: number}>}
 */
export async function restoreCheckpoint(project, commit) {
  const exists = await git(project, ['cat-file', '-e', `${commit}^{commit}`], { allowFailure: true })
  if (!exists.ok) return { ok: false, reason: 'that checkpoint object is gone from this repository' }
  const restored = await git(project, ['restore', `--source=${commit}`, '--worktree', '--', '.'], { allowFailure: true })
  if (!restored.ok) return { ok: false, reason: `restore failed: ${restored.reason}` }
  const changed = await git(project, ['diff', '--name-only'], { allowFailure: true })
  return { ok: true, restored: changed.ok ? changed.out.split('\n').filter(Boolean).length : 0 }
}

/**
 * List the checkpoints of one task, newest sequence first.
 *
 * @param project absolute repository path
 * @param slug short task slug
 * @returns {Promise<Array<{ref: string, commit: string, seq: string, tag: string}>>}
 */
export async function listCheckpoints(project, slug) {
  const listed = await git(project, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/dsh-auto-dev/${slug}/`], { allowFailure: true })
  if (!listed.ok) return []
  return listed.out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [ref, commit] = line.split(' ')
      const tail = ref.slice(`refs/dsh-auto-dev/${slug}/`.length)
      const dash = tail.lastIndexOf('-')
      return { ref, commit, seq: tail.slice(0, dash), tag: tail.slice(dash + 1) }
    })
    .sort((a, b) => Number(b.seq) - Number(a.seq))
}

/**
 * Keep only the newest `keep` automatic checkpoints of one task.
 *
 * Automatic copies are the background safety net (`work_submit` takes one each
 * time), so they rotate instead of growing without bound. Boss checkpoints are
 * never touched: a pair around something demonstrable is the record, not noise.
 *
 * @param project absolute repository path
 * @param slug short task slug
 * @param keep how many newest automatic refs to keep
 * @returns {Promise<number>} how many refs were dropped
 */
export async function rotateCheckpoints(project, slug, keep = 5) {
  const listed = await listCheckpoints(project, slug)
  const automatic = listed.filter(row => row.tag === 'auto')
  let dropped = 0
  // Newest first already; everything past the keep count is deleted oldest-last.
  for (const row of automatic.slice(keep)) {
    const removed = await git(project, ['update-ref', '-d', row.ref], { allowFailure: true })
    if (removed.ok) dropped += 1
  }
  return dropped
}

/** Saves of how many tasks stay in the repository (设计约定 大原则 8：有存就有退役). */
export const KEEP_TASKS = 3

/**
 * Retire the saves of all but the newest `keep` tasks, by the time of each task's
 * newest save. The task `current` is never retired. Returns the refs removed.
 */
export async function retireCheckpoints(project, { keep = KEEP_TASKS, current } = {}) {
  const listed = await git(project, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/dsh-auto-dev/'], { allowFailure: true })
  if (!listed.ok) return []
  const order = []
  const refs = new Map()
  for (const ref of listed.out.split('\n').filter(Boolean)) {
    const slug = ref.slice('refs/dsh-auto-dev/'.length).split('/')[0]
    if (!refs.has(slug)) { refs.set(slug, []); order.push(slug) }
    refs.get(slug).push(ref)
  }
  const kept = new Set([current, ...order.filter(slug => slug !== current).slice(0, Math.max(0, keep - (current && refs.has(current) ? 1 : 0)))])
  const removed = []
  for (const slug of order) {
    if (kept.has(slug)) continue
    for (const ref of refs.get(slug)) {
      if ((await git(project, ['update-ref', '-d', ref], { allowFailure: true })).ok) removed.push(ref)
    }
  }
  return removed
}
