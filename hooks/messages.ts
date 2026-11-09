export type Locale = 'en' | 'zh'

export type Messages = {
  commandDescription: string
  usage: string
  resumeText: string

  // The status line.
  duration: (minutes: number) => string
  running: string
  waiting: string
  stopped: string
  reading: (frame: string) => string
  next: (bar: string, wait: string, reads: number) => string
  paused: (percent: number, wait: string, held: number) => string
  skippedSmall: (tokens: string, min: string) => string
  skippedFiveMinute: string

  // Why a plan ended, as /keepalive reports it.
  stoppedBecause: (why: string) => string
  failed: (err: string) => string
  couldNotResume: (err: string) => string
  notKeptFiveMinute: string
  notKeptSmall: (tokens: string, min: string) => string
  longestPassed: string
  expired: string
  modelChanged: string
  cacheGone: (read: string, prompt: string) => string
  turnFailed: string
  compacted: string
  turnedOff: string

  // Why a read did not run.
  limitUsedUp: (kind: string) => string
  nothingToKeep: string
  noResponse: (why: string) => string
  requestFailed: (why: string) => string
  noUsageReported: string

  // /keepalive.
  isOff: string
  plan: (tokens: string, next: number, reads: number, left: number) => string
  nothingPlanned: string
  nothingPlannedLast: (why: string) => string
  pauseLine: (percent: number, minutes: number) => string
  heldCount: (held: number) => string
  resumeHint: string
  readLine: (read: string, prompt: string, written: string) => string
  coldNote: string
  readDidNotRun: (why: string) => string
  noPause: string
  carryingOn: string

  // A message sent during a pause.
  attachmentsRefused: string
  messageHeld: string
}

const WINDOW_NAMES_ZH: Record<string, string> = {
  five_hour: '5 小时额度',
  seven_day: '每周额度',
  spend_limit: '消费上限',
}

const en: Messages = {
  commandDescription: 'Shows or changes the prompt cache keepalive: status, on, off, now, resume',
  usage: 'Usage: /keepalive [status|on|off|now|resume]',
  resumeText: 'Continue where you left off; a usage pause stopped the last turn.',

  duration: minutes => {
    if (minutes < 60) return `${minutes}m`
    const rest = minutes % 60
    return rest ? `${Math.floor(minutes / 60)}h ${rest}m` : `${minutes / 60}h`
  },
  running: '◌ keepalive on · waits for this turn',
  waiting: '○ keepalive starts after the next turn',
  stopped: '✕ keepalive stopped',
  reading: frame => `${frame} keepalive reading`,
  next: (bar, wait, reads) => `● keepalive ${bar} ${wait}${reads ? ` (${reads} read${reads > 1 ? 's' : ''})` : ''}`,
  paused: (percent, wait, held) => `⏸ keepalive paused at ${percent}%, resets in ${wait}${held ? `, ${held} held` : ''}`,
  skippedSmall: (tokens, min) => `○ keepalive skipped: ${tokens} is below ${min}`,
  skippedFiveMinute: '○ keepalive skipped: 5-minute cache',

  stoppedBecause: why => `stopped: ${why}`,
  failed: err => `failed: ${err}`,
  couldNotResume: err => `could not resume: ${err}`,
  notKeptFiveMinute: 'not kept: this account writes five-minute caches',
  notKeptSmall: (tokens, min) => `not kept: the prompt has ${tokens} tokens, below ${min}`,
  longestPassed: 'stopped: the longest keepalive after the last turn has passed',
  expired: 'stopped: the cache had already expired (was the computer asleep?)',
  modelChanged: 'stopped: the model changed',
  cacheGone: (read, prompt) => `stopped: the cache was gone (read ${read} of ${prompt})`,
  turnFailed: 'stopped: the last turn failed',
  compacted: 'stopped: the conversation was compacted',
  turnedOff: 'turned off',

  limitUsedUp: kind => `the ${kind} limit is used up`,
  nothingToKeep: 'the conversation has nothing to keep (new, or just cleared)',
  noResponse: why => `no response (${why})`,
  requestFailed: why => `request failed (${why})`,
  noUsageReported: 'no usage reported',

  isOff: 'Cache keepalive is off for this session.',
  plan: (tokens, next, reads, left) => `Cache keepalive: ${tokens} tokens, next read in ${next} min, ${reads} read(s) so far, kept for ${left} more min.`,
  nothingPlanned: 'Cache keepalive is on, nothing planned. It starts when the next turn ends.',
  nothingPlannedLast: why => `Cache keepalive is on, nothing planned. Last: ${why}.`,
  pauseLine: (percent, minutes) => `Five-hour usage is at ${percent}%, reserved for the cache keepalive until the window resets in ${minutes} min.`,
  heldCount: held => ` ${held} message(s) held.`,
  resumeHint: ' /keepalive resume carries on now.',
  readLine: (read, prompt, written) => `Read ${read} of ${prompt} prompt tokens from the cache (${written} written).`,
  coldNote: ' The cache was gone, so this read paid to write it.',
  readDidNotRun: why => `Keepalive read did not run: ${why}.`,
  noPause: 'No five-hour pause is in force.',
  carryingOn: 'Carrying on in this five-hour window; no more pauses until it resets.',

  attachmentsRefused: ' Send this message with its attachments again then, or run /keepalive resume first.',
  messageHeld: ' Your message is held and goes out by itself then; /keepalive resume sends it now.',
}

