/**
 * Código en vivo (añadido por dpseek-local-updater): lo que el modelo está
 * escribiendo en el turno actual de cada chat, y lo que escribió y los pasos que
 * dio con el navegador en los turnos anteriores.
 *
 * El chat (ui-chat) lo publica mientras llegan las llamadas a write/edit y la
 * pestaña «Live code» del panel derecho (ui-deliverables) lo dibuja. Son paquetes
 * distintos, así que comparten el estado por un símbolo global. Los turnos
 * anteriores salen del registro del chat (el mismo que se guarda en disco), así
 * que siguen ahí al reiniciar la app.
 */

/** Una escritura o edición de un fichero, tal y como va llegando. */
export interface LiveEdit {
  readonly callId: string
  /** `write` sustituye el fichero entero; `edit` cambia un trozo. */
  readonly kind: 'write' | 'edit'
  readonly status: 'writing' | 'running' | 'done' | 'failed'
  /** Contenido completo (write) o texto nuevo (edit), parcial mientras se escribe. */
  readonly text: string
  /** Texto sustituido (edit). */
  readonly oldText?: string
}

/** Un fichero tocado en el turno, con sus escrituras en orden. */
export interface LiveFile {
  readonly path: string
  readonly edits: readonly LiveEdit[]
}

/** El turno actual de un chat. */
export interface LiveTurn {
  readonly sessionId: string
  readonly turn: number
  readonly running: boolean
  /** Cuándo empezó el turno (el usuario mandó el mensaje), con el reloj del PC. */
  readonly startedAt?: number
  readonly files: readonly LiveFile[]
  /** Evento `workspace/changes` del turno, cuando ya ha terminado y hay cambios que revisar. */
  readonly changesSeq?: number
  /** Pasos del turno con el navegador del agente (abrir, leer, escribir, pulsar…), en orden. */
  readonly browser?: readonly LiveBrowserStep[]
}

/** Un paso del agente con el navegador. */
export interface LiveBrowserStep {
  readonly callId: string
  /** Nombre de la herramienta sin el prefijo del servidor: «navigate», «click»… */
  readonly action: string
  /** Qué hace, en pocas palabras (la dirección, el elemento…); nunca lo que escribe en un campo. */
  readonly detail: string
  readonly status: 'running' | 'done' | 'failed'
}

interface LiveStore {
  readonly turns: Map<string, LiveTurn>
  readonly listeners: Set<() => void>
  readonly openers: Set<(sessionId: string) => void>
  browserOpeners?: Set<(sessionId: string) => void>
  /** El último fichero que se pidió ver desde el chat (la lista de la flecha de «Live code»), y de qué turno. */
  liveChoice?: { readonly sessionId: string; readonly path: string; readonly at: number; readonly turn?: number }
  /** Turnos ya terminados de cada chat que escribieron ficheros o usaron el navegador, por número de turno. */
  history?: Map<string, Map<number, LiveTurn>>
  /** Los turnos de cada chat (los terminados y el actual) en orden, para no rehacer la lista en cada lectura. */
  turnLists?: Map<string, readonly LiveTurn[]>
  /** Quien quiere saber que un chat empieza un turno (el usuario acaba de mandar un mensaje). */
  turnStarters?: Set<(sessionId: string, startedAt: number | undefined) => void>
}

const KEY = Symbol.for('dpseek-local-updater.live-code')
const store = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  turns: new Map(), listeners: new Set(), openers: new Set(),
}) as LiveStore
store.browserOpeners ??= new Set()
const browserOpeners = store.browserOpeners

/** El chat pide abrir la pestaña «Browser». */
export function requestBrowserOpen(sessionId: string): void {
  for (const opener of browserOpeners) opener(sessionId)
}

/** @returns cómo dejar de atender las peticiones de abrir la pestaña «Browser». */
export function onBrowserOpen(opener: (sessionId: string) => void): () => void {
  browserOpeners.add(opener)
  return () => { browserOpeners.delete(opener) }
}

/** @param turn - estado nuevo del turno de un chat. */
export function publishLive(turn: LiveTurn): void {
  const previous = store.turns.get(turn.sessionId)
  store.turns.set(turn.sessionId, turn)
  store.turnLists?.delete(turn.sessionId)
  for (const listener of store.listeners) listener()
  // Un turno nuevo en marcha: el usuario acaba de mandar un mensaje (también el primero de un chat nuevo).
  if (turn.running && previous?.turn !== turn.turn) {
    for (const starter of store.turnStarters ?? []) starter(turn.sessionId, turn.startedAt)
  }
}

/** @returns cómo dejar de escuchar cuándo empieza un turno nuevo en un chat. */
export function onTurnStart(starter: (sessionId: string, startedAt: number | undefined) => void): () => void {
  store.turnStarters ??= new Set()
  store.turnStarters.add(starter)
  return () => { store.turnStarters?.delete(starter) }
}

