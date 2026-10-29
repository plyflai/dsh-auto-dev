/**
 * Which project does this agent belong to?
 *
 * `session.header.cwd` is the session's own creation metadata, so a subagent
 * started in another directory keeps its own project. The working-directory
 * service answers for the *parent* agent inside an in-process subagent — during
 * the journey-D run it reported the parent's cwd and made every declared unit
 * scope look like it wrote outside the project. `agent.cwd` is not set for
 * in-process subagents either, and falling back to the host's `process.cwd()`
 * once scoped a task in /tmp to the harness checkout.
 *
 * @param agent the running agent (or `undefined` in a stripped context)
 * @param ctx plugin context carrying the optional workingDirectory service
 * @returns an absolute path, preferring the most specific source available
 */
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

export function resolveProject(agent, ctx) {
  const candidates = [
    () => agent?.session?.header?.cwd,
    () => ctx?.workingDirectory?.get?.(agent?.session),
    () => agent?.cwd,
  ]
  for (const read of candidates) {
    try {
      const cwd = read()
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch { /* a missing service or header is not an error: try the next source */ }
  }
  return process.cwd()
}

/**
 * The directory this session's own shell was last told to work in.
 *
 * Inside an in-process subagent neither the session header nor the
 * working-directory service knows where the shell actually runs: both report the
 * *parent's* directory. The commands do. On three separate journeys a subagent
 * working in `…/v3-journey-e` declared `scope: ["str.mjs"]` and got "writes
 * outside the declared scope", because the task was rooted at the parent. A
 * `cd /abs/path` that really ran is the most specific evidence available, so it
 * is consulted before the metadata — and only when the directory still exists.
 */
export function observedDirectory(observations) {
  const results = Array.isArray(observations?.results) ? observations.results : []
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const command = results[index]?.command
    if (typeof command !== 'string') continue
    const match = /(?:^|&&|;|\n)\s*cd\s+(['"]?)(\/[^&;|\n]*)\1\s*(?:&&|;|$)/.exec(command)
    if (!match) continue
    const directory = match[2].trim()
    try {
      if (statSync(directory).isDirectory()) return directory
    } catch { /* the shell may have left a directory that was later removed */ }
  }
  return undefined
}

const inside = (child, parent) => {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

const countAt = (root, scope) => (scope ?? [])
  .filter(entry => typeof entry === 'string' && entry !== '' && entry !== '.' && entry !== './')
  .filter(entry => existsSync(path.join(root, entry)))
  .length

/**
 * Which root the task should be registered at, when the metadata and the shell
 * disagree.
 *
 * Taking any recent `cd` as the project was too eager: during a harness
 * self-check one throwaway `cd …/v3-final3` moved a task out of the session's own
 * directory. So the shell only wins on evidence of being more specific —
 * - it resolves more of the declared scope paths than the metadata does, or
 * - the metadata resolves none of them and the shell's directory sits inside it.
 *
 * The second rule used to also demand that the directory look like a project
 * (a manifest or a `.git`). That refused the most ordinary journey there is: a
 * brand-new empty folder where the work is about to start, so every write there
 * came back as "outside the declared scope" until the folder happened to get a
 * manifest. Standing in the directory with a named scope path is specific enough
 * evidence on its own; a tie still keeps the recorded directory.
 */
const PROJECT_MARKERS = ['package.json', '.git', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'setup.py', 'pom.xml']

/** Does this directory look like the root of something, rather than a folder of things? */
export function looksLikeProject(directory) {
  if (!directory) return false
  return PROJECT_MARKERS.some(marker => existsSync(path.join(directory, marker)))
}

export function chooseProject({ base, observed, scope }) {
  if (!observed || observed === base) return base
  // `scope: ["."]` says "the whole session project". There is nothing more
  // specific to learn, and a throwaway `cd` in one command must not move the
  // root of the session that issued it. One exception, because it cost a whole
  // journey: a subagent inherits the parent's directory as its session root, so
  // `["."]` pointed at a folder that is not a project at all while the shell was
  // standing in one inside it. There the shell is the only specific evidence
  // there is.
  const specific = (scope ?? []).filter(entry => typeof entry === 'string' && entry !== '' && entry !== '.' && entry !== './')
  if (!specific.length) {
    return !looksLikeProject(base) && looksLikeProject(observed) && inside(observed, base) ? observed : base
  }
  const atObserved = countAt(observed, scope)
  const atBase = countAt(base, scope)
  if (atObserved > atBase) return observed
  if (atBase > atObserved) return base
  if (atBase === 0 && inside(observed, base)) return observed
  return base
}
