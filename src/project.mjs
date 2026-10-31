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
