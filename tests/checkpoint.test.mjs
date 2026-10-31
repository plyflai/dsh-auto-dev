import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { captureCheckpoint, listCheckpoints, restoreCheckpoint, retireCheckpoints } from '../src/checkpoint.mjs'

// Keep leading whitespace: porcelain status uses it to mean "unstaged".
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).replace(/\n+$/, '')

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'adv3-ck-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

test('a checkpoint names the working tree without moving HEAD, the branch or the index', async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'a.txt'), 'two\n')
  writeFileSync(path.join(dir, 'b.txt'), 'new\n')
  git(dir, 'add', 'b.txt') // staged work must survive untouched
  const headBefore = git(dir, 'rev-parse', 'HEAD')
  const statusBefore = git(dir, 'status', '--porcelain')

  const checkpoint = await captureCheckpoint(dir, { slug: 'task-abc', tag: 'before', seq: 1 })
  assert.equal(checkpoint.ok, true)
  assert.equal(checkpoint.ref, 'refs/dsh-auto-dev/task-abc/1-before')
  assert.match(checkpoint.commit, /^[0-9a-f]{40}$/)

  assert.equal(git(dir, 'rev-parse', 'HEAD'), headBefore)
  assert.equal(git(dir, 'status', '--porcelain'), statusBefore)
  assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'two\n')
})

test('nothing to capture is reported, not faked', async () => {
  const dir = repo()
  const checkpoint = await captureCheckpoint(dir, { slug: 'task-abc', tag: 'before', seq: 1 })
  assert.equal(checkpoint.ok, false)
  assert.equal(checkpoint.skipped, 'no writes since the last commit')
})

test('a plain directory is not a git repository', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adv3-plain-'))
  const checkpoint = await captureCheckpoint(dir, { slug: 'task-abc', tag: 'before', seq: 1 })
  assert.equal(checkpoint.ok, false)
  assert.equal(checkpoint.skipped, 'not a git repository')
})

test('a repository without commits has nothing to compare against', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adv3-empty-'))
  git(dir, 'init', '-q')
  writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  const checkpoint = await captureCheckpoint(dir, { slug: 'task-abc', tag: 'before', seq: 1 })
  assert.equal(checkpoint.ok, false)
  assert.equal(checkpoint.skipped, 'no commits yet')
})

test('checkpoints list newest sequence first', async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'a.txt'), 'two\n')
  await captureCheckpoint(dir, { slug: 's', tag: 'before', seq: 1 })
  writeFileSync(path.join(dir, 'a.txt'), 'three\n')
  await captureCheckpoint(dir, { slug: 's', tag: 'after', seq: 2 })
  const listed = await listCheckpoints(dir, 's')
  assert.deepEqual(listed.map(row => `${row.seq}-${row.tag}`), ['2-after', '1-before'])
})

test('restoring brings the working tree back and leaves the index alone', async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'a.txt'), 'two\n')
  const checkpoint = await captureCheckpoint(dir, { slug: 's', tag: 'before', seq: 1 })
  writeFileSync(path.join(dir, 'a.txt'), 'wrecked\n')
  const stagedBefore = git(dir, 'diff', '--cached', '--name-only')
  const result = await restoreCheckpoint(dir, checkpoint.commit)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'two\n')
  assert.equal(git(dir, 'status', '--porcelain'), ' M a.txt', 'the change stays unstaged: restore never touches the index')
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), stagedBefore, 'the staging area is untouched')
})

test('restoring a checkpoint that no longer exists reports it', async () => {
  const dir = repo()
  const result = await restoreCheckpoint(dir, '0123456789012345678901234567890123456789')
  assert.equal(result.ok, false)
  assert.match(result.reason, /gone from this repository/)
})

test('a refused git call says why, and never reports an empty reason', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'v3-ck-msg-'))
  // Not a repository: `rev-parse` refuses, and the checkpoint reports a reason
  // that is a real sentence rather than "checkpoint failed: ".
  const result = await captureCheckpoint(repo, { slug: 's', tag: 'before', seq: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, 'not a git repository')
  assert.equal(result.skipped.endsWith(': '), false)
})

test('saves of all but the newest three tasks retire; the current task is always kept', async () => {
  const dir = repo()
  const saved = process.env.GIT_COMMITTER_DATE
  try {
    for (const [index, slug] of ['t1', 't2', 't3', 't4', 't5'].entries()) {
      process.env.GIT_COMMITTER_DATE = `2026-01-0${index + 1}T00:00:00Z`
      writeFileSync(path.join(dir, 'a.txt'), `${slug}\n`)
      await captureCheckpoint(dir, { slug, tag: 'before', seq: 1 })
    }
  } finally {
    if (saved === undefined) delete process.env.GIT_COMMITTER_DATE
    else process.env.GIT_COMMITTER_DATE = saved
  }
  const removed = await retireCheckpoints(dir, { current: 't1' })
  assert.deepEqual(removed.sort(), ['refs/dsh-auto-dev/t2/1-before', 'refs/dsh-auto-dev/t3/1-before'])
  const left = git(dir, 'for-each-ref', '--format=%(refname)', 'refs/dsh-auto-dev/').split('\n').sort()
  assert.deepEqual(left, ['refs/dsh-auto-dev/t1/1-before', 'refs/dsh-auto-dev/t4/1-before', 'refs/dsh-auto-dev/t5/1-before'])
})
