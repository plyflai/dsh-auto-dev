import { decisionSource } from '../decisions.mjs'
import { text } from '../task.mjs'
import { ENV_FILE, FACT_KINDS, MAX_FACTS, envDigest, envLine, readEnv, writeEnv } from '../env.mjs'
import { evidenceCommand, executionFailed } from '../session-log.mjs'
import { output, string } from './shared.mjs'

export const workEnv = api => (
  // --------------------------------------------------------------- work_env
  ['work_env', `Read project runtime facts or observe fact/gui from a successful current callId or exact user quote/sourceSeq; value must occur in the source. propose keeps unsupported interpretation a candidate; lock/blocked/release require explicit sourced human confirmation. stale removes usable context until a fresh observation; forget protected rules preserves sourced history.`, {
    operation: { type: 'string', enum: ['list', 'observe', 'propose', 'confirm', 'forget', 'stale'] },
    kind: { type: 'string', enum: [...FACT_KINDS] },
    taskId: string, key: string, value: string, command: string, note: string, callId: string, quote: string, sourceSeq: { type: 'integer' },
  }, ['operation'],
  async (args, exec) => {
    const task = api.requireTask(api.activeTask(exec.agent), args.taskId, { agent: exec.agent })
    const project = task.project
    const env = await readEnv(project)
    const now = new Date().toISOString()
    const key = typeof args.key === 'string' ? args.key.trim() : ''
    const value = typeof args.value === 'string' ? args.value.trim() : ''

    if (args.operation === 'list') {
      const digest = envDigest(env)
      return { project, path: ENV_FILE, facts: env.facts.length, blocked: env.blocked.length, lock: env.lock.length, release: env.release.length, gui: env.gui.length, digest, line: envLine(digest) }
    }

    if (args.operation === 'observe') {
      if (!key || !value || !['fact', 'gui'].includes(args.kind)) throw new Error('observe needs key/value and kind fact or gui; protected rules require propose + sourced confirm')
      let source, command
      const normalized = text => String(text ?? '').replace(/\s+/g, ' ').trim()
      if (args.callId) {
        const row = api.observationsOf(exec.agent).results.find(row => row.callId === args.callId && row.seq >= (task.startedSeq ?? 0))
        if (!row || executionFailed(row) || (row.command && !evidenceCommand(row.command))) throw new Error('observe needs a successful execution in this task evidence window')
        const output = (row.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
        if (![row.command, output].some(body => normalized(body).includes(normalized(value)))) throw new Error('observe value is not supported by the cited execution; use propose for model interpretation')
        command = row.command
        source = { by: 'execution', sessionId: api.sessionId(exec.agent), taskId: task.id, callId: row.callId, seq: row.seq, at: row.at ?? now }
      } else {
        source = { by: 'user', ...decisionSource({ agent: exec.agent, task, quote: args.quote, subject: value, intent: 'observation', sourceSeq: args.sourceSeq, allowShort: false }), at: now }
        if (!normalized(source.quote).includes(normalized(value))) throw new Error('observe value must occur in the full user message; use propose for interpretation')
      }
      const bucket = args.kind === 'fact' ? 'facts' : 'gui'
      const prior = env[bucket].find(row => row.key === key)
      if (prior?.status === 'stale' && prior.staleSource?.sessionId === source.sessionId && source.seq <= prior.staleSource.seq) throw new Error('stale environment needs a fresh observation after it was marked stale')
      if (prior?.value === value && prior.status !== 'stale') return { project, path: ENV_FILE, observed: prior.id, unchanged: true, digest: envDigest(env) }
      const observed = { id: prior?.id ?? api.newId('env'), kind: args.kind, key, value, status: 'observed', source, at: now,
        ...(command ? { command } : {}), ...(args.note ? { note: args.note.trim() } : {}),
        ...(prior ? { history: [...(prior.history ?? []), { value: prior.value, status: prior.status, source: prior.source, at: prior.at }] } : {}) }
      const list = [...env[bucket].filter(row => row.key !== key), observed]
      if (list.length > MAX_FACTS) throw new Error(`environment facts exceed ${MAX_FACTS}; remove obsolete facts first`)
      const next = { ...env, [bucket]: list }
      await writeEnv(project, next)
      api.queueNotice(exec.agent, `**已观测环境** — ${key} = ${value}`, 'auto-dev-v3 env observe',
        { form: 'env', data: { unit: '', title: '已观测环境', line: `${key} = ${value}`, tag: source.by === 'user' ? '用户陈述' : '执行观测', tone: 'info' } })
      return { project, path: ENV_FILE, observed: observed.id, source, digest: envDigest(next) }
    }

    if (args.operation === 'propose') {
      if (!key || !value) throw new Error('work_env propose needs both key and value: what it is called, and what it is')
      if (!FACT_KINDS.includes(args.kind)) throw new Error(`work_env propose needs kind: ${FACT_KINDS.join(' / ')}`)
      const candidate = {
        id: api.newId('env'), kind: args.kind, key, value, status: 'observed', at: now,
        ...(args.command ? { command: args.command.trim() } : {}),
        ...(args.note ? { note: args.note.trim() } : {}),
        source: { by: 'model', session: api.sessionId(exec.agent), seq: api.seq(exec.agent), at: now },
      }
      const next = { ...env, candidates: [candidate, ...env.candidates.filter(row => !(row.key === key && row.value === value))] }
      await writeEnv(project, next)
      return { project, path: ENV_FILE, candidate: candidate.id, pending: next.candidates.length, tellUser: `先记成候选：${key} = ${value}。推断保留为候选；实际观测用 observe，受保护规则需用户明确确认。` }
    }

    if (args.operation === 'confirm') {
      const pending = env.candidates.find(row => row.key === key) ?? env.candidates.find(row => row.value === value)
      if (!pending) throw new Error(`work_env confirm: 没有找到 key 为「${key || value}」的候选，先 work_env propose`)
      const section = pending.kind ?? (FACT_KINDS.includes(args.kind) ? args.kind : 'fact')
      if (args.kind && pending.kind && args.kind !== pending.kind) throw new Error('confirm kind must match the proposed environment rule')
      const source = decisionSource({ agent: exec.agent, task, quote: args.note, after: pending.source?.seq ?? task.startedSeq, subject: pending.key, intent: 'environment', allowShort: false })
      const original = (env[section === 'fact' ? 'facts' : section] ?? []).find(row => row.key === pending.key)
      const confirmed = {
        ...pending, status: 'confirmed', at: now,
        source: { by: 'user', ...source, at: now },
        ...(original ? { history: [...(original.history ?? []), { value: original.value, status: original.status, source: original.source, at: original.at }] } : {}),
      }
      const bucket = section === 'fact' ? 'facts' : section
      const list = [...(env[bucket] ?? []).filter(row => row.key !== confirmed.key), confirmed]
      if (bucket !== 'blocked' && bucket !== 'lock' && list.length > MAX_FACTS) {
        throw new Error(`这个项目的事实已经 ${list.length} 条（上限 ${MAX_FACTS}）：先把同类的合并一条，或者 work_env forget 掉过时的，再写。`)
      }
      const next = {
        ...env,
        [bucket]: list,
        candidates: env.candidates.filter(row => row.id !== pending.id),
      }
      await writeEnv(project, next)
      api.queueNotice(exec.agent,
        `**记下环境** — ${confirmed.key} = ${String(confirmed.value).slice(0, 50)}`,
        'auto-dev-v3 env confirm',
        { form: 'env', data: { unit: '', title: '记下环境', line: `${confirmed.key} = ${String(confirmed.value).slice(0, 50)}`, tag: '用户确认', tone: 'info' } })
      return { project, path: ENV_FILE, confirmed: confirmed.id, section, total: list.length }
    }

    if (args.operation === 'stale' || args.operation === 'forget') {
      if (!key && !value) throw new Error('work_env forget/stale needs a specific key or value')
      const protectedRules = [...env.blocked, ...env.lock].filter(row => row.status !== 'stale' && (row.key === key || row.value === value))
      const sources = new Map(protectedRules.map(row => [row.key, decisionSource({ agent: exec.agent, task, quote: args.note,
        after: row.source?.sessionId === api.sessionId(exec.agent) ? row.source.seq ?? task.startedSeq : task.startedSeq - 1,
        subject: row.key, intent: 'revoke', allowShort: false })]))
      if (protectedRules.length && !/(?:解除|撤销|取消|不再|作废|放开|移除|revoke|remove|lift)/i.test(args.note ?? '')) throw new Error("changing a prohibition needs the owner's explicit revoke/update instruction naming this rule")
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
          'auto-dev-v3 env forget',
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

    throw new Error(`work_env: 不认识的 operation「${args.operation}」`)
  }]
)
