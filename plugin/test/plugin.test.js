/**
 * Tests for the suggest-question bundle: the Host prediction route, the Client
 * registration, and the light-hint / Tab behavior in a real DOM.
 *
 * The Client half is a plain browser artifact with no exports, so the suite
 * loads it the way the page does — through `window.__ModuleLoader__` — with
 * React and jsdom resolved from the DSH checkout that owns them.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { before, test } from 'node:test'

const HERE = new URL('.', import.meta.url)
const PACKAGE_DIR = fileURLToPath(new URL('../', HERE))
// Resolve a DSH source checkout for React/jsdom; a published package can point it
// elsewhere with DSH_REPO and then skips the DOM cases.
const REPO = process.env.DSH_REPO ?? fileURLToPath(new URL('../../../', HERE))
const ROUTE = '/suggest-question/predict'
/** Browser form of the route: the shell documents routes document-relative. */
const CLIENT_ROUTE = ROUTE.slice(1)
const SESSION = 'session-test'

/** React and a DOM from the checkout that serves the page under test. */
function loadBrowserRuntime() {
  try {
    const require = createRequire(`${REPO}/apps/web/package.json`)
    return {
      React: require('react'),
      createRoot: require('react-dom/client').createRoot,
      act: require('react').act,
      JSDOM: require('jsdom').JSDOM,
    }
  } catch {
    return null
  }
}

const runtime = loadBrowserRuntime()
const domTest = runtime === null ? test.skip : test

/** Minimal HTTP request the route handler can iterate. */
function fakeRequest(method, body) {
  return {
    method,
    on() {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
}

/** Minimal HTTP response capturing the handler's write. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: undefined,
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
      this.headersSent = true
    },
    end(text) {
      if (text !== undefined) this.body += String(text)
      this.writableEnded = true
    },
  }
}

/** Host context double: one route capture, one session, one scripted model. */
function hostContext({ question = '继续加一个开关吧' } = {}) {
  const routes = []
  const session = {
    id: SESSION,
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: '帮我把插件改成回合结束后预测' }] },
      { role: 'assistant', content: [{ type: 'text', text: '已经改好了，接下来可以验证。' }] },
    ],
    requestContext: () => ({ provider: 'test-provider', model: 'test-model' }),
  }
  return {
    routes,
    ctx: {
      effect: callback => callback(),
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
      agents: { get: id => (id === SESSION ? { session } : undefined) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      llm: {
        async prepareCall() {
          return {
            config: { provider: 'test-provider', model: 'test-model' },
            stream: async function* stream() {
              yield { type: 'text-delta', text: `  “${question}”  ` }
            },
          }
        },
      },
    },
  }
}

let Component = null
let dom = null

before(async () => {
  if (runtime === null) return
  dom = new runtime.JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' }).window
  globalThis.window = dom
  globalThis.document = dom.document
  globalThis.HTMLElement = dom.HTMLElement
  globalThis.Element = dom.Element
  globalThis.Node = dom.Node
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let captured = null
  dom.__ModuleLoader__ = {
    load(registration) {
      captured = registration
    },
  }
  await import(`${new URL('../client.js', HERE).href}?case=${String(Date.now())}`)
  assert.ok(captured !== null, 'the artifact registers itself with the module loader')
  const plugin = captured.factory(name => (name === 'react' ? runtime.React : {}))
  const injects = []
  const registrations = []
  plugin.apply({
    effect: callback => callback(),
    locale: { register: () => () => {} },
    slots: {
      inject(name, callback) {
        injects.push({ name, callback })
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  })
  for (const entry of injects) entry.callback()
  const overlay = registrations.find(entry => entry.options.name === 'conversation.input.overlay')
  assert.ok(overlay !== undefined, 'the plugin registers an in-composer overlay entry')
  assert.equal(overlay.options.id, 'suggest-question')
  Component = overlay.component
})

/** Mount one composer entry inside a composer card, the way the page nests it. */
function mount(props) {
  const card = dom.document.createElement('div')
  card.setAttribute('data-composer-card', '')
  dom.document.body.append(card)
  const container = dom.document.createElement('div')
  card.append(container)
  const root = runtime.createRoot(container)
  runtime.act(() => {
    root.render(runtime.React.createElement(Component, props))
  })
  return {
    container,
    rerender(next) {
      runtime.act(() => {
        root.render(runtime.React.createElement(Component, next))
      })
    },
    text: () => container.textContent,
    unmount() {
      runtime.act(() => {
        root.unmount()
      })
      card.remove()
    },
  }
}

/** Composer shares; `running` and the input snapshot are per-render values. */
function composerProps({ running, draft = '', phase = 'plain' }) {
  const filled = []
  return {
    filled,
    props: {
      sessionId: SESSION,
      useSession: selector => selector({ running }),
      useInput: selector => selector({ draft, phase, queue: [] }),
      inputActions: { setDraft: text => filled.push(text) },
    },
  }
}

/** Let pending promises and their React updates settle. */
async function flush() {
  await runtime.act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

/** Install a fetch double returning one question. */
function stubFetch(question) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, json: async () => ({ question }) }
  }
  return calls
}

