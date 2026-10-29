/**
 * Which command actually proves this project still works.
 *
 * A unit is only executable if someone can run its check, and asking the model to
 * invent the command every time invites a plausible command that does not exist.
 * The repository already knows: read it once, attach it, and a mismatch between
 * what the unit promised and what the claim ran becomes visible.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function scriptNames(project) {
  try {
    const parsed = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
    return Object.keys(parsed?.scripts ?? {})
  } catch { return [] }
}

/**
 * The project's own verification command, or nothing when the repository does not
 * declare one. "Nothing" is a real answer: inventing `npm test` for a project with
 * no test script would make every check fail for the wrong reason.
 */
export function detectVerifier(project) {
  if (typeof project !== 'string' || project === '') return undefined
  if (existsSync(join(project, 'package.json'))) {
    const names = scriptNames(project)
    const candidates = [
      ['test', 'npm test'],
      ['check', 'npm run check'],
      ['lint', 'npm run lint'],
      ['build', 'npm run build'],
    ]
    for (const [name, command] of candidates) {
      if (!names.includes(name)) continue
      return { command, source: `package.json scripts.${name}` }
    }
  }
  if (existsSync(join(project, 'go.mod'))) return { command: 'go test ./...', source: 'go.mod' }
  if (existsSync(join(project, 'Cargo.toml'))) return { command: 'cargo test', source: 'Cargo.toml' }
  if (existsSync(join(project, 'pyproject.toml')) || existsSync(join(project, 'pytest.ini')) || existsSync(join(project, 'setup.cfg'))) {
    return { command: 'pytest -q', source: 'python project' }
  }
  if (existsSync(join(project, 'Makefile'))) {
    try {
      if (/^test:/m.test(readFileSync(join(project, 'Makefile'), 'utf8'))) return { command: 'make test', source: 'Makefile' }
    } catch { /* an unreadable Makefile is not a verifier */ }
  }
  if (existsSync(join(project, 'tests'))) return { command: 'node --test', source: 'tests/ with no declared runner' }
  return undefined
}
