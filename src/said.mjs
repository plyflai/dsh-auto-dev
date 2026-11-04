/**
 * What the session log already says, for state that must survive a host restart
 * (v50: the start grant and 「每个任务一次」 lived only in memory; after a restart the
 * plugin told the model nobody had started, and said the first-write card again).
 * The log is the hard fact; memory is a cache in front of it.
 */
import { COMMAND_VERBS } from './command.mjs'

const eventsFrom = (session, from = 0) => {
  const out = []
  for (let at = Math.max(0, from); at < (session?.seq ?? 0); at += 1) {
    const event = session.eventAt?.(at)
    if (event) out.push({ at, event })
  }
  return out
}

/** The newest `/dsh-auto-dev start|new <words>` the person ran here: `{ seq, text, auto }`, or undefined. */
export function lastStartCommand(session) {
  for (let at = (session?.seq ?? 0) - 1; at >= 0; at -= 1) {
    const event = session.eventAt?.(at)
    if (event?.type !== 'command/run' || event.data?.name !== 'dsh-auto-dev') continue
    const raw = String(event.data?.args ?? '').trim()
    const head = raw.split(/\s+/)[0]?.toLowerCase() ?? ''
    if (COMMAND_VERBS.has(head) && head !== 'start' && head !== 'new') continue
    const tail = COMMAND_VERBS.has(head) ? raw.slice(raw.split(/\s+/)[0].length).trim() : raw
    if (!tail) continue
    const auto = /^--auto(\s|$)/.test(tail)
    return { seq: at, text: auto ? tail.replace(/^--auto\s*/, '') : tail, auto }
  }
  return undefined
}

/** Whether a plugin notice with this summary reached the conversation since `from`. */
export function noticeSaid(session, summary, from = 0) {
  for (const { event } of eventsFrom(session, from)) {
    const messages = event.type === 'agent/inbox/spliced' ? (event.data?.inserted ?? [])
      : event.type === 'user/message' ? [event.data?.message ?? event.data] : []
    if (messages.some(message => message?.source?.kind === 'dsh-auto-dev' && message.source.summary === summary)) return true
  }
  return false
}
