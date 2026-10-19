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
 * La misma barra tiene dos caras. Con un resultado, el ✨ se convierte en un interruptor
 * «Your text | ✨ Reprompt» (con el anillo de progreso alrededor del ✨): en la cara de Reprompt
 * el prompt nuevo ocupa el sitio de tu texto, se edita ahí mismo, la barra se tiñe un poco y el
 * botón de enviar lleva un ✨ pequeño, porque envía ese prompt. Una pestaña pegada al borde de
 * arriba lleva las opciones como iconos (Step by step, English y Fix grammar se quedan marcados
 * mientras ves esa versión; Changes, Ask for a change, Again, Think deeper, Discard), y se
 * pueden reordenar arrastrándolas. Alt+← / Alt+→ (o deslizar con dos dedos) cambian de cara y
 * Esc vuelve a tu texto. Cada chat recuerda lo suyo. El botón avisa (color y un punto) si el
 * mensaje es vago o si acabas de pegar un texto largo; nunca cambia nada por sí solo.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
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

/** Una petición corta deja tu texto a la vista hasta este tiempo (si acaba antes, enseña el resultado). */
const REVEAL_MS = 3000
const RING = 2 * Math.PI * 8.5

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

/** Atajos de «Ask for a change»: las versiones de siempre, a un clic (otra vez, vuelves a la sugerida). */
const SHORTCUTS: readonly { readonly key: 'steps' | 'english' | 'grammar'; readonly label: string }[] = [
  { key: 'steps', label: 'Step by step' },
  { key: 'english', label: 'English' },
  { key: 'grammar', label: 'Fix grammar' },
]

/** «Pensar a fondo» en el cerebro de la barra (LocalThinkButton.tsx, en el selector de modelo). */
function thinkingHard(): boolean {
  return document.querySelector<HTMLElement>('[data-composer-card] button[data-mode]')?.dataset.mode === '2'
}

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

/** Lo de Reprompt en un chat. */
interface State {
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
  readonly busy: string | null
  readonly live: { readonly phase: string; readonly text: string }
  readonly answers: readonly string[]
  readonly error: string | null
  readonly showChanges: boolean
  readonly preview: boolean
  /** La línea de «Ask for a change» abierta, y lo escrito en ella. */
  readonly asking: boolean
  readonly refine: string
  /** A la vista tu texto (la otra cara), aunque haya resultado o siga trabajando. */
  readonly minimized: boolean
  /** Cuándo empezó la petición en curso. */
  readonly since: number
  /** La pidió ✨: si es corta, tu texto sigue a la vista hasta el resultado. */
  readonly quiet: boolean
}

