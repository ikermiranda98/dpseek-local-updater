/**
 * Subchats (añadido por dpseek-local-updater): qué chats hijos son subchats
 * abiertos desde la app, con su chat principal y su nombre.
 *
 * Los subchats son subagentes «fork» oficiales: la lista de sesiones ya trae su
 * `parentSessionId`, pero no distingue los que abriste tú de los que lanza el
 * modelo. Este registro (en el almacenamiento del navegador de la app) lo hace.
 * Lo usan el chat (ui-chat), que los crea, y la barra lateral (ui-workspace),
 * que los anida bajo su chat; son paquetes distintos y comparten un símbolo global.
 */

/** Un subchat abierto desde la app. */
export interface LocalSubchat {
  readonly childId: string
  readonly parentId: string
  readonly label: string
  readonly createdAt: number
}

interface SubchatStore {
  list: readonly LocalSubchat[]
  readonly listeners: Set<() => void>
  /** Quién puede lanzar subchats: ui-chat, que tiene acceso al Host. */
  starter?: ((sessionId: string, task: string) => Promise<string>) | undefined
}

const STORAGE_KEY = 'dpseek-local-updater.subchats.v1'
const KEY = Symbol.for('dpseek-local-updater.subchats')

function load(): readonly LocalSubchat[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((entry): entry is LocalSubchat =>
      typeof entry === 'object' && entry !== null && typeof (entry as LocalSubchat).childId === 'string'
      && typeof (entry as LocalSubchat).parentId === 'string') : []
  } catch {
    return []
  }
}

const store = ((globalThis as Record<symbol, unknown>)[KEY] ??= { list: load(), listeners: new Set() }) as SubchatStore

function save(list: readonly LocalSubchat[]): void {
  store.list = list
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)) } catch { /* sin almacenamiento: solo en esta sesión */ }
  for (const listener of store.listeners) listener()
}

/** @param subchat - subchat recién creado. */
export function addSubchat(subchat: LocalSubchat): void {
  save([...store.list.filter((entry) => entry.childId !== subchat.childId), subchat])
}

/** @param starter - cómo lanzar un subchat (ui-chat), o nada al descargarse. */
export function setSubchatStarter(starter: ((sessionId: string, task: string) => Promise<string>) | undefined): void {
  store.starter = starter
}

/**
 * Lanza un subchat desde cualquier parte de la app (p. ej. la sugerencia del medidor de contexto).
 * @returns la sesión del subchat.
 */
export function startSubchat(sessionId: string, task: string): Promise<string> {
  if (store.starter === undefined) return Promise.reject(new Error('Subchats are not available right now.'))
  return store.starter(sessionId, task)
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
