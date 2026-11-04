import { CONSENT_ASK, consent, decisionSource, repliesAfter } from '../decisions.mjs'
import { GateError } from '../gate.mjs'
import { text } from '../task.mjs'
import { ENV_FILE, FACT_KINDS, MAX_FACTS, envDigest, envLine, readEnv, writeEnv } from '../env.mjs'
import { executionFailed } from '../session-log.mjs'
import { output, string } from './shared.mjs'

export const workEnv = api => (
  // --------------------------------------------------------------- work_env
  ['work_env', `Read project runtime facts or observe fact/gui from a successful current callId or exact user quote/sourceSeq; value must occur in the source. propose keeps unsupported interpretation a candidate; lock/blocked/release require explicit sourced human confirmation. stale removes usable context until a fresh observation; forget protected rules preserves sourced history.`, {
    operation: { type: 'string', enum: ['list', 'observe', 'propose', 'confirm', 'forget', 'stale'] },
    kind: { type: 'string', enum: [...FACT_KINDS] },
    taskId: string, key: string, value: string, command: string, note: string, callId: string, quote: string, sourceSeq: { type: 'integer' },
  }, ['operation'],
  async (args, exec) => {
    const task = api.requireTask(api.activeTask(exec.agent), args.taskId)
    if (!task) return api.noTask(exec.agent)
    const project = task.project
    const env = await readEnv(project)
    const now = new Date().toISOString()
    const key = typeof args.key === 'string' ? args.key.trim() : ''
    const value = typeof args.value === 'string' ? args.value.trim() : ''
    const kind = FACT_KINDS.includes(args.kind) ? args.kind : 'fact'
    // Nothing here is refused for its shape: a missing name is answered, an unsupported
    // observation is kept as a candidate, and a full list makes room by dropping its oldest.
    const answer = tellUser => ({ project, path: ENV_FILE, unchanged: true, tellUser })
    const roomy = list => list.length > MAX_FACTS ? list.slice(list.length - MAX_FACTS) : list
    const propose = async (why = '') => {
      const candidate = {
        id: api.newId('env'), kind, key, value, status: 'observed', at: now,
        ...(args.command ? { command: String(args.command).trim() } : {}),
        ...(args.note ? { note: String(args.note).trim() } : {}),
        source: { by: 'model', session: api.sessionId(exec.agent), seq: api.seq(exec.agent), at: now },
      }
      const next = { ...env, candidates: [candidate, ...env.candidates.filter(row => !(row.key === key && row.value === value))] }
      await writeEnv(project, next)
      return { project, path: ENV_FILE, candidate: candidate.id, pending: next.candidates.length,
        tellUser: `${why}先记成候选：${key} = ${value}。用户确认后才算项目事实。` }
    }

    if (args.operation === 'list') {
      const digest = envDigest(env)
      return { project, path: ENV_FILE, facts: env.facts.length, blocked: env.blocked.length, lock: env.lock.length, release: env.release.length, gui: env.gui.length, digest, line: envLine(digest) }
    }

    if (args.operation === 'observe') {
      if (!key || !value) return answer('要记的环境事实得有名字和值，这次没记。')
      // A rule (lock / blocked / release) only comes from the user's confirmation.
      if (!['fact', 'gui'].includes(kind)) return propose('规则要用户确认，')
      let source, command
      const normalized = text => String(text ?? '').replace(/\s+/g, ' ').trim()
      if (args.callId) {
        const row = api.observationsOf(exec.agent).results.find(row => row.callId === args.callId && row.seq >= (task.startedSeq ?? 0))
        if (!row || executionFailed(row)) return propose('引用的那次执行不在本任务里或没跑通，')
        const output = (row.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
        if (![row.command, output].some(body => normalized(body).includes(normalized(value)))) return propose('那次执行的输出里没有这个值，')
        command = row.command
        source = { by: 'execution', sessionId: api.sessionId(exec.agent), taskId: task.id, callId: row.callId, seq: row.seq, at: row.at ?? now }
      } else {
        // The person's own words, found in the log: the latest reply in this task that contains the value.
        const said = repliesAfter(exec.agent, (task.startedSeq ?? 0) - 1).findLast(row => normalized(row.text).includes(normalized(value)))
        if (!said) return propose('用户原话里没有这个值，')
        source = { by: 'user', sessionId: api.sessionId(exec.agent), taskId: task.id, seq: said.seq, via: said.via, quote: said.text, at: now }
      }
      const bucket = kind === 'fact' ? 'facts' : 'gui'
      const prior = env[bucket].find(row => row.key === key)
      if (prior?.status === 'stale' && prior.staleSource?.sessionId === source.sessionId && source.seq <= prior.staleSource.seq) return propose('这条已标过期，引用的是过期之前的观测，')
      if (prior?.value === value && prior.status !== 'stale') return { project, path: ENV_FILE, observed: prior.id, unchanged: true, digest: envDigest(env) }
      const observed = { id: prior?.id ?? api.newId('env'), kind, key, value, status: 'observed', source, at: now,
        ...(command ? { command } : {}), ...(args.note ? { note: args.note.trim() } : {}),
        ...(prior ? { history: [...(prior.history ?? []), { value: prior.value, status: prior.status, source: prior.source, at: prior.at }] } : {}) }
      const list = roomy([...env[bucket].filter(row => row.key !== key), observed])
      const next = { ...env, [bucket]: list }
      await writeEnv(project, next)
      api.queueNotice(exec.agent, `**已观测环境** — ${key} = ${value}`, 'dsh-auto-dev env observe',
        { form: 'env', data: { unit: '', title: '已观测环境', line: `${key} = ${value}`, tag: source.by === 'user' ? '用户陈述' : '执行观测', tone: 'info' } })
      return { project, path: ENV_FILE, observed: observed.id, source, digest: envDigest(next) }
    }

    if (args.operation === 'propose') {
      if (!key || !value) return answer('候选得有名字和值，这次没记。')
      return propose()
    }

    if (args.operation === 'confirm') {
      const pending = env.candidates.find(row => row.key === key) ?? env.candidates.find(row => row.value === value)
      if (!pending) return answer(env.candidates.length ? `没有「${key || value}」这条候选；现有候选：${env.candidates.map(row => row.key).join('、')}` : '现在没有待确认的候选。')
      // The candidate decides what kind of rule it is; a different kind on confirm is ignored.
      const section = pending.kind ?? kind
      // The person's reply after the candidate was written decides; until then it stays a candidate.
      const source = decisionSource({ agent: exec.agent, task, after: pending.source?.seq ?? task.startedSeq, subject: pending.key })
      if (!source) return answer(`问用户一句「${pending.key} = ${pending.value}，对吗？」，他回了再确认。`)
      const original = (env[section === 'fact' ? 'facts' : section] ?? []).find(row => row.key === pending.key)
      const confirmed = {
        ...pending, status: 'confirmed', at: now,
        source: { by: 'user', ...source, at: now },
        ...(original ? { history: [...(original.history ?? []), { value: original.value, status: original.status, source: original.source, at: original.at }] } : {}),
      }
      const bucket = section === 'fact' ? 'facts' : section
      const all = [...(env[bucket] ?? []).filter(row => row.key !== confirmed.key), confirmed]
      const list = bucket === 'blocked' || bucket === 'lock' ? all : roomy(all)
      const next = {
        ...env,
        [bucket]: list,
        candidates: env.candidates.filter(row => row.id !== pending.id),
      }
      await writeEnv(project, next)
      api.queueNotice(exec.agent,
        `**记下环境** — ${confirmed.key} = ${String(confirmed.value).slice(0, 50)}`,
        'dsh-auto-dev env confirm',
        { form: 'env', data: { unit: '', title: '记下环境', line: `${confirmed.key} = ${String(confirmed.value).slice(0, 50)}`, tag: '用户确认', tone: 'info' } })
      return { project, path: ENV_FILE, confirmed: confirmed.id, section, total: list.length }
    }

    if (args.operation === 'stale' || args.operation === 'forget') {
      if (!key && !value) return answer('没说忘掉哪一条，什么都没动。')
      const protectedRules = [...env.blocked, ...env.lock].filter(row => row.status !== 'stale' && (row.key === key || row.value === value))
      // G3: a rule the person set is lifted only by the person — asked once, then their reply decides.
      let lifted
      if (protectedRules.length) {
        const asked = task.auto ? { granted: false } : consent(api.sessionState(exec.agent), exec.agent, task, `revoke:${protectedRules.map(row => row.key).join(',')}`, api.seq(exec.agent))
        if (!asked.granted) {
          const named = protectedRules.map(row => `「${row.value}」`).join('、')
          throw new GateError('G3', `${named} 是用户定的规则`, task.auto
            ? '自动驾驶开着，不替用户解除他定的规则：照规则来，交付时把这一步列为「等你决定」'
            : `${CONSENT_ASK}要不要解除 ${named}；他选「同意」再改，选「不同意」就照规则来、别再改这条`)
        }
        lifted = { sessionId: api.sessionId(exec.agent), taskId: task.id, ...asked.source }
      }
      const sources = new Map(protectedRules.map(row => [row.key, lifted]))
      const revoke = row => sources.has(row.key) ? { ...row, status: 'stale', at: now,
        history: [...(row.history ?? []), { status: row.status, source: row.source, at: row.at }],
        source: { by: 'user', ...sources.get(row.key), at: now } } : row
      const drop = row => !(row.key === key || row.value === value)
      if (args.operation === 'forget') {
        const next = { ...env, facts: env.facts.filter(drop), lock: env.lock.map(revoke), blocked: env.blocked.map(revoke), release: env.release.filter(drop), gui: env.gui.filter(drop), candidates: env.candidates.filter(drop) }
        await writeEnv(project, next)
        const changed = protectedRules.length ? `用户已撤销规则 ${protectedRules.map(row => row.key).join('、')}（保留历史）` : `${key || value}：已删除`
        api.queueNotice(exec.agent,
          `**环境更新** — ${changed}`,
          'dsh-auto-dev env forget',
          { form: 'env-forget', data: { unit: '', title: '环境更新', line: changed, tag: protectedRules.length ? '用户已撤销' : '已删掉', tone: 'info' } })
        return { project, path: ENV_FILE, forgotten: key || value }
      }
      const mark = row => (row.key === key || row.value === value ? { ...row, status: 'stale', at: now,
        staleSource: { sessionId: api.sessionId(exec.agent), seq: api.seq(exec.agent) },
        history: [...(row.history ?? []), { status: row.status, source: row.source, at: row.at }] } : row)
      const next = { ...env, facts: env.facts.map(mark), lock: env.lock.map(revoke), blocked: env.blocked.map(revoke), release: env.release.map(mark), gui: env.gui.map(mark) }
      await writeEnv(project, next)
      return { project, path: ENV_FILE, stale: key || value }
    }

    const digest = envDigest(env)
    return { project, path: ENV_FILE, facts: env.facts.length, blocked: env.blocked.length, lock: env.lock.length, release: env.release.length, gui: env.gui.length, digest, line: envLine(digest) }
  }]
)
