import test from 'node:test'
import assert from 'node:assert/strict'
import { irreversibleIn, filePathOf, risksOfCall, isProtectedPath } from '../src/risk.mjs'

test('G2 is an exact list: program and flags, nothing read from meaning', () => {
  for (const [command, risk] of [
    ['git reset --hard HEAD~1', 'forced-git-reset'],
    ['git clean -fdx', 'forced-git-reset'],
    ['git push --force origin main', 'force-push'],
    ['git push origin --delete feature', 'force-push'],
    ['git branch -D old', 'forced-git-reset'],
    ['npm publish', 'disk-or-package'],
    ['cd app && terraform destroy', 'infrastructure'],
    ['sudo kubectl delete pod x', 'infrastructure'],
    ['FOO=1 vercel --prod', 'deploy'],
  ]) assert.deepEqual(irreversibleIn(command), [risk], command)
})

test('anything not on the list runs: deletes, tests, reads, quoted text', () => {
  for (const command of [
    'rm -rf src', 'rm -f a.js', 'npm test', 'git status', 'git push origin main', 'git reset HEAD a.js',
    'echo "git reset --hard"', "node -e 'console.log(\"npm publish\")'",
    'cat <<EOF > notes.md\ngit push --force\nEOF',
  ]) assert.deepEqual(irreversibleIn(command), [], command)
})

test('G3 and the control plane see only a file tool\'s own path', () => {
  assert.equal(filePathOf({ name: 'write', arguments: { file_path: '.auto-dev/memory.json' } }), '.auto-dev/memory.json')
  assert.equal(filePathOf({ name: 'bash', arguments: { command: 'echo x > .auto-dev/memory.json' } }), '')
  assert.deepEqual(risksOfCall({ name: 'edit', arguments: { path: '/repo/.github/workflows/ci.yml' } }).destructive, ['control-plane'])
  assert.deepEqual(risksOfCall({ name: 'bash', arguments: { command: 'echo x > .github/workflows/ci.yml' } }).destructive, [])
  // The files the plugin asks the model to write are not the control plane.
  assert.deepEqual(risksOfCall({ name: 'write', arguments: { path: '/repo/.auto-dev/incidents.md' } }).destructive, [])
  assert.deepEqual(risksOfCall({ name: 'write', arguments: { path: '.auto-dev/project-domain.md' } }).destructive, [])
})

test('a protected prefix matches an absolute path at a segment boundary', () => {
  assert.equal(isProtectedPath('/repo/.auto-dev/runtime.json'), true)
  assert.equal(isProtectedPath('/repo/not.auto-dev/x'), false)
  assert.equal(isProtectedPath('src/a.js'), false)
})
