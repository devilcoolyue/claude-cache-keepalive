import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const SUBSCRIPTION = [{ kind: 'five_hour', percentUsed: 10, resetsAt: new Date(4 * HOUR).toISOString() }]
const window = (kind: string, percentUsed: number, resetAt = 4 * HOUR) => ({ kind, percentUsed, resetsAt: new Date(resetAt).toISOString() })

type Reply = Record<string, unknown>

const warm: Reply = {
  isAnswered: true,
  text: 'OK',
  usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0 },
}

const cold: Reply = {
  isAnswered: true,
  text: 'OK',
  usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 146_000 },
}

const turnUsage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1, model: 'm' }

function engine(on: On, world: { tokens?: number; rateLimits?: unknown[]; replies?: Reply[]; model?: string } = {}) {
  const forks: string[] = []
  const requests: number[] = []
  const aborted: string[] = []
  const submitted: string[] = []
  const box = { text: '', cleared: 0 }
  const state = { model: world.model ?? 'm' }
  on('turn.step', async function* (_, e) {
    requests.push(e.index)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.abort', (_, e) => {
    aborted.push(e.turnId)
    return { value: undefined } as never
  })
  const shown: { tail?: string } = {}
  on('ui.render', ($$, e: any) => {
    shown.tail = e.props.tail
    const { Text } = $$.ui.resolve(e)
    return h(Text, {}, 'engine') as never
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: 0 } }) as never)
  on('prompt.fill', () => {
    box.text = ''
    box.cleared += 1
    return { isFilled: true } as never
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('command.register', () => ({ value: { command: 'keepalive' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: world.tokens ?? 150_000, window: 1_000_000 }, rateLimits: world.rateLimits ?? SUBSCRIPTION },
  }) as never)
  on('session.model', () => ({ value: state.model }) as never)
  on('session.turns', () => ({ value: 1 }) as never)
  on('model.fork', (_, e) => {
    forks.push(e.prompt)
    return { value: world.replies?.shift() ?? warm } as never
  })
  return { forks, state, requests, aborted, submitted, box, shown }
}

const STEP = { turnId: 't', index: 1, model: 'm', messageCount: 3 }

async function step($: any) {
  for await (const _ of $.turn.step(STEP)) void _
}

function keepalive($: any, args: string) {
  return $.command.run({ command: 'keepalive', args })
}

function say($: any, text: string) {
  return $.prompt.submit({ text })
}

async function turn($: any) {
  await $.turn.start({ turnId: 't', text: 'hi' })
  await $.turn.complete({ turnId: 't', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer', usage: turnUsage })
}

test('an idle session is read every interval until the longest keepalive', async ($, on) => {
  const clock = mock.clock(on)
  const { forks } = engine(on)
  await turn($)
  await clock.advance(49 * MINUTE)
  expect(forks.length).toBe(0)
  await clock.advance(MINUTE)
  expect(forks.length).toBe(1)
  await clock.advance(180 * MINUTE)
  // 50, 100, 150 minutes; 200 is past the three hours.
  expect(forks.length).toBe(3)
})

test('a new turn moves the plan', async ($, on) => {
  const clock = mock.clock(on)
  const { forks } = engine(on)
  await turn($)
  await clock.advance(40 * MINUTE)
  await turn($)
  await clock.advance(40 * MINUTE)
  expect(forks.length).toBe(0)
  await clock.advance(10 * MINUTE)
  expect(forks.length).toBe(1)
})

test('nothing is read while a turn runs', async ($, on) => {
  const clock = mock.clock(on)
  const { forks } = engine(on)
  await turn($)
  await $.turn.start({ turnId: 'long', text: 'hi' })
  await clock.advance(50 * MINUTE)
  expect(forks.length).toBe(0)
})

test('a small prompt is left alone', async ($, on) => {
  const clock = mock.clock(on)
  const { forks } = engine(on, { tokens: 5_000 })
  await turn($)
  await clock.advance(120 * MINUTE)
  expect(forks.length).toBe(0)
})

test('an account with five-minute caches is left alone', async ($, on) => {
  const clock = mock.clock(on)
  const { forks } = engine(on, { rateLimits: [] })
  await turn($)
  await clock.advance(120 * MINUTE)
  expect(forks.length).toBe(0)
})

test('an API key that opted in to one-hour caches is kept', { options: { hourCacheOnApiKey: true } }, async ($, on) => {
  const clock = mock.clock(on)
  const { forks } = engine(on, { rateLimits: [] })
  await turn($)
  await clock.advance(50 * MINUTE)
  expect(forks.length).toBe(1)
})

test('a read that finds the cache gone ends the plan', async ($, on) => {
  const clock = mock.clock(on)
  const { forks } = engine(on, { replies: [cold] })
  await turn($)
  await clock.advance(50 * MINUTE)
  expect(forks.length).toBe(1)
  await clock.advance(120 * MINUTE)
  expect(forks.length).toBe(1)
  const { text } = (await keepalive($, '')) as { text: string }
  expect(text).toContain('the cache was gone')
})

test('a model switch ends the plan without a request', async ($, on) => {
  const clock = mock.clock(on)
  const { forks, state } = engine(on)
  await turn($)
  state.model = 'other'
  await clock.advance(120 * MINUTE)
  expect(forks.length).toBe(0)
})

test('/keepalive off stops reads and on starts them again', async ($, on) => {
  const clock = mock.clock(on)
  const { forks } = engine(on)
  await turn($)
  await keepalive($, 'off')
  await clock.advance(120 * MINUTE)
  expect(forks.length).toBe(0)
  await keepalive($, 'on')
  await clock.advance(50 * MINUTE)
  expect(forks.length).toBe(1)
})

test('/keepalive now reports what it read', async ($, on) => {
  mock.clock(on)
  engine(on)
  await turn($)
  const { text } = (await keepalive($, 'now')) as { text: string }
  expect(text).toBe('Read 150K of 150K prompt tokens from the cache (0 written).')
})

test('a used-up weekly limit stops the reads without a request', async ($, on) => {
  const clock = mock.clock(on)
  const world = { rateLimits: [window('five_hour', 10)] as unknown[] }
  const { forks } = engine(on, world)
  await turn($)
  world.rateLimits = [window('five_hour', 10), window('seven_day', 100, 48 * HOUR)]
  await clock.advance(120 * MINUTE)
  expect(forks.length).toBe(0)
  const { text } = (await keepalive($, '')) as { text: string }
  expect(text).toContain('seven_day limit is used up')
})

test('a window that already started over does not stop the reads', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, { rateLimits: [window('five_hour', 100, 10 * MINUTE)] }).forks
  await turn($)
  await clock.advance(50 * MINUTE)
  const { text } = (await keepalive($, '')) as { text: string }
  expect(text).toContain('1 read(s)')
})