const NO_LIVE = { phase: '', text: '' }
const EMPTY: State = {
  documents: [], intent: null, block: null, attach: 'whole', keyNote: null, versions: {}, active: 'suggested', original: '',
  slow: false, busy: null, live: NO_LIVE, answers: [], error: null, showChanges: false, preview: false, asking: false,
  refine: '', minimized: false, since: 0, quiet: false,
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
const made = (state: State): boolean => Object.values(state.versions).some((version) => version !== undefined)
/** Si la cara de Reprompt está a la vista con un prompt listo para enviar. */
const panelShown = (state: State): boolean => !state.minimized && state.busy === null && made(state) && state.error === null

/**
 * Al enviar (lo llama el envío de la app, input/hub.ts): con la cara de Reprompt a la vista se
 * envía el prompt nuevo (y los documentos debajo, si los hay) y la barra vuelve a tu texto.
 */
const SEND_KEY = Symbol.for('dpseek-local-updater.before-send')
;(globalThis as Record<symbol, unknown>)[SEND_KEY] = (sessionId: string, text: string): string => {
  const shown = sessions.get(sessionId)
  if (shown === undefined || !panelShown(shown)) return text
  const suggestion = shown.versions[shown.active]
  if (suggestion === undefined) return text
  const below = appendix(shown)
  write(sessionId, () => EMPTY)
  return below === '' ? suggestion.text.trim() : `${suggestion.text.trim()}\n\n---\n\n${below}`
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

/** Alto del prompt nuevo: el de sus líneas (el tope lo pone el CSS). */
function fitPrompt(box: HTMLTextAreaElement): void {
  box.style.height = 'auto'
  box.style.height = `${String(box.scrollHeight)}px`
}

/** Iconos de las opciones (trazo fino, como los de la app; la librería no los trae todos). */
function OptionIcon({ name }: { name: string }): ReactNode {
  const paths: Readonly<Record<string, ReactNode>> = {
    ask: <path d="M3 3.5h10v7H7.5L4.5 13v-2.5H3z" />,
    again: <><path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13 2.5v2.5h-2.5" /></>,
    discard: <path d="M4 4l8 8M12 4l-8 8" />,
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
  )
}

/**
 * El botón (o el interruptor de caras), la cara de Reprompt con su pestaña de opciones y los documentos cargados.
 * @param props - chat, borrador, cómo sustituirlo y la clase del botón «+» (mismo aspecto).
 * @returns el botón, o nada fuera de un chat o dentro de un subagente.
 */
export function LocalImprove({ sessionId, draft, subagent, className, disabled }: {
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
  const anchor = useRef<HTMLSpanElement | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)
  const picker = useRef<HTMLInputElement | null>(null)
  const liveBox = useRef<HTMLPreElement | null>(null)
  const mine = useRef<HTMLButtonElement | null>(null)
  const theirs = useRef<HTMLButtonElement | null>(null)
  const [knob, setKnob] = useState<{ left: number; width: number } | null>(null)
  const loadRef = useRef<(files: readonly File[]) => void>(() => undefined)
  const flipRef = useRef<(face: 0 | 1) => void>(() => undefined)
  const previous = useRef({ sid, draft })
  const suggestion = s.versions[s.active] ?? null
  const choosing = s.documents.length > 0 && s.intent === null && s.busy === null && s.error === null && !made(s)
  const enabled = host !== undefined && sessionId !== undefined && !subagent && !disabled
  // La cara de Reprompt: con el resultado, o trabajando (una petición corta, pasados 3 s).
  const revealed = s.busy !== null && (!s.quiet || s.slow || s.documents.length > 0 || Date.now() - s.since >= REVEAL_MS)
  const reading = s.busy !== null && s.busy.startsWith('Reading')
  const page = !s.minimized && !reading && ((s.busy !== null && revealed) || (s.busy === null && (made(s) || s.error !== null)))
  // Con un resultado (o trabajando en uno), el ✨ es el interruptor de caras.
  const twoFaces = made(s) || s.error !== null || (s.busy !== null && !reading)
  // El prompt nuevo crece con sus líneas reales (también las que salen al ajustar al ancho), como el editor de la
  // barra; el tope de altura lo pone el CSS y a partir de ahí se desplaza. Se ajusta cada vez que el cuadro aparece
  // (al terminar una opción se crea de nuevo aunque el texto no cambie) y en cada pintado, que es barato.
  const promptBox = useRef<HTMLTextAreaElement | null>(null)
  const promptObserver = useRef<ResizeObserver | null>(null)
  const promptRef = useCallback((box: HTMLTextAreaElement | null): void => {
    promptObserver.current?.disconnect()
    promptObserver.current = null
    promptBox.current = box
    if (box === null) return
    fitPrompt(box)
    // Solo los cambios de ancho cambian el ajuste de líneas (los de alto los provoca el propio ajuste).
    let width = box.clientWidth
    const observer = new ResizeObserver(() => {
      if (box.clientWidth === width) return
      width = box.clientWidth
      fitPrompt(box)
    })
    observer.observe(box.parentElement ?? box)
    promptObserver.current = observer
  }, [])
  useLayoutEffect(() => { if (promptBox.current !== null) fitPrompt(promptBox.current) })
  useEffect(() => () => { promptObserver.current?.disconnect() }, [])

  // El botón avisa de un mensaje vago cuando dejas de escribir (no mientras escribes).
  useEffect(() => {
    const timer = setTimeout(() => { setVague(isVagueDraft(draft)) }, 800)
    return () => { clearTimeout(timer) }
  }, [draft])
  // Una petición corta pasa a la cara de Reprompt a los 3 s (si no ha terminado antes).
  useEffect(() => {
    if (s.busy === null) return
    const left = s.since + REVEAL_MS - Date.now()
    if (left <= 0) return
    const timer = setTimeout(() => { setTick((value) => value + 1) }, left + 20)
    return () => { clearTimeout(timer) }
  }, [s.busy, s.since])
  // Un texto largo que aparece de golpe (pegado) en el mismo chat; no al cambiar de chat.
  useEffect(() => {
    const before = previous.current
    previous.current = { sid, draft }
    if (!isLongPrompt(draft)) setLongPaste(false)
    else if (before.sid === sid && !isLongPrompt(before.draft) && draft.length - before.draft.length > 800) setLongPaste(true)
  }, [sid, draft])
  // El texto en directo, siempre por el final.
  useEffect(() => {
    if (liveBox.current !== null) liveBox.current.scrollTop = liveBox.current.scrollHeight
  }, [s.live.text])
  // Los huecos de la barra (los pone InputBar).
  useEffect(() => {
    const bar = anchor.current?.closest('[data-composer-card]')
    setDocsHost(bar?.querySelector<HTMLElement>('[data-local-improve-docs]') ?? null)
    setPanelHost(bar?.querySelector<HTMLElement>('[data-local-improve-panel]') ?? null)
  }, [sessionId, enabled])
  // La cara de Reprompt: tu texto se esconde (sigue ahí), la barra se tiñe y enviar lleva su ✨.
  useEffect(() => {
    const bar = anchor.current?.closest<HTMLElement>('[data-composer-card]')
    if (bar == null || !page || panelHost === null) return
    bar.setAttribute('data-local-reprompt', '')
    return () => { bar.removeAttribute('data-local-reprompt') }
  }, [page, panelHost])
  // Con la pestaña, la esquina de arriba a la izquierda de la barra es recta: su lado sigue el de la pestaña.
  const withNotch = page && suggestion !== null && s.error === null
  useEffect(() => {
    const bar = anchor.current?.closest<HTMLElement>('[data-composer-card]')
    if (bar == null || !withNotch || panelHost === null) return
    bar.setAttribute('data-local-notch', '')
    return () => { bar.removeAttribute('data-local-notch') }
  }, [withNotch, panelHost])
  // El fondo del interruptor, bajo la cara activa (se desliza al cambiar).
  useLayoutEffect(() => {
    const active = page ? theirs.current : mine.current
    setKnob(active === null ? null : { left: active.offsetLeft, width: active.offsetWidth })
  }, [page, twoFaces, s.busy])
  // Alt+← / Alt+→, Esc y deslizar con dos dedos: cambiar de cara sin buscar el interruptor.
  useEffect(() => {
    const bar = anchor.current?.closest<HTMLElement>('[data-composer-card]')
    if (bar == null || !twoFaces) return
    let swipe = 0
    const keys = (event: KeyboardEvent): void => {
      if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); flipRef.current(0) }
      else if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); flipRef.current(1) }
      else if (event.key === 'Escape' && bar.hasAttribute('data-local-reprompt')) { event.preventDefault(); flipRef.current(0) }
    }
    const wheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.5) return
      swipe += event.deltaX
      if (swipe > 80) { swipe = 0; flipRef.current(1) } else if (swipe < -80) { swipe = 0; flipRef.current(0) }
    }
    bar.addEventListener('keydown', keys, true)
    bar.addEventListener('wheel', wheel, { passive: true })
    return () => {
      bar.removeEventListener('keydown', keys, true)
      bar.removeEventListener('wheel', wheel)
    }
  }, [twoFaces])
  // Con el texto desplazado, la línea de arriba queda cortada: se difumina (solo mientras hay scroll).
  useEffect(() => {
    const scroller = anchor.current?.closest('[data-composer-card]')?.querySelector<HTMLElement>('[data-input-scroll]')
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
    const bar = anchor.current?.closest<HTMLElement>('[data-composer-card]')
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
  const flip = (face: 0 | 1): void => {
    if (face === 0) set({ minimized: true, asking: false })
    else set({ minimized: false, since: 0 })
  }
  flipRef.current = flip

  /** Olvida la petición en curso de este chat y la corta también en Ollama. */
  const invalidate = (): void => {
    generations.set(sid, (generations.get(sid) ?? 0) + 1)
    const jobId = running.get(sid)
    if (jobId !== undefined) void host.cancel(jobId).catch(() => undefined)
    running.delete(sid)
  }
  /**
   * Una petición al Host, con su texto en directo cada medio segundo y su cancelación.
   * @param text - el texto de partida (tu texto al pedirlo, o el original de la cara de Reprompt).
   */
  const request = (text: string, options: LocalImproveOptions, status: string, quiet: boolean,
    done: (value: LocalImproveSuggestion) => void): void => {
    invalidate()
    const generation = generations.get(sid) ?? 0
    const current = (): boolean => generations.get(sid) === generation
    const jobId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${String(Date.now())}-${String(Math.random())}`
    running.set(sid, jobId)
    set({ busy: status, error: null, live: NO_LIVE, showChanges: false, preview: false, asking: false, minimized: false, since: Date.now(), quiet })
    const poll = setInterval(() => {
      host.progress(jobId).then((value) => {
        if (current() && value.phase !== '') set({ live: value })
      }, () => undefined)
    }, 500)
    host.improve(sid, text, { ...options, jobId }).then(
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
  /** Una versión más sobre el mismo original (pasos, inglés, gramática, pensar más, un cambio…). */
  const run = (options: LocalImproveOptions, status: string, key: VersionKey, deep = false): void => {
    request(s.original === '' ? draft : s.original, options, status, false, (value) => {
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
  /** Desde cero, con lo que hay ahora en tu texto: se olvidan las versiones anteriores. */
  const start = (text: string, options: LocalImproveOptions, status: string, long: boolean, quiet: boolean): void => {
    write(sid, (state) => ({ ...state, versions: {}, active: 'suggested', original: text, slow: long }))
    request(text, options, status, quiet, (value) => {
      write(sid, (state) => ({
        ...state,
        versions: { suggested: value },
        active: 'suggested',
        answers: value.questions.map(() => ''),
        refine: '',
        ...value.document === undefined ? {} : { block: value.document },
      }))
    })
  }
  const base = (): LocalImproveOptions => {
    const document = combined(s.documents)
    return { ...document === undefined ? {} : { document }, ...s.intent === null ? {} : { intent: s.intent } }
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
  const docName = s.documents.length === 1 ? s.documents[0]?.name ?? '' : `${String(s.documents.length)} documents`
  const choose = (value: string): void => {
    const document = combined(s.documents)
    if (document === undefined || s.busy !== null || value.trim() === '') return
    set({ intent: value.trim() })
    start(draft, { document, intent: value.trim() }, `Writing a prompt from ${docName}…`, false, false)
  }
  const pick = (): void => { picker.current?.click() }
  /** ✨ cuando no hay resultado: pedirlo (o, sin texto ni documentos, elegir ficheros). */
  const click = (): void => {
    if (s.busy !== null) { flip(1); return }
    setLongPaste(false)
    const document = combined(s.documents)
    // Sin texto ni documentos no hace nada: los ficheros se traen arrastrándolos al botón, sin abrir el explorador.
    if (document === undefined && empty) return
    // Con documentos y el cuadro vacío, la fila ya ofrece qué hacer con ellos.
    if (document !== undefined && empty) return
    // Con documentos y texto, el texto es la instrucción.
    if (document !== undefined) {
      set({ intent: null })
      start(draft, { document }, `Writing a prompt from your text and ${docName}…`, false, false)
      return
    }
    const long = isLongPrompt(draft)
    start(draft, {}, long ? `Reorganizing a long prompt, keeping all of it… (${longMinutes(draft)})` : 'Reprompting…', long, false)
  }
  /** Descarta el resultado: queda tu texto, como estaba (y los documentos, si los hay). */
  const close = (): void => {
    invalidate()
    write(sid, (state) => ({ ...EMPTY, documents: state.documents, intent: state.intent }))
  }
  const removeDocument = (index: number): void => {
    if (s.busy !== null) return
    const documents = s.documents.filter((_, at) => at !== index)
    set({ documents, intent: null, block: null, attach: 'whole', keyNote: null, versions: {}, active: 'suggested', error: null })
  }
  /** Las versiones son interruptores: pulsada, la ves; otra vez, vuelves a la sugerida. */
  const version = (key: 'steps' | 'english' | 'grammar'): void => {
    if (s.busy !== null) return
    if (s.active === key) { set({ active: 'suggested', showChanges: false }); return }
    if (s.versions[key] !== undefined) { set({ active: key, showChanges: false }); return }
    const from = s.versions.suggested?.text ?? s.original
    if (key === 'steps') {
      const steps: LocalImproveStyle = 'steps'
      run({ ...base(), style: steps }, 'Writing the step-by-step version…', key)
    } else {
      run({ transform: { kind: key, text: from } }, key === 'english' ? 'Translating into English…' : 'Fixing the grammar…', key)
    }
  }
  const unify = (): void => {
    if (s.busy !== null || suggestion === null) return
    run({ transform: { kind: 'unify', text: suggestion.text } }, 'Translating the other sentences…', s.active)
  }
  /** Otra vez desde tu texto; con el cerebro de la barra en «Pensar a fondo», razonándolo (lo que era «Think deeper»). */
  const again = (): void => {
    if (s.busy !== null) return
    const text = s.original === '' ? draft : s.original
    const document = combined(s.documents)
    const long = document === undefined && isLongPrompt(text)
    if (thinkingHard()) {
      start(text, { ...base(), think: true }, long ? 'Thinking it through, then reorganizing… (several minutes)' : 'Thinking it through…', long, false)
      return
    }
    start(text, base(), long ? `Reorganizing a long prompt, keeping all of it… (${longMinutes(text)})` : 'Reprompting…', long, false)
  }
  /** Un atajo de «Ask for a change»: cierra la línea y hace (o deshace) esa versión. */
  const shortcut = (key: 'steps' | 'english' | 'grammar'): void => {
    set({ asking: false })
    version(key)
  }
  /** Corrige el texto que ves con lo que digas («más corto», «no toques X»). */
  const refine = (): void => {
    if (s.busy !== null || suggestion === null || s.refine.trim() === '') return
    run({ ...base(), ...s.active === 'steps' ? { style: 'steps' as LocalImproveStyle } : {}, refine: { previous: suggestion.text, request: s.refine.trim() } },
      'Applying your change…', s.active)
  }
  /** Solo las partes clave: el Host elige qué bloques sobran y copia el resto tal cual (un minuto, más o menos). */
  const keyParts = (): void => {
    if (s.busy !== null || s.documents.length === 0) return
    if (s.block?.key !== undefined) { set({ attach: 'key' }); return }
    request(s.original === '' ? draft : s.original, { ...base(), keyParts: true }, 'Choosing the key parts of the documents…', false, (value) => {
      const next = value.document
      if (next?.key !== undefined) set({ block: next, attach: 'key', keyNote: value.note ?? null })
    })
  }
  const answered = suggestion === null ? [] : suggestion.questions
    .map((question, index) => ({ question, answer: (s.answers[index] ?? '').trim() }))
    .filter((item) => item.answer !== '')
  const updateWithAnswers = (): void => {
    if (answered.length > 0) run({ ...base(), ...s.active === 'steps' ? { style: 'steps' as LocalImproveStyle } : {}, answers: answered }, 'Updating with your answers…', s.active)
  }

  const diff = suggestion !== null && s.original.trim() !== '' ? localDiff(s.original, suggestion.text) : null
  // Con documentos, tu texto es la instrucción, no un borrador del prompt: comparar no dice nada.
  const counts = diff === null || s.documents.length > 0 ? null : localDiffCount(diff)
  // Resultado esperando con tu texto a la vista: el interruptor lo dice con un punto.
  const waiting = s.minimized && s.busy === null && (made(s) || s.error !== null)
  const hint = (vague || longPaste) && s.busy === null && !twoFaces
  const progress = s.busy === null ? null : progressOf(s)
  const docsLabel = s.documents.length === 1 ? 'it' : 'them'
  const label = s.busy ?? (s.documents.length > 0
    ? (empty ? `Choose what to do with the document${s.documents.length === 1 ? '' : 's'}` : `Make a prompt from your text and the document${s.documents.length === 1 ? '' : 's'}`)
    : empty ? 'Write a message, or drop files here (PDF, DOCX or text) to make a prompt'
      : longPaste ? 'Long text: click to reorganize it, keeping all of it'
        : vague ? 'This message is a bit vague: click to make it clearer' : 'Reprompt')
  const phase = s.live.phase === '' ? s.busy : PHASES[s.live.phase] ?? `${s.live.phase.charAt(0).toUpperCase()}${s.live.phase.slice(1)}…`
  const intentLabel = s.intent === null ? null
    : INTENTS.find((item) => item.key === s.intent)?.label ?? `“${s.intent.length > 40 ? `${s.intent.slice(0, 40)}…` : s.intent}”`
  const below = suggestion !== null && s.busy === null && s.error === null && s.documents.length > 0 && s.block !== null
  const allText = s.documents.reduce((sum, document) => sum + document.text.length, 0)
  const allWords = s.documents.reduce((sum, document) => sum + document.words, 0)
  // «+12 −3» junto al interruptor: cuánto cambió; al pulsarlo, los cambios marcados (lo que era «Show changes»).
  const changes = page && counts !== null && s.busy === null && s.error === null
  const ring = (
    <svg className={progress === null && s.busy !== null ? `${css.ring} ${css.spin}` : css.ring} viewBox="0 0 20 20" aria-hidden="true" data-local-improve-ring>
      <circle cx="10" cy="10" r="8.5" className={css.ringTrack} />
      <circle cx="10" cy="10" r="8.5" className={css.ringValue} strokeDasharray={String(RING)}
        strokeDashoffset={String(progress === null ? RING * 0.72 : RING * (1 - progress))} />
    </svg>
  )

  return (
    <span ref={anchor} className={css.contents}>
      {twoFaces && !target
        ? (
          <>
          <span className={css.faces} role="tablist" aria-label="Reprompt" data-local-improve data-busy={s.busy !== null || undefined}
            data-local-improve-ready={waiting || undefined}>
            {knob !== null && <span className={css.knob} style={{ left: knob.left, width: knob.width }} />}
            <Tooltip label="Your text (Alt+←, Esc)" side="top" delayMs={600}>
              <button ref={mine} type="button" role="tab" className={css.face} aria-selected={!page} data-local-improve-mine
                onMouseDown={(event) => { event.preventDefault() }} onClick={() => { flip(0) }}>Your text</button>
            </Tooltip>
            <Tooltip label={waiting ? 'Reprompt is ready (Alt+→)' : s.busy ?? 'Reprompt (Alt+→)'} side="top" delayMs={waiting ? 0 : 600}>
              <button ref={theirs} type="button" role="tab" className={css.face} aria-selected={page} data-local-improve-theirs
                data-waiting={waiting || undefined}
                onMouseDown={(event) => { event.preventDefault() }} onClick={() => { flip(1) }}>
                <span className={css.spark}>
                  <IconSparkleMedium size={12} />
                  {s.busy !== null && ring}
                </span>
                {s.busy !== null ? 'Reprompting…' : s.error !== null ? 'Failed' : 'Reprompt'}
              </button>
            </Tooltip>
          </span>
          {changes && counts !== null && (
            <Tooltip label={s.showChanges ? 'Hide changes' : 'Show changes'} side="top" delayMs={500}>
              <button type="button" className={css.counter} aria-pressed={s.showChanges} data-local-improve-changes
                aria-label={`${s.showChanges ? 'Hide' : 'Show'} changes: ${String(counts.added)} words added, ${String(counts.removed)} removed`}
                onMouseDown={(event) => { event.preventDefault() }} onClick={() => { set({ showChanges: !s.showChanges }) }}>
                <span className={css.added}>+{counts.added}</span> <span className={css.removed}>−{counts.removed}</span>
              </button>
            </Tooltip>
          )}
          </>
        )
        : (
          <Tooltip label={target ? 'Drop here to make a prompt from it' : label} side="top" delayMs={hint ? 0 : 500}>
            <button ref={button} type="button"
              className={[className, css.host, hint ? css.hint : '', target ? css.target : '', s.documents.length > 0 ? css.loaded : ''].filter(Boolean).join(' ')}
              aria-label={target ? 'Make a prompt from the dropped files' : empty && s.documents.length === 0 ? 'Reprompt: write a message or drop files here' : 'Reprompt'}
              data-local-improve data-local-improve-hint={hint || undefined} data-busy={s.busy !== null || undefined}
              data-local-improve-target={target || undefined} data-over={(target && over) || undefined}
              disabled={disabled}
              onMouseDown={(event) => { event.preventDefault() }} onClick={click}>
              <IconSparkleMedium size={14} />
              {s.busy !== null && !target && (
                <svg className={progress === null ? `${css.bigRing} ${css.spin}` : css.bigRing} viewBox="0 0 28 28" aria-hidden="true" data-local-improve-ring>
                  <circle cx="14" cy="14" r="12.5" className={css.ringTrack} />
                  <circle cx="14" cy="14" r="12.5" className={css.ringValue} strokeDasharray={String(2 * Math.PI * 12.5)}
                    strokeDashoffset={String(2 * Math.PI * 12.5 * (progress === null ? 0.72 : 1 - progress))} />
                </svg>
              )}
              {target && <span>Make prompt</span>}
              {!target && s.documents.length > 0 && <span className={css.count} aria-hidden="true">{s.documents.length}</span>}
            </button>
          </Tooltip>
        )}
      <input ref={picker} type="file" accept={DOCUMENT_ACCEPT} multiple hidden data-local-improve-file
        onChange={(event) => {
          const files = [...event.target.files ?? []]
          event.target.value = ''
          if (files.length > 0) load(files)
        }} />
      {docsHost !== null && (s.documents.length > 0 || choosing) && createPortal(
        <div className={css.docs}>
          {s.documents.map((document, index) => (
            <Tooltip key={`${document.name}-${String(index)}`} side="top" delayMs={400}
              disabled={document.cut === undefined && document.blank === undefined}
              label={[document.cut === undefined ? '' : `Read ${document.cut}`,
                document.blank === undefined ? '' : `${number(document.blank)} page${document.blank === 1 ? '' : 's'} without text`]
                .filter(Boolean).join(' · ')}>
            <span className={css.pill} data-local-improve-docs-pill>
              <IconSparkleMedium size={12} />
              <span className={css.pillName}>{document.name}</span>
              <span className={css.pillMeta}>
                {document.pages === undefined ? `${number(document.words)} words` : `${number(document.pages)} p.`}
                {document.cut === undefined && document.blank === undefined ? '' : ' ⚠'}
              </span>
              <button type="button" className={css.pillRemove} aria-label={`Remove ${document.name}`} disabled={s.busy !== null}
                onMouseDown={(event) => { event.preventDefault() }} onClick={() => { removeDocument(index) }}>✕</button>
            </span>
            </Tooltip>
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
          {withNotch && (
            <div className={css.notch} role="toolbar" aria-label="Reprompt options" data-local-improve-options
              data-busy={s.busy !== null || undefined}>
              <span className={css.optionsTrack}>
              <Tooltip label={thinkingHard() ? 'Again, thinking it through (brain: Think hard)' : 'Again, from your text'} side="top" delayMs={600}>
                <button type="button" className={css.option} data-option="again"
                  onMouseDown={(event) => { event.preventDefault() }} onClick={again}>
                  <OptionIcon name="again" />
                  Reprompt again
                </button>
              </Tooltip>
              <button type="button" className={css.option} data-option="ask" aria-pressed={s.asking}
                onMouseDown={(event) => { event.preventDefault() }} onClick={() => { set({ asking: !s.asking }) }}>
                <OptionIcon name="ask" />
                Ask for a change
              </button>
              <Tooltip label="Discard" side="top" delayMs={400}>
                <button type="button" className={`${css.option} ${css.discard}`} data-option="discard" aria-label="Discard"
                  onMouseDown={(event) => { event.preventDefault() }} onClick={close}>
                  <OptionIcon name="discard" />
                </button>
              </Tooltip>
              </span>
            </div>
          )}
          {s.busy !== null && <>
            <p className={css.status}>
              {phase}
              {' '}
              <button type="button" className={css.link} onClick={close} data-local-improve-cancel>Cancel</button>
            </p>
            {s.live.text !== '' && (
              <pre ref={liveBox} className={css.live} data-local-improve-live data-phase={s.live.phase}>
                {s.live.text.length > 6000 ? `…${s.live.text.slice(-6000)}` : s.live.text}
              </pre>
            )}
          </>}
          {s.error !== null && s.busy === null && (
            <p className={css.error}>
              {s.error}
              {' '}
              <button type="button" className={css.link} onClick={again}>Try again</button>
              {' · '}
              <button type="button" className={css.link} onClick={close}>Discard</button>
            </p>
          )}
          {suggestion !== null && s.busy === null && s.error === null && <>
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
                <textarea ref={promptRef} className={css.text} value={suggestion.text} rows={1} aria-label="New prompt"
                  onChange={(event) => {
                    const text = event.target.value
                    write(sid, (state) => ({ ...state, versions: { ...state.versions, [state.active]: { ...suggestion, text } } }))
                  }} />
              )}
            {(suggestion.note !== undefined || intentLabel !== null) && (
              <p className={css.note}>
                {intentLabel === null ? '' : `${intentLabel}. `}{suggestion.note ?? ''}
                {suggestion.note?.startsWith('Mixed languages') === true && <>
                  {' '}
                  <button type="button" className={css.link} onClick={unify} data-local-improve-unify>Translate them</button>
                </>}
              </p>
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
                    <input className={css.answer} value={s.answers[index] ?? ''} placeholder="Your answer (optional), then Enter"
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
            {s.asking && (
              <div className={css.ask} data-local-improve-ask>
                {SHORTCUTS.map((item) => (
                  <button key={item.key} type="button" className={css.shortcut} aria-pressed={s.active === item.key}
                    data-shortcut={item.key} onMouseDown={(event) => { event.preventDefault() }} onClick={() => { shortcut(item.key) }}>
                    {item.label}
                  </button>
                ))}
                <input className={css.answer} value={s.refine} data-local-improve-refine autoFocus
                  placeholder="Or write it: shorter, in Python, don't touch X… then Enter"
                  onChange={(event) => { set({ refine: event.target.value }) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); refine() }
                    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); set({ asking: false }) }
                  }} />
              </div>
            )}
          </>}
        </div>,
        panelHost,
      )}
    </span>
  )
}
