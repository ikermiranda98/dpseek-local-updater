/**
 * Reprompt: el botón ✨ de la barra del cuadro de texto (añadido por dpseek-local-updater).
 *
 * Un botón más de la barra, junto al «+» y con su mismo aspecto: pide al modelo del chat (en su
 * misma variante de contexto, así Ollama no lo recarga) una versión más clara del mensaje para
 * la IA. También convierte documentos (PDF, DOCX o texto) en un prompt: con el cuadro vacío, el
 * botón pide los ficheros. Al arrastrar ficheros, la barra marca los dos destinos: soltarlos en
 * la barra los adjunta al mensaje, como siempre; soltarlos en ✨ los carga para el prompt. Los
 * documentos cargados se ven encima del texto con su ✨; lo que escribas es la instrucción y,
 * con el cuadro vacío, una fila ofrece qué hacer con ellos.
 *
 * Todo pasa dentro de la propia barra, sin nada encima: el resultado ocupa el sitio del texto
 * («página» derecha) con sus versiones (Suggested · Step by step, y English / Grammar fixed
 * cuando existen), el texto editable, «Not quite?» para corregir con una frase, enlaces
 * (Changes, Think deeper, English, Fix grammar) y «Use». La flecha ‹ vuelve a tu texto original
 * («página» izquierda, la barra de siempre) y «Reprompt ›» vuelve al nuevo: nunca se ven los dos
 * a la vez. Con el prompt nuevo a la vista, el botón de enviar envía ese prompt.
 *
 * Mientras trabaja, un anillo alrededor de ✨ enseña el progreso (lleno cuando se sabe cuánto
 * falta; girando cuando no). Una petición corta deja tu texto a la vista hasta tener el
 * resultado; una larga pasa a la página nueva con el texto en directo, y ‹ deja verlo trabajar
 * desde tu texto. Después de «Use», la flecha junto a ✨ devuelve tu texto. Cada chat guarda lo
 * suyo. El botón avisa (color y un punto) si el mensaje es vago, si acabas de pegar un texto
 * largo o si hay un resultado esperando; nunca cambia nada por sí solo.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconSparkleMedium, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { DOCUMENT_ACCEPT, DOCUMENT_MAX_CHARS, localDocumentText, type LocalDocument } from './local-document-text.ts'
import { localDiff, localDiffCount } from './local-improve-diff.ts'
import {
  improver, isLongPrompt, subscribeImprover,
  type LocalImproveDocument, type LocalImproveDocumentBlock, type LocalImproveOptions, type LocalImproveStyle,
  type LocalImproveSuggestion,
} from './local-improve-bridge.ts'
import css from './LocalImprove.module.css'

type VersionKey = 'suggested' | 'steps' | 'english' | 'grammar'
type Suggestion = LocalImproveSuggestion & { deep?: boolean }

const VERSIONS: readonly { readonly key: VersionKey; readonly label: string }[] = [
  { key: 'suggested', label: 'Suggested' },
  { key: 'steps', label: 'Step by step' },
  { key: 'english', label: 'English' },
  { key: 'grammar', label: 'Grammar fixed' },
]
/** Versiones que se piden al pulsarlas; las demás solo salen cuando existen. */
const ON_DEMAND: readonly VersionKey[] = ['suggested', 'steps']
/** Una petición corta deja tu texto a la vista hasta este tiempo (si acaba antes, enseña el resultado). */
const REVEAL_MS = 3000
const RING = 2 * Math.PI * 12.5

/** Cuánto tarda reorganizar un prompt largo: revisarlo y reescribirlo a unos 85 caracteres por segundo (medido con Qwen3.6-35B). */
const longMinutes = (text: string): string => {
  const minutes = Math.max(2, Math.round((text.length / 85 + 90) / 60))
  return minutes <= 3 ? 'a few minutes' : `about ${String(minutes)} minutes`
}

/** Qué hacer con los documentos (el Host sabe qué pedir con cada uno). */
const INTENTS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'implement', label: 'Implement' },
  { key: 'review', label: 'Review' },
  { key: 'plan', label: 'Plan the tasks' },
  { key: 'explain', label: 'Explain' },
]

/** Desde este tamaño tiene sentido ofrecer solo las partes clave (para gastar menos contexto del chat). */
const KEY_PARTS_CHARS = 20_000

/** Cómo se llama cada fase del Host. */
const PHASES: Readonly<Record<string, string>> = {
  writing: 'Writing…',
  thinking: 'Thinking…',
  reviewing: 'Reviewing the prompt…',
  rewriting: 'Rewriting it, keeping all of it…',
  translating: 'Translating…',
  'fixing the grammar': 'Fixing the grammar…',
}

