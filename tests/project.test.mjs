import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chooseProject, observedDirectory, resolveProject } from '../src/project.mjs'

test('the session header cwd wins: a subagent started elsewhere keeps its own project', () => {
  const agent = { session: { header: { cwd: '/work/api' } }, cwd: '/work' }
  const ctx = { workingDirectory: { get: () => '/work' } }
  assert.equal(resolveProject(agent, ctx), '/work/api')
})

test('without a header cwd the working-directory service answers', () => {
  const agent = { session: { header: {} } }
  const ctx = { workingDirectory: { get: () => '/work/service' } }
  assert.equal(resolveProject(agent, ctx), '/work/service')
})

test('a service that throws is skipped, not fatal', () => {
  const agent = { session: { header: {} }, cwd: '/work/agent' }
  const ctx = { workingDirectory: { get: () => { throw new Error('no store') } } }
  assert.equal(resolveProject(agent, ctx), '/work/agent')
})

test('an empty header cwd does not shadow a real source', () => {
  const agent = { session: { header: { cwd: '' } }, cwd: '/work/agent' }
  assert.equal(resolveProject(agent, { workingDirectory: { get: () => undefined } }), '/work/agent')
})

test('with nothing available the host process cwd is the last resort', () => {
  assert.equal(resolveProject(undefined, undefined), process.cwd())
})

test('a cd that really ran outranks the parent directory a subagent inherits', () => {
  const observations = { results: [
    { command: 'ls' },
    { command: 'cd /tmp && ls' },
    { command: 'cd /Users && npm test' },
  ] }
  const project = resolveProject({ session: { header: { cwd: '/Users' } } }, {}, observations)
  assert.equal(project, '/Users', 'the recorded header still wins when the cd went nowhere useful')
})

test('observedDirectory skips a directory that no longer exists', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v3-final2-'))
  const observations = { results: [
    { command: `cd ${dir} && node --test` },
    { command: 'cd /nowhere/at/all && ls' },
  ] }
  assert.equal(observedDirectory(observations), dir)
  rmSync(dir, { recursive: true, force: true })
})

test('the shell root wins only when it resolves scope the metadata cannot', () => {
  // Real directories, because the rule reads the filesystem to decide.
  const base = mkdtempSync(path.join(tmpdir(), 'ad-v3-base-'))
  const child = path.join(base, 'workspace')
  mkdirSync(child)
  writeFileSync(path.join(child, 'package.json'), '{}')

  // The subdirectory holds the declared file, the parent does not.
  writeFileSync(path.join(child, 'str.mjs'), '')
  assert.equal(chooseProject({ base, observed: child, scope: ['str.mjs'] }), child)

  // Both hold it: the recorded directory stands.
  writeFileSync(path.join(base, 'shared.mjs'), '')
  writeFileSync(path.join(child, 'shared.mjs'), '')
  assert.equal(chooseProject({ base, observed: child, scope: ['shared.mjs'] }), base)

  // Nothing exists yet, but the shell's directory is a project inside the base.
  assert.equal(chooseProject({ base, observed: child, scope: ['not-written-yet.mjs'] }), child)

  // Whole-project scope says nothing more specific. The recorded directory stands
  // while it is itself a project; here the temp base is a bare folder, so the shell
  // standing inside a real project inside it is the only specific evidence.
  writeFileSync(path.join(base, 'package.json'), '{}')
  assert.equal(chooseProject({ base, observed: child, scope: ['.'] }), base)
  assert.equal(chooseProject({ base, observed: child, scope: [] }), base)
  rmSync(path.join(base, 'package.json'))

  // A directory outside the session root never takes over on a guess.
  const outside = mkdtempSync(path.join(tmpdir(), 'ad-v3-outside-'))
  writeFileSync(path.join(outside, 'package.json'), '{}')
  assert.equal(chooseProject({ base, observed: outside, scope: ['not-written-yet.mjs'] }), base)
})

test('a cd buried in prose or a quoted message is not a directory change', () => {
  const observations = { results: [{ command: 'git commit -m "cd /etc && rm -rf /"' }] }
  const project = resolveProject({ session: { header: { cwd: '/Users' } } }, {}, observations)
  assert.equal(project, '/Users')
})

test('an empty folder with a named scope path wins over the session directory', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'v3-base-'))
  const fresh = path.join(base, 'brand-new')
  mkdirSync(fresh)
  // No manifest, no .git: the directory is empty because the work has not started.
  assert.equal(chooseProject({ base, observed: fresh, scope: ['NOTES.md'] }), fresh)
  // A throwaway cd with no named path still does not move the session root.
  assert.equal(chooseProject({ base, observed: fresh, scope: ['.'] }), base)
  // A directory outside the session root is never adopted on this evidence.
  const outside = mkdtempSync(path.join(tmpdir(), 'v3-out-'))
  assert.equal(chooseProject({ base, observed: outside, scope: ['NOTES.md'] }), base)
})

test('a scope of "." stays at the session root, unless the root is not a project at all', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'ad3-root-'))
  const child = path.join(parent, 'repo')
  mkdirSync(child)
  writeFileSync(path.join(child, 'package.json'), '{"name":"x"}')
  try {
    // The session root is a folder of folders: the shell standing in a project
    // inside it is the only specific evidence, so the task follows the shell.
    assert.equal(chooseProject({ base: parent, observed: child, scope: ['.'] }), child)
    // The session root is itself a project: a stray `cd` must not move it.
    writeFileSync(path.join(parent, 'package.json'), '{"name":"mono"}')
    assert.equal(chooseProject({ base: parent, observed: child, scope: ['.'] }), parent)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