/** @returns el turno publicado de ese chat. */
export function liveSnapshot(sessionId: string): LiveTurn | undefined {
  return store.turns.get(sessionId)
}

/**
 * Los turnos anteriores de un chat (se calculan del registro del chat al abrirlo).
 * @param sessionId - chat.
 * @param turns - turnos terminados que escribieron ficheros o usaron el navegador.
 */
export function publishHistory(sessionId: string, turns: readonly LiveTurn[]): void {
  store.history ??= new Map()
  store.history.set(sessionId, new Map(turns.map(turn => [turn.turn, turn])))
  store.turnLists?.delete(sessionId)
  for (const listener of store.listeners) listener()
}

/** @returns ese turno del chat: el actual o uno anterior, si escribió ficheros o usó el navegador. */
export function turnSnapshot(sessionId: string, turn: number): LiveTurn | undefined {
  const live = store.turns.get(sessionId)
  return live?.turn === turn ? live : store.history?.get(sessionId)?.get(turn)
}

/** @returns los turnos del chat con ficheros o pasos del navegador, del más antiguo al actual (misma lista mientras no cambien). */
export function sessionTurns(sessionId: string): readonly LiveTurn[] {
  store.turnLists ??= new Map()
  const cached = store.turnLists.get(sessionId)
  if (cached !== undefined) return cached
  const live = store.turns.get(sessionId)
  const older = [...store.history?.get(sessionId)?.values() ?? []].filter(turn => turn.turn !== live?.turn)
  const list = [...older, ...live === undefined ? [] : [live]]
    .filter(turn => turn.files.length > 0 || (turn.browser?.length ?? 0) > 0)
    .sort((a, b) => a.turn - b.turn)
  store.turnLists.set(sessionId, list)
  return list
}

/** @returns los chats con un turno en marcha, el que usa el navegador ahora primero. */
export function runningSessions(): string[] {
  const running = [...store.turns.values()].filter(turn => turn.running)
  const browsing = (turn: LiveTurn): number => turn.browser?.at(-1)?.status === 'running' ? 0 : 1
  return running.sort((a, b) => browsing(a) - browsing(b)).map(turn => turn.sessionId)
}

/** @returns cómo dejar de escuchar. */
export function subscribeLive(listener: () => void): () => void {
  store.listeners.add(listener)
  return () => { store.listeners.delete(listener) }
}

/** El chat pide abrir la pestaña: el modelo ha empezado a escribir un fichero. */
export function requestLiveOpen(sessionId: string): void {
  for (const opener of store.openers) opener(sessionId)
}

/** El chat pide abrir la pestaña «Live code» en un fichero concreto (de ese turno; sin turno, el actual). */
export function requestLiveFile(sessionId: string, path: string, turn?: number): void {
  store.liveChoice = { sessionId, path, at: Date.now(), ...turn === undefined ? {} : { turn } }
  for (const listener of store.listeners) listener()
  requestLiveOpen(sessionId)
}

/** @returns el último fichero que se pidió ver en ese chat, si lo hay. */
export function liveChoice(sessionId: string): { readonly path: string; readonly at: number; readonly turn?: number } | undefined {
  return store.liveChoice?.sessionId === sessionId ? store.liveChoice : undefined
}

/** @returns cómo dejar de atender las peticiones de abrir la pestaña. */
export function onLiveOpen(opener: (sessionId: string) => void): () => void {
  store.openers.add(opener)
  return () => { store.openers.delete(opener) }
}

/** Cómo se dice cada paso del navegador, en pocas palabras (en el chat y en el panel). */
export function browserStepText(step: LiveBrowserStep): string {
  const on = step.detail === '' ? '' : ` ${step.detail}`
  switch (step.action) {
    case 'navigate': return `Opened${on}`
    case 'navigate_back': return 'Went back'
    case 'snapshot': return 'Read the page'
    case 'click': return `Clicked${on}`
    case 'hover': return `Hovered${on}`
    case 'type': return `Typed in${on}`
    case 'fill_form': return 'Filled in the form'
    case 'select_option': return `Chose an option in${on}`
    case 'press_key': return `Pressed${on}`
    case 'wait_for': return step.detail === '' ? 'Waited' : `Waited for «${step.detail}»`
    case 'take_screenshot': return 'Took a screenshot'
    case 'tabs': return `Tabs: ${step.detail}`
    case 'close': return 'Closed the page'
    case 'evaluate': case 'run_code_unsafe': return 'Ran a script on the page'
    case 'file_upload': return 'Uploaded a file'
    case 'find': return step.detail === '' ? 'Searched the page' : `Searched the page for «${step.detail}»`
    case 'network_requests': return 'Checked the network requests'
    case 'network_request': return 'Read a network request'
    case 'console_messages': return 'Read the console'
    case 'handle_dialog': return 'Answered a dialog'
    case 'drag': return `Dragged${on}`
    case 'resize': return 'Resized the window'
    default: return `${step.action.replace(/_/g, ' ')}${on}`
  }
}
