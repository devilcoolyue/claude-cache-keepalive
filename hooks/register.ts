import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, PluginOptions, Register, SessionRateLimit } from 'claude-code'

import { MESSAGES } from './messages'
import type { Locale, Messages } from './messages'

const statusLine = atom({ plugin: 'cache-keepalive', key: 'statusLine' } as const, '')

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** How long the provider keeps a one-hour cache after its last use. */
const CACHE_LIFETIME = HOUR
/** A read this close to the end of the hour may find the cache gone. */
const LATE_MARGIN = 2 * MINUTE

/** How long after the reported reset held work starts, for clock differences. */
const RESUME_DELAY = MINUTE
/** How long past the reset a pause keeps the cache, so the resumed turn finds it. */
const KEEP_PAST_RESET = 15 * MINUTE
/** Delay of a resume the person asked for: a moment, off the command's hook. */
const RESUME_NOW = 100
/** The engine puts a dropped prompt back in the box just after the hook. */
const CLEAR_DRAFT_DELAY = 200
/** The longest a pause may keep a cache after the last turn. */
const PAUSE_LIMIT = 6 * HOUR

/**
 * The throwaway message of a read. The fork names no effort, which would move
 * the cached prefix on some models, so haste is asked for here instead.
 */
const PROMPT =
  'Reply with just OK. You have no tools; answer straight away without thinking it over.'

/** Cells of the status line's countdown bar. */
const BAR_CELLS = 8
/** A cell's eighths, so the bar moves with every minute of the countdown. */
const PARTIAL_CELLS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
/** The frames shown only while a read is out, and how fast they turn. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPIN_INTERVAL = 250

type Settings = {
  enabled: boolean
  maxHours: number
  minTokens: number
  interval: number
  hourCacheOnApiKey: boolean
  /** The five-hour usage that pauses the session; 0 never pauses. */
  pausePercent: number
  showStatus: boolean
  language: 'auto' | Locale
}

type Plan = {
  /** The turn the plan was made from. */
  at: number
  /** No read starts after this. */
  until: number
  /** When the provider last used the cache, which starts its hour. */
  lastUse: number
  /** When the next read is due. */
  next: number
  /** A read under another model would pay for the whole prefix. */
  model: string
  /** The prompt the plan was made for. */
  tokens: number
  /** Reads that found the cache. */
  reads: number
}

type Pause = { percent: number; resetsAt: number }

/** Dropped on a reload with the timers it holds; the next turn plans again. */
type Runtime = {
  config: Settings
  locale: Locale
  plan?: Plan
  cancelTimer?: () => void
  /** The running main-loop turn. */
  turnId?: string
  /** When the last turn of this process ended. */
  lastTurnAt?: number
  /** When the provider last used the cache, as far as this process knows. */
  lastUseAt?: number
  isOff: boolean
  lastEnd: string
  /** Why nothing is planned, in the few words the status line has room for. */
  lastLabel: string
  /** What the status line was last told, to redraw only on a change. */
  lastStatus?: string
  /** The spinner's frame while a read is out. */
  spinFrame?: number
  /** Messages typed during a pause, sent once it ends. */
  held: string[]
  /** A turn the pause stopped, carried on once it ends. */
  isTurnStopped: boolean
  cancelResume?: () => void
  /** The reset of a window the person chose to carry on in. */
  ignoredReset?: number
}

type ReadOutcome =
  | { kind: 'warm'; read: number; prompt: number; detail: string }
  | { kind: 'cold'; read: number; prompt: number; detail: string }
  | { kind: 'failed'; why: string }

function clamp(value: unknown, low: number, high: number, fallback: number) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(n, low), high)
}

function settings(options: PluginOptions): Settings {
  const pause = typeof options.pausePercent === 'number' ? options.pausePercent : 95
  return {
    enabled: options.enabled !== false,
    maxHours: clamp(options.maxHours, 1, 24, 3),
    minTokens: clamp(options.minTokens, 0, Number.MAX_SAFE_INTEGER, 100_000),
    interval: clamp(options.intervalMinutes, 30, 55, 50) * MINUTE,
    hourCacheOnApiKey: options.hourCacheOnApiKey === true,
    pausePercent: pause <= 0 ? 0 : clamp(pause, 50, 99, 95),
    showStatus: options.showStatus !== false,
    language: options.language === 'zh' || options.language === 'en' ? options.language : 'auto',
  }
}