test('the Host half registers the prediction route', async () => {
  const host = await import(`${new URL('../index.js', HERE).href}`)
  assert.equal(host.name, '@local/dsh-suggest-question')
  assert.deepEqual(host.inject, ['agents', 'llm', 'webServer'])
  const { ctx, routes } = hostContext()
  host.apply(ctx)
  const prediction = routes.find(route => route.path === ROUTE)
  assert.ok(prediction !== undefined, 'the prediction route is registered')
  assert.equal(prediction.kind, 'exact')
  assert.ok(routes.some(route => route.path === '/suggest-question/ping'), 'the ping route is registered')
  assert.ok(routes.some(route => route.path === '/suggest-question/stats'), 'the stats route is registered')
})

test('the route answers with one normalized suggestion', async () => {
  const host = await import(`${new URL('../index.js', HERE).href}`)
  const { ctx, routes } = hostContext()
  host.apply(ctx)
  const res = fakeResponse()
  await routes.find(route => route.path === ROUTE).handler(fakeRequest('POST', JSON.stringify({ sessionId: SESSION })), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { question: '继续加一个开关吧' })
})

test('the route rejects unknown sessions and non-POST requests', async () => {
  const host = await import(`${new URL('../index.js', HERE).href}`)
  const { ctx, routes } = hostContext()
  host.apply(ctx)
  const route = routes.find(entry => entry.path === ROUTE)
  const missing = fakeResponse()
  await route.handler(fakeRequest('POST', JSON.stringify({ sessionId: 'session-other' })), missing)
  assert.equal(missing.statusCode, 404)
  const wrongMethod = fakeResponse()
  await route.handler(fakeRequest('GET'), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)
})

domTest('the client asks for a prediction when a Turn ends', async () => {
  const calls = stubFetch('试试 Tab 填入')
  const first = composerProps({ running: true })
  const view = mount(first.props)
  assert.equal(view.text(), '')
  const second = composerProps({ running: false })
  view.rerender(second.props)
  await flush()
  const prediction = calls.find(call => call.url === CLIENT_ROUTE)
  assert.ok(prediction !== undefined, 'the client posts to the prediction route')
  assert.equal(prediction.init.method, 'POST')
  assert.deepEqual(JSON.parse(prediction.init.body), { sessionId: SESSION })
  assert.match(view.text(), /试试 Tab 填入/)
  assert.equal(view.container.querySelector('.sq-ghost-key'), null, 'no Tab hint is rendered')
  view.unmount()
})

domTest('Tab fills the draft and clears the hint', async () => {
  stubFetch('把插件提成正式包')
  const running = composerProps({ running: true })
  const view = mount(running.props)
  const idle = composerProps({ running: false })
  view.rerender(idle.props)
  await flush()
  assert.match(view.text(), /把插件提成正式包/)
  const event = new dom.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  runtime.act(() => { dom.dispatchEvent(event) })
  assert.deepEqual(idle.filled, ['把插件提成正式包'])
  assert.equal(view.text(), '')
  view.unmount()
})

domTest('a typed draft suppresses the hint and refuses Tab', async () => {
  stubFetch('不会被填入')
  const running = composerProps({ running: true })
  const view = mount(running.props)
  const idle = composerProps({ running: false, draft: '我已经在写了' })
  view.rerender(idle.props)
  await flush()
  assert.equal(view.text(), '')
  const event = new dom.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  runtime.act(() => { dom.dispatchEvent(event) })
  assert.deepEqual(idle.filled, [])
  view.unmount()
})

domTest('an empty prediction renders nothing', async () => {
  stubFetch('')
  const running = composerProps({ running: true })
  const view = mount(running.props)
  const idle = composerProps({ running: false })
  view.rerender(idle.props)
  await flush()
  assert.equal(view.text(), '')
  view.unmount()
})

domTest('a pointer press inside the composer keeps the hint for Tab', async () => {
  stubFetch('点进来也别消失')
  const running = composerProps({ running: true })
  const view = mount(running.props)
  const idle = composerProps({ running: false })
  view.rerender(idle.props)
  await flush()
  assert.match(view.text(), /点进来也别消失/)
  runtime.act(() => { view.container.dispatchEvent(new dom.Event('pointerdown', { bubbles: true })) })
  runtime.act(() => { view.container.dispatchEvent(new dom.Event('focusin', { bubbles: true })) })
  assert.match(view.text(), /点进来也别消失/)
  view.unmount()
})

domTest('typing hides the hint and deleting the draft restores it', async () => {
  stubFetch('删掉还会回来')
  const running = composerProps({ running: true })
  const view = mount(running.props)
  const idle = composerProps({ running: false })
  view.rerender(idle.props)
  await flush()
  assert.match(view.text(), /删掉还会回来/)
  const typed = composerProps({ running: false, draft: 'x' })
  view.rerender(typed.props)
  assert.equal(view.text(), '')
  const cleared = composerProps({ running: false })
  view.rerender(cleared.props)
  assert.match(view.text(), /删掉还会回来/)
  view.unmount()
})

test('reads the plugin declaration', () => {
  const pkg = JSON.parse(readFileSync(`${PACKAGE_DIR}/package.json`, 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.ok(pkg.files.includes('client.js'))
})
