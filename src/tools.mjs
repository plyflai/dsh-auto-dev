/**
 * The seven tools the model sees, and the host registration loop around them.
 *
 * These descriptions are the only resident knowledge this package has: they sit in
 * every request, unlike the craft manuals behind the skill provider. Keeping them
 * in one table makes that cost visible, and lets the loop wrap every return value
 * in `lossless()` — a tool that changes state and then fails the host's JSON
 * validator is worse than one that never ran.
 */
import { lossless } from './json.mjs'
import { output } from './tools/shared.mjs'
import { workStart } from './tools/start.mjs'
import { workPlan } from './tools/plan.mjs'
import { workSubmit } from './tools/submit.mjs'
import { workStatus } from './tools/status.mjs'
import { workControl } from './tools/control.mjs'
import { workExtend } from './tools/extend.mjs'
import { workEnv } from './tools/env.mjs'

/** The tool table, in the order the model sees it. One file per tool under `tools/`. */
export const WORK_TOOLS = [workStart, workPlan, workSubmit, workStatus, workControl, workExtend, workEnv]

/** Release a set of registrations, newest first, without letting one failure strand the rest. */
export function releaseAll(disposers) {
  for (const dispose of (disposers ?? []).splice(0).reverse()) {
    try { dispose?.() } catch { /* the scope is already gone; nothing left to unregister */ }
  }
}

/**
 * Install the seven `work_*` tools into one scope.
 *
 * The scope decides who can see them: the agent's own context registers for that
 * conversation alone, the plugin context for the whole host. Auto Dev is
 * user-started, so the caller passes a scope only for a session that opted in —
 * a model that never saw the tools cannot start a task by accident.
 *
 * Returns one disposer for the whole set: a task the model can open but not hand
 * in is worse than no task at all, so a partial install is undone, not kept.
 */
export function installWorkTools(scope, api) {
  const tools = WORK_TOOLS.map(entry => entry(api))

  const disposers = []
  try {
    for (const [toolName, description, properties, required, execute] of tools) {
      disposers.push(scope.tools.register({
        name: toolName,
        description,
        parameters: { type: 'object', properties, required, additionalProperties: false },
        output,
        // Every value crosses the host's output validator, which requires
        // lossless JSON. A single `undefined` field (an unset unit id, a plan
        // without a deliverable) kills the tool call *after* it already changed
        // state — the caller sees "value is not lossless JSON" and the work looks
        // like it never happened. Strip non-representable values at the boundary.
        execute: async (args, exec) => lossless({ ...await execute(args, exec), ...(toolName === 'work_control' ? { reference: 'references/operations.md' } : {}) }),
        ...(['work_status'].includes(toolName) ? { isConcurrencySafe: () => true } : {}),
      }))
    }
  } catch (error) {
    releaseAll(disposers)
    throw error
  }
  return () => releaseAll(disposers)
}
