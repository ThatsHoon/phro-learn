import { expect, test } from 'claude-code/testing'

// The desktop app reloads every plugin about hourly; an unload drops the pane without
// telling the plugin, and session.start runs again in the fresh copy.
function engine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'phro-learn' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return opened
}

const start = { cwd: '/', surface: 'desktop', isInteractive: true } as const

test('a board left open comes back after a plugin reload', async ($, on) => {
  const opened = engine(on)
  await $.session.start(start)
  await $.command.run({ command: 'phro-learn', args: '' })
  opened.length = 0
  await $.session.start(start)
  expect(opened).toContain('phro-learn')
})

// lean: closed-by-hand is untested; the test kit raises no ui.close | when: the kit gains $.ui.close | fix: open, close, reload, expect no open

test('a board never opened is not opened by a reload', async ($, on) => {
  const opened = engine(on)
  await $.session.start(start)
  await $.session.start(start)
  expect(opened).not.toContain('phro-learn')
})
