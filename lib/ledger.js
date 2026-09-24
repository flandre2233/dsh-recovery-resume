/**
 * 续跑账本：存在磁盘上、跨重启保留的续跑计数。
 *
 * 为什么要落盘：进程内的计数每次重启都会归零，挡不住
 * "中断 → 重启 → 续跑 → 又中断 → 又重启 → 又续跑 …" 这种每圈都烧 token 的循环。
 *
 * 账本负责两件事：
 *   - 连续没带来进展的续跑达到上限（3 次）就停下，只写日志等人处理
 *   - 两次续跑之间要冷却，连续失败时冷却时间翻倍
 * 超过 RETENTION_DAYS 天的旧条目会被清掉，文件不会无限增长。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * **连续未成功**的续跑次数上限（不是总次数）。超过就停下等人。
 * 一旦检测到"上次续跑之后任务有进展"（即上次成功），这个计数会清零。
 */
export const MAX_CONSECUTIVE_FAILED_RESUMES = 3

/** 两次续跑之间的基础间隔（毫秒），防止"崩—续—崩"的紧密循环。 */
export const COOLDOWN_MS = 5 * 60 * 1000

/** 连续失败时冷却的翻倍系数（借鉴 dsh-client-auto-continue 的 backoffFactor）。 */
export const BACKOFF_FACTOR = 2

/** 冷却的上限（毫秒）。 */
export const BACKOFF_MAX_MS = 30 * 60 * 1000

/**
 * 退避：已经连续续跑 n 次之后，下一次至少要等多久。
 * 公式是 base × factor^n，封顶 max。默认参数下实际用到的只有两档：
 * 续跑 1 次后等 10 分钟，2 次后等 20 分钟；3 次后直接停下（见 checkLedger），轮不到冷却。
 *
 * @param {number} attempts 已经连续续跑过的次数
 * @returns {number} 本次应等的毫秒数
 */
export function effectiveCooldown(attempts, base = COOLDOWN_MS, factor = BACKOFF_FACTOR, max = BACKOFF_MAX_MS) {
  const n = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0
  const raw = base * factor ** n
  return Math.min(raw, max)
}

/** 账本条目的保留天数。 */
export const RETENTION_DAYS = 7

/**
 * 读取账本。任何读取/解析问题都当成"空账本"并原样返回空对象 ——
 * 但要**报告**出来（调用方负责 console.error），不能静默吞掉。
 *
 * @param {string} path
 * @returns {{data: Record<string, {attempts: number, lastAt: number, history: number[]}>, error?: string}}
 */
export function readLedger(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: {}, error: '账本内容不是对象' }
    }
    return { data: parsed }
  } catch (error) {
    const code = error && error.code
    if (code === 'ENOENT') return { data: {} }   // 首次运行：没有文件是正常的
    return { data: {}, error: error && error.message ? error.message : String(error) }
  }
}

/** 原子写入账本（先写临时文件再 rename，避免写一半崩掉留下坏 JSON）。 */
export function writeLedger(path, data) {
  const tmp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** 清掉过期条目（避免账本无限增长）。返回清理后的新对象。 */
export function pruneLedger(data, now, retentionDays = RETENTION_DAYS) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  const out = {}
  for (const [sessionId, entry] of Object.entries(data)) {
    if (entry && typeof entry.lastAt === 'number' && entry.lastAt >= cutoff) out[sessionId] = entry
  }
  return out
}

/**
 * 判断"这次还允不允许续跑"。
 *
 * @param {Record<string, unknown>} data 账本
 * @param {string} sessionId
 * @param {number} now
 * @returns {{allow: true} | {allow: false, why: string}}
 */
