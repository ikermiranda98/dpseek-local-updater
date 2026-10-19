/**
 * Editar tus mensajes y regenerar respuestas, con versiones «‹ 1/2 ›»
 * (añadido por dpseek-local-updater; la interacción copia la de Hermes Agent Desktop).
 *
 *   - Clic en tu mensaje: se edita en el sitio. Enter envía, Mayús+Enter salta de
 *     línea, Esc cancela; un clic fuera cancela solo si no has cambiado nada; si
 *     hay texto seleccionado, o el clic es en un enlace o una imagen, no se edita.
 *   - Icono «Regenerate» debajo de cada respuesta de la IA, también en las antiguas.
 *
 * El registro de un chat no se puede recortar: editar o regenerar el turno T copia
 * el chat hasta justo antes de T (localForkBefore en el Host, con el historial completo), envía allí el mensaje (el mismo o
 * el editado) con el modelo elegido, abre la copia y archiva el original. Las copias
 * de un mismo turno forman un grupo de versiones; debajo de tu mensaje, «‹ 2/3 ›»
 * cambia de versión (desarchiva la elegida y archiva la que dejas). Cuando escribes
 * un mensaje nuevo en una versión, las demás se borran del todo (deletePermanently).
 * Los grupos se guardan en el almacenamiento local de la ventana.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular,
  IconRefreshOutlineRegular, IconSendOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import type { UseChat } from '../contract/slots.ts'
import css from './local-regenerate.module.css'

/** Textos de esta función (claves local.* añadidas al idioma del chat). */
type LocalKey =
  | 'local.regen.button' | 'local.edit.hint' | 'local.edit.send' | 'local.edit.files'
  | 'local.versions.previous' | 'local.versions.next' | 'local.versions.count'
  | 'local.versions.warn' | 'local.versions.warnLater'
type T = (key: LocalKey, params?: Record<string, unknown>) => string
type PromptParts = Parameters<SessionBinding['session']['prompt']>[0]

interface TurnRef {
  readonly turn: number
  readonly start: { readonly seq: number } | undefined
}

/** Lo que interesa de un mensaje tuyo del chat. */
interface UserNodeLike {
  readonly kind: string
  readonly location: { readonly kind: string; readonly turn?: TurnRef }
  readonly data: { readonly content: readonly unknown[] }
}

let ctx: Context | undefined

/** Lo llama apply() del chat con su contexto (sesiones, espacios de trabajo, Host). */
export function setLocalChat(next: Context | undefined): void {
  ctx = next
}

// ── Grupos de versiones ───────────────────────────────────────────────────────

interface VersionGroup {
  readonly id: string
  /** Turno regenerado: en todas las versiones lleva el mismo número. */
  readonly turn: number
  readonly members: readonly SessionId[]
  /** Último turno de cada versión al entrar en el grupo (undefined: aún sin ver). */
  readonly marks: Readonly<Record<string, number | undefined>>
  /** Seq del corte de cada copia: su turno regenerado empieza después. */
  readonly cuts: Readonly<Record<string, number>>
  /** Turnos que tenía cada versión al entrar (para avisar de lo que se borrará). */
  readonly lastTurns: Readonly<Record<string, number>>
}

const STORE_KEY = 'dpseek-local-updater.versions.v1'
const listeners = new Set<() => void>()
let groups: readonly VersionGroup[] = load()

function load(): readonly VersionGroup[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as VersionGroup[] : []
  } catch {
    return []
  }
}

function save(next: readonly VersionGroup[]): void {
  groups = next
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next))
  } catch {
    // Sin almacenamiento local las versiones duran lo que la ventana.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function useGroups(): readonly VersionGroup[] {
  return useSyncExternalStore(subscribe, () => groups)
}

function groupFor(list: readonly VersionGroup[], sessionId: SessionId, turn: number): VersionGroup | undefined {
  return list.find(group => group.turn === turn && group.members.includes(sessionId))
}

// ── Contexto por chat ─────────────────────────────────────────────────────────

interface LocalChat {
  readonly sessionId: SessionId
  readonly useChat: UseChat
}

const LocalChatContext = createContext<LocalChat | undefined>(undefined)

/**
 * Envuelve el chat (ChatView): da el chat a los mensajes y vigila sus versiones.
 * @param props - el chat que se muestra, su lector y su contenido.
 * @returns el contenido con el contexto.
 */
