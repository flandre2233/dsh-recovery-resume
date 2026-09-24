/**
 * dsh-recovery-resume —— DSH 重启后，自动接着做被打断的回合。
 *
 * 触发时机：会话"活过来"的那一刻（`agent/created`，或 `agent/status` 变成 idle）。
 * 此时 DSH 的崩溃修复已经给没收尾的回合补上了 `turn/end reason=interrupted`，
 * 直接读事件流就能判断要不要续跑。
 *
 * 为什么不在服务启动时扫一遍：启动那一刻会话还没被打开、不是活的 agent，
 * 扫描会什么都看不到。设计经过见 docs/notes.md 第 2 节。
 *
 * 流程：
 *   1. 读事件流，判断尾部有没有"被打断且没人处理"的回合（lib/logic.js）
 *   2. 过三层防失控检查（进程内次数、跨重启账本、冷却）（lib/ledger.js）
 *   3. 发一条"先核对真实状态再继续"的消息（lib/logic.js + lib/message.js）
 *   4. 如果会话有进行中的 goal，重新授权它继续推进
 */

import { buildUserMessage } from './message.js'
import { decideRearm, inspectTail, renderResumePrompt } from './logic.js'
import { extractKeyPoints } from './context.js'
import {
  COOLDOWN_MS,
  MAX_CONSECUTIVE_FAILED_RESUMES,
  checkLedger,
  detectProgressSinceLastAttempt,
  pruneLedger,
  readLedger,
  recordAttemptWithTurn,
  resetAttempts,
  writeLedger,
} from './ledger.js'

const PLUGIN = 'dsh-recovery-resume'

/** 同一会话在同一进程内最多续跑几次。 */
const MAX_ATTEMPTS_PER_SESSION = 1

/** agent 变成 idle 后等多久再判断（毫秒），让崩溃修复和页面加载先完成。 */
const SETTLE_MS = 3000

/** 续跑消息发出后，等多久再重新授权 goal（毫秒），让续跑消息先占住这一轮。 */
const REARM_DELAY_MS = 1500

/** 跨重启账本：进程内计数每次重启都会归零，靠它防止"崩→续→崩→续"无限循环。 */
const LEDGER_PATH = `${process.env.DSH_HOME || `${process.env.HOME}/.dsh`}/recovery-attempts.json`

export const name = PLUGIN

