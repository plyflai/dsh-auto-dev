import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyCommand, shellWritePaths, risksOfCall, inScope, isCheckCommand, isProtectedPath, scopeViolations } from '../src/risk.mjs'
import { classifyObservations } from '../src/task.mjs'

test('a quoted description of an action is not the action', () => {
  assert.deepEqual(classifyCommand('git commit -m "rm -rf tmp"').destructive, [])
  // Payload rules still read inside quotes: that is where SQL lives.
  assert.deepEqual(classifyCommand('psql -c "delete from prod.users"').production, ['production-write'])
  // A heredoc body is data handed to an interpreter, not shell about to run.
  const heredoc = "python3 - <<'PY'\nPRODUCTION = 1\np.write_text(s)\nPY"
  assert.deepEqual(classifyCommand(heredoc).production, [])
})

test('a recursive delete is destructive', () => {
  // Deleting toolchain output is recoverable by rebuilding, so it is a mutation
  // without being irreversible; deleting source is both.
  assert.deepEqual(classifyCommand('rm -rf build').destructive, [])
  assert.deepEqual(classifyCommand('rm -rf src').destructive, ['recursive-delete'])
  assert.deepEqual(classifyCommand('rm -rf node_modules src').destructive, ['recursive-delete'])
  assert.equal(classifyCommand('rm build/app.js').destructive.length, 0)
  assert.equal(classifyCommand('rm build/app.js').mutating, true)
})

test('history rewrites and force pushes are destructive', () => {
  assert.ok(classifyCommand('git push --force origin main').destructive.includes('forced-git-reset'))
  assert.ok(classifyCommand('git reset --hard HEAD~3').destructive.includes('forced-git-reset'))
  assert.ok(classifyCommand('git rebase -i HEAD~2').destructive.includes('history-rewrite'))
})

test('a deploy is production, not destructive', () => {
  const verdict = classifyCommand('npm run deploy -- --prod')
  assert.deepEqual(verdict.production, ['deploy'])
  assert.deepEqual(verdict.destructive, [])
})

test('reads are not mutations', () => {
  for (const command of ['ls -la', 'git status', 'npm test', 'cat package.json', 'node --version']) {
    assert.equal(classifyCommand(command).mutating, false, command)
  }
})

test('scope containment respects prefixes and the root sentinel', () => {
  assert.equal(inScope('src/a.js', ['src']), true)
  assert.equal(inScope('tests/a.js', ['src']), false)
  assert.equal(inScope('anything/a.js', ['.']), true)
  assert.equal(inScope('anything/a.js', []), true)
  assert.deepEqual(scopeViolations(['src/a.js', 'docs/b.md'], ['src']), ['docs/b.md'])
})

test('control-plane prefixes are protected by default', () => {
  assert.equal(isProtectedPath('.auto-dev/ledger.json'), true)
  assert.equal(isProtectedPath('.github/workflows/ci.yml'), true)
  assert.equal(isProtectedPath('src/index.js'), false)
})

test('observations are bucketed into writes, destructive and production', () => {
  const observations = { results: [
    { seq: 1, callId: 'c1', name: 'bash', command: 'npm test', isError: false },
    { seq: 2, callId: 'c2', name: 'bash', command: 'rm -rf src', isError: false },
    { seq: 3, callId: 'c3', name: 'edit', path: '.auto-dev/ledger.json', isError: false },
    { seq: 4, callId: 'c4', name: 'bash', command: 'npm run deploy', isError: false },
  ] }
  const classified = classifyObservations(observations)
  assert.deepEqual(classified.writes.map(entry => entry.path), ['.auto-dev/ledger.json'])
  assert.deepEqual(classified.destructive.map(entry => entry.callId), ['c2', 'c3'])
  assert.deepEqual(classified.production.map(entry => entry.callId), ['c4'])
})

