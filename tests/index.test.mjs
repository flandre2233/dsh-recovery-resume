/**
 * 入口单测：用假的 ctx / agent 把 lib/index.js 整条流程跑一遍。
 *
 * 零依赖，脱离 DSH 直接跑（约 5 秒，要等插件内部的两个定时器）：
 *   node tests/index.test.mjs
 *
 * 重点钉住一件事：重新授权 goal 失败后的那次重试，也必须重新过 decideRearm。
 * revision 变了可能正是因为用户刚把目标暂停了，这时不许把它恢复回来。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 账本路径在模块加载时就定了，所以要先设好临时目录再 import。
const HOME = mkdtempSync(join(tmpdir(), 'dsh-recovery-resume-test-'))
process.env.DSH_HOME = HOME
const plugin = await import('../lib/index.js')

let pass = 0
let fail = 0

// 插件运行时会打很多日志；跑插件期间静音，出结果前再恢复。
const realLog = console.log
const realError = console.error
function mute() { console.log = () => {}; console.error = () => {} }
function unmute() { console.log = realLog; console.error = realError }

async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
    pass += 1
  } catch (error) {
    console.log(`  ❌ ${name}\n     ${error && error.message ? error.message : error}`)
    fail += 1
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等插件的判断（3 秒）和重新授权（再 1.5 秒）都跑完。 */
const WAIT_MS = 5200

/**
 * 搭一个假环境并触发一次 agent/created。
 * @param {string} sessionId
 * @param {object[]} goalReads 每次 goals.get() 依次返回的值
 * @param {(call: number) => void} onResume 每次 goals.resume() 被调用时执行，可抛错
 */
function run(sessionId, goalReads, onResume) {
  const handlers = {}
  const resumes = []
  const followups = []
  let reads = 0
  const scoped = {
    on: (event, handler) => { handlers[event] = handler },
    goals: {
      get: () => goalReads[Math.min(reads++, goalReads.length - 1)],
      resume: (agent, target) => {
        resumes.push(target)
        onResume(resumes.length)
      },
    },
  }
  const ctx = { inject: (_keys, callback) => callback(scoped) }
  plugin.apply(ctx)

  const events = [
    { type: 'turn/start', seq: 1, time: Date.now() - 60_000 },
    { type: 'turn/end', seq: 2, time: Date.now() - 30_000, data: { reason: 'interrupted' } },
  ]
  const agent = {
    id: `agent-${sessionId}`,
    status: 'idle',
    session: { id: sessionId, snapshotEvents: () => events },
    followup: (message) => followups.push(message),
  }
  handlers['agent/created']({ agent })
  return { resumes, followups }
}

const activeGoal = (revision) => ({ id: 'goal-1', phase: 'active', activation: 'disarmed', revision })

mute()
const paused = run('session-paused', [activeGoal(1), { ...activeGoal(2), phase: 'paused' }], (call) => {
  if (call === 1) throw new Error('revision mismatch')
})
const moved = run('session-moved', [activeGoal(1), activeGoal(2)], (call) => {
  if (call === 1) throw new Error('revision mismatch')
})
const plain = run('session-plain', [activeGoal(1)], () => {})

await sleep(WAIT_MS)
unmute()

await test('正常情况：发出续跑消息，并按当前 revision 授权一次', () => {
  assert.equal(plain.followups.length, 1)
  assert.deepEqual(plain.resumes, [{ id: 'goal-1', revision: 1 }])
})

await test('授权失败后重试：目标仍是 active → 按新 revision 再试一次', () => {
  assert.deepEqual(moved.resumes, [{ id: 'goal-1', revision: 1 }, { id: 'goal-1', revision: 2 }])
})

await test('授权失败后重试：目标已被暂停 → 放弃重试，绝不恢复暂停的目标', () => {
  assert.deepEqual(paused.resumes, [{ id: 'goal-1', revision: 1 }])
})

rmSync(HOME, { recursive: true, force: true })
console.log(`\n  index: PASS=${pass} FAIL=${fail}`)
process.exit(fail === 0 ? 0 : 1)
