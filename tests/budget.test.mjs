/**
 * The control plane has a weight, and weight is what made v2 tiring: every
 * sentence in a tool description is read on every request, so growth has to be
 * paid for deliberately rather than noticed later.
 *
 * These are budgets, not targets: raise them in the same commit that earns it,
 * with a line saying what got cheaper to pay for it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stubHost } from '../tools/flow.mjs'
import { apply } from '../src/index.js'

const TOOL_BUDGET = 8 // +work_recall (2026-11-09): the start brief lists incident titles instead of carrying old entries verbatim
const DESCRIPTION_BUDGET = 6600 // characters; retained historical ceiling, not a token-efficiency measurement

test('the resident surface stays inside its budget', async () => {
  const host = stubHost({ cwd: mkdtempSync(join(tmpdir(), 'v3-budget-')) })
  await apply(host.ctx, { requireUserStart: false, checkpoints: false })
  const rows = [...host.tools.values()]
  const chars = rows.reduce((sum, tool) => sum + (tool.description ?? '').length, 0)
  assert.ok(rows.length <= TOOL_BUDGET, `tools grew to ${rows.length}: ${rows.map(row => row.name).join(', ')}`)
  assert.ok(chars <= DESCRIPTION_BUDGET, `resident descriptions grew to ${chars} characters`)
})
