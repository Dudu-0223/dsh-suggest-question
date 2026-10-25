/**
 * Client half of the suggest-question plugin.
 *
 * When a Turn ends, asks the Host route for a guessed next user message and
 * renders it as a light hint below the composer. Tab fills it into the draft;
 * anything the user types first discards it. This half never sends a message.
 *
 * Standalone Client artifact: the client module table supplies React, and the
 * Host half (index.js) serves the prediction route.
 */
window.__ModuleLoader__.load({
  id: '@dudu-0223/dsh-suggest-question',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    /** Document-relative form of the Host prediction route (`/suggest-question/predict`). */
    const ROUTE = 'suggest-question/predict'
    /** Document-relative liveness probe used to confirm this module reached the Host. */
    const PING = 'suggest-question/ping'

    /** Ghost line drawn over the composer's empty draft, matching the placeholder box. */
    const CSS = `
/* Starts just right of the empty draft's caret so the blinking caret stays
   visible; the native placeholder is hidden only while this line exists. */
[data-composer-card]:has(.sq-ghost) [data-composer-placeholder] { visibility: hidden; }
.sq-ghost { position: absolute; top: 12px; left: 16px; right: 12px; height: 24px; box-sizing: border-box;
  z-index: 1; display: flex; align-items: center; gap: 6px; overflow: hidden; pointer-events: none;
  color: var(--dsw-alias-label-caption);
  font-size: inherit; line-height: inherit; white-space: nowrap; }
.sq-ghost-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
`

    /**
     * Ask the Host for one guessed next message.
     * @param sessionId - current Session identity.
     * @param signal - cancellation for this page request.
     * @returns the suggestion, or '' when none arrives.
     */
    async function requestPrediction(sessionId, signal) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
        signal,
      })
      if (!response.ok) return ''
      const value = await response.json()
      return value !== null && typeof value === 'object' && typeof value.question === 'string'
        ? value.question.trim()
        : ''
    }

    /**
     * Ambient dock entry: one light suggestion line and its Tab acceptance.
     * @param props - composer dock shares plus the localized translate seat.
     * @returns the hint, or nothing while no suggestion is available.
     */
    function SuggestQuestionHint(props) {
      const sessionId = props.sessionId
      const useSession = props.useSession
      const useInput = props.useInput
      const inputActions = props.inputActions
      const running = useSession(state => state.running)
      const draft = useInput(state => state.draft)
      const phase = useInput(state => state.phase)
      const [suggestion, setSuggestion] = React.useState(null)
      const previousRunning = React.useRef(running)
      const pending = React.useRef(null)
      React.useEffect(() => {
        // Diagnostic only: marks that this module version reached the Host.
        fetch(PING, { method: 'POST' }).catch(() => {})
      }, [])
      React.useEffect(() => {
        const wasRunning = previousRunning.current
        previousRunning.current = running
        if (running) {
          // A new Turn supersedes the previous guess.
          setSuggestion(null)
          return
        }
        if (!wasRunning) return
        pending.current?.abort()
        const controller = new AbortController()
        pending.current = controller
        requestPrediction(sessionId, controller.signal)
          .then((question) => {
            if (controller.signal.aborted) return
            setSuggestion(question === '' ? null : question)
          })
          .catch((error) => {
            // An aborted request is expected on session switch or a new Turn.
            if (!controller.signal.aborted) console.warn('[suggest-question] prediction failed:', error)
          })
      }, [running, sessionId])
      React.useEffect(() => () => { pending.current?.abort() }, [])
      React.useEffect(() => {
        if (suggestion === null) return
        const onKeyDown = (event) => {
          if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (phase !== 'plain') return
          if (typeof draft === 'string' && draft.trim() !== '') return
          event.preventDefault()
          event.stopPropagation()
          inputActions.setDraft(suggestion)
          setSuggestion(null)
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [suggestion, draft, phase, inputActions])
      const typed = typeof draft === 'string' && draft.trim() !== ''
      if (suggestion === null || typed || phase !== 'plain') return null
      return h('div', { className: 'sq-ghost', 'data-suggest-question': '' },
        h('style', null, CSS),
        h('span', { className: 'sq-ghost-text', title: suggestion }, suggestion),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'suggest-question',
          order: 90,
        }, SuggestQuestionHint))
      },
    }
  },
})