test('a recursive delete confined to OS temp paths is not irreversible', () => {
  assert.deepEqual(classifyCommand('rm -rf /tmp/e2e-v3').destructive, [])
  assert.deepEqual(classifyCommand('rm -rf /tmp/a /tmp/b').destructive, [])
  // one real target is enough to make the whole command destructive again
  assert.deepEqual(classifyCommand('rm -rf /tmp/a ./src').destructive, ['recursive-delete'])
  assert.deepEqual(classifyCommand('rm -rf .').destructive, ['recursive-delete'])
  // A redirection or a comment after the targets is not a target.
  assert.deepEqual(classifyCommand('rm -rf /tmp/a /tmp/b 2>/dev/null').destructive, [])
  assert.deepEqual(classifyCommand('rm -rf src 2>/dev/null').destructive, ['recursive-delete'])
})

test('the risk of the call that is running is read from its own arguments', () => {
  const call = { name: 'bash', arguments: { command: 'rm -rf ./src' } }
  assert.deepEqual(risksOfCall(call).destructive, ['recursive-delete'])
  assert.deepEqual(risksOfCall({ name: 'bash', arguments: { command: 'npm test' } }).destructive, [])
  assert.deepEqual(risksOfCall({ name: 'bash', arguments: 'not-an-object' }).destructive, [])
})

test('a write to a protected path is a control-plane action, judged from the call itself', () => {
  const call = { name: 'edit', arguments: { path: '.auto-dev/ledger.json' } }
  assert.deepEqual(risksOfCall(call).destructive, ['control-plane'])
  assert.deepEqual(risksOfCall({ name: 'read', arguments: { path: '.auto-dev/ledger.json' } }).destructive, [])
})

test('scratch deletes stay exempt when the call is judged on its own', () => {
  const call = { name: 'bash', arguments: { command: 'rm -rf /tmp/e2e-scratch' } }
  assert.deepEqual(risksOfCall(call).destructive, [])
})

test('a line that runs a check is recognised as a check, a plain write is not', () => {
  assert.equal(isCheckCommand('npm test'), true)
  assert.equal(isCheckCommand('cd app && npm run build'), true)
  assert.equal(isCheckCommand('node --test tests/*.test.mjs'), true)
  assert.equal(isCheckCommand('node --check src/index.js'), true)
  assert.equal(isCheckCommand('pytest -q'), true)
  assert.equal(isCheckCommand('curl -s localhost:3000/health'), true)
  assert.equal(isCheckCommand("python3 - <<'EOF' ... EOF"), false)
  assert.equal(isCheckCommand('mv a b'), false)
  assert.equal(isCheckCommand(undefined), false)
})

test('only the rm segments decide a delete, not the rest of the shell line', () => {
  // A compound scratch command must not be graded irreversible because the
  // words "mkdir" and "&&" were read as delete targets.
  assert.deepEqual(classifyCommand('rm -rf /tmp/ck-live && mkdir -p /tmp/ck-live').destructive, [])
  assert.deepEqual(classifyCommand('rm -rf /tmp/ck-live').destructive, [])
  assert.deepEqual(classifyCommand('sudo rm -rf /var/tmp/x | tee out.log').destructive, [])
  assert.deepEqual(classifyCommand('rm -rf ./src').destructive, ['recursive-delete'])
  assert.deepEqual(classifyCommand('rm -rf /tmp/a ./src').destructive, ['recursive-delete'])
  assert.deepEqual(classifyCommand('cd /tmp && rm -rf ./a').destructive, ['recursive-delete'])
})

test('a protected prefix matches an absolute path at a segment boundary', () => {
  // The tools report /repo/.auto-dev/ledger.json; the setting says ".auto-dev/".
  // Comparing them literally meant a control-plane write was never recognised.
  assert.equal(isProtectedPath('/Users/x/repo/.auto-dev/ledger.json'), true)
  assert.equal(isProtectedPath('/Users/x/repo/.github/workflows/ci.yml'), true)
  assert.equal(isProtectedPath('/Users/x/repo/not.auto-dev/ledger.json'), false)
  assert.equal(isProtectedPath('src/index.js'), false)
})