test('at the threshold the next model request stops the turn, and it carries on after the reset', async ($, on) => {
  const clock = mock.clock(on)
  const world = { rateLimits: [window('five_hour', 96, 2 * HOUR)] as unknown[] }
  const { requests, aborted, submitted } = engine(on, world)
  await $.turn.start({ turnId: 't', text: 'hi' })
  await step($)
  expect(requests.length).toBe(0)
  expect(aborted).toEqual(['t'])
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
  await clock.advance(120 * MINUTE)
  expect(submitted.length).toBe(0)
  await clock.advance(MINUTE)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('Continue')
})

test('below the threshold requests go through', async ($, on) => {
  mock.clock(on)
  const { requests, aborted } = engine(on, { rateLimits: [window('five_hour', 94, 2 * HOUR)] })
  await $.turn.start({ turnId: 't', text: 'hi' })
  await step($)
  expect(requests.length).toBe(1)
  expect(aborted.length).toBe(0)
})

test('a conversation too small to keep is never paused', async ($, on) => {
  mock.clock(on)
  const { requests } = engine(on, { tokens: 5_000, rateLimits: [window('five_hour', 96, 2 * HOUR)] })
  await $.turn.start({ turnId: 't', text: 'hi' })
  await step($)
  expect(requests.length).toBe(1)
})

test('pausePercent 0 never pauses', { options: { pausePercent: 0 } }, async ($, on) => {
  mock.clock(on)
  const { requests } = engine(on, { rateLimits: [window('five_hour', 99, 2 * HOUR)] })
  await $.turn.start({ turnId: 't', text: 'hi' })
  await step($)
  expect(requests.length).toBe(1)
})

test('a message typed during a pause is held and goes out after the reset', async ($, on) => {
  const clock = mock.clock(on)
  const { submitted } = engine(on, { rateLimits: [window('five_hour', 96, 2 * HOUR)] })
  await turn($).catch(() => undefined)
  const held = await say($, 'first')
  await say($, 'second')
  expect((held as { drop?: string }).drop).toContain('held')
  expect(submitted.length).toBe(0)
  await clock.advance(121 * MINUTE)
  expect(submitted).toEqual(['first\n\nsecond'])
})

test('/keepalive resume releases what is held and stops pausing in this window', async ($, on) => {
  const clock = mock.clock(on)
  const { submitted, requests } = engine(on, { rateLimits: [window('five_hour', 96, 2 * HOUR)] })
  await say($, 'first')
  await keepalive($, 'resume')
  await clock.advance(1000)
  expect(submitted).toEqual(['first'])
  await $.turn.start({ turnId: 't', text: 'hi' })
  await step($)
  expect(requests.length).toBe(1)
})