function formatTokens(n: number) {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)
}

function minutesUntil(at: number, now: number) {
  return Math.max(Math.ceil((at - now) / MINUTE), 0)
}

function t(s: Runtime): Messages {
  return MESSAGES[s.locale]
}

/** A language picked in the settings, else Claude Code's, else the system's. */
async function detectLocale($: Engine, s: Runtime): Promise<Locale> {
  const { language } = s.config
  if (language !== 'auto') return language
  try {
    const row = (await $.config.list()).find(item => item.key === 'language')
    const chosen = String(row?.value ?? '')
    if (/chin|中文|汉语|简体|繁体|^zh/i.test(chosen)) return 'zh'
    if (chosen && !/default/i.test(chosen)) return 'en'
    const system = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG')) || ''
    return /^zh/i.test(system) ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

/** Full at the start of the wait, emptying as the next read comes closer. */
function countdownBar(next: number, now: number, interval: number) {
  const eighths = Math.min(Math.max(Math.ceil(((next - now) / interval) * BAR_CELLS * 8), 0), BAR_CELLS * 8)
  const full = Math.floor(eighths / 8)
  const partial = PARTIAL_CELLS[eighths % 8] ?? ''
  return '█'.repeat(full) + partial + '░'.repeat(BAR_CELLS - full - (partial ? 1 : 0))
}

/** Turns the spinner while `work` runs; the only thing that animates. */
async function withSpinner<T>($: Engine, s: Runtime, work: () => Promise<T>): Promise<T> {
  if (!s.config.showStatus) return work()
  s.spinFrame = 0
  const timer = $.clock.every(SPIN_INTERVAL, () => {
    s.spinFrame = (s.spinFrame ?? 0) + 1
    void refreshStatus($, s)
  })
  await refreshStatus($, s)
  try {
    return await work()
  } finally {
    timer.cancel()
    s.spinFrame = undefined
    await refreshStatus($, s)
  }
}

/** The window's reset, or undefined when it reported none it can be held to. */
function resetOf(limit: SessionRateLimit) {
  const at = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
  return Number.isFinite(at) ? at : undefined
}

/** Names a window that is used up and has not started over. */
function usedUpWindow(limits: readonly SessionRateLimit[], now: number) {
  return limits.find(limit => {
    const reset = resetOf(limit)
    return limit.percentUsed >= 100 && (reset === undefined || now < reset)
  })?.kind
}

/** The pause in force: the five-hour window at the threshold, worth reserving. */
async function currentPause($: Engine, s: Runtime): Promise<Pause | undefined> {
  if (s.config.pausePercent === 0 || s.isOff) return undefined
  const usage = await $.session.usage()
  if ((usage.context.tokens ?? 0) < s.config.minTokens) return undefined
  const window = usage.rateLimits.find(limit => limit.kind === 'five_hour')
  const resetsAt = window && resetOf(window)
  if (!window || resetsAt === undefined || window.percentUsed < s.config.pausePercent) return undefined
  if (resetsAt === s.ignoredReset || (await $.clock.now()) >= resetsAt) return undefined
  return { percent: window.percentUsed, resetsAt }
}

function disarm(s: Runtime) {
  s.cancelTimer?.()
  s.cancelTimer = undefined
}

function end(s: Runtime, why: string, label = t(s).stopped) {
  disarm(s)
  s.plan = undefined
  s.lastEnd = why
  s.lastLabel = label
}

/** The few words shown under the prompt; empty when there is nothing to show. */
function statusText(s: Runtime, now: number, pause: Pause | undefined) {
  if (s.isOff) return ''
  const m = t(s)
  if (s.spinFrame !== undefined) return m.reading(SPINNER[s.spinFrame % SPINNER.length] ?? '')
  if (pause) return m.paused(pause.percent, m.duration(minutesUntil(pause.resetsAt, now)), s.held.length)
  if (s.turnId !== undefined) return m.running
  if (s.plan) {
    const { next, reads } = s.plan
    return m.next(countdownBar(next, now, s.config.interval), m.duration(minutesUntil(next, now)), reads)
  }
  return s.lastLabel || m.waiting
}

/** Tells the status line the current state. Never fails the hook that asks. */
async function refreshStatus($: Engine, s: Runtime) {
  try {
    if (!s.config.showStatus) return
    const pause = s.spinFrame === undefined ? await currentPause($, s) : undefined
    const text = statusText(s, await $.clock.now(), pause)
    if (text === s.lastStatus) return
    s.lastStatus = text
    await update($, statusLine, () => text)
  } catch {
    s.lastStatus = undefined
  }
}

function arm($: Engine, s: Runtime, plan: Plan, now: number) {
  disarm(s)
  const timer = $.clock.after(Math.max(plan.next - now, 1000), () => {
    fire($, s)
      .catch(err => end(s, t(s).failed(String(err))))
      .finally(() => refreshStatus($, s))
  })
  s.cancelTimer = () => timer.cancel()
}

function disarmResume(s: Runtime) {
  s.cancelResume?.()
  s.cancelResume = undefined
}

function armResume($: Engine, s: Runtime, delay: number) {
  disarmResume(s)
  const timer = $.clock.after(delay, () => {
    s.cancelResume = undefined
    resume($, s)
      .catch(err => {
        s.lastEnd = t(s).couldNotResume(String(err))
      })
      .finally(() => refreshStatus($, s))
  })
  s.cancelResume = () => timer.cancel()
}

function resumeAfterReset($: Engine, s: Runtime, pause: Pause, now: number) {
  armResume($, s, Math.max(pause.resetsAt + RESUME_DELAY - now, 1000))
}

/** Sends what the pause held back, unless the window has not started over. */
async function resume($: Engine, s: Runtime) {
  disarmResume(s)
  const pause = await currentPause($, s)
  if (pause) {
    resumeAfterReset($, s, pause, await $.clock.now())
    return
  }
  const held = s.held.splice(0)
  const wasStopped = s.isTurnStopped
  s.isTurnStopped = false
  // Messages the person queued already carry on; no second turn for that.
  if (held.length > 0) await $.prompt.submit({ text: held.join('\n\n') })
  else if (wasStopped) await $.prompt.submit({ text: t(s).resumeText })
}

/** Empties the box of a held message, so Enter does not send it twice. */
async function clearHeldDraft($: Engine, text: string) {
  const box = await $.prompt.read()
  if (box.text === text) await $.prompt.fill({ text: '', mode: 'replace' })
}

/** A pause keeps the cache for the turn that resumes after the reset. */
function untilFor(s: Runtime, at: number, pause: Pause | undefined) {
  const until = at + s.config.maxHours * HOUR
  if (!pause) return until
  return Math.max(until, Math.min(pause.resetsAt + KEEP_PAST_RESET, at + PAUSE_LIMIT))
}

/** A subscription writes one-hour caches; other accounts five-minute ones. */
async function hasHourCache($: Engine, s: Runtime) {
  if (s.config.hourCacheOnApiKey) return true
  return (await $.session.usage()).rateLimits.length > 0
}

/** Plans from a turn that just ended, or with `isRestore` from the last known use. */
async function replan($: Engine, s: Runtime, isRestore = false) {
  disarm(s)
  s.plan = undefined
  if (s.isOff) return
  const { config } = s
  const now = await $.clock.now()
  if (!isRestore) {
    s.lastTurnAt = now
    s.lastUseAt = now
  }
  const at = s.lastTurnAt ?? now
  const lastUse = s.lastUseAt ?? now
  if (!(await hasHourCache($, s))) {
    end(s, t(s).notKeptFiveMinute, t(s).skippedFiveMinute)
    return
  }
  const tokens = (await $.session.usage()).context.tokens ?? 0
  if (tokens < config.minTokens) {
    const [size, min] = [formatTokens(tokens), formatTokens(config.minTokens)]
    end(s, t(s).notKeptSmall(size, min), t(s).skippedSmall(size, min))
    return
  }
  const model = await $.session.model()
  const pause = await currentPause($, s)
  // A turn may have started while the checks above were answered.
  if (s.turnId !== undefined) return
  if (now - lastUse >= CACHE_LIFETIME - LATE_MARGIN) {
    end(s, t(s).expired)
    return
  }
  const plan = {
    at,
    until: untilFor(s, at, pause),
    lastUse,
    next: Math.max(lastUse + config.interval, now + 1000),
    model,
    tokens,
    reads: 0,
  }
  if (plan.next >= plan.until) {
    end(s, t(s).longestPassed)
    return
  }
  s.plan = plan
  arm($, s, plan, now)
}

/** Sends one read of the conversation's cache and says what it found. */
async function readCache($: Engine, s: Runtime): Promise<ReadOutcome> {
  const m = t(s)
  // A read here would be refused, or billed as extra usage.
  const usedUp = usedUpWindow((await $.session.usage()).rateLimits, await $.clock.now())
  if (usedUp) return { kind: 'failed', why: m.limitUsedUp(usedUp) }
  const reply = await withSpinner($, s, () => $.model.fork({ prompt: PROMPT }))
  if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
    return { kind: 'failed', why: m.nothingToKeep }
  }
  const why = reply.isAnswered ? m.noUsageReported : reply.reason
  const usage = reply.usage
  if (!usage) return { kind: 'failed', why: m.noResponse(why) }
  const read = usage.cache_read_input_tokens
  const prompt = usage.input_tokens + read + usage.cache_creation_input_tokens
  if (prompt === 0) return { kind: 'failed', why: m.noResponse(why) }
  const detail = formatTokens(usage.cache_creation_input_tokens)
  if (read * 2 < prompt) return { kind: 'cold', read, prompt, detail }
  if (!reply.isAnswered && reply.reason !== 'empty-reply') {
    return { kind: 'failed', why: m.requestFailed(reply.reason) }
  }
  return { kind: 'warm', read, prompt, detail }
}

/** Records a warm read on the plan and arms the next one, if there is one. */
async function advance($: Engine, s: Runtime, plan: Plan, now: number) {
  plan.lastUse = now
  s.lastUseAt = now
  plan.reads += 1
  plan.next = now + s.config.interval
  plan.until = Math.max(plan.until, untilFor(s, plan.at, await currentPause($, s)))
  if (s.plan !== plan) return
  if (plan.next >= plan.until) {
    end(s, t(s).longestPassed)
    return
  }
  arm($, s, plan, now)
}

async function fire($: Engine, s: Runtime) {
  const plan = s.plan
  if (!plan) return
  const now = await $.clock.now()
  if (s.turnId !== undefined) {
    // The turn refreshes the cache itself and plans anew when it ends.
    plan.next = now + s.config.interval
    arm($, s, plan, now)
    return
  }
  if (now - plan.lastUse >= CACHE_LIFETIME - LATE_MARGIN) {
    end(s, t(s).expired)
    return
  }
  if ((await $.session.model()) !== plan.model) {
    end(s, t(s).modelChanged)
    return
  }
  const outcome = await readCache($, s)
  // A turn that ended meanwhile has made a newer plan.
  if (s.plan !== plan) return
  if (outcome.kind === 'failed') {
    end(s, t(s).stoppedBecause(outcome.why))
  } else if (outcome.kind === 'cold') {
    end(s, t(s).cacheGone(formatTokens(outcome.read), formatTokens(outcome.prompt)))
  } else {
    await advance($, s, plan, await $.clock.now())
  }
}

function pauseLine(s: Runtime, pause: Pause, now: number) {
  return t(s).pauseLine(pause.percent, minutesUntil(pause.resetsAt, now))
}

async function describe($: Engine, s: Runtime) {
  const m = t(s)
  if (s.isOff) return m.isOff
  const now = await $.clock.now()
  const pause = await currentPause($, s)
  const lines: string[] = []
  const plan = s.plan
  if (plan) {
    lines.push(m.plan(formatTokens(plan.tokens), minutesUntil(plan.next, now), plan.reads, minutesUntil(plan.until, now)))
  } else {
    lines.push(s.lastEnd ? m.nothingPlannedLast(s.lastEnd) : m.nothingPlanned)
  }
  if (pause) {
    const held = s.held.length ? m.heldCount(s.held.length) : ''
    lines.push(`${pauseLine(s, pause, now)}${held}${m.resumeHint}`)
  }
  return lines.join('\n')
}

async function readNow($: Engine, s: Runtime) {
  const m = t(s)
  const plan = s.plan
  const outcome = await readCache($, s)
  if (outcome.kind === 'failed') return m.readDidNotRun(outcome.why)
  const line = m.readLine(formatTokens(outcome.read), formatTokens(outcome.prompt), outcome.detail)
  if (outcome.kind === 'cold') return `${line}${m.coldNote}`
  if (plan && s.plan === plan) await advance($, s, plan, await $.clock.now())
  return line
}

/** Carries on now, in spite of the five-hour window. */
async function overridePause($: Engine, s: Runtime) {
  const pause = await currentPause($, s)
  if (!pause) return t(s).noPause
  s.ignoredReset = pause.resetsAt
  // Off the timer: a command's hook may not submit a prompt itself.
  armResume($, s, RESUME_NOW)
  return t(s).carryingOn
}

async function runCommand($: Engine, s: Runtime, args: string) {
  switch (args.trim().toLowerCase()) {
    case '':
    case 'status':
      return describe($, s)
    case 'off':
      s.isOff = true
      end(s, t(s).turnedOff)
      armResume($, s, RESUME_NOW)
      return t(s).isOff
    case 'on':
      s.isOff = false
      s.lastEnd = ''
      s.lastLabel = ''
      if (s.turnId === undefined && s.lastUseAt !== undefined) await replan($, s, true)
      return describe($, s)
    case 'now':
      return readNow($, s)
    case 'resume':
      return overridePause($, s)
    default:
      return t(s).usage
  }
}

export const register: Register = (on, options) => {
  const config = settings(options)
  const s: Runtime = {
    config,
    locale: config.language === 'auto' ? 'en' : config.language,
    isOff: !config.enabled,
    lastEnd: '',
    lastLabel: '',
    held: [],
    isTurnStopped: false,
  }

  on('session.start', async ($, e, next) => {
    s.locale = await detectLocale($, s)
    await $.command.register({ name: 'keepalive', description: t(s).commandDescription })
    if (e.isInteractive && config.showStatus) {
      // The minutes it counts down, and usage that moved without a turn.
      $.clock.every(MINUTE, () => {
        void refreshStatus($, s)
      })
      await refreshStatus($, s)
    }
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const text = config.showStatus ? await read($, statusLine) : ''
    if (!text) return next(e)
    const tail = e.props.tail ? `${e.props.tail} · ${text}` : text
    return next({ ...e, props: { ...e.props, tail } })
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      s.turnId = e.turnId
      await refreshStatus($, s)
    }
    return next(e)
  })

  // Before the turn's next model request, its tools having finished; a
  // subagent's request stops the turn that started it too.
  on('turn.step', async function* ($, e, next) {
    const turnId = s.turnId
    if (turnId !== undefined) {
      const pause = await currentPause($, s)
      if (pause) {
        s.isTurnStopped = true
        resumeAfterReset($, s, pause, await $.clock.now())
        await refreshStatus($, s)
        await $.turn.abort({ turnId })
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
      }
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    s.turnId = undefined
    if (e.reason === 'error') {
      end(s, t(s).turnFailed)
    } else if (e.usage || s.isTurnStopped) {
      await replan($, s)
    }
    // No usage: the turn sent no request, so the cache's hour and the plan stand.
    await refreshStatus($, s)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind
    if (e.command || e.isMeta || (kind !== undefined && kind !== 'composer' && kind !== 'bridge')) return next(e)
    const pause = await currentPause($, s)
    if (!pause) return next(e)
    const now = await $.clock.now()
    if (e.attachments?.length) {
      return { drop: `${pauseLine(s, pause, now)}${t(s).attachmentsRefused}` }
    }
    s.held.push(e.text)
    resumeAfterReset($, s, pause, now)
    const { text } = e
    $.clock.after(CLEAR_DRAFT_DELAY, () => {
      clearHeldDraft($, text).catch(() => undefined)
    })
    await refreshStatus($, s)
    return { drop: `${pauseLine(s, pause, now)}${t(s).messageHeld}` }
  })

  // A compaction replaces what the cache held; the next turn writes it anew.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      end(s, t(s).compacted)
      await refreshStatus($, s)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'keepalive' }, async ($, e) => {
    const text = await runCommand($, s, e.args)
    await refreshStatus($, s)
    return { text }
  })
}
