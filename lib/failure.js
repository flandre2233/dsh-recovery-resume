/**
 * 失败分类：这次失败值不值得自动续跑。
 *
 * 判断顺序：
 *   1. DSH 官方的"可重试"错误码 → 续跑
 *   2. 已知的永久性错误码，或 HTTP 401 / 403 → 跳过（重试只会白烧 token）
 *   3. 错误消息里有永久性失败的字样（余额不足、模型不存在、上下文超限……）→ 跳过
 *   4. 其余一律放行：宁可多试一次，也不要因为不认识就永远不续跑。
 *      真正的浪费由账本的连续失败上限和退避兜住。
 *
 * DSH 升级后，如果它的码表变了，更新下面两张表即可。
 */

/**
 * DSH 官方的"可重试"码表，照抄自 `@deepseek-ai/dsh-llm/retry-policy`
 * 的 `DEFAULT_RETRYABLE_CODES`（网络失败的码是 TRANSPORT）。
 */
export const DSH_RETRYABLE_CODES = new Set([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/**
 * 已知的永久性码。前四个是 `dsh-llm` 导出的常量；
 * `AUTH` 是 DeepSeek 适配器在 API key 无效（HTTP 401）时抛的。
 */
export const PERMANENT_CODES = new Set([
  'INVALID_CREDENTIAL',
  'QUOTA',
  'CONTEXT_WINDOW_EXCEEDED',
  'IMAGE_OFFLOAD_REQUIRED',
  'AUTH',
])

/**
 * 永久性失败的文字特征，只在错误码不认识时兜底用。
 * 分隔符同时匹配空格、下划线、连字符（`model not found` 和 `model_not_found` 都要认得）。
 */
const SEP = '[ _-]?'
const PERMANENT_PATTERNS = [
  /auth|unauthor|forbidden|credential|api[_-]?key|permission/i,
  new RegExp(`insufficient[^]*?(balance|quota)|quota[^]*?exceed|billing|payment`, 'i'),
  new RegExp(`model.*not${SEP}found|unknown${SEP}model|not.*support.*model`, 'i'),
  new RegExp(`context.*(length|limit|window|overflow|exceed)|token.*limit|max.*context`, 'i'),
  new RegExp(`invalid${SEP}request|bad${SEP}request`, 'i'),
]

/**
 * 从 `turn/end` 的 reason 里取出错误码、HTTP 状态和错误消息。
 * 按 DSH 的类型定义，错误信息在 `reason.error` 里；也兼容几种别的写法，
 * 字段缺失或形状不同都不会报错。
 *
 * @returns {{code?: string, status?: number, message?: string}}
 */
export function failureFacts(reason) {
  const out = {}
  if (reason === null || typeof reason !== 'object') return out
  const candidates = [reason.error, reason.failure, reason.detail, reason]
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue
    if (out.code === undefined && typeof candidate.code === 'string') out.code = candidate.code
    if (out.message === undefined && typeof candidate.message === 'string') out.message = candidate.message
    if (out.status === undefined) {
      if (typeof candidate.status === 'number') out.status = candidate.status
      else if (typeof candidate.statusCode === 'number') out.status = candidate.statusCode
      else if (typeof candidate.httpStatus === 'number') out.status = candidate.httpStatus
    }
  }
  return out
}

/**
 * 这次失败值不值得自动续跑？
 *
 * @param {{code?: string, status?: number, message?: string}} facts
 * @returns {{retry: boolean, why: string, source?: string}}
 */
export function isTransientFailure(facts) {
  const code = typeof facts.code === 'string' ? facts.code.toUpperCase() : ''

  // ① DSH 官方码表优先
  if (code !== '' && DSH_RETRYABLE_CODES.has(code)) {
    return { retry: true, why: `DSH 官方可重试码 ${code}`, source: 'dsh-retry-policy' }
  }

  // ② 已知永久性码
  if (code !== '' && PERMANENT_CODES.has(code)) {
    return { retry: false, why: `永久性码 ${code}`, source: 'dsh-permanent-codes' }
  }

  // ③ HTTP 状态：401/403 是认证/权限，重试无益
  if (facts.status === 401 || facts.status === 403) {
    return { retry: false, why: `HTTP ${facts.status}（认证/权限）`, source: 'http-status' }
  }

  // ④ 文本兜底（码不认识时）
  const haystack = `${code} ${facts.status === undefined ? '' : facts.status} ${facts.message || ''}`.toLowerCase()
  for (const pattern of PERMANENT_PATTERNS) {
    if (pattern.test(haystack)) {
      return { retry: false, why: `命中永久性文本特征：${pattern.source}`, source: 'text-pattern' }
    }
  }

  // ⑤ 其余放行 —— 保守；真正的浪费由账本上限与退避兜住
  return {
    retry: true,
    why: code === '' ? '失败没有 code，无法判定为永久性，按可重试处理' : `未知码 ${code}，按可重试处理`,
    source: 'conservative-default',
  }
}