export function LocalChatProvider({ sessionId, useChat, children }: LocalChat & { children: ReactNode }) {
  const value = useMemo(() => ({ sessionId, useChat }), [sessionId, useChat])
  return (
    <LocalChatContext.Provider value={value}>
      <VersionWatcher sessionId={sessionId} useChat={useChat} />
      {children}
    </LocalChatContext.Provider>
  )
}

/**
 * Al escribir un mensaje nuevo en una versión, esa queda como la buena y las
 * demás de su grupo se borran del todo.
 */
function VersionWatcher({ sessionId, useChat }: LocalChat) {
  const list = useGroups()
  const lastTurn = useChat(s => s.timeline.turnOrder.at(-1))
  const lastStart = useChat((s) => {
    const last = s.timeline.turnOrder.at(-1)
    return last === undefined ? undefined : s.timeline.turns.get(last)?.start?.seq
  })
  useEffect(() => {
    if (lastTurn === undefined) return
    let changed = false
    const finished: VersionGroup[] = []
    const next = list.flatMap((group) => {
      if (!group.members.includes(sessionId)) return [group]
      const mark = group.marks[sessionId]
      if (mark === undefined) {
        // El original se marca en cuanto se ve (corte -1); una copia, cuando ya se
        // ve su turno regenerado (empieza después de su corte).
        const cut = group.cuts[sessionId] ?? -1
        if (lastStart === undefined || lastStart <= cut) return [group]
        changed = true
        return [{
          ...group,
          marks: { ...group.marks, [sessionId]: lastTurn },
          lastTurns: { ...group.lastTurns, [sessionId]: lastTurn },
        }]
      }
      if (lastTurn > mark) {
        changed = true
        finished.push(group)
        return []
      }
      return [group]
    })
    if (!changed) return
    save(next)
    for (const group of finished) {
      for (const member of group.members) {
        if (member !== sessionId) void deleteSession(member)
      }
    }
  }, [list, lastTurn, lastStart, sessionId])
  return null
}

async function deleteSession(sessionId: SessionId): Promise<void> {
  try {
    await ctx?.remote.session.deletePermanently({ sessionId })
  } catch {
    // Si no se puede borrar, se queda archivado.
  }
}

// ── Regenerar ─────────────────────────────────────────────────────────────────

function textOf(content: readonly unknown[]): string {
  return content
    .map(block => (block as { type?: string; text?: unknown }))
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('')
}

