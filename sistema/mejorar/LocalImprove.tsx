/**
 * «Improve message» en la barra del cuadro de texto (añadido por dpseek-local-updater).
 *
 * Un botón más de la barra, junto al «+» y con su mismo aspecto: pide al modelo del
 * chat (en su misma variante de contexto, así Ollama no lo recarga) una versión más
 * clara del mensaje para la IA. También convierte documentos (PDF, DOCX o texto) en un
 * prompt: con el cuadro vacío, el botón pide los ficheros. Al arrastrar ficheros, la
 * barra marca los dos destinos: soltarlos en la barra los adjunta al mensaje, como
 * siempre; soltarlos en ✨ los carga para el prompt. Los documentos cargados se ven
 * encima del texto, como los adjuntos, con su ✨. Con ellos, lo que escribas en el
 * cuadro es la instrucción (y ✨ la usa); con el cuadro vacío, la tarjeta ofrece qué
 * hacer: implementarlos, revisarlos, planificarlos o explicarlos. El prompt va delante
 * y los documentos debajo, palabra por palabra: enteros o solo sus partes clave.
 *
 * La tarjeta, encima del cuadro, es mínima: las versiones en una línea, el texto
 * editable, un solo botón («Use») y el resto como enlaces. Enseña el texto mientras el
 * modelo lo escribe y cancelar corta la petición también en Ollama. Una frase en «Not
 * quite?» corrige la sugerencia. Después de «Use», la flecha junto a ✨ devuelve tu
 * texto (y la tarjeta). Cada chat guarda su tarjeta: cambiar de chat no la pierde. El
 * botón avisa (color y un punto) si lo que escribes es vago o si acabas de pegar un
 * texto largo que conviene reorganizar; nunca cambia nada por sí solo.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconSparkleMedium, Tooltip, useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import { DOCUMENT_ACCEPT, DOCUMENT_MAX_CHARS, localDocumentText, type LocalDocument } from './local-document-text.ts'
import { localDiff, localDiffCount } from './local-improve-diff.ts'
import {
  improver, isLongPrompt, subscribeImprover,
  type LocalImproveDocument, type LocalImproveDocumentBlock, type LocalImproveOptions, type LocalImproveStyle,
  type LocalImproveSuggestion,
} from './local-improve-bridge.ts'
import css from './LocalImprove.module.css'

type VersionKey = 'suggested' | LocalImproveStyle
type Suggestion = LocalImproveSuggestion & { deep?: boolean }

const VERSIONS: readonly { readonly key: VersionKey; readonly label: string }[] = [
  { key: 'suggested', label: 'Suggested' },
  { key: 'short', label: 'Short' },
  { key: 'detailed', label: 'Detailed' },
  { key: 'steps', label: 'Step by step' },
]

/** Qué hacer con los documentos (el Host sabe qué pedir con cada uno). */
const INTENTS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'implement', label: 'Implement' },
  { key: 'review', label: 'Review' },
  { key: 'plan', label: 'Plan the tasks' },
  { key: 'explain', label: 'Explain' },
]

/** Desde este tamaño tiene sentido ofrecer solo las partes clave (para gastar menos contexto del chat). */
const KEY_PARTS_CHARS = 20_000

