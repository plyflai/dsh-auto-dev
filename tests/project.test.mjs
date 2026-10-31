import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveProject } from '../src/project.mjs'

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
