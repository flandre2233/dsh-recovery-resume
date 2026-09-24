/**
 * 从事件流里提取几个"关键点"，附在续跑消息里。
 *
 * 原则是不重述上下文（那只会让消息变长，agent 自己能查），
 * 只给它不好查的三样，而且每样都有长度上限：
 *   ① 中断前 agent 最后说的话（截断）—— 它当时正打算做什么
 *   ② 结局未知的工具调用名（最多几个）—— 哪几步的结果不能信
 *   ③ 断在第几回合
 */

/** 每个字段的字符上限（避免注入膨胀）。 */
export const MAX_ASSISTANT_CHARS = 240
export const MAX_UNCONFIRMED = 3

/** 从长文本里取前 n 个字符，并标出被截断。 */
export function clip(text, max = MAX_ASSISTANT_CHARS) {
  if (typeof text !== 'string') return ''
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max)}…（已截断）`
}

/** 把 content（字符串或分块数组）压成纯文本。 */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      out += part.text
    }
  }
  return out
}

/**
 * 从一个 `turn/end` 的位置往前提取"最小关键点"。
 *
 * @param {readonly object[]} events 完整事件流
 * @param {number} endIndex 最后一条 turn/end 的下标
 * @returns {{turn?: number, lastAssistant?: string, unconfirmed: string[]}}
 */
export function extractKeyPoints(events, endIndex) {
  const out = { unconfirmed: [] }
  if (!Array.isArray(events) || endIndex < 0) return out

  // ② 结局未知的工具调用：DSH 的崩溃修复会在 tool/result 的 data.error.code
  //    里标上 TOOL_OUTCOME_UNKNOWN（没跑起来的是 TOOL_NOT_STARTED）。
  const unconfirmed = []
  const seen = new Set()
  for (let i = endIndex; i >= 0 && unconfirmed.length < MAX_UNCONFIRMED; i -= 1) {
    const event = events[i]
    if (!event || event.type !== 'tool/result') continue
    const code = event.data && event.data.error && event.data.error.code
    if (code !== 'TOOL_OUTCOME_UNKNOWN' && code !== 'TOOL_NOT_STARTED') continue
    const callId = event.data && event.data.message && event.data.message.source
      && event.data.message.source.callId
    if (typeof callId !== 'string' || seen.has(callId)) continue
    seen.add(callId)
    // 用 callId 反查工具名（tool/call 在同一段里）
    let name
    for (let j = i; j >= 0; j -= 1) {
      const e2 = events[j]
      if (e2 && e2.type === 'tool/call' && e2.data && e2.data.callId === callId) {
        name = e2.data.name || e2.data.tool
        break
      }
    }
    unconfirmed.push(typeof name === 'string' && name !== '' ? name : '(未知工具)')
  }
  out.unconfirmed = unconfirmed.reverse()   // 还原时间顺序

  // ① 中断前最后一条 assistant 文本 + ③ 该回合序号
  for (let i = endIndex; i >= 0; i -= 1) {
    const event = events[i]
    if (!event) continue
    if (out.turn === undefined && typeof event.data?.turn === 'number') out.turn = event.data.turn
    if (event.type === 'assistant/message') {
      const text = contentText(event.data && event.data.message && event.data.message.content)
      if (text.trim() !== '') {
        out.lastAssistant = clip(text)
        break
      }
    }
  }
  return out
}
