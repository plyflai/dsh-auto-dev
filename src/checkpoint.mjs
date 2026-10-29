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
  const ref = `refs/auto-dev-v3/${slug}/${seq}-${tag}`
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
  const listed = await git(project, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/auto-dev-v3/${slug}/`], { allowFailure: true })
  if (!listed.ok) return []
  return listed.out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [ref, commit] = line.split(' ')
      const tail = ref.slice(`refs/auto-dev-v3/${slug}/`.length)
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
