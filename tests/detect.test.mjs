import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectVerifier } from '../src/detect.mjs'

const project = () => mkdtempSync(join(tmpdir(), 'v3-detect-'))

test('a package.json test script is the verifier', () => {
  const root = project()
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', build: 'tsc' } }))
  assert.deepEqual(detectVerifier(root), { command: 'npm test', source: 'package.json scripts.test' })
})

test('with no test script the next declared check is used, not an invented one', () => {
  const root = project()
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .', build: 'tsc' } }))
  assert.deepEqual(detectVerifier(root), { command: 'npm run lint', source: 'package.json scripts.lint' })
})

test('a project that declares nothing gets nothing', () => {
  const root = project()
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { start: 'node .' } }))
  assert.equal(detectVerifier(root), undefined)
})

test('other stacks are recognised from their own files', () => {
  const go = project()
  writeFileSync(join(go, 'go.mod'), 'module x\n')
  assert.equal(detectVerifier(go).command, 'go test ./...')

  const python = project()
  writeFileSync(join(python, 'pyproject.toml'), '[project]\nname = "x"\n')
  assert.equal(detectVerifier(python).command, 'pytest -q')

  const make = project()
  writeFileSync(join(make, 'Makefile'), 'build:\n\t@echo hi\ntest:\n\t@echo test\n')
  assert.equal(detectVerifier(make).command, 'make test')
})

test('a tests directory with no declared runner still gets a runnable check', () => {
  const root = project()
  mkdirSync(join(root, 'tests'))
  assert.deepEqual(detectVerifier(root), { command: 'node --test', source: 'tests/ with no declared runner' })
})