function hasFiles(content: readonly unknown[]): boolean {
  return content.some(block => (block as { type?: string }).type === 'file')
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** Texto (el original o el editado) y las imágenes del mensaje, para reenviarlo. */
async function promptParts(sessionId: SessionId, content: readonly unknown[], text: string): Promise<PromptParts> {
  const parts: PromptParts = []
  if (text.trim() !== '') parts.push({ type: 'text', text })
  const session = ctx?.sessions.binding(sessionId)?.session
  for (const block of content) {
    const image = block as { type?: string; attachment?: { attachmentId?: unknown } }
    if (image.type !== 'image' || image.attachment?.attachmentId === undefined || session === undefined) continue
    const read = await session.readAttachment(image.attachment.attachmentId as Parameters<typeof session.readAttachment>[0])
    if (!read.ok) continue
    parts.push({ type: 'image', mediaType: read.value.attachment.mediaType, data: base64(read.value.data) })
  }
  return parts
}

let busy = false

/**
 * Copia el chat hasta antes del turno, envía el mensaje, abre la copia y archiva
 * el original; anota la copia como versión de ese turno.
 * @param sessionId - chat de origen.
 * @param turn - turno que se regenera.
 * @param content - contenido original de tu mensaje en ese turno.
 * @param text - texto que se envía (el original o el editado).
 * @param originalLast - último turno del chat de origen (para avisar de lo que se perdería).
 */
async function regenerate(
  sessionId: SessionId, turn: TurnRef, content: readonly unknown[], text: string, originalLast: number | undefined,
): Promise<void> {
  const app = ctx
  if (app === undefined || busy || turn.start === undefined) return
  busy = true
  try {
    const parts = await promptParts(sessionId, content, text)
    if (parts.length === 0) return
    // El Host corta con el historial completo y deja la copia en la misma carpeta y
    // con el modelo elegido. Si no se puede copiar, se avisa: nunca un chat vacío.
    const forked = await app.remote.session.localForkBefore({ sessionId, beforeSeq: turn.start.seq })
    if (!forked.ok) throw new Error(forked.error.message)
    const child = forked.value.sessionId
    const cut = forked.value.atSeq
    await app.sessions.refresh().catch(() => undefined)
    await app.sessions.using(child, { source: 'controllerOperation' }, async (reference) => {
      const binding = await reference.ready
      const sent = await binding.session.prompt(parts, 'queue')
      if (!sent.ok) throw new Error(sent.error.message)
    })
    const current = groupFor(groups, sessionId, turn.turn)
    if (current === undefined) {
      save([...groups, {
        id: `${sessionId}:${String(turn.turn)}:${String(Date.now())}`,
        turn: turn.turn,
        members: [sessionId, child],
        marks: { [sessionId]: originalLast, [child]: undefined },
        cuts: { [sessionId]: -1, [child]: cut },
        lastTurns: originalLast === undefined ? {} : { [sessionId]: originalLast },
      }])
    } else {
      save(groups.map(group => group.id !== current.id ? group : {
        ...group,
        members: [...group.members, child],
        marks: { ...group.marks, [child]: undefined },
        cuts: { ...group.cuts, [child]: cut },
      }))
    }
    app.uiWorkspace.openSession(child)
    await app.uiWorkspace.archiveSession(sessionId, { stopActivity: true }).catch(() => undefined)
  } finally {
    busy = false
  }
}

/** Primer mensaje tuyo de un turno, con su contenido. */
function userNodeOf(snapshot: ChatSnapshot, turn: number): UserNodeLike | undefined {
  for (const key of snapshot.locations.getTurn(turn)) {
    const node = snapshot.nodes.get(key) as unknown as UserNodeLike | undefined
    if (node?.kind === 'user') return node
  }
  return undefined
}

/**
 * Icono «Regenerate» del pie de cada respuesta.
 * @param props - turno de la respuesta, lector del chat y textos.
 * @returns el botón, o null si no se puede regenerar ese turno.
 */
export function LocalRegenerateButton({ turn, useChat, t }: { turn: TurnRef; useChat: UseChat; t: T }) {
  const local = useContext(LocalChatContext)
  const user = useChat(s => userNodeOf(s, turn.turn))
  const lastTurn = useChat(s => s.timeline.turnOrder.at(-1))
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (local === undefined || user === undefined || turn.start === undefined || ctx === undefined) return null
  const label = error ?? t('local.regen.button')
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        className={css.action}
        aria-label={label}
        aria-busy={working || undefined}
        data-error={error === null ? undefined : ''}
        disabled={working}
        onClick={() => {
          setWorking(true)
          setError(null)
          regenerate(local.sessionId, turn, user.data.content, textOf(user.data.content), lastTurn)
            .catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
            .finally(() => { setWorking(false) })
        }}
      >
        <IconRefreshOutlineRegular />
      </button>
    </Tooltip>
  )
}

// ── Editar tu mensaje ─────────────────────────────────────────────────────────

function hasTextSelection(): boolean {
  const selection = window.getSelection()
  return selection !== null && !selection.isCollapsed && selection.toString().length > 0
}

/**
 * Tu mensaje del chat: clic para editarlo en el sitio y, si hay versiones de ese
 * turno, «‹ 1/2 ›» debajo.
 * @param props - el nodo del mensaje, su burbuja y los textos.
 * @returns la burbuja (o el editor) y la barra de versiones.
 */
export function LocalUserMessage({ node, t, children }: { node: UserNodeLike; t: T; children: ReactNode }) {
  const local = useContext(LocalChatContext)
  const turn = node.location.kind === 'turn' || node.location.kind === 'step' ? node.location.turn : undefined
  const editable = local !== undefined && node.kind === 'user' && turn?.start !== undefined && ctx !== undefined
  const [editing, setEditing] = useState(false)
  if (!editable || turn === undefined) return <>{children}</>
  return (
    <div className={css.userMessage}>
      {editing
        ? <EditBox node={node} turn={turn} sessionId={local.sessionId} useChat={local.useChat} t={t} onClose={() => { setEditing(false) }} />
        : (
          <div
            className={css.editable}
            onClick={(event) => {
              const target = event.target as HTMLElement
              if (hasTextSelection() || target.closest('a, button, img, video, [role="button"]') !== null) return
              setEditing(true)
            }}
          >
            {children}
          </div>
        )}
      <VersionBar sessionId={local.sessionId} turn={turn.turn} t={t} />
    </div>
  )
}