/** Una orden sin objeto: «arregla», «hazlo», «mejóralo eso». */
const BARE_COMMAND = /^(por favor,?\s*)?(arr[eé]gl(a|alo|ala)|hazlo|haz(lo)? que funcione|mej[oó]r(a|alo|ala)|c[aá]mbialo|fix|improve|change)(\s+(eso|esto|aquello|it|this|that|lo|la))?\s*(por favor)?[.!?]*$/i
/** Una referencia a algo sin decir qué: «lo de antes», «lo que te dije». */
const VAGUE_REFERENCE = /(^|\s)(eso|esto|aquello|lo de antes|lo que (te )?dije|como (te )?dije|como antes)([\s.,!?]|$)/i
/** Una queja sin detalles: solo vale como vaga si el mensaje es muy corto. */
const BARE_COMPLAINT = /(no va|no funciona|sigue (sin funcionar|igual|mal)|que funcione|doesn'?t work|not working|make it work)/i
/** Algo concreto: un fichero, código, un identificador o una cifra. */
const SPECIFIC = /[\w-]+\.[a-z0-9]{1,5}\b|`|\b[a-z]+[A-Z]\w*|\w+_\w+|\d{2,}/

/** @returns si el mensaje es corto y vago (el botón lo indica; nunca cambia nada solo). */
export function isVagueDraft(draft: string): boolean {
  const text = draft.trim()
  if (text.length < 4 || text.length > 140 || SPECIFIC.test(text)) return false
  const words = text.split(/\s+/).length
  return BARE_COMMAND.test(text) || (VAGUE_REFERENCE.test(text) && words <= 8) || (BARE_COMPLAINT.test(text) && words <= 5)
}

const count = (text: string): number => text.split(/\s+/).filter((word) => word !== '').length
const number = (value: number): string => value.toLocaleString('en-US')
const tokens = (chars: number): string => `~${number(Math.max(1, Math.round(chars / 3500)))}k tokens`

/** Lo que «volver» recupera después de «Use»: los documentos y el resultado tal como estaban. */
interface Snapshot {
  readonly documents: readonly LocalDocument[]
  readonly intent: string | null
  readonly block: LocalImproveDocumentBlock | null
  readonly attach: 'whole' | 'key'
  readonly keyNote: string | null
  readonly versions: Partial<Record<VersionKey, Suggestion>>
  readonly active: VersionKey
  readonly original: string
  // Un prompt largo se reorganiza entero en el Host y tarda minutos.
  readonly slow: boolean
}

/** Lo de Reprompt en un chat. */
interface State extends Snapshot {
  readonly busy: string | null
  readonly live: { readonly phase: string; readonly text: string }
  readonly answers: readonly string[]
  readonly error: string | null
  readonly showChanges: boolean
  readonly preview: boolean
  readonly refine: string
  readonly undo: { readonly before: string; readonly after: string; readonly snapshot: Snapshot } | null
  /** Lo que «Use» dejó para enviar debajo del mensaje (los documentos, ya con su título). */
  readonly attached: Attached | null
  /** A la vista tu texto original (‹), aunque haya resultado o siga trabajando. */
  readonly minimized: boolean
  /** Cuándo empezó la petición en curso. */
  readonly since: number
  /** La pidió ✨ (no la página del resultado): si es corta, tu texto sigue a la vista hasta el resultado. */
  readonly quiet: boolean
}

/** Documentos que se envían debajo del mensaje. */
interface Attached {
  readonly prompt: string
  readonly appendix: string
  readonly names: readonly string[]
  readonly words: number
  readonly key: boolean
}

const NO_LIVE = { phase: '', text: '' }
const EMPTY: State = {
  documents: [], intent: null, block: null, attach: 'whole', keyNote: null, versions: {}, active: 'suggested', original: '',
  slow: false, busy: null, live: NO_LIVE, answers: [], error: null, showChanges: false, preview: false, refine: '', undo: null,
  attached: null, minimized: false, since: 0, quiet: false,
}

// Cada chat guarda lo suyo aquí (cambiar de chat y volver lo encuentra igual, también si sigue trabajando).
const sessions = new Map<string, State>()
const listeners = new Set<() => void>()
// Cada petición lleva un número por chat: si se descarta, la respuesta que llegue tarde no se enseña.
const generations = new Map<string, number>()
const running = new Map<string, string>()
const read = (sid: string): State => sessions.get(sid) ?? EMPTY
const write = (sid: string, change: (state: State) => State): void => {
  sessions.set(sid, change(read(sid)))
  for (const listener of listeners) listener()
}
const made = (state: State): boolean => VERSIONS.some((version) => state.versions[version.key] !== undefined)
/** Si el resultado ocupa la barra (la «página» derecha) en vez de tu texto. */
const panelShown = (state: State): boolean => !state.minimized && state.busy === null && made(state) && state.error === null

/**
 * Al enviar (lo llama el envío de la app, input/hub.ts). Con el prompt nuevo a la vista se envía
 * ese (y los documentos debajo, si los hay); si no, los documentos que «Use» dejó adjuntos van
 * debajo de tu mensaje. Se buscan por chat y, si no, por el texto.
 */
const SEND_KEY = Symbol.for('dpseek-local-updater.before-send')
;(globalThis as Record<symbol, unknown>)[SEND_KEY] = (sessionId: string, text: string): string => {
  const shown = sessions.get(sessionId)
  if (shown !== undefined && panelShown(shown)) {
    const suggestion = shown.versions[shown.active]
    if (suggestion !== undefined) {
      const below = appendix(shown)
      write(sessionId, () => EMPTY)
      return below === '' ? suggestion.text.trim() : `${suggestion.text.trim()}\n\n---\n\n${below}`
    }
  }
  let sid = sessionId
  let attached = sessions.get(sid)?.attached ?? null
  if (attached === null) {
    const found = [...sessions.entries()].find(([, state]) => state.attached?.prompt.trim() === text.trim())
    if (found === undefined) return text
    sid = found[0]
    attached = found[1].attached
  }
  if (attached === null) return text
  write(sid, (state) => ({ ...state, attached: null, undo: null }))
  return `${text.trim()}\n\n---\n\n${attached.appendix}`
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Los documentos como uno solo para el Host (cada uno con su nombre como título). */
function combined(documents: readonly LocalDocument[]): LocalImproveDocument | undefined {
  const [first] = documents
  if (first === undefined) return undefined
  if (documents.length === 1) return { name: first.name, text: first.text, ...first.pages === undefined ? {} : { pages: first.pages } }
  const text = documents.map((document) => `# ${document.name}\n\n${document.text}`).join('\n\n')
  return { name: documents.map((document) => document.name).join(', '), text: text.slice(0, DOCUMENT_MAX_CHARS) }
}

/** Lo que va debajo del prompt: los documentos enteros (cada uno con su título) o sus partes clave. */
function appendix(state: State): string {
  const { documents, block } = state
  const [first] = documents
  if (first === undefined || block === null) return ''
  if (state.attach === 'key' && block.key !== undefined) return `## ${block.keyHeading}\n\n${block.key}`
  if (documents.length === 1) return `## ${block.heading}\n\n${first.text}`
  const prefix = block.heading.split(':')[0] ?? 'Document'
  return documents.map((document) => `## ${prefix}: ${document.name}\n\n${document.text}`).join('\n\n')
}

