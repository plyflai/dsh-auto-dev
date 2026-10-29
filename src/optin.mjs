/**
 * Who may see Auto Dev at all, and putting it in front of them.
 *
 * Mounted is not asked for: only a conversation that ran the command (or holds a
 * task from before the opt-in table existed) gets the tools, the skill and the
 * notices. The answer is a record, so it survives a reload.
 */
import { installSkill } from './skill.mjs'
import { installWorkTools, releaseAll } from './tools.mjs'
import { heldSessions } from './lookup.mjs'

export async function setupOptIn({ ctx, settings, records, sessionState, sessionId, seq, activeTask, planOf, projectOf, toolApi, skillScope, diag }) {
  // ── who may see Auto Dev at all ────────────────────────────────────────────
  //
  // This plugin is mounted for every conversation in the profile, and mounted is
  // not the same as asked for. A conversation that never ran `/dsh-auto-dev start`
  // gets none of it: no `work_*` tools in the schema, no craft skill in the
  // catalog, no notices in the model's context. The opt-in is one record written
  // by the command, so it survives a reload — a restart in the middle of a task
  // must not quietly take the tools away from the session doing the work.
  const optedInCache = new Map()
  const installs = new Map()
  const isChildSession = agent => {
    const parent = agent?.session?.header?.parentSession
    return typeof parent === 'string' && parent !== ''
  }
  const optedIn = agent => {
    // A profile that turned the ownership gate off opted every conversation in by
    // definition: there is nothing left to opt into.
    if (settings().requireUserStart === false) return true
    // A delegated child cannot talk to the person who owns the task, and must not
    // be able to book one of its own. Its writes belong to the parent's task.
    if (isChildSession(agent)) return false
    const sid = sessionId(agent)
    if (typeof sid !== 'string' || sid === '') return false
    if (optedInCache.has(sid)) return optedInCache.get(sid)
    let found = false
    try { found = Boolean(records.get('sessions', sid)) } catch { found = false }
    optedInCache.set(sid, found)
    return found
  }
  const installKey = agent => sessionId(agent) ?? agent
  /**
   * Put the tools and the skill in front of one conversation.
   *
   * The agent's own context is what scopes a registration to that conversation;
   * the plugin context is the fallback for a host that has no agent scopes. A
   * failure is reported, never thrown: this runs inside `agent/created` for a
   * resumed session, where a throw would fail the creation itself.
   */
  const install = agent => {
    if (!agent) return undefined
    if (settings().requireUserStart === false) return undefined
    const key = installKey(agent)
    const held = installs.get(key)
    // Same key, different agent: a session that was set aside and brought back
    // gets a new context, and the old registration belongs to the old one.
    if (held?.agent === agent) return held.release
    if (held) uninstall(agent)
    const scope = agent.ctx ?? ctx
    try {
      const releases = [installWorkTools(scope, toolApi())]
      try { releases.push(installSkill(agent.ctx ?? skillScope() ?? ctx)) } catch (error) { diag(`install:skill-failed ${error?.message ?? error}`) }
      const release = () => releaseAll(releases)
      installs.set(key, { agent, release })
      return release
    } catch (error) {
      diag(`install:failed ${error?.message ?? error}`)
      return undefined
    }
  }
  const uninstall = agent => {
    const key = installKey(agent)
    const held = installs.get(key)
    if (!held) return
    installs.delete(key)
    try { held.release() } catch {}
  }
  /**
   * Record that this conversation asked for Auto Dev, then show it what it asked
   * for. Storage is best-effort: if the row cannot be written, the person's
   * request still has to work for the turn they just made.
   */
  /**
   * Record that the person just said something. Set from user messages in
   * `pre-step` and from the answer tool's result, because a question answered in
   * the UI arrives as a tool result rather than a message.
   */
  const markUserSpoke = async agent => {
    sessionState(agent).userSpokeAt = seq(agent)
    // People answer in whichever window is open. Stamp the pending organize
    // proposal so an approval given elsewhere still counts, without asking the
    // model to re-post the question.
    const task = activeTask(agent)
    const plan = planOf(task)
    const proposal = plan?.proposal
    if (!proposal || proposal.applied) return
    try {
      await records.change('plans', plan.id, current => (current?.proposal && !current.proposal.applied)
        ? { ...current, proposal: { ...current.proposal, spokeAt: new Date().toISOString() } }
        : current)
    } catch (error) {
      diag(`proposal:spoke-failed ${error?.message ?? error}`)
    }
  }

  const optIn = async agent => {
    const sid = sessionId(agent)
    if (typeof sid !== 'string' || sid === '') return false
    const now = new Date().toISOString()
    try {
      await records.change('sessions', sid, current => ({
        id: sid, version: 1,
        project: current?.project ?? projectOf(agent, ['.']),
        at: current?.at ?? now,
        updatedAt: now,
      }))
    } catch (error) {
      diag(`optin:record-failed ${error?.message ?? error}`)
    }
    optedInCache.set(sid, true)
    install(agent)
    return true
  }

  // A conversation that opted in and comes back later — a resumed session, a
  // reload, a restart — gets its tools back without touching the command again.
  // Neither listener may throw: `agent/created` is awaited before the conversation
  // exists, so a failure there would keep the person from starting their session.
  ctx.on('agent/created', ({ agent }) => {
    try { if (optedIn(agent)) install(agent) } catch (error) { diag(`created:failed ${error?.message ?? error}`) }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    try { uninstall(agent) } catch (error) { diag(`disposed:failed ${error?.message ?? error}`) }
  })
  ctx.effect(() => () => {
    for (const held of installs.values()) { try { held.release() } catch {} }
    installs.clear()
    optedInCache.clear()
  })
  // A task already running when this build arrives proves its holder opted in
  // before the table existed. Record that, so an upgrade does not take the tools
  // away from the conversation in the middle of its work; nothing else is
  // backfilled, and a conversation holding no task stays dormant.
  try {
    for (const task of records.all('tasks', task => ['active', 'paused'].includes(task.state))) {
      for (const sid of heldSessions(task)) {
        if (records.get('sessions', sid)) continue
        await records.change('sessions', sid, () => ({ id: sid, version: 1, project: task.project, at: new Date().toISOString() }))
        optedInCache.set(sid, true)
      }
    }
  } catch (error) { diag(`optin:backfill-failed ${error?.message ?? error}`) }

  // Sessions that already existed when this instance loaded: their opt-in row is
  // older than these listeners.
  try {
    for (const agent of (ctx.root ?? ctx).get?.('agents')?.list?.() ?? []) if (optedIn(agent)) install(agent)
  } catch (error) { diag(`install:rescan-failed ${error?.message ?? error}`) }

  return { optedIn, optIn, install, markUserSpoke }
}
