/**
 * What a task leaves on its record for the next session (交接): only hard facts,
 * written at the moment they happen — the tree the task started from, the last
 * plain run of the project's check with its exit status, and what the person said.
 * A new window reads them back verbatim; nobody is asked to write a progress note.
 *
 * Retirement (大原则 8): the trail lives on the task record and goes with it; the
 * person's words keep the newest SAID entries, each cut at SAID_CHARS.
 */
export const SAID = 5
export const SAID_CHARS = 200

/** Merge `patch(trail)` into the task's trail. A missing task is left alone. */
export async function noteTrail(records, taskId, patch) {
  if (!taskId || !records.get('tasks', taskId)) return
  await records.change('tasks', taskId, current => ({ ...current, trail: { ...(current.trail ?? {}), ...patch(current.trail ?? {}) } }))
}

/** The person's words, newest SAID kept. */
export const withSaid = (trail, texts, at) => ({
  said: [...(trail.said ?? []), ...texts.map(text => ({ text: String(text).slice(0, SAID_CHARS), at }))].slice(-SAID),
})
