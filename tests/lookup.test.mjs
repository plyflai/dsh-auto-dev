import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Records } from '../src/records.mjs'
import { newestFirst } from '../src/lookup.mjs'

const memory = () => ({
  kv: { open: async () => ({ loadAll: async () => ({ tables: {} }), putRecord: async () => {}, close: async () => {} }) },
})
const row = (id, updatedAt) => ({ id, version: 1, project: '/p', updatedAt })

test('two writes in the same millisecond order by which came last, not by table order', async () => {
  const records = await Records.open(memory())
  const at = '2026-10-29T00:00:00.000Z'
  await records.change('tasks', 'task-b', () => row('task-b', at))
  await records.change('tasks', 'task-a', () => row('task-a', at))
  assert.deepEqual(records.peek('tasks').sort(newestFirst(records)).map(task => task.id), ['task-a', 'task-b'])
  await records.change('tasks', 'task-b', current => ({ ...current }))
  assert.deepEqual(records.peek('tasks').sort(newestFirst(records)).map(task => task.id), ['task-b', 'task-a'])
})

test('rows this process never wrote fall back to the id, newest issued first', () => {
  const at = '2026-10-29T00:00:00.000Z'
  const rows = [row('task-mvs00001-aaaaaa', at), row('task-mvs00002-aaaaaa', at)]
  assert.deepEqual(rows.sort(newestFirst()).map(task => task.id), ['task-mvs00002-aaaaaa', 'task-mvs00001-aaaaaa'])
})