function EditBox({ node, turn, sessionId, useChat, t, onClose }: {
  node: UserNodeLike
  turn: TurnRef
  sessionId: SessionId
  useChat: UseChat
  t: T
  onClose: () => void
}) {
  const initial = useMemo(() => textOf(node.data.content), [node])
  const lastTurn = useChat(s => s.timeline.turnOrder.at(-1))
  const [text, setText] = useState(initial)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement | null>(null)
  const textRef = useRef(text)
  textRef.current = text
  useEffect(() => {
    const element = area.current
    if (element === null) return
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
  }, [])
  useEffect(() => {
    const element = area.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${String(element.scrollHeight)}px`
  }, [text])
  const send = useCallback(() => {
    if (sending || textRef.current.trim() === '') return
    setSending(true)
    setError(null)
    regenerate(sessionId, turn, node.data.content, textRef.current, lastTurn).then(
      () => { onClose() },
      (reason: unknown) => {
        setSending(false)
        setError(reason instanceof Error ? reason.message : String(reason))
      },
    )
  }, [lastTurn, node, onClose, sending, sessionId, turn])
  return (
    <div
      className={css.editBox}
      onBlur={(event) => {
        // Clic fuera: solo se cierra si no has cambiado nada (como Hermes).
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        if (!sending && textRef.current === initial) onClose()
      }}
    >
      <textarea
        ref={area}
        className={css.editArea}
        value={text}
        rows={1}
        aria-label={t('local.edit.hint')}
        disabled={sending}
        onChange={(event) => { setText(event.target.value) }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          } else if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            send()
          }
        }}
      />
      <div className={css.editFooter}>
        {error !== null && <span className={css.editError}>{error}</span>}
        {error === null && hasFiles(node.data.content) && <span className={css.editNote}>{t('local.edit.files')}</span>}
        <Tooltip label={t('local.edit.send')} side="top" delayMs={500}>
        <button
          type="button"
          className={css.send}
          aria-label={t('local.edit.send')}
          disabled={sending || text.trim() === ''}
          // Que el clic no quite el foco al editor antes de enviar.
          onPointerDown={(event) => { event.preventDefault() }}
          onClick={send}
        >
          <IconSendOutlineRegular size={14} />
        </button>
        </Tooltip>
      </div>
    </div>
  )
}

// ── Barra de versiones «‹ 1/2 ›» ──────────────────────────────────────────────

function VersionBar({ sessionId, turn, t }: { sessionId: SessionId; turn: number; t: T }) {
  const list = useGroups()
  const group = groupFor(list, sessionId, turn)
  const [moving, setMoving] = useState(false)
  if (group === undefined || group.members.length < 2) return null
  const index = group.members.indexOf(sessionId)
  const go = (target: SessionId | undefined): void => {
    const app = ctx
    if (app === undefined || target === undefined || moving) return
    setMoving(true)
    app.uiWorkspace.unarchiveSession(target)
      .catch(() => undefined)
      .then(async () => {
        app.uiWorkspace.openSession(target)
        await app.uiWorkspace.archiveSession(sessionId, { stopActivity: true }).catch(() => undefined)
      })
      .finally(() => { setMoving(false) })
  }
  // Mensajes posteriores que se perderán al seguir escribiendo en esta versión.
  const later = group.members
    .filter(member => member !== sessionId)
    .map(member => (group.lastTurns[member] ?? turn) - turn)
    .reduce((max, value) => Math.max(max, value), 0)
  return (
    <div className={css.versions}>
      <button
        type="button"
        className={css.versionArrow}
        aria-label={t('local.versions.previous')}
        disabled={index <= 0 || moving}
        onClick={() => { go(group.members[index - 1]) }}
      >
        <IconChevronLeftOutlineRegular size={12} />
      </button>
      <span className={css.versionCount}>{t('local.versions.count', { n: index + 1, total: group.members.length })}</span>
      <button
        type="button"
        className={css.versionArrow}
        aria-label={t('local.versions.next')}
        disabled={index >= group.members.length - 1 || moving}
        onClick={() => { go(group.members[index + 1]) }}
      >
        <IconChevronRightOutlineRegular size={12} />
      </button>
      <span className={css.versionNote}>
        {later > 0 ? t('local.versions.warnLater', { n: later }) : t('local.versions.warn')}
      </span>
    </div>
  )
}