export function apply(ctx) {
  // 用 console 而不是 ctx.logger：实测 ctx.logger 的输出进不了宿主日志，
  // 排查"插件到底有没有加载"需要一个一定看得到的出口。
  console.log(`[${PLUGIN}] apply() 被调用 —— 插件已加载`)

  /** 本次进程里已续跑过的会话 → 次数。 */
  const attempted = new Map()

  ctx.inject(['agents', 'goals'], (scoped) => {
    scoped.on('agent/created', ({ agent }) => {
      console.log(`${PLUGIN}: agent 创建 id=${agent.id} status=${agent.status}`)
      schedule(agent, scoped)
    })
    scoped.on('agent/status', ({ agent, status }) => {
      console.log(`${PLUGIN}: agent 状态 id=${agent.id} -> ${status}`)
      if (status === 'idle') schedule(agent, scoped)
    })
  })

  function schedule(agent, scoped) {
    const timer = setTimeout(() => {
      try {
        consider(agent, scoped)
      } catch (error) {
        console.error(`${PLUGIN}: 判断异常 ${agent && agent.id}: ${errText(error)}`)
      }
    }, SETTLE_MS)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function errText(error) {
    return error && error.message ? error.message : String(error)
  }

  function consider(agent, scoped) {
    if (!agent) return
    if (agent.status !== 'idle') {
      console.log(`${PLUGIN}: 跳过（status=${agent.status} ≠ idle）`)
      return
    }
    const session = agent.session
    if (!session) {
      console.error(`${PLUGIN}: agent 没有 session，跳过`)
      return
    }
    const done = attempted.get(session.id) || 0
    if (done >= MAX_ATTEMPTS_PER_SESSION) {
      console.log(`${PLUGIN}: 跳过 ${session.id}（本次进程已续跑 ${done} 次）`)
      return
    }

    let ledgerState = readLedger(LEDGER_PATH)
    if (ledgerState.error !== undefined) {
      console.error(`${PLUGIN}: 账本读取失败（按空账本处理）: ${ledgerState.error}`)
    }
    let ledger = ledgerState.data

    // DSH 0.1.6 起用 snapshotEvents()；更老的版本是 events 属性。
    let events
    try {
      if (typeof session.snapshotEvents === 'function') events = session.snapshotEvents()
      else if (Array.isArray(session.events)) events = session.events
    } catch (error) {
      console.error(`${PLUGIN}: snapshotEvents() 抛错 ${session.id}: ${errText(error)}`)
      return
    }
    if (!Array.isArray(events)) {
      // 故意不用 `|| []` 兜底：读不到事件流说明 DSH 的 API 变了，必须在日志里看得见。
      console.error(`${PLUGIN}: 读不到 ${session.id} 的事件流（既没有 snapshotEvents() 也没有 events）`)
      return
    }

    let info = inspectTail(events, Date.now())
    if (!info.resume) {
      if (info.skippedError !== undefined) {
        console.log(
          `${PLUGIN}: 跳过 ${session.id}（上次失败是永久性的，重试无益：` +
            `${info.skippedError.why}` +
            `${info.skippedError.code ? ` code=${info.skippedError.code}` : ''}）`,
        )
      } else {
        console.log(`${PLUGIN}: ${session.id} 无需续跑（尾部没有未处理的非人为中断）`)
      }
      return
    }

    console.log(
      `${PLUGIN}: ★ ${session.id} 发现未处理的中断（reason=${info.reason} turnSeq=${info.turnSeq}` +
        `${info.lastTool ? ` lastTool=${info.lastTool}` : ''}）→ 发送续跑消息`,
    )

    // 先看上次续跑有没有带来进展：有的话说明上次成功了，清零退避计数。
    // 否则"续跑成功 → 又被打断"会被当成连续失败，反被自己的冷却挡住。
    const progress = detectProgressSinceLastAttempt(ledger, session.id, info.turnSeq)
    if (progress.success) {
      console.log(
        `${PLUGIN}: 上次续跑之后任务有进展（turnSeq ${progress.prevSeq} → ${info.turnSeq}）` +
          `→ 判定上次续跑成功，清零退避计数`,
      )
      ledger = resetAttempts(ledger, session.id)
      try {
        writeLedger(LEDGER_PATH, ledger)
      } catch (error) {
        console.error(`${PLUGIN}: 清零账本写入失败: ${errText(error)}`)
      }
    }

    const verdict = checkLedger(ledger, session.id, Date.now())
    if (!verdict.allow) {
      console.log(`${PLUGIN}: 跳过 ${session.id}（${verdict.why}）`)
      return
    }

    // 附上几个 agent 自己不好查的关键点（见 lib/context.js）。提取失败不影响续跑。
    let endIndex = -1
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i] && events[i].type === 'turn/end' && events[i].seq === info.turnSeq) { endIndex = i; break }
    }
    try {
      info = { ...info, keyPoints: extractKeyPoints(events, endIndex) }
    } catch (error) {
      console.error(`${PLUGIN}: 关键点提取失败（不影响续跑）: ${errText(error)}`)
    }

    let message
    try {
      // DSH 的消息来源可以由各模块自定义 kind，不认识的 kind 会被跳过；
      // 这里用插件名，这样一眼就能认出是谁发的。
      message = buildUserMessage({
        content: renderResumePrompt(info),
        source: { kind: PLUGIN, plugin: PLUGIN },
      })
    } catch (error) {
      console.error(`${PLUGIN}: 构造消息失败: ${errText(error)}`)
      return
    }

    try {
      agent.followup(message)
      attempted.set(session.id, done + 1)
      console.log(`${PLUGIN}: 续跑消息已入队 ${session.id}（messageId=${message && message.id}）`)
      // 记账写失败要报出来：静默失败 = 防失控机制悄悄失效。
      try {
        const now = Date.now()
        const updated = recordAttemptWithTurn(pruneLedger(ledger, now), session.id, now, info.turnSeq)
        writeLedger(LEDGER_PATH, updated)
        console.log(
          `${PLUGIN}: 账本已更新 ${session.id} → 累计续跑 ${updated[session.id].attempts} 次` +
            `（本次 turnSeq=${info.turnSeq}）` +
            `（连续未成功上限 ${MAX_CONSECUTIVE_FAILED_RESUMES}，冷却 ${COOLDOWN_MS / 1000}s）`,
        )
      } catch (ledgerWriteError) {
        console.error(`${PLUGIN}: 账本写入失败（防失控计数不生效！）: ${errText(ledgerWriteError)}`)
      }
    } catch (error) {
      console.error(`${PLUGIN}: followup 失败 ${session.id}: ${errText(error)}`)
    }

    // goal 的"可以继续执行"授权只存在内存里，每次重启都会被收回。
    // 这里把它重新授权（和界面上"继续"按钮是同一个 API）。
    const rearmTimer = setTimeout(() => {
      try {
        rearmGoal(scoped, agent, info.reason)
      } catch (error) {
        console.error(`${PLUGIN}: 重新武装异常 ${session.id}: ${errText(error)}`)
      }
    }, REARM_DELAY_MS)
    if (typeof rearmTimer.unref === 'function') rearmTimer.unref()
  }

  /**
   * 重新授权 goal 继续推进。是否动手完全由 decideRearm 决定（只动 active 的目标）——
   * `goals.resume()` 本身也接受 paused/blocked，无条件调用会把用户手动暂停的目标恢复掉。
   */
  function rearmGoal(scoped, agent, reason) {
    let goal
    try {
      goal = scoped.goals.get(agent)
    } catch (error) {
      console.error(`${PLUGIN}: 读 goal 失败 ${agent.id}: ${errText(error)}`)
      return
    }
    const decision = decideRearm(goal, reason)
    if (!decision.rearm) {
      console.log(`${PLUGIN}: 不重新武装 goal（${decision.why}）`)
      return
    }
    try {
      scoped.goals.resume(agent, { id: decision.id, revision: decision.revision })
      console.log(`${PLUGIN}: ★ 已重新武装 goal ${decision.id}（revision=${decision.revision}）→ 目标可继续推进`)
    } catch (error) {
      // revision 可能刚好被推进了一次：重新读取后再试一次（只试一次）。
      // 重试前必须重新过 decideRearm —— revision 变了，可能正是因为用户刚把它暂停了。
      console.error(`${PLUGIN}: 重新武装失败（将按最新 revision 重试一次）: ${errText(error)}`)
      try {
        const retry = decideRearm(scoped.goals.get(agent), reason)
        if (!retry.rearm) {
          console.log(`${PLUGIN}: 放弃重试（${retry.why}）`)
          return
        }
        scoped.goals.resume(agent, { id: retry.id, revision: retry.revision })
        console.log(`${PLUGIN}: ★ 重试成功，已重新武装 goal ${retry.id}（revision=${retry.revision}）`)
      } catch (retryError) {
        console.error(`${PLUGIN}: 重新武装重试仍失败: ${errText(retryError)}`)
      }
    }
  }
}