/** Cómo se llama cada fase del Host en la tarjeta. */
const PHASES: Readonly<Record<string, string>> = {
  writing: 'Writing…',
  thinking: 'Thinking…',
  reviewing: 'Reviewing the prompt…',
  rewriting: 'Rewriting it, keeping all of it…',
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

/** Lo que «volver» recupera después de «Use»: los documentos y la tarjeta tal como estaban. */
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

/** La tarjeta de un chat. */
interface State extends Snapshot {
  readonly busy: string | null
  readonly live: { readonly phase: string; readonly text: string }
  readonly answers: readonly string[]
  readonly error: string | null
  readonly showChanges: boolean
  readonly preview: boolean
  readonly refine: string
  readonly undo: { readonly before: string; readonly after: string; readonly snapshot: Snapshot } | null
}

const NO_LIVE = { phase: '', text: '' }
const EMPTY: State = {
  documents: [], intent: null, block: null, attach: 'whole', keyNote: null, versions: {}, active: 'suggested', original: '',
  slow: false, busy: null, live: NO_LIVE, answers: [], error: null, showChanges: false, preview: false, refine: '', undo: null,
}

// Cada chat guarda su tarjeta aquí (cambiar de chat y volver la encuentra igual, también si sigue trabajando).
const sessions = new Map<string, State>()
const listeners = new Set<() => void>()
// Cada petición lleva un número por chat: si se descarta la tarjeta, la respuesta que llegue tarde no se enseña.
const generations = new Map<string, number>()
const running = new Map<string, string>()
const read = (sid: string): State => sessions.get(sid) ?? EMPTY
const write = (sid: string, change: (state: State) => State): void => {
  sessions.set(sid, change(read(sid)))
  for (const listener of listeners) listener()
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

/** Flecha de volver (la librería de iconos de la app no trae una). */
const IconBack = (): ReactNode => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true">
    <path d="M5.5 4 2.5 7l3 3" />
    <path d="M2.5 7h7a3.5 3.5 0 0 1 0 7H7" />
  </svg>
)

/**
 * El botón de la barra, la tarjeta, los documentos cargados y la flecha de volver.
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
  // Ficheros arrastrándose por la ventana, y si están encima de ✨.
  const [dragging, setDragging] = useState(false)
  const [over, setOver] = useState(false)
  const [docsHost, setDocsHost] = useState<HTMLElement | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)
  const picker = useRef<HTMLInputElement | null>(null)
  const card = useRef<HTMLDivElement | null>(null)
  const liveBox = useRef<HTMLPreElement | null>(null)
  const loadRef = useRef<(files: readonly File[]) => void>(() => undefined)
  const previous = useRef({ sid, draft })
  // La tarjeta va encima de todo el cuadro de texto y con su ancho.
  const composer = useRef<HTMLElement | null>(null)
  composer.current = button.current?.closest<HTMLElement>('[data-composer-dock]')?.parentElement
    ?? button.current?.parentElement?.parentElement?.parentElement ?? null
  const suggestion = s.versions[s.active] ?? null
  const choosing = s.documents.length > 0 && s.intent === null && s.busy === null && s.error === null
    && s.versions.suggested === undefined && s.versions[s.active] === undefined
  const open = s.busy !== null || suggestion !== null || s.error !== null || s.documents.length > 0
  const position = useAnchoredPosition({ open, anchorRef: composer, panelRef: card, side: 'top', align: 'start', gap: 8, margin: 12 })
  const bounds = composer.current?.getBoundingClientRect()
  const width = bounds?.width
  // Lo que cabe encima del cuadro (en un chat nuevo está a media altura): lo demás, con scroll.
  const room = bounds === undefined ? undefined : Math.max(180, bounds.top - 20)
  const enabled = host !== undefined && sessionId !== undefined && !subagent && !disabled

  // El botón avisa de un mensaje vago cuando dejas de escribir (no mientras escribes).
  useEffect(() => {
    const timer = setTimeout(() => { setVague(isVagueDraft(draft)) }, 800)
    return () => { clearTimeout(timer) }
  }, [draft])
  // Un texto largo que aparece de golpe (pegado) en el mismo chat; no al cambiar de chat ni al usar ✨.
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
  // El hueco de los documentos, encima del texto (lo pone InputBar).
  useEffect(() => {
    setDocsHost(button.current?.closest('[data-composer-card]')?.querySelector<HTMLElement>('[data-local-improve-docs]') ?? null)
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
    set({ busy: status, error: null, live: NO_LIVE, showChanges: false, preview: false })
    const poll = setInterval(() => {
      host.progress(jobId).then((value) => {
        if (current() && value.phase !== '') set({ live: value })
      }, () => undefined)
    }, 500)
    host.improve(sid, draft, { ...options, jobId }).then(
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
  /** Primera sugerencia (o desde cero): se olvidan las versiones anteriores. */
  const start = (options: LocalImproveOptions, status: string, long: boolean): void => {
    set({ versions: {}, active: 'suggested', original: draft, slow: long })
    run(options, status)
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
    set({ busy: `Reading ${files.length === 1 ? files[0]?.name ?? '' : `${String(files.length)} files`}…`, error: null, live: NO_LIVE })
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
    start({ document, intent: value.trim() }, `Writing a prompt from ${s.documents.length === 1 ? s.documents[0]?.name ?? '' : `${String(s.documents.length)} documents`}…`, false)
  }
  const pick = (): void => { picker.current?.click() }
  const click = (): void => {
    if (s.busy !== null) return
    setLongPaste(false)
    const document = combined(s.documents)
    if (document === undefined && empty) { pick(); return }
    // Con documentos y el cuadro vacío, la tarjeta ya ofrece qué hacer con ellos.
    if (document !== undefined && empty) return
    // Con documentos y texto, el texto es la instrucción.
    if (document !== undefined) {
      set({ intent: null })
      start({ document }, `Writing a prompt from your text and ${s.documents.length === 1 ? s.documents[0]?.name ?? '' : `${String(s.documents.length)} documents`}…`, false)
      return
    }
    const long = isLongPrompt(draft)
    start({}, long ? 'Reorganizing a long prompt, keeping all of it… (a few minutes)' : 'Improving message…', long)
  }
  const close = (): void => {
    invalidate()
    write(sid, (state) => ({ ...EMPTY, undo: state.undo }))
  }
  const removeDocument = (index: number): void => {
    if (s.busy !== null) return
    const documents = s.documents.filter((_, at) => at !== index)
    if (documents.length === 0 && s.versions.suggested === undefined) { close(); return }
    set({ documents, intent: null, block: null, attach: 'whole', keyNote: null, versions: {}, active: 'suggested', error: null })
  }
  const pickVersion = (key: VersionKey): void => {
    if (s.busy !== null) return
    if (s.versions[key] !== undefined) { set({ active: key, showChanges: false }); return }
    run({ ...base(), ...key === 'suggested' ? {} : { style: key } }, `Writing the ${VERSIONS.find((v) => v.key === key)?.label.toLowerCase() ?? ''} version…`, key)
  }
  const style = (): LocalImproveOptions => (s.active === 'suggested' ? {} : { style: s.active })
  const thinkDeeper = (): void => {
    if (s.busy !== null) return
    run({ ...base(), ...style(), think: true },
      s.slow ? 'Thinking it through, then reorganizing… (several minutes)' : 'Thinking it through…', s.active, true)
  }
  /** Corrige la sugerencia con lo que digas («más corto», «no toques X»). */
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
    const after = below === '' ? suggestion.text : `${suggestion.text.trim()}\n\n---\n\n${below}`
    const { documents, intent, block, attach, keyNote, versions, active, original, slow } = s
    invalidate()
    setDraft(after)
    write(sid, () => ({ ...EMPTY, undo: { before: draft, after, snapshot: { documents, intent, block, attach, keyNote, versions, active, original, slow } } }))
  }
  /** Volver: tu texto de antes, con sus documentos y la tarjeta como estaban. */
  const undo = (): void => {
    if (s.undo === null) return
    const { before, snapshot } = s.undo
    invalidate()
    setDraft(before)
    write(sid, () => ({ ...EMPTY, ...snapshot }))
  }

  const diff = suggestion !== null && s.original.trim() !== '' ? localDiff(s.original, suggestion.text) : null
  const counts = diff === null ? null : localDiffCount(diff)
  const hint = (vague || longPaste) && s.busy === null && !open
  const docsLabel = s.documents.length === 1 ? 'it' : 'them'
  const label = s.busy ?? (s.documents.length > 0
    ? (empty ? `Choose what to do with the document${s.documents.length === 1 ? '' : 's'}` : `Make a prompt from your text and the document${s.documents.length === 1 ? '' : 's'}`)
    : empty ? 'Create a prompt from files (PDF, DOCX or text)'
      : longPaste ? 'Long text: click to reorganize it, keeping all of it'
        : vague ? 'This message is a bit vague: click to make it clearer' : 'Improve message')
  const phase = s.live.phase === '' ? s.busy : PHASES[s.live.phase] ?? `${s.live.phase.charAt(0).toUpperCase()}${s.live.phase.slice(1)}…`
  const intentLabel = s.intent === null ? null
    : INTENTS.find((item) => item.key === s.intent)?.label ?? `“${s.intent.length > 40 ? `${s.intent.slice(0, 40)}…` : s.intent}”`
  const below = suggestion !== null && s.busy === null && s.error === null && s.documents.length > 0 && s.block !== null
  const allText = s.documents.reduce((sum, document) => sum + document.text.length, 0)
  const allWords = s.documents.reduce((sum, document) => sum + document.words, 0)
  const showUndo = s.undo !== null && draft.trim() === s.undo.after.trim() && s.busy === null
  const tabs = !s.slow && !choosing && (s.versions.suggested !== undefined || (s.busy !== null && s.active !== 'suggested'))

  return (
    <>
      <Tooltip label={target ? 'Drop here to make a prompt from it' : label} side="top" delayMs={hint ? 0 : 500}>
        <button ref={button} type="button"
          className={[className, hint ? css.hint : '', target ? css.target : '', s.documents.length > 0 ? css.loaded : ''].filter(Boolean).join(' ')}
          aria-label={target ? 'Make a prompt from the dropped files' : empty && s.documents.length === 0 ? 'Create a prompt from files' : 'Improve message'}
          data-local-improve data-local-improve-hint={hint || undefined} data-busy={s.busy !== null || undefined}
          data-local-improve-target={target || undefined} data-over={(target && over) || undefined}
          disabled={disabled || s.busy !== null}
          onMouseDown={(event) => { event.preventDefault() }} onClick={click}>
          <IconSparkleMedium size={14} className={s.busy !== null ? css.busy : undefined} />
          {target && <span>Make prompt</span>}
          {!target && s.documents.length > 0 && <span className={css.count} aria-hidden="true">{s.documents.length}</span>}
        </button>
      </Tooltip>
      {showUndo && (
        <Tooltip label="Back to your text (undo ✨)" side="top" delayMs={300}>
          <button type="button" className={className} aria-label="Back to your text" data-local-improve-undo
            onMouseDown={(event) => { event.preventDefault() }} onClick={undo}>
            <IconBack />
          </button>
        </Tooltip>
      )}
      <input ref={picker} type="file" accept={DOCUMENT_ACCEPT} multiple hidden data-local-improve-file
        onChange={(event) => {
          const files = [...event.target.files ?? []]
          event.target.value = ''
          if (files.length > 0) load(files)
        }} />
      {docsHost !== null && s.documents.length > 0 && createPortal(
        <div className={css.docs}>
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
        </div>,
        docsHost,
      )}
      {open && !target && createPortal(
        <div ref={card} className={css.card} role="dialog" aria-label="Improve message" data-local-improve-card
          style={{ ...position ?? { visibility: 'hidden', left: 0, top: 0 }, ...width === undefined ? {} : { width }, ...room === undefined ? {} : { maxHeight: room, overflowY: 'auto' } }}>
          <div className={css.head}>
            {tabs && (
              <div className={css.tabs} role="tablist" data-local-improve-versions>
                {VERSIONS.map((version) => (
                  <button key={version.key} type="button" role="tab" className={css.tab} aria-selected={s.active === version.key}
                    disabled={s.busy !== null} data-ready={s.versions[version.key] !== undefined || undefined}
                    onClick={() => { pickVersion(version.key) }}>{version.label}</button>
                ))}
              </div>
            )}
            {choosing && <span className={css.title}>What should the AI do with {docsLabel}?</span>}
            {!tabs && !choosing && s.slow && <span className={css.title}>Reorganized prompt</span>}
            <span className={css.spacer} />
            {suggestion !== null && s.busy === null && (
              <span className={css.meta}>
                {intentLabel === null ? '' : `${intentLabel} · `}{suggestion.deep === true ? 'thought through · ' : ''}{(suggestion.ms / 1000).toFixed(1)} s
              </span>
            )}
            {s.busy !== null
              ? <button type="button" className={css.link} onClick={close} data-local-improve-cancel>Cancel</button>
              : <button type="button" className={css.close} aria-label="Close" onClick={close} data-local-improve-close>✕</button>}
          </div>
          {s.busy !== null && <>
            <p className={css.status}>{phase}</p>
            {s.live.text !== '' && (
              <pre ref={liveBox} className={css.live} data-local-improve-live data-phase={s.live.phase}>
                {s.live.text.length > 6000 ? `…${s.live.text.slice(-6000)}` : s.live.text}
              </pre>
            )}
          </>}
          {choosing && (
            <div className={css.intent} data-local-improve-intent>
              <div className={css.choices}>
                {!empty && (
                  <button type="button" className={`${css.choice} ${css.choiceMain}`} onClick={click}>With my text</button>
                )}
                {INTENTS.map((item) => (
                  <button key={item.key} type="button" className={css.choice} onClick={() => { choose(item.key) }}>{item.label}</button>
                ))}
                <button type="button" className={css.link} onClick={pick}>Add file</button>
              </div>
              <span className={css.note}>
                {empty ? 'Or type in the box what to do with them, then press ✨' : 'Or press ✨ to use what you wrote as the instruction'}
              </span>
            </div>
          )}
          {s.error !== null && s.busy === null && <p className={css.error}>{s.error}</p>}
          {suggestion !== null && s.busy === null && s.error === null && <>
            {suggestion.note !== undefined && <p className={css.note}>{suggestion.note}</p>}
            {s.showChanges && diff !== null
              ? (
                <div className={css.diff} data-local-improve-diff
                  style={{ maxHeight: `${String(Math.min(s.slow ? 22 : 12, Math.max(3, suggestion.text.split('\n').length + 1)) * 20 + 18)}px` }}>
                  {diff.map((part, index) => part.kind === 'same'
                    ? <span key={index}>{part.text}</span>
                    : part.kind === 'add'
                      ? <ins key={index} className={css.ins}>{part.text}</ins>
                      : <del key={index} className={css.del}>{part.text}</del>)}
                </div>
              )
              : (
                <textarea className={css.text} value={suggestion.text}
                  rows={Math.min(s.slow ? 22 : 12, Math.max(3, suggestion.text.split('\n').length + 1))}
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
          </>}
          {suggestion !== null && s.busy === null && s.error === null && (
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
              {suggestion.deep !== true && (
                <Tooltip label="Ask again with the model's reasoning: better for tricky cases, but slower (about a minute)" side="top" delayMs={400}>
                  <button type="button" className={css.link} onClick={thinkDeeper} data-local-improve-deeper>Think deeper</button>
                </Tooltip>
              )}
              <span className={css.spacer} />
              <button type="button" className={css.use} onClick={use}>Use</button>
            </div>
          )}
        </div>,
        window.document.body,
      )}
    </>
  )
}