/**
 * Cuánto lleva una petición (0–1), o null si no se sabe (el anillo gira). La reescritura de un
 * prompt largo, por lo escrito frente al original; por partes cuando las hay; si no, por lo
 * escrito frente a lo que se espera.
 */
function progressOf(state: State): number | null {
  const { phase, text } = state.live
  const within = (value: number): number => Math.min(0.97, Math.max(0.03, value))
  if (phase.startsWith('rewriting')) return within(0.25 + 0.75 * text.length / Math.max(1, state.original.length))
  const part = /part (\d+) of (\d+)/.exec(phase)
  if (part !== null) {
    const index = Number(part[1])
    const total = Math.max(1, Number(part[2]))
    return within((index - 1 + Math.min(0.9, text.length / 4000)) / total)
  }
  if (phase === 'reviewing') return within(0.03 + 0.22 * Math.min(1, text.length / 1500))
  if (phase === 'writing' || phase === 'translating' || phase === 'fixing the grammar') {
    const expected = phase === 'writing' && !state.slow ? Math.max(400, Math.min(4000, state.original.length * 1.3)) : Math.max(400, state.original.length)
    return within(text.length / expected)
  }
  return null
}

/** Flecha de volver (la librería de iconos de la app no trae una). */
const IconBack = (): ReactNode => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true">
    <path d="M5.5 4 2.5 7l3 3" />
    <path d="M2.5 7h7a3.5 3.5 0 0 1 0 7H7" />
  </svg>
)

/** Clip de adjunto (la librería de la app solo lo trae en otro tamaño y peso). */
const IconClip = (): ReactNode => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true">
    <path d="M13.5 7.5 8 13a3.5 3.5 0 0 1-5-5l6-6a2.3 2.3 0 0 1 3.3 3.3L6.4 11.2a1.2 1.2 0 0 1-1.7-1.7L10 4.2" />
  </svg>
)

/**
 * El botón de la barra, la página del resultado, los documentos cargados y la flecha de volver.
 * @param props - chat, borrador, cómo sustituirlo y la clase del botón «+» (mismo aspecto).
 * @returns el botón, o nada fuera de un chat o dentro de un subagente.
 */
