export type StatusLine = string

declare module 'claude-code' {
  interface PluginState {
    'cache-keepalive': { statusLine: StatusLine }
  }
}
