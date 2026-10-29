import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveScopeRoot } from '../src/scope-root.mjs'

function fixture(layout) {
  const root = mkdtempSync(path.join(tmpdir(), 'v3-scope-root-'))
  for (const entry of layout) {
    const target = path.join(root, entry)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, '// fixture\n')
  }
  return { root, drop: () => rmSync(root, { recursive: true, force: true }) }
}

test('a scope that resolves at the recorded root keeps that root', () => {
  const fixtureRoot = fixture(['calc.mjs', 'calc.test.mjs'])
  try {
    const result = resolveScopeRoot(fixtureRoot.root, ['calc.mjs', 'calc.test.mjs'])
    assert.equal(result.project, fixtureRoot.root)
    assert.equal(result.adjusted, false)
  } finally {
    fixtureRoot.drop()
  }
})

test('a scope that exists under exactly one subdirectory moves the root there', () => {
  // The observed defect: a subagent works in `journey-e/`, the session records
  // the parent directory, and every declared path then matches nothing.
  const fixtureRoot = fixture(['journey-e/str.mjs', 'journey-e/str.test.mjs', 'other/notes.md'])
  try {
    const result = resolveScopeRoot(fixtureRoot.root, ['str.mjs', 'str.test.mjs'])
    assert.equal(result.project, path.join(fixtureRoot.root, 'journey-e'))
    assert.equal(result.adjusted, true)
    assert.match(result.reason, /journey-e/)
  } finally {
    fixtureRoot.drop()
  }
})

test('two plausible subdirectories are reported, not guessed', () => {
  const fixtureRoot = fixture(['one/str.mjs', 'two/str.mjs'])
  try {
    const result = resolveScopeRoot(fixtureRoot.root, ['str.mjs'])
    assert.equal(result.project, fixtureRoot.root)
    assert.equal(result.adjusted, false)
    assert.deepEqual(result.candidates, ['one', 'two'])
    assert.match(result.reason, /declare the subdirectory/)
  } finally {
    fixtureRoot.drop()
  }
})

test('paths that exist nowhere leave the recorded root alone', () => {
  // A task may legitimately declare files it has not created yet.
  const fixtureRoot = fixture(['notes.md'])
  try {
    const result = resolveScopeRoot(fixtureRoot.root, ['new.mjs'])
    assert.equal(result.project, fixtureRoot.root)
    assert.equal(result.adjusted, false)
    assert.match(result.reason, /recorded root stands/)
  } finally {
    fixtureRoot.drop()
  }
})

test('a partial match under a subdirectory is not enough to move the root', () => {
  const fixtureRoot = fixture(['pkg/a.mjs'])
  try {
    const result = resolveScopeRoot(fixtureRoot.root, ['a.mjs', 'b.mjs'])
    assert.equal(result.project, fixtureRoot.root)
    assert.equal(result.adjusted, false)
  } finally {
    fixtureRoot.drop()
  }
})

test('scopes covering the whole project or nothing at all never move', () => {
  const fixtureRoot = fixture(['pkg/a.mjs'])
  try {
    assert.equal(resolveScopeRoot(fixtureRoot.root, ['.']).project, fixtureRoot.root)
    assert.equal(resolveScopeRoot(fixtureRoot.root, []).project, fixtureRoot.root)
    assert.equal(resolveScopeRoot(fixtureRoot.root, undefined).project, fixtureRoot.root)
  } finally {
    fixtureRoot.drop()
  }
})