const zh: Messages = {
  commandDescription: '查看或修改提示词缓存保活：status、on、off、now、resume',
  usage: '用法：/keepalive [status|on|off|now|resume]',
  resumeText: '继续刚才的工作；上一轮被 5 小时额度暂停打断了。',

  duration: minutes => {
    if (minutes < 60) return `${minutes}分钟`
    const rest = minutes % 60
    return rest ? `${Math.floor(minutes / 60)}小时${rest}分钟` : `${minutes / 60}小时`
  },
  running: '◌ 保活已开启 · 等待本轮结束',
  waiting: '○ 保活将在下一轮结束后开始',
  stopped: '✕ 保活已停止',
  reading: frame => `${frame} 保活读取中`,
  next: (bar, wait, reads) => `● 保活 ${bar} ${wait}${reads ? `（已读 ${reads} 次）` : ''}`,
  paused: (percent, wait, held) => `⏸ 保活暂停 ${percent}% · ${wait}后重置${held ? ` · 暂存 ${held} 条` : ''}`,
  skippedSmall: (tokens, min) => `○ 保活跳过：${tokens} 低于 ${min}`,
  skippedFiveMinute: '○ 保活跳过：5 分钟缓存',

  stoppedBecause: why => `已停止：${why}`,
  failed: err => `失败：${err}`,
  couldNotResume: err => `无法继续：${err}`,
  notKeptFiveMinute: '未保活：这个账号写的是 5 分钟缓存',
  notKeptSmall: (tokens, min) => `未保活：对话只有 ${tokens} token，低于 ${min}`,
  longestPassed: '已停止：距离上一轮已超过最长保活时间',
  expired: '已停止：缓存已经过期（电脑休眠过？）',
  modelChanged: '已停止：模型已切换',
  cacheGone: (read, prompt) => `已停止：缓存已失效（只读到 ${prompt} 中的 ${read}）`,
  turnFailed: '已停止：上一轮失败了',
  compacted: '已停止：对话已被压缩',
  turnedOff: '已关闭',

  limitUsedUp: kind => `${WINDOW_NAMES_ZH[kind] ?? kind}已用尽`,
  nothingToKeep: '对话没有可保活的内容（刚开始或刚清空）',
  noResponse: why => `没有响应（${why}）`,
  requestFailed: why => `请求失败（${why}）`,
  noUsageReported: '没有返回用量',

  isOff: '当前会话的缓存保活已关闭。',
  plan: (tokens, next, reads, left) => `缓存保活：${tokens} token，${next} 分钟后读取，已读取 ${reads} 次，还会保活 ${left} 分钟。`,
  nothingPlanned: '缓存保活已开启，暂无计划，下一轮结束后开始。',
  nothingPlannedLast: why => `缓存保活已开启，暂无计划。上次：${why}。`,
  pauseLine: (percent, minutes) => `5 小时额度已用 ${percent}%，剩余额度留给缓存保活，${minutes} 分钟后重置。`,
  heldCount: held => `已暂存 ${held} 条消息。`,
  resumeHint: '运行 /keepalive resume 可立即继续。',
  readLine: (read, prompt, written) => `从缓存读取了 ${prompt} 中的 ${read} token（写入 ${written}）。`,
  coldNote: '缓存已失效，这次读取付了重新写入的费用。',
  readDidNotRun: why => `保活读取未执行：${why}。`,
  noPause: '当前没有 5 小时额度暂停。',
  carryingOn: '已继续，在这个额度窗口内不再暂停。',

  attachmentsRefused: '届时请重新发送这条带附件的消息，或先运行 /keepalive resume。',
  messageHeld: '你的消息已暂存，届时自动发出；运行 /keepalive resume 可立即发送。',
}

export const MESSAGES: Record<Locale, Messages> = { en, zh }
