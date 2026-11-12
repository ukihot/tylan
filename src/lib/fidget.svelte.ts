import { untrack } from 'svelte'

/** Progress text that floats at the right edge (fidget.nvim style): one line per job, gone when done. */
type Line = { key: string; text: string; detail: string; done: boolean }
let lines = $state.raw<Line[]>([])
const timers = new Map<string, ReturnType<typeof setTimeout>>()
// Called from effects: reading the list here must not make the caller depend on it.
const put = (key: string, text: string, detail: string, done: boolean) =>
  untrack(() => {
    const old = lines.find((l) => l.key === key)
    if (old && old.text === text && old.detail === detail && old.done === done) {
      return
    }
    clearTimeout(timers.get(key))
    const line = { key, text, detail, done }
    lines = old ? lines.map((l) => (l === old ? line : l)) : [...lines, line]
    if (done) {
      timers.set(
        key,
        setTimeout(() => {
          lines = lines.filter((l) => l.key !== key)
        }, 4000),
      )
    }
  })
let said = 0
export const fidget = {
  get lines() {
    return lines
  },
  /** A running job; call again to update its text. */
  progress: (key: string, text: string, detail = '') => put(key, text, detail, false),
  /** The job's last word, which then fades out. */
  done: (key: string, text: string, detail = '') => put(key, text, detail, true),
  /** A one-off message. */
  say: (text: string) => put(`say${++said}`, text, '', true),
}