test('a pause keeps the cache past the reset, beyond the usual three hours', async ($, on) => {
  const clock = mock.clock(on)
  const { forks } = engine(on, { rateLimits: [window('five_hour', 96, 4 * HOUR)] })
  await $.turn.start({ turnId: 't', text: 'hi' })
  await $.turn.complete({ turnId: 't', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer', usage: turnUsage })
  await clock.advance(5 * HOUR)
  // 50 to 250 minutes; the reset at 240 plus 15 ends it before 300.
  expect(forks.length).toBe(5)
})

test('a held message leaves the box, but a new draft stays', async ($, on) => {
  const clock = mock.clock(on)
  const { box } = engine(on, { rateLimits: [window('five_hour', 96, 2 * HOUR)] })
  box.text = 'first'
  await say($, 'first')
  await clock.advance(1000)
  expect(box.text).toBe('')
  box.text = 'something new'
  box.cleared = 0
  await say($, 'second')
  await clock.advance(1000)
  expect(box.text).toBe('something new')
  expect(box.cleared).toBe(0)
})

const HINT = {
  plugin: 'cache-keepalive',
  surface: 'terminal',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

async function tailShown($: any, shown: { tail?: string }) {
  shown.tail = undefined
  const ui = await $.ui.mount(HINT)
  await ui.unmount()
  return shown.tail
}

async function interactive($: any) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

test('the status line counts down to the next read', async ($, on) => {
  const clock = mock.clock(on)
  const { shown } = engine(on)
  await interactive($)
  await turn($)
  await clock.advance(10 * MINUTE)
  expect(await tailShown($, shown)).toBe('● keepalive ███████░ 40m')
})

test('the status line counts the reads', async ($, on) => {
  const clock = mock.clock(on)
  const { shown } = engine(on)
  await interactive($)
  await turn($)
  await clock.advance(50 * MINUTE)
  expect(await tailShown($, shown)).toBe('● keepalive ████████ 50m (1 read)')
})

test('the status line shows a pause and what it holds', async ($, on) => {
  mock.clock(on)
  const { shown } = engine(on, { rateLimits: [window('five_hour', 96, 2 * HOUR)] })
  await interactive($)
  await say($, 'first')
  expect(await tailShown($, shown)).toBe('⏸ keepalive paused at 96%, resets in 2h, 1 held')
})

test('the status line says why a conversation is skipped', async ($, on) => {
  mock.clock(on)
  const { shown } = engine(on, { tokens: 5_000 })
  await interactive($)
  await turn($)
  expect(await tailShown($, shown)).toBe('○ keepalive skipped: 5K is below 100K')
})

test('while a turn runs the status line says it waits for it', async ($, on) => {
  mock.clock(on)
  const { shown } = engine(on)
  await interactive($)
  await $.turn.start({ turnId: 't', text: 'hi' })
  expect(await tailShown($, shown)).toBe('◌ keepalive on · waits for this turn')
})

test('before any turn the status line says what it waits for', async ($, on) => {
  mock.clock(on)
  const { shown } = engine(on)
  await interactive($)
  expect(await tailShown($, shown)).toBe('○ keepalive starts after the next turn')
})

test('the status line clears when it is turned off', async ($, on) => {
  mock.clock(on)
  const { shown } = engine(on)
  await interactive($)
  await turn($)
  await keepalive($, 'off')
  expect(await tailShown($, shown)).toBeUndefined()
})

test('showStatus false leaves the line alone', { options: { showStatus: false } }, async ($, on) => {
  mock.clock(on)
  const { shown } = engine(on)
  await interactive($)
  await turn($)
  expect(await tailShown($, shown)).toBeUndefined()
})

test('the countdown bar empties as the next read comes closer', async ($, on) => {
  const clock = mock.clock(on)
  const { shown } = engine(on)
  await interactive($)
  await turn($)
  await clock.advance(45 * MINUTE)
  expect(await tailShown($, shown)).toBe('● keepalive █░░░░░░░ 5m')
})

test('the language setting puts everything in Chinese', { options: { language: 'zh' } }, async ($, on) => {
  mock.clock(on)
  const { shown } = engine(on)
  await interactive($)
  await turn($)
  expect(await tailShown($, shown)).toBe('● 保活 ████████ 50分钟')
  const { text } = (await keepalive($, '')) as { text: string }
  expect(text).toBe('缓存保活：150K token，50 分钟后读取，已读取 0 次，还会保活 180 分钟。')
})

test('auto follows a Chinese system locale', async ($, on) => {
  mock.clock(on)
  mock.env(on, { LANG: 'zh_CN.UTF-8' })
  on('config.list', () => ({ value: [{ key: 'language', value: 'Default (English)' }] }) as never)
  const { shown } = engine(on)
  await interactive($)
  expect(await tailShown($, shown)).toBe('○ 保活将在下一轮结束后开始')
})

test('auto follows Claude Code\'s language over the system', async ($, on) => {
  mock.clock(on)
  mock.env(on, { LANG: 'en_US.UTF-8' })
  on('config.list', () => ({ value: [{ key: 'language', value: '中文' }] }) as never)
  const { shown } = engine(on)
  await interactive($)
  expect(await tailShown($, shown)).toBe('○ 保活将在下一轮结束后开始')
})

test('the Chinese pause message goes out with the five-hour reason', { options: { language: 'zh' } }, async ($, on) => {
  const clock = mock.clock(on)
  const { submitted, aborted } = engine(on, { rateLimits: [window('five_hour', 96, 2 * HOUR)] })
  await interactive($)
  await $.turn.start({ turnId: 't', text: 'hi' })
  await step($)
  expect(aborted).toEqual(['t'])
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
  await clock.advance(121 * MINUTE)
  expect(submitted[0]).toContain('继续')
})
