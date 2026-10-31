// 重放报表（`node tools/replay.mjs <session…>`）：读真实会话日志，回答三个问题——
// 出了哪些卡、出卡之后模型接着做了什么、提交被打回几次和为什么。
// 只读日志，不进插件运行时；每个 flow 的实测报告都用它当同一把尺子。
//
// 参数可以是 session.v4.jsonl(.zstd) 文件、会话目录，或 `--home <DSH_HOME>` 加会话 id 前缀。
// `--json` 输出机器可读结果。
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { FILLS } from './fills.mjs'

const REASONS = [
  ['编造/不存在的 callId', /is not an observed result|not found in this task|no execution/i],
  ['管道/掩码', /can mask a check's failure/],
  ['证据过期', /is stale/],
  ['命令对不上', /the claim names/],
  ['失败的运行', /failed — a failed run/],
  ['缺少检查', /needs at least one executed check|needs an executed check/],
  ['复盘', /复盘/],
  ['范围', /scope|out of scope|范围/i],
]


const args = process.argv.slice(2)
const json = args.includes('--json')
const homeAt = args.indexOf('--home')
const home = homeAt >= 0 ? args[homeAt + 1] : undefined
const targets = args.filter((arg, index) => !arg.startsWith('--') && (homeAt < 0 || index !== homeAt + 1))

const files = targets.flatMap(target => resolve(target))
if (!files.length) {
  console.error('usage: node tools/replay.mjs [--json] [--home <DSH_HOME>] <session file | session dir | id prefix>…')
  process.exit(2)
}
const reports = files.map(file => report(file, read(file)))
if (json) console.log(JSON.stringify(reports, null, 2))
else for (const row of reports) print(row)

function resolve(target) {
  if (existsSync(target)) {
    if (statSync(target).isFile()) return [target]
    const found = ['session.v4.jsonl.zstd', 'session.v4.jsonl'].map(name => join(target, name)).find(existsSync)
    return found ? [found] : []
  }
  if (!home) return []
  const root = join(home, 'sessions')
  const hits = []
  for (const cwd of existsSync(root) ? readdirSync(root) : []) {
    for (const dir of readdirSync(join(root, cwd))) {
      if (dir.replace(/^session-/, '').startsWith(target.replace(/^session-/, ''))) hits.push(...resolve(join(root, cwd, dir)))
    }
  }
  return hits
}

function read(file) {
  const text = file.endsWith('.zstd') ? execFileSync('zstd', ['-qdc', file], { maxBuffer: 1 << 28 }).toString() : readFileSync(file, 'utf8')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function textOf(content) {
  return (Array.isArray(content) ? content : []).filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function report(file, events) {
  const header = events.find(event => event.type === 'session') ?? {}
  const calls = new Map()
  const actions = []
  const cards = []
  const submits = []
  const refusals = []
  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'tool/call') {
      const args = typeof data.arguments === 'string' ? safeJson(data.arguments) : data.arguments ?? {}
      calls.set(data.callId, { name: data.name, args })
      actions.push({ seq: event.seq, name: data.name, what: String(args?.command ?? args?.path ?? args?.file_path ?? '').split('\n')[0].slice(0, 70) })
    }
    if (event.type === 'user/message' && data.source?.kind === 'dsh-auto-dev') {
      const text = textOf(data.content)
      // A card that asks the model to call a tool or fill a field breaks the light control plane.
      const fills = [...new Set(text.match(FILLS) ?? [])]
      cards.push({ seq: event.seq, form: data.source.form, title: data.source.data?.title ?? data.source.summary ?? '', fills })
    }
    if (event.type === 'tool/result') {
      const message = data.message ?? {}
      const name = calls.get(message.toolCallId)?.name ?? ''
      if (message.isError && /^work_/.test(name)) refusals.push({ seq: event.seq, name, first: textOf(message.content).split('\n')[0].slice(0, 160) })
      if (name !== 'work_submit') continue
      const text = textOf(message.content)
      const lines = text.split('\n').filter(line => /^- /.test(line))
      const reasons = message.isError ? [...new Set(lines.map(line => REASONS.find(([, pattern]) => pattern.test(line))?.[0] ?? '其他'))] : []
      submits.push({ seq: event.seq, refused: !!message.isError, reasons, lines: lines.map(line => line.slice(2, 200)) })
    }
  }
  // What the model did right after each card: the next three tool calls.
  for (const card of cards) card.after = actions.filter(row => row.seq > card.seq).slice(0, 3)
  return {
    session: header.id ?? file, cwd: header.cwd, file,
    steps: events.filter(event => event.type === 'step/start').length,
    toolCalls: actions.length,
    cards,
    submits: { total: submits.length, refused: submits.filter(row => row.refused).length, rows: submits },
    refusals,
  }
}

function safeJson(text) {
  try { return JSON.parse(text) } catch { return { command: text } }
}

function print(row) {
  console.log(`\n# ${row.session}  (${row.cwd ?? ''})`)
  console.log(`步数 ${row.steps} · 工具调用 ${row.toolCalls} · 卡 ${row.cards.length} · 提交 ${row.submits.total}（打回 ${row.submits.refused}）· 插件工具报错 ${row.refusals.length} · 教填参数的卡 ${row.cards.filter(card => card.fills.length).length}`)
  console.log('\n卡片与随后三步：')
  for (const card of row.cards) {
    console.log(`  #${card.seq} [${card.form}] ${card.title}${card.fills.length ? `  ⚠ 教填参数：${card.fills.join(' ')}` : ''}`)
    for (const next of card.after) console.log(`      → ${next.name} ${next.what}`)
  }
  if (row.refusals.length) {
    console.log('\n插件工具报错：')
    for (const refusal of row.refusals) console.log(`  #${refusal.seq} ${refusal.name}：${refusal.first}`)
  }
  console.log('\n提交：')
  for (const submit of row.submits.rows) {
    console.log(`  #${submit.seq} ${submit.refused ? `打回：${submit.reasons.join('、')}` : '通过'}`)
  }
}