export function checkLedger(data, sessionId, now, maxAttempts = MAX_CONSECUTIVE_FAILED_RESUMES, cooldownMs = COOLDOWN_MS) {
  const entry = data[sessionId]
  if (entry === undefined || entry === null) return { allow: true }
  const consecutive = typeof entry.consecutive === 'number'
    ? entry.consecutive
    : (typeof entry.attempts === 'number' ? entry.attempts : 0)   // 旧账本回退
  if (consecutive >= maxAttempts) {
    return {
      allow: false,
      why: `已连续 ${consecutive} 次续跑都没带来进展（上限 ${maxAttempts}），停下等人确认`,
    }
  }
  const lastAt = typeof entry.lastAt === 'number' ? entry.lastAt : 0
  const elapsed = now - lastAt
  // 用默认冷却时走翻倍退避；调用方显式传了别的冷却时间（测试用）就按固定值。
  const cooldown = cooldownMs === COOLDOWN_MS ? effectiveCooldown(consecutive) : cooldownMs
  if (elapsed < cooldown) {
    const wait = Math.ceil((cooldown - elapsed) / 1000)
    return {
      allow: false,
      why: `距上次续跑仅 ${Math.round(elapsed / 1000)}s，冷却中（本次冷却 ${Math.round(cooldown / 1000)}s，还需 ${wait}s）`,
    }
  }
  return { allow: true }
}

/**
 * 记一次续跑，返回更新后的账本（不写盘，由调用方决定何时写）。
 *
 * 记两个数：
 *   - `attempts`：总次数，只用来在日志里看，不做限制
 *   - `consecutive`：连续没带来进展的次数，上限和退避都看它
 * 上限看"连续失败"而不是"总次数"：成功续跑过很多次并不危险，反复失败才是失控。
 */
export function recordAttempt(data, sessionId, now) {
  const prev = data[sessionId]
  const attempts = (prev && typeof prev.attempts === 'number' ? prev.attempts : 0) + 1
  const consecutive = (prev && typeof prev.consecutive === 'number' ? prev.consecutive : 0) + 1
  const history = Array.isArray(prev && prev.history) ? prev.history.slice(-9) : []
  history.push(now)
  return { ...data, [sessionId]: { attempts, consecutive, lastAt: now, history } }
}

/**
 * 判断上次续跑是不是成功了（成功就该清零退避，否则会被自己的冷却挡住）。
 *
 * 判据：这次的 `turn/end` 比上次续跑时记下的更新（seq 更大），
 * 说明上次续跑之后任务确实往前走了。
 *
 * @param {Record<string, unknown>} data 账本
 * @param {string} sessionId
 * @param {number} currentTurnSeq 本次发现的 turn/end 的 seq
 * @returns {{success: boolean, prevSeq?: number}}
 */
export function detectProgressSinceLastAttempt(data, sessionId, currentTurnSeq) {
  const entry = data[sessionId]
  if (entry === undefined || entry === null) return { success: false }
  const prevSeq = typeof entry.lastTurnSeq === 'number' ? entry.lastTurnSeq : undefined
  if (prevSeq === undefined) {
    // 旧版账本没有 `lastTurnSeq`，无从比较：当作有进展、清零重来。
    // 这只会发生一次——清零后下一次记账就会带上 lastTurnSeq，连续失败上限照常生效。
    return { success: true, prevSeq: undefined, migrated: true }
  }
  return { success: Number.isFinite(currentTurnSeq) && currentTurnSeq > prevSeq, prevSeq }
}

/** 清零某个会话的尝试记录（= 上次续跑被判定为成功，撤销退避）。 */
export function resetAttempts(data, sessionId) {
  if (data[sessionId] === undefined) return data
  const next = { ...data }
  delete next[sessionId]
  return next
}

/** 记一次续跑，同时记下当时的 turn/end seq（供下次判断"有没有进展"）。 */
export function recordAttemptWithTurn(data, sessionId, now, turnSeq) {
  const updated = recordAttempt(data, sessionId, now)
  return { ...updated, [sessionId]: { ...updated[sessionId], lastTurnSeq: turnSeq } }
}