test('a shell redirect into the control plane is caught the way a file tool is', () => {
  assert.deepEqual(shellWritePaths("echo '{}' > .auto-dev/ledger.json"), ['.auto-dev/ledger.json'])
  assert.deepEqual(shellWritePaths('npm test 2>&1 | tee .auto-dev/run.log'), ['.auto-dev/run.log'])
  assert.deepEqual(shellWritePaths('sed -i s/a/b/ .auto-dev/state.json'), ['.auto-dev/state.json'])
  assert.deepEqual(shellWritePaths('cp src/a.js dist/a.js'), ['dist/a.js'])
  // A heredoc body is content, not a command stream.
  assert.deepEqual(shellWritePaths("cat > notes.md <<'EOF'\nrm -rf /\nEOF"), ['notes.md'])
  // Documentation about the gate must not trip the gate.
  assert.deepEqual(shellWritePaths("python3 - <<'PY'\ntext('echo x > .auto-dev/ledger.json')\nPY"), [])
  // Mentions in prose or commit messages are not writes.
  assert.deepEqual(shellWritePaths('git commit -m "rm -rf .auto-dev"'), [])
  assert.deepEqual(shellWritePaths('echo hi > /dev/null'), [])
})

test('risksOfCall reads the shell, not just the file tools, for the control plane', () => {
  const redirect = risksOfCall({ name: 'bash', arguments: { command: "echo '{}' > .auto-dev/ledger.json" } })
  assert.deepEqual(redirect.destructive, ['control-plane'])
  const ordinary = risksOfCall({ name: 'bash', arguments: { command: 'npm test > /tmp/out.log' } })
  assert.deepEqual(ordinary.destructive, [])
  const write = risksOfCall({ name: 'write', arguments: { path: '/repo/.auto-dev/ledger.json', content: '{}' } })
  assert.deepEqual(write.destructive, ['control-plane'])
})

/**
 * Quoting decides what is code and what is data. A probe that merely mentioned
 * `> .auto-dev/ledger.json` inside a JavaScript string was refused as that write,
 * which is the same class of mistake as missing a real one — an over-eager gate
 * teaches people to route around the gate.
 */
test('a redirect is only a redirect when it is not quoted', () => {
  assert.deepEqual(shellWritePaths(String.raw`node -e "console.log('echo hi > .auto-dev/ledger.json')"`), [])
  assert.deepEqual(shellWritePaths('echo hi > .auto-dev/ledger.json'), ['.auto-dev/ledger.json'])
  assert.deepEqual(shellWritePaths('cat notes.md >> .auto-dev/ledger.json'), ['.auto-dev/ledger.json'])
  assert.deepEqual(shellWritePaths('npm test > /tmp/out.log'), ['/tmp/out.log'])
  // A filename with a space is one target, not two.
  assert.deepEqual(shellWritePaths('echo x > "notes file.txt"'), ['notes file.txt'])
})

test('a wrapper that runs its argument as code is read through, not skipped', () => {
  assert.deepEqual(shellWritePaths('sh -c "echo hi > .auto-dev/ledger.json"'), ['.auto-dev/ledger.json'])
  assert.deepEqual(shellWritePaths('bash -c "cp a .auto-dev/b"'), ['.auto-dev/b'])
  const wrapped = risksOfCall({ name: 'bash', arguments: { command: 'bash -c "echo hi > .auto-dev/ledger.json"' } })
  assert.deepEqual(wrapped.destructive, ['control-plane'])
})

test('a scratch delete stays scratch when the next line rebuilds the directory', () => {
  // Regression: the code view used to collapse newlines into spaces, so `mkdir` on
  // the following line became an argument of `rm` and a temp-only delete was graded
  // irreversible — the gate would have blocked ordinary scratch cleanup.
  const verdict = classifyCommand('rm -rf /tmp/v3-matrix\nmkdir -p /tmp/v3-matrix')
  assert.deepEqual(verdict.destructive, [])
  assert.deepEqual(classifyCommand('rm -rf /tmp/a ./src').destructive, ['recursive-delete'])
})

