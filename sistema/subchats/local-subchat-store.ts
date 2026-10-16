/**
 * Subchats (añadido por dpseek-local-updater): qué chats hijos son subchats
 * abiertos desde la app, con su chat principal y su nombre, y qué grupos de la
 * barra lateral están plegados.
 *
 * Los subchats son subagentes «fork» oficiales: la lista de sesiones ya trae su
 * `parentSessionId`, pero no distingue los que abriste tú de los que lanza el
 * modelo. Este registro (en el almacenamiento del navegador de la app) lo hace.
 * Lo usan el chat (ui-chat), que los crea; la barra lateral (ui-workspace), que los
 * anida bajo su chat; y el cuadro de texto (ui-conversation), que los sugiere. Son
 * paquetes distintos y comparten un símbolo global.
 */

/** Un subchat abierto desde la app. */
export interface LocalSubchat {
  readonly childId: string
  readonly parentId: string
  readonly label: string
  readonly createdAt: number
  /** El resultado no vuelve solo: lo manda el usuario desde el subchat. */
  readonly review?: boolean
  /** El usuario ya ha mandado un resultado al chat principal. */
  readonly delivered?: boolean
}

/** Cómo lanzar un subchat (lo pone ui-chat, que tiene acceso al Host). */
export type LocalSubchatStarter = (sessionId: string, task: string, options: { readonly review: boolean }) => Promise<string>

interface SubchatStore {
  list: readonly LocalSubchat[]
  collapsed: ReadonlySet<string>
  readonly listeners: Set<() => void>
  starter?: LocalSubchatStarter | undefined
}

const STORAGE_KEY = 'dpseek-local-updater.subchats.v1'
const COLLAPSED_KEY = 'dpseek-local-updater.subchats.collapsed.v1'
const KEY = Symbol.for('dpseek-local-updater.subchats')

function load<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return valid(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

const isSubchat = (entry: unknown): entry is LocalSubchat => typeof entry === 'object' && entry !== null
  && typeof (entry as LocalSubchat).childId === 'string' && typeof (entry as LocalSubchat).parentId === 'string'

const store = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  list: load<readonly LocalSubchat[]>(STORAGE_KEY, [], (value): value is readonly LocalSubchat[] =>
    Array.isArray(value) && value.every(isSubchat)),
  collapsed: new Set(load<readonly string[]>(COLLAPSED_KEY, [], (value): value is readonly string[] =>
    Array.isArray(value) && value.every((id) => typeof id === 'string'))),
  listeners: new Set(),
}) as SubchatStore

function changed(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store.list))
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...store.collapsed]))
  } catch { /* sin almacenamiento: solo en esta sesión */ }
  for (const listener of store.listeners) listener()
}

/** @param subchat - subchat recién creado (su grupo se despliega). */
export function addSubchat(subchat: LocalSubchat): void {
  store.list = [...store.list.filter((entry) => entry.childId !== subchat.childId), subchat]
  if (store.collapsed.has(subchat.parentId)) store.collapsed = new Set([...store.collapsed].filter((id) => id !== subchat.parentId))
  changed()
}

/** @param childId - subchat. @param patch - cambios (nombre, entregado…). */
export function updateSubchat(childId: string, patch: Partial<Pick<LocalSubchat, 'label' | 'delivered'>>): void {
  store.list = store.list.map((entry) => entry.childId === childId ? { ...entry, ...patch } : entry)
  changed()
}

/** @param childId - subchat que deja de verse en la barra lateral. */
export function forgetSubchat(childId: string): void {
  store.list = store.list.filter((entry) => entry.childId !== childId)
  changed()
}

/** @returns el subchat con esa sesión, si es uno de la app. */
export function subchatOf(childId: string): LocalSubchat | undefined {
  return store.list.find((entry) => entry.childId === childId)
}

/** @param parentId - chat principal. @param collapsed - si sus subchats se pliegan. */
export function setSubchatsCollapsed(parentId: string, collapsed: boolean): void {
  const next = new Set(store.collapsed)
  if (collapsed) next.add(parentId)
  else next.delete(parentId)
  store.collapsed = next
  changed()
}

/** @returns los chats principales con los subchats plegados. */
export function collapsedSnapshot(): ReadonlySet<string> {
  return store.collapsed
}

/** @param starter - cómo lanzar un subchat (ui-chat), o nada al descargarse. */
export function setSubchatStarter(starter: LocalSubchatStarter | undefined): void {
  store.starter = starter
}

/**
 * Lanza un subchat desde cualquier parte de la app (p. ej. la sugerencia del medidor de contexto).
 * @returns la sesión del subchat.
 */
export function startSubchat(sessionId: string, task: string, options: { readonly review: boolean } = { review: false }): Promise<string> {
  if (store.starter === undefined) return Promise.reject(new Error('Subchats are not available right now.'))
  return store.starter(sessionId, task, options)
}

/** @returns todos los subchats, en orden de creación. */
export function subchatsSnapshot(): readonly LocalSubchat[] {
  return store.list
}

/** @returns cómo dejar de escuchar. */
export function subscribeSubchats(listener: () => void): () => void {
  store.listeners.add(listener)
  return () => { store.listeners.delete(listener) }
}
