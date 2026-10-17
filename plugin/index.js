/**
 * Host half of the suggest-question plugin.
 *
 * Predicts the user's likely next message with one auxiliary model request and
 * returns it over a same-origin HTTP route. The Client half calls the route when
 * a Turn ends, renders the sentence as a light hint, and fills it on Tab. This
 * half owns the model call and the context excerpt; it adds no tool and writes
 * no Session events.
 */

/** Loader entry name. */
export const name = '@local/dsh-suggest-question'

/** Host services: live Agent lookup, the model route, and the browser carrier. */
export const inject = ['agents', 'llm', 'webServer']

/** Same-origin route the Client half calls after a Turn ends. */
const ROUTE = '/suggest-question/predict'
/** Liveness probe the Client half calls when its entry mounts. */
const PING_ROUTE = '/suggest-question/ping'
/** Diagnostic snapshot of what the Client half actually reached. */
const STATS_ROUTE = '/suggest-question/stats'
/** How many trailing user/assistant messages the excerpt keeps. */
const MAX_MESSAGES = 14
/** Hard cap on the excerpt sent as the user message. */
const MAX_CONTEXT_CHARS = 6_000
/** Output budget: one short sentence. */
const MAX_OUTPUT_TOKENS = 80
/** End-to-end deadline for one prediction request. */
const TIMEOUT_MS = 8_000
/** Longest suggestion the Client may render. */
const MAX_QUESTION_CHARS = 120

/** Model-facing instruction: one short sentence, no framing. */
const SYSTEM = [
  'You predict the user\'s next message in an ongoing conversation with an AI coding agent.',
  'Read the transcript excerpt and reply with exactly one message the user is most likely to send next.',
  'Write it in the language the user has been using, phrased the way the user would type it.',
  'Keep it short and concrete, without quotes, labels, explanations, or a leading speaker name.',
  'If no plausible next message exists, reply with an empty string.',
].join(' ')

/**
 * Register the prediction route.
 * @param ctx - Host context with agents, llm, and the web server.
 */
export function apply(ctx) {
  const diagnostics = { pings: 0, predictions: 0, empty: 0, lastAt: 0, lastSessionId: '', lastError: '' }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: (req, res) => handlePrediction(ctx, req, res, diagnostics),
  }), 'suggest-question: prediction route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PING_ROUTE,
    handler: (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      diagnostics.pings += 1
      res.writeHead(204)
      res.end()
    },
  }), 'suggest-question: ping route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATS_ROUTE,
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(diagnostics))
    },
  }), 'suggest-question: stats route')
}

/**
 * Serve one prediction request.
 * @param ctx - Host context.
 * @param req - HTTP request; POST with a JSON `{ sessionId }` body.
 * @param res - HTTP response carrying `{ question }`.
 * @param diagnostics - counters the stats route reports.
 */
async function handlePrediction(ctx, req, res, diagnostics) {
  if (req.method !== 'POST') {
    res.writeHead(405)
    res.end()
    return
  }
  diagnostics.predictions += 1
  diagnostics.lastAt = Date.now()
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (error) {
    // A malformed or oversized body is a caller defect; answer 400 and stop.
    res.writeHead(400)
    res.end()
    return
  }
  const sessionId = body !== null && typeof body === 'object' && typeof body.sessionId === 'string'
    ? body.sessionId
    : ''
  diagnostics.lastSessionId = sessionId
  const agent = sessionId === '' ? undefined : ctx.agents.get(sessionId)
  if (agent === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  req.on('close', () => controller.abort())
  let question = ''
  try {
    question = await predict(ctx, agent.session, controller.signal)
  } catch (error) {
    diagnostics.lastError = error instanceof Error ? error.message : String(error)
    if (!controller.signal.aborted) {
      console.warn('[suggest-question] prediction failed:', error)
    }
  } finally {
    clearTimeout(timer)
  }
  if (question === '') diagnostics.empty += 1
  else diagnostics.lastError = ''
  if (res.headersSent || res.writableEnded) return
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ question }))
}

/**
 * Ask the Session's own route for one guessed next user message.
 * @param ctx - Host context.
 * @param session - live Session whose transcript supplies the excerpt.
 * @param signal - request cancellation forwarded to the model call.
 * @returns the suggestion, or '' when none could be produced.
 */
async function predict(ctx, session, signal) {
  const context = recentContext(session)
  if (context === '') return ''
  const route = session.requestContext() ?? ctx.agentDefaultModel.currentSelection()
  if (route === undefined || typeof route.provider !== 'string' || typeof route.model !== 'string') return ''
  const call = await ctx.llm.prepareCall(
    { provider: route.provider, model: route.model, maxTokens: MAX_OUTPUT_TOKENS },
    signal,
    (controls, model) => {
      const effort = model?.reasoning?.efforts?.[0]?.id
      return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
    },
  )
  const messages = [{
    role: 'user',
    content: [{
      type: 'text',
      text: `Conversation excerpt:\n\n${context}\n\nNext user message:`,
    }],
  }]
  let text = ''
  for await (const chunk of call.stream({ ...call.config, messages, system: SYSTEM, sessionId: session.id, signal })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return normalize(text)
}

/**
 * Render the trailing user/assistant text as the model's context excerpt.
 * @param session - live Session.
 * @returns bounded excerpt text; '' when the Session has no dialogue yet.
 */
function recentContext(session) {
  const messages = session.deriveMessages()
  const parts = []
  for (let index = messages.length - 1; index >= 0 && parts.length < MAX_MESSAGES; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text === '') continue
    parts.unshift(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`)
  }
  const joined = parts.join('\n\n')
  return joined.length > MAX_CONTEXT_CHARS ? joined.slice(-MAX_CONTEXT_CHARS) : joined
}

/**
 * Reduce one model response to a single clean suggestion sentence.
 * @param raw - assembled response text.
 * @returns trimmed first line without wrapping quotes, capped in length.
 */
function normalize(raw) {
  const line = raw.trim().split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
  let text = line.replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, '').trim()
  text = text.replace(/^(user|assistant|next user message)\s*[:：]\s*/iu, '').trim()
  return text.length > MAX_QUESTION_CHARS ? text.slice(0, MAX_QUESTION_CHARS) : text
}

/**
 * Read a bounded request body.
 * @param req - HTTP request.
 * @returns the request text.
 */
async function readBody(req) {
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (text.length > 4_096) throw new Error('suggest-question: request body too large')
  }
  return text
}
