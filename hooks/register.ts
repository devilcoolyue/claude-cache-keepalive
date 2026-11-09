import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, PluginOptions, Register, SessionRateLimit } from 'claude-code'

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

/** Sent once the window starts over, for a turn the pause stopped. */
const RESUME_TEXT = 'Continue where you left off; a usage pause stopped the last turn.'

type Settings = {
  enabled: boolean
  maxHours: number
  minTokens: number
  interval: number
  hourCacheOnApiKey: boolean
  /** The five-hour usage that pauses the session; 0 never pauses. */
  pausePercent: number
  showStatus: boolean
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
  plan?: Plan
  cancelTimer?: () => void
  /** The running main-loop turn. */
  turnId?: string
  isOff: boolean
  lastEnd: string
  /** Why nothing is planned, in the few words the status line has room for. */
  lastLabel: string
  /** What the status line was last told, to redraw only on a change. */
  lastStatus?: string
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
  }
}

function formatTokens(n: number) {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)
}

function minutesUntil(at: number, now: number) {
  return Math.max(Math.ceil((at - now) / MINUTE), 0)
}

function formatWait(at: number, now: number) {
  const minutes = minutesUntil(at, now)
  if (minutes < 60) return `${minutes}m`
  const rest = minutes % 60
  return rest ? `${Math.floor(minutes / 60)}h ${rest}m` : `${minutes / 60}h`
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

function end(s: Runtime, why: string, label = 'stopped') {
  disarm(s)
  s.plan = undefined
  s.lastEnd = why
  s.lastLabel = label
}

/** The few words shown under the prompt; empty when there is nothing to show. */
function statusText(s: Runtime, now: number, pause: Pause | undefined) {
  if (s.isOff) return ''
  if (pause) {
    const held = s.held.length ? `, ${s.held.length} held` : ''
    return `keepalive paused at ${pause.percent}%, resets in ${formatWait(pause.resetsAt, now)}${held}`
  }
  if (s.turnId !== undefined) return 'keepalive on'
  if (s.plan) {
    const { reads } = s.plan
    const count = reads ? ` (${reads} read${reads > 1 ? 's' : ''})` : ''
    return `keepalive next read in ${formatWait(s.plan.next, now)}${count}`
  }
  return `keepalive ${s.lastLabel || 'starts after the next turn'}`
}

/** Tells the status line the current state. Never fails the hook that asks. */
async function refreshStatus($: Engine, s: Runtime) {
  try {
    if (!s.config.showStatus) return
    const text = statusText(s, await $.clock.now(), await currentPause($, s))
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
      .catch(err => end(s, `failed: ${String(err)}`))
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
        s.lastEnd = `could not resume: ${String(err)}`
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
  else if (wasStopped) await $.prompt.submit({ text: RESUME_TEXT })
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

async function replan($: Engine, s: Runtime) {
  disarm(s)
  s.plan = undefined
  if (s.isOff) return
  const { config } = s
  const now = await $.clock.now()
  if (!(await hasHourCache($, s))) {
    end(s, 'not kept: this account writes five-minute caches', 'skipped: 5-minute cache')
    return
  }
  const tokens = (await $.session.usage()).context.tokens ?? 0
  if (tokens < config.minTokens) {
    end(s, `not kept: the prompt has ${formatTokens(tokens)} tokens, below ${formatTokens(config.minTokens)}`,
      `skipped: ${formatTokens(tokens)} is below ${formatTokens(config.minTokens)}`)
    return
  }
  const model = await $.session.model()
  const pause = await currentPause($, s)
  // A turn may have started while the checks above were answered.
  if (s.turnId !== undefined) return
  s.plan = {
    at: now,
    until: untilFor(s, now, pause),
    lastUse: now,
    next: now + config.interval,
    model,
    tokens,
    reads: 0,
  }
  arm($, s, s.plan, now)
}

/** Sends one read of the conversation's cache and says what it found. */
async function readCache($: Engine): Promise<ReadOutcome> {
  // A read here would be refused, or billed as extra usage.
  const usedUp = usedUpWindow((await $.session.usage()).rateLimits, await $.clock.now())
  if (usedUp) return { kind: 'failed', why: `the ${usedUp} limit is used up` }
  const reply = await $.model.fork({ prompt: PROMPT })
  if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
    return { kind: 'failed', why: 'the conversation has nothing to keep (new, or just cleared)' }
  }
  const why = reply.isAnswered ? 'no usage reported' : reply.reason
  const usage = reply.usage
  if (!usage) return { kind: 'failed', why: `no response (${why})` }
  const read = usage.cache_read_input_tokens
  const prompt = usage.input_tokens + read + usage.cache_creation_input_tokens
  if (prompt === 0) return { kind: 'failed', why: `no response (${why})` }
  const detail = `${formatTokens(usage.cache_creation_input_tokens)} written`
  if (read * 2 < prompt) return { kind: 'cold', read, prompt, detail }
  if (!reply.isAnswered && reply.reason !== 'empty-reply') {
    return { kind: 'failed', why: `request failed (${reply.reason})` }
  }
  return { kind: 'warm', read, prompt, detail }
}

/** Records a warm read on the plan and arms the next one, if there is one. */
async function advance($: Engine, s: Runtime, plan: Plan, now: number) {
  plan.lastUse = now
  plan.reads += 1
  plan.next = now + s.config.interval
  plan.until = Math.max(plan.until, untilFor(s, plan.at, await currentPause($, s)))
  if (s.plan !== plan) return
  if (plan.next >= plan.until) {
    end(s, `stopped: the longest keepalive after the last turn has passed`)
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
    end(s, 'stopped: the cache had already expired (was the computer asleep?)')
    return
  }
  if ((await $.session.model()) !== plan.model) {
    end(s, 'stopped: the model changed')
    return
  }
  const outcome = await readCache($)
  // A turn that ended meanwhile has made a newer plan.
  if (s.plan !== plan) return
  if (outcome.kind === 'failed') {
    end(s, `stopped: ${outcome.why}`)
  } else if (outcome.kind === 'cold') {
    end(s, `stopped: the cache was gone (read ${formatTokens(outcome.read)} of ${formatTokens(outcome.prompt)})`)
  } else {
    await advance($, s, plan, await $.clock.now())
  }
}

function pauseLine(pause: Pause, now: number) {
  return `Five-hour usage is at ${pause.percent}%, reserved for the cache keepalive until the window resets in ${minutesUntil(pause.resetsAt, now)} min.`
}

async function describe($: Engine, s: Runtime) {
  if (s.isOff) return 'Cache keepalive is off for this session.'
  const now = await $.clock.now()
  const pause = await currentPause($, s)
  const lines: string[] = []
  const plan = s.plan
  if (plan) {
    lines.push(`Cache keepalive: ${formatTokens(plan.tokens)} tokens, next read in ${minutesUntil(plan.next, now)} min, ${plan.reads} read(s) so far, kept for ${minutesUntil(plan.until, now)} more min.`)
  } else {
    lines.push(`Cache keepalive is on, nothing planned.${s.lastEnd ? ` Last: ${s.lastEnd}.` : ' It starts when the next turn ends.'}`)
  }
  if (pause) {
    const held = s.held.length ? ` ${s.held.length} message(s) held.` : ''
    lines.push(`${pauseLine(pause, now)}${held} /keepalive resume carries on now.`)
  }
  return lines.join('\n')
}

async function readNow($: Engine, s: Runtime) {
  const plan = s.plan
  const outcome = await readCache($)
  if (outcome.kind === 'failed') return `Keepalive read did not run: ${outcome.why}.`
  const line = `Read ${formatTokens(outcome.read)} of ${formatTokens(outcome.prompt)} prompt tokens from the cache (${outcome.detail}).`
  if (outcome.kind === 'cold') return `${line} The cache was gone, so this read paid to write it.`
  if (plan && s.plan === plan) await advance($, s, plan, await $.clock.now())
  return line
}

/** Carries on now, in spite of the five-hour window. */
async function overridePause($: Engine, s: Runtime) {
  const pause = await currentPause($, s)
  if (!pause) return 'No five-hour pause is in force.'
  s.ignoredReset = pause.resetsAt
  // Off the timer: a command's hook may not submit a prompt itself.
  armResume($, s, RESUME_NOW)
  return 'Carrying on in this five-hour window; no more pauses until it resets.'
}

async function runCommand($: Engine, s: Runtime, args: string) {
  switch (args.trim().toLowerCase()) {
    case '':
    case 'status':
      return describe($, s)
    case 'off':
      s.isOff = true
      end(s, 'turned off')
      armResume($, s, RESUME_NOW)
      return 'Cache keepalive is off for this session.'
    case 'on':
      s.isOff = false
      s.lastEnd = ''
      s.lastLabel = ''
      if (s.turnId === undefined && (await $.session.turns()) > 0) await replan($, s)
      return describe($, s)
    case 'now':
      return readNow($, s)
    case 'resume':
      return overridePause($, s)
    default:
      return 'Usage: /keepalive [status|on|off|now|resume]'
  }
}

export const register: Register = (on, options) => {
  const config = settings(options)
  const s: Runtime = { config, isOff: !config.enabled, lastEnd: '', lastLabel: '', held: [], isTurnStopped: false }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'keepalive',
      description: 'Shows or changes the prompt cache keepalive: status, on, off, now, resume',
    })
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
      end(s, 'stopped: the last turn failed')
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
      return { drop: `${pauseLine(pause, now)} Send this message with its attachments again then, or run /keepalive resume first.` }
    }
    s.held.push(e.text)
    resumeAfterReset($, s, pause, now)
    const { text } = e
    $.clock.after(CLEAR_DRAFT_DELAY, () => {
      clearHeldDraft($, text).catch(() => undefined)
    })
    await refreshStatus($, s)
    return { drop: `${pauseLine(pause, now)} Your message is held and goes out by itself then; /keepalive resume sends it now.` }
  })

  // A compaction replaces what the cache held; the next turn writes it anew.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      end(s, 'stopped: the conversation was compacted')
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