export function LocalImprove({ sessionId, draft, subagent, setDraft, className, disabled }: {
  sessionId: string | undefined
  draft: string
  subagent: boolean
  setDraft: (text: string) => void
  className: string | undefined
  disabled: boolean
}): ReactNode {
  const host = useSyncExternalStore(subscribeImprover, improver)
  const sid = sessionId ?? ''
  const s = useSyncExternalStore(subscribe, () => read(sid))
  const [vague, setVague] = useState(false)
  // Acabas de pegar un texto largo: el botón sugiere reorganizarlo.
  const [longPaste, setLongPaste] = useState(false)
  const [, setTick] = useState(0)
  // Ficheros arrastrándose por la ventana, y si están encima de ✨.
  const [dragging, setDragging] = useState(false)
  const [over, setOver] = useState(false)
  // Los dos huecos que pone InputBar en la barra: encima del texto (documentos) y en su sitio (resultado).
  const [docsHost, setDocsHost] = useState<HTMLElement | null>(null)
  const [panelHost, setPanelHost] = useState<HTMLElement | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)
  const picker = useRef<HTMLInputElement | null>(null)
  const liveBox = useRef<HTMLPreElement | null>(null)
  const loadRef = useRef<(files: readonly File[]) => void>(() => undefined)
  const previous = useRef({ sid, draft })
  const suggestion = s.versions[s.active] ?? null
  const choosing = s.documents.length > 0 && s.intent === null && s.busy === null && s.error === null && !made(s)
  const enabled = host !== undefined && sessionId !== undefined && !subagent && !disabled
  // La página del resultado: con el resultado, o trabajando (una petición corta, pasados 3 s).
  const revealed = s.busy !== null && (!s.quiet || s.slow || s.documents.length > 0 || Date.now() - s.since >= REVEAL_MS)
  const page = !s.minimized && ((s.busy !== null && revealed) || (s.busy === null && (made(s) || s.error !== null)))

  // El botón avisa de un mensaje vago cuando dejas de escribir (no mientras escribes).
  useEffect(() => {
    const timer = setTimeout(() => { setVague(isVagueDraft(draft)) }, 800)
    return () => { clearTimeout(timer) }
  }, [draft])
  // Una petición corta pasa a la página del resultado a los 3 s (si no ha terminado antes).
  useEffect(() => {
    if (s.busy === null) return
    const left = s.since + REVEAL_MS - Date.now()
    if (left <= 0) return
    const timer = setTimeout(() => { setTick((value) => value + 1) }, left + 20)
    return () => { clearTimeout(timer) }
  }, [s.busy, s.since])
  // Un texto largo que aparece de golpe (pegado) en el mismo chat; no al cambiar de chat ni al usar Reprompt.
  useEffect(() => {
    const before = previous.current
    previous.current = { sid, draft }
    if (!isLongPrompt(draft)) setLongPaste(false)
    else if (before.sid === sid && !isLongPrompt(before.draft) && draft.length - before.draft.length > 800
      && draft !== read(sid).undo?.after) setLongPaste(true)
  }, [sid, draft])
  // El texto en directo, siempre por el final.
  useEffect(() => {
    if (liveBox.current !== null) liveBox.current.scrollTop = liveBox.current.scrollHeight
  }, [s.live.text])
  // Los huecos de la barra (los pone InputBar).
  useEffect(() => {
    const bar = button.current?.closest('[data-composer-card]')
    setDocsHost(bar?.querySelector<HTMLElement>('[data-local-improve-docs]') ?? null)
    setPanelHost(bar?.querySelector<HTMLElement>('[data-local-improve-panel]') ?? null)
  }, [sessionId, enabled])
  // Con la página del resultado, tu texto se esconde (sigue ahí: ‹ lo vuelve a enseñar).
  useEffect(() => {
    const bar = button.current?.closest<HTMLElement>('[data-composer-card]')
    if (bar == null || !page || panelHost === null) return
    bar.setAttribute('data-local-reprompt', '')
    return () => { bar.removeAttribute('data-local-reprompt') }
  }, [page, panelHost])
  // Con el texto desplazado, la línea de arriba queda cortada: se difumina (solo mientras hay scroll).
  useEffect(() => {
    const scroller = button.current?.closest('[data-composer-card]')?.querySelector<HTMLElement>('[data-input-scroll]')
    if (scroller == null) return
    const update = (): void => { scroller.toggleAttribute('data-local-scrolled', scroller.scrollTop > 2) }
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => { scroller.removeEventListener('scroll', update); scroller.removeAttribute('data-local-scrolled') }
  }, [sessionId, enabled])
  // Ficheros arrastrándose por la ventana: la barra marca sus dos destinos mientras dure.
  useEffect(() => {
    if (!enabled) return
    let depth = 0
    const files = (event: DragEvent): boolean => event.dataTransfer?.types.includes('Files') === true
    const enter = (event: DragEvent): void => { if (files(event)) { depth++; setDragging(true) } }
    const leave = (event: DragEvent): void => {
      if (!files(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const reset = (): void => { depth = 0; setDragging(false); setOver(false) }
    window.document.addEventListener('dragenter', enter)
    window.document.addEventListener('dragleave', leave)
    window.document.addEventListener('drop', reset)
    window.addEventListener('dragend', reset)
    return () => {
      window.document.removeEventListener('dragenter', enter)
      window.document.removeEventListener('dragleave', leave)
      window.document.removeEventListener('drop', reset)
      window.removeEventListener('dragend', reset)
    }
  }, [enabled])
  const target = enabled && dragging && s.busy === null
  // La barra entera: soltar adjunta (lo hace la app); se marca con un borde y su rótulo.
  useEffect(() => {
    const bar = button.current?.closest<HTMLElement>('[data-composer-card]')
    if (bar == null || !target) return
    bar.setAttribute('data-local-drag', '')
    return () => { bar.removeAttribute('data-local-drag') }
  }, [target])
  // ✨: soltar aquí carga los ficheros para el prompt (no se adjuntan al mensaje).
  useEffect(() => {
    const zone = button.current
    if (!target || zone === null) return
    const overZone = (event: DragEvent): void => {
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
      setOver(true)
    }
    const leaveZone = (): void => { setOver(false) }
    const drop = (event: DragEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      const files = [...event.dataTransfer?.files ?? []]
      setDragging(false)
      setOver(false)
      // El contador de arrastre de la app no se entera del drop: dragend lo pone a cero.
      window.dispatchEvent(new Event('dragend'))
      if (files.length > 0) loadRef.current(files)
    }
    zone.addEventListener('dragenter', overZone)
    zone.addEventListener('dragover', overZone)
    zone.addEventListener('dragleave', leaveZone)
    zone.addEventListener('drop', drop)
    return () => {
      zone.removeEventListener('dragenter', overZone)
      zone.removeEventListener('dragover', overZone)
      zone.removeEventListener('dragleave', leaveZone)
      zone.removeEventListener('drop', drop)
    }
  }, [target])

  if (host === undefined || sessionId === undefined || subagent) return null
  const empty = draft.trim() === ''
  const set = (change: Partial<State>): void => { write(sid, (state) => ({ ...state, ...change })) }

  /** Olvida la petición en curso de este chat y la corta también en Ollama. */
  const invalidate = (): void => {
    generations.set(sid, (generations.get(sid) ?? 0) + 1)
    const jobId = running.get(sid)
    if (jobId !== undefined) void host.cancel(jobId).catch(() => undefined)
    running.delete(sid)
  }
  /** Una petición al Host, con su texto en directo cada medio segundo y su cancelación. */
  const request = (options: LocalImproveOptions, status: string, done: (value: LocalImproveSuggestion) => void): void => {
    invalidate()
    const generation = generations.get(sid) ?? 0
    const current = (): boolean => generations.get(sid) === generation
    const jobId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${String(Date.now())}-${String(Math.random())}`
    running.set(sid, jobId)
    set({ busy: status, error: null, live: NO_LIVE, showChanges: false, preview: false, minimized: false, since: Date.now(), quiet: false })
    const poll = setInterval(() => {
      host.progress(jobId).then((value) => {
        if (current() && value.phase !== '') set({ live: value })
      }, () => undefined)
    }, 500)
    host.improve(sid, s.original === '' ? draft : s.original, { ...options, jobId }).then(
      (value) => { if (current()) done(value) },
      (reason: unknown) => { if (current()) set({ error: reason instanceof Error ? reason.message : String(reason) }) },
    ).finally(() => {
      clearInterval(poll)
      if (current()) {
        set({ busy: null })
        running.delete(sid)
      }
    })
  }
  const run = (options: LocalImproveOptions, status: string, key: VersionKey = 'suggested', deep = false): void => {
    request(options, status, (value) => {
      write(sid, (state) => ({
        ...state,
        versions: { ...state.versions, [key]: { ...value, ...deep ? { deep: true } : {} } },
        active: key,
        answers: value.questions.map(() => ''),
        refine: '',
        // Las partes clave, si ya se eligieron, siguen valiendo para los mismos documentos.
        ...value.document === undefined ? {} : {
          block: state.block?.key === undefined ? value.document : { ...value.document, key: state.block.key },
        },
      }))
    })
  }
  /** Primera petición (o desde cero) con lo que hay ahora en la barra: se olvidan las versiones anteriores. */
  const start = (options: LocalImproveOptions, status: string, long: boolean, quiet: boolean): void => {
    write(sid, (state) => ({ ...state, versions: {}, active: 'suggested', original: draft, slow: long }))
    // request lee el original de este render: se pasa el de ahora.
    invalidate()
    const generation = generations.get(sid) ?? 0
    const current = (): boolean => generations.get(sid) === generation
    const jobId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${String(Date.now())}-${String(Math.random())}`
    running.set(sid, jobId)
    set({ busy: status, error: null, live: NO_LIVE, showChanges: false, preview: false, minimized: false, since: Date.now(), quiet })
    const poll = setInterval(() => {
      host.progress(jobId).then((value) => {
        if (current() && value.phase !== '') set({ live: value })
      }, () => undefined)
    }, 500)
    host.improve(sid, draft, { ...options, jobId }).then(
      (value) => {
        if (!current()) return
        write(sid, (state) => ({
          ...state,
          versions: { suggested: value },
          active: 'suggested',
          answers: value.questions.map(() => ''),
          refine: '',
          ...value.document === undefined ? {} : { block: value.document },
        }))
      },
      (reason: unknown) => { if (current()) set({ error: reason instanceof Error ? reason.message : String(reason) }) },
    ).finally(() => {
      clearInterval(poll)
      if (current()) {
        set({ busy: null })
        running.delete(sid)
      }
    })
  }
  const base = (state: State = s): LocalImproveOptions => {
    const document = combined(state.documents)
    return { ...document === undefined ? {} : { document }, ...state.intent === null ? {} : { intent: state.intent } }
  }
  /** Lee los ficheros y los añade a los documentos de este chat (sin pedir nada todavía). */
  const load = (files: readonly File[]): void => {
    invalidate()
    const generation = generations.get(sid) ?? 0
    const controller = new AbortController()
    set({ busy: `Reading ${files.length === 1 ? files[0]?.name ?? '' : `${String(files.length)} files`}…`, error: null, live: NO_LIVE, quiet: true, since: Date.now() })
    void (async () => {
      const loaded: LocalDocument[] = []
      const failed: string[] = []
      for (const file of files) {
        try {
          loaded.push(await localDocumentText(file, controller.signal))
        } catch (reason) {
          failed.push(reason instanceof Error ? reason.message : String(reason))
        }
      }
      if (generations.get(sid) !== generation) return
      write(sid, (state) => {
        const known = new Set(state.documents.map((document) => `${document.name}\0${String(document.text.length)}`))
        const added = loaded.filter((document) => !known.has(`${document.name}\0${String(document.text.length)}`))
        return {
          ...state, busy: null, documents: [...state.documents, ...added],
          // Otros documentos: lo hecho con los anteriores ya no vale.
          ...added.length === 0 ? {} : { intent: null, block: null, attach: 'whole' as const, keyNote: null, versions: {}, active: 'suggested' as const },
          error: failed.length === 0 ? null : failed.join(' · '),
        }
      })
    })()
  }
  loadRef.current = load
  const choose = (value: string): void => {
    const document = combined(s.documents)
    if (document === undefined || s.busy !== null || value.trim() === '') return
    set({ intent: value.trim() })
    start({ document, intent: value.trim() }, `Writing a prompt from ${s.documents.length === 1 ? s.documents[0]?.name ?? '' : `${String(s.documents.length)} documents`}…`, false, false)
  }
  const pick = (): void => { picker.current?.click() }
  const click = (): void => {
    // Trabajando, o con un resultado de este mismo texto: ✨ enseña la página del resultado.
    if (s.busy !== null) { set({ minimized: false, since: 0 }); return }
    if (s.minimized && (made(s) || s.error !== null) && draft === s.original) { set({ minimized: false }); return }
    setLongPaste(false)
    const document = combined(s.documents)
    if (document === undefined && empty) { pick(); return }
    // Con documentos y el cuadro vacío, la fila ya ofrece qué hacer con ellos.
    if (document !== undefined && empty) return
    // Con documentos y texto, el texto es la instrucción.
    if (document !== undefined) {
      set({ intent: null })
      start({ document }, `Writing a prompt from your text and ${s.documents.length === 1 ? s.documents[0]?.name ?? '' : `${String(s.documents.length)} documents`}…`, false, false)
      return
    }
    const long = isLongPrompt(draft)
    start({}, long ? `Reorganizing a long prompt, keeping all of it… (${longMinutes(draft)})` : 'Reprompting…', long, true)
  }
  /** Descarta el resultado: queda tu texto, como estaba. */
  const close = (): void => {
    invalidate()
    write(sid, (state) => ({ ...EMPTY, undo: state.undo, attached: state.attached, documents: state.documents, intent: state.intent }))
  }
  const removeDocument = (index: number): void => {
    if (s.busy !== null) return
    const documents = s.documents.filter((_, at) => at !== index)
    set({ documents, intent: null, block: null, attach: 'whole', keyNote: null, versions: {}, active: 'suggested', error: null })
  }
  const pickVersion = (key: VersionKey): void => {
    if (s.busy !== null) return
    if (s.versions[key] !== undefined) { set({ active: key, showChanges: false }); return }
    if (!ON_DEMAND.includes(key)) return
    const steps: LocalImproveStyle = 'steps'
    run({ ...base(), ...key === 'steps' ? { style: steps } : {} },
      key === 'steps' ? 'Writing the step-by-step version…' : 'Reprompting…', key)
  }
  /** Las versiones hechas, en orden: las flechas ‹ › pasan de una a otra (y ‹ desde la primera, a tu texto). */
  const ready = VERSIONS.map((version) => version.key).filter((key) => s.versions[key] !== undefined)
  const style = (): LocalImproveOptions => (s.active === 'steps' ? { style: 'steps' as LocalImproveStyle } : {})
  const previousPage = (): void => {
    const at = ready.indexOf(s.active)
    const before = at > 0 ? ready[at - 1] : undefined
    if (s.busy === null && before !== undefined) set({ active: before, showChanges: false })
    else set({ minimized: true })
  }
  const nextPage = (): void => {
    const at = ready.indexOf(s.active)
    const after = ready[at + 1]
    if (s.busy === null && after !== undefined) set({ active: after, showChanges: false })
  }
  const thinkDeeper = (): void => {
    if (s.busy !== null) return
    run({ ...base(), ...style(), think: true },
      s.slow ? 'Thinking it through, then reorganizing… (several minutes)' : 'Thinking it through…', s.active, true)
  }
  /** Traduce, corrige o unifica el idioma del texto que se ve (sale como otra versión). */
  const transformText = (kind: 'english' | 'grammar' | 'unify'): void => {
    if (s.busy !== null || suggestion === null) return
    run({ transform: { kind, text: suggestion.text } },
      kind === 'english' ? 'Translating into English…' : kind === 'grammar' ? 'Fixing the grammar…' : 'Translating the other sentences…',
      kind === 'english' ? 'english' : 'grammar')
  }
  /** Corrige el resultado con lo que digas («más corto», «no toques X»). */
  const refine = (): void => {
    if (s.busy !== null || suggestion === null || s.refine.trim() === '') return
    run({ ...base(), ...style(), refine: { previous: suggestion.text, request: s.refine.trim() } }, 'Applying your change…', s.active)
  }
  /** Solo las partes clave: el Host elige qué bloques sobran y copia el resto tal cual (un minuto, más o menos). */
  const keyParts = (): void => {
    if (s.busy !== null || s.documents.length === 0) return
    if (s.block?.key !== undefined) { set({ attach: 'key' }); return }
    request({ ...base(), keyParts: true }, 'Choosing the key parts of the documents…', (value) => {
      const next = value.document
      if (next?.key !== undefined) set({ block: next, attach: 'key', keyNote: value.note ?? null })
    })
  }
  const answered = suggestion === null ? [] : suggestion.questions
    .map((question, index) => ({ question, answer: (s.answers[index] ?? '').trim() }))
    .filter((item) => item.answer !== '')
  const updateWithAnswers = (): void => {
    if (answered.length > 0) run({ ...base(), ...style(), answers: answered }, 'Updating with your answers…', s.active)
  }
  const use = (): void => {
    if (suggestion === null) return
    const below = appendix(s)
    const after = suggestion.text.trim()
    const { documents, intent, block, attach, keyNote, versions, active, original, slow } = s
    const attached: Attached | null = below === '' ? null : {
      prompt: after, appendix: below, names: documents.map((document) => document.name),
      words: attach === 'key' && block?.key !== undefined ? count(block.key) : documents.reduce((sum, document) => sum + document.words, 0),
      key: attach === 'key' && block?.key !== undefined,
    }
    invalidate()
    setDraft(after)
    write(sid, () => ({ ...EMPTY, attached, undo: { before: draft, after, snapshot: { documents, intent, block, attach, keyNote, versions, active, original, slow } } }))
  }
  /** Volver: tu texto de antes, con sus documentos y el resultado como estaban. */
  const undo = (): void => {
    if (s.undo === null) return
    const { before, snapshot } = s.undo
    invalidate()
    setDraft(before)
    write(sid, () => ({ ...EMPTY, ...snapshot, minimized: true }))
  }

  const diff = suggestion !== null && s.original.trim() !== '' ? localDiff(s.original, suggestion.text) : null
  // Con documentos, tu texto es la instrucción, no un borrador del prompt: comparar no dice nada.
  const counts = diff === null || s.documents.length > 0 ? null : localDiffCount(diff)
  // Resultado esperando con tu texto a la vista: ✨ pone su punto de «listo».
  const waiting = s.minimized && s.busy === null && (made(s) || s.error !== null)
  const hint = ((vague || longPaste) && s.busy === null && !page && !waiting) || waiting
  const progress = s.busy === null ? null : progressOf(s)
  const docsLabel = s.documents.length === 1 ? 'it' : 'them'
  const label = waiting ? 'Reprompt is ready: click to see it' : s.busy ?? (s.documents.length > 0
    ? (empty ? `Choose what to do with the document${s.documents.length === 1 ? '' : 's'}` : `Make a prompt from your text and the document${s.documents.length === 1 ? '' : 's'}`)
    : empty ? 'Create a prompt from files (PDF, DOCX or text)'
      : longPaste ? 'Long text: click to reorganize it, keeping all of it'
        : vague ? 'This message is a bit vague: click to make it clearer' : 'Reprompt')
  const phase = s.live.phase === '' ? s.busy : PHASES[s.live.phase] ?? `${s.live.phase.charAt(0).toUpperCase()}${s.live.phase.slice(1)}…`
  const intentLabel = s.intent === null ? null
    : INTENTS.find((item) => item.key === s.intent)?.label ?? `“${s.intent.length > 40 ? `${s.intent.slice(0, 40)}…` : s.intent}”`
  const below = suggestion !== null && s.busy === null && s.error === null && s.documents.length > 0 && s.block !== null
  const allText = s.documents.reduce((sum, document) => sum + document.text.length, 0)
  const allWords = s.documents.reduce((sum, document) => sum + document.words, 0)
  const showUndo = s.undo !== null && draft.trim() === s.undo.after.trim() && s.busy === null
  const shownVersions = VERSIONS.filter((version) => s.versions[version.key] !== undefined || ON_DEMAND.includes(version.key))
  // Con tu texto a la vista y un resultado (o trabajando): el camino de vuelta a la página del resultado.
  const toPage = !page && (s.busy !== null || made(s) || s.error !== null)
  const lines = suggestion === null ? 1 : suggestion.text.split('\n').length

  return (
    <>
      <Tooltip label={target ? 'Drop here to make a prompt from it' : label} side="top" delayMs={hint ? 0 : 500}>
        <button ref={button} type="button"
          className={[className, css.host, hint ? css.hint : '', target ? css.target : '', s.documents.length > 0 ? css.loaded : ''].filter(Boolean).join(' ')}
          aria-label={target ? 'Make a prompt from the dropped files' : empty && s.documents.length === 0 ? 'Reprompt: create a prompt from files' : 'Reprompt'}
          data-local-improve data-local-improve-hint={hint || undefined} data-busy={s.busy !== null || undefined}
          data-local-improve-ready={waiting || undefined}
          data-local-improve-target={target || undefined} data-over={(target && over) || undefined}
          disabled={disabled}
          onMouseDown={(event) => { event.preventDefault() }} onClick={click}>
          <IconSparkleMedium size={14} />
          {s.busy !== null && !target && (
            <svg className={progress === null ? `${css.ring} ${css.spin}` : css.ring} viewBox="0 0 28 28" aria-hidden="true" data-local-improve-ring>
              <circle cx="14" cy="14" r="12.5" className={css.ringTrack} />
              <circle cx="14" cy="14" r="12.5" className={css.ringValue} strokeDasharray={String(RING)}
                strokeDashoffset={String(progress === null ? RING * 0.72 : RING * (1 - progress))} />
            </svg>
          )}
          {target && <span>Make prompt</span>}
          {!target && s.documents.length > 0 && <span className={css.count} aria-hidden="true">{s.documents.length}</span>}
        </button>
      </Tooltip>
      {showUndo && (
        <Tooltip label="Back to your text (undo Reprompt)" side="top" delayMs={300}>
          <button type="button" className={className} aria-label="Back to your text" data-local-improve-undo
            onMouseDown={(event) => { event.preventDefault() }} onClick={undo}>
            <IconBack />
          </button>
        </Tooltip>
      )}
      {/* Con tu texto a la vista y un resultado (o trabajando): junto a ✨, el camino a la página del resultado. */}
      {toPage && (
        <button type="button" className={css.toPage} data-local-improve-to-page data-waiting={waiting || undefined}
          onMouseDown={(event) => { event.preventDefault() }} onClick={() => { set({ minimized: false, since: 0 }) }}>
          {s.busy !== null ? 'Reprompting' : s.error !== null ? 'Reprompt failed' : 'Reprompt'} ›
        </button>
      )}
      <input ref={picker} type="file" accept={DOCUMENT_ACCEPT} multiple hidden data-local-improve-file
        onChange={(event) => {
          const files = [...event.target.files ?? []]
          event.target.value = ''
          if (files.length > 0) load(files)
        }} />
      {docsHost !== null && (s.documents.length > 0 || s.attached !== null || choosing) && createPortal(
        <div className={css.docs}>
          {s.attached !== null && (
            <span className={`${css.pill} ${css.pillAttached}`} data-local-improve-attached
              title={`Goes below your message when you send it, word for word${s.attached.key ? ' (key parts)' : ''}`}>
              <IconClip />
              <span className={css.pillName}>{s.attached.names.length === 1 ? s.attached.names[0] : `${String(s.attached.names.length)} documents`}</span>
              <span className={css.pillMeta}>{s.attached.key ? 'key parts · ' : ''}{number(s.attached.words)} words</span>
              <button type="button" className={css.pillRemove} aria-label="Don't send the documents"
                onMouseDown={(event) => { event.preventDefault() }} onClick={() => { set({ attached: null }) }}>✕</button>
            </span>
          )}
          {s.documents.map((document, index) => (
            <span key={`${document.name}-${String(index)}`} className={css.pill} data-local-improve-docs-pill
              title={[document.cut === undefined ? '' : `Read ${document.cut}`,
                document.blank === undefined ? '' : `${number(document.blank)} page${document.blank === 1 ? '' : 's'} without text`]
                .filter(Boolean).join(' · ') || undefined}>
              <IconSparkleMedium size={12} />
              <span className={css.pillName}>{document.name}</span>
              <span className={css.pillMeta}>
                {document.pages === undefined ? `${number(document.words)} words` : `${number(document.pages)} p.`}
                {document.cut === undefined && document.blank === undefined ? '' : ' ⚠'}
              </span>
              <button type="button" className={css.pillRemove} aria-label={`Remove ${document.name}`} disabled={s.busy !== null}
                onMouseDown={(event) => { event.preventDefault() }} onClick={() => { removeDocument(index) }}>✕</button>
            </span>
          ))}
          {choosing && (
            <span className={css.choices} data-local-improve-intent>
              <span className={css.title}>{empty ? `Do with ${docsLabel}:` : 'Or:'}</span>
              {!empty && (
                <button type="button" className={`${css.choice} ${css.choiceMain}`} onClick={click}>With my text</button>
              )}
              {INTENTS.map((item) => (
                <button key={item.key} type="button" className={css.choice} onMouseDown={(event) => { event.preventDefault() }}
                  onClick={() => { choose(item.key) }}>{item.label}</button>
              ))}
              <button type="button" className={css.link} onMouseDown={(event) => { event.preventDefault() }} onClick={pick}>Add file</button>
            </span>
          )}
        </div>,
        docsHost,
      )}
      {panelHost !== null && page && createPortal(
        <div className={css.panel} role="region" aria-label="Reprompt" data-local-improve-card>
          <div className={css.head}>
            <Tooltip label="Back to your text" side="top" delayMs={300}>
              <button type="button" className={css.arrow} aria-label="Back to your text" onClick={previousPage} data-local-improve-prev>‹</button>
            </Tooltip>
            <div className={css.tabs} role="tablist" data-local-improve-versions>
              {shownVersions.map((version) => (
                <button key={version.key} type="button" role="tab" className={css.tab} aria-selected={s.active === version.key}
                  disabled={s.busy !== null} data-ready={s.versions[version.key] !== undefined || undefined}
                  data-version={version.key}
                  onClick={() => { pickVersion(version.key) }}>{version.key === 'suggested' && s.slow ? 'Reorganized' : version.label}</button>
              ))}
            </div>
            <button type="button" className={css.arrow} aria-label="Next version" onClick={nextPage} data-local-improve-next
              disabled={s.busy !== null || ready.indexOf(s.active) >= ready.length - 1}>›</button>
            <span className={css.spacer} />
            {suggestion !== null && s.busy === null && (
              <span className={css.meta}>
                {intentLabel === null ? '' : `${intentLabel} · `}{suggestion.deep === true ? 'thought through · ' : ''}{(suggestion.ms / 1000).toFixed(1)} s
              </span>
            )}
            {s.busy !== null && <button type="button" className={css.link} onClick={close} data-local-improve-cancel>Cancel</button>}
            {s.busy === null && (
              <Tooltip label="Discard and go back to your text" side="top" delayMs={300}>
                <button type="button" className={css.close} aria-label="Discard" onClick={close} data-local-improve-close>✕</button>
              </Tooltip>
            )}
          </div>
          {s.busy !== null && <>
            <p className={css.status}>{phase}</p>
            {s.live.text !== '' && (
              <pre ref={liveBox} className={css.live} data-local-improve-live data-phase={s.live.phase}>
                {s.live.text.length > 6000 ? `…${s.live.text.slice(-6000)}` : s.live.text}
              </pre>
            )}
          </>}
          {s.error !== null && s.busy === null && <p className={css.error}>{s.error}</p>}
          {suggestion !== null && s.busy === null && s.error === null && <>
            {suggestion.note !== undefined && (
              <p className={css.note}>
                {suggestion.note}
                {suggestion.note.startsWith('Mixed languages') && <>
                  {' '}
                  <button type="button" className={css.link} onClick={() => { transformText('unify') }} data-local-improve-unify>Translate them</button>
                </>}
              </p>
            )}
            {s.showChanges && diff !== null
              ? (
                <div className={css.diff} data-local-improve-diff>
                  {diff.map((part, index) => part.kind === 'same'
                    ? <span key={index}>{part.text}</span>
                    : part.kind === 'add'
                      ? <ins key={index} className={css.ins}>{part.text}</ins>
                      : <del key={index} className={css.del}>{part.text}</del>)}
                </div>
              )
              : (
                <textarea className={css.text} value={suggestion.text} rows={Math.min(14, Math.max(2, lines))} aria-label="New prompt"
                  onChange={(event) => {
                    const text = event.target.value
                    write(sid, (state) => ({ ...state, versions: { ...state.versions, [state.active]: { ...suggestion, text } } }))
                  }} />
              )}
            {below && s.block !== null && (
              <div className={css.attach} data-local-improve-attach={s.attach}>
                <span>
                  {s.attach === 'key' && s.block.key !== undefined
                    ? `Below: key parts, word for word · ${number(count(s.block.key))} of ${number(allWords)} words (${tokens(s.block.key.length)})`
                    : `Below: ${s.documents.length === 1 ? 'the whole document' : `${String(s.documents.length)} whole documents`}, word for word · ${number(allWords)} words (${tokens(allText)})`}
                </span>
                {allText > KEY_PARTS_CHARS && (s.attach === 'key'
                  ? <button type="button" className={css.link} onClick={() => { set({ attach: 'whole' }) }}>Whole</button>
                  : (
                    <Tooltip label="Leaves out what the AI does not need (cover, index, background, repetitions) and copies the rest as it is, so it uses less of the chat's context. Takes about a minute." side="top" delayMs={300}>
                      <button type="button" className={css.link} onClick={keyParts} data-local-improve-key>Key parts</button>
                    </Tooltip>
                  ))}
                <button type="button" className={css.link} aria-pressed={s.preview} onClick={() => { set({ preview: !s.preview }) }}>
                  {s.preview ? 'Hide' : 'Preview'}
                </button>
              </div>
            )}
            {below && s.attach === 'key' && s.keyNote !== null && <p className={css.note}>{s.keyNote}</p>}
            {below && s.preview && (() => {
              const text = appendix(s)
              return <pre className={`${css.live} ${css.preview}`} data-local-improve-preview>{text.length > 20_000 ? `${text.slice(0, 20_000)}\n…` : text}</pre>
            })()}
            {suggestion.questions.length > 0 && (
              <div className={css.questions} data-local-improve-questions>
                {suggestion.questions.map((question, index) => (
                  <label key={index} className={css.question}>
                    <span>{question}</span>
                    <input className={css.answer} value={s.answers[index] ?? ''} placeholder="Your answer (optional)"
                      onChange={(event) => {
                        const answers = [...s.answers]
                        answers[index] = event.target.value
                        set({ answers })
                      }}
                      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); updateWithAnswers() } }} />
                  </label>
                ))}
              </div>
            )}
            <input className={css.answer} value={s.refine} data-local-improve-refine
              placeholder="Not quite? Say what to change, then press Enter"
              onChange={(event) => { set({ refine: event.target.value }) }}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); refine() } }} />
            <div className={css.actions}>
              {answered.length > 0 && (
                <button type="button" className={css.link} onClick={updateWithAnswers}>Update with answers</button>
              )}
              {counts !== null && (
                <button type="button" className={css.link} aria-pressed={s.showChanges} data-local-improve-changes
                  onClick={() => { set({ showChanges: !s.showChanges }) }}>
                  {s.showChanges ? 'Edit' : `Changes +${String(counts.added)} −${String(counts.removed)}`}
                </button>
              )}
              {suggestion.deep !== true && (s.active === 'suggested' || s.active === 'steps') && (
                <Tooltip label="Ask again with the model's reasoning: better for tricky cases, but slower (about a minute)" side="top" delayMs={400}>
                  <button type="button" className={css.link} onClick={thinkDeeper} data-local-improve-deeper>Think deeper</button>
                </Tooltip>
              )}
              {s.active !== 'english' && (
                <Tooltip label="Translate this text into English as faithfully as possible (code, names and numbers stay as they are)" side="top" delayMs={400}>
                  <button type="button" className={css.link} onClick={() => { transformText('english') }} data-local-improve-english>English</button>
                </Tooltip>
              )}
              {s.active !== 'grammar' && (
                <Tooltip label="Fix spelling and grammar in each sentence's own language; technical English words stay as they are" side="top" delayMs={400}>
                  <button type="button" className={css.link} onClick={() => { transformText('grammar') }} data-local-improve-grammar>Fix grammar</button>
                </Tooltip>
              )}
              <span className={css.spacer} />
              <Tooltip label="Put it in the box to edit it there (the send button also sends it as it is)" side="top" delayMs={500}>
                <button type="button" className={css.use} onClick={use}>Use</button>
              </Tooltip>
            </div>
          </>}
        </div>,
        panelHost,
      )}
    </>
  )
}
