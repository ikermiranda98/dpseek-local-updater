/**
 * Lista de modelos de Ollama al día (añadido por dpseek-local-updater).
 *
 * Al arrancar, la configuración de la app fija la lista de modelos de Ollama
 * (arranque.cjs). Al abrir el selector de modelos, el Host la vuelve a pedir
 * (local-optimize.ts → localRefreshModels) y la deja aquí; el adaptador llm-pi-ai
 * la usa en lugar de la de arranque y vuelve a registrar sus rutas, lo que avisa
 * a la interfaz (`llm/adapters-updated`) para que recargue el catálogo.
 *
 * Este fichero se copia en los dos paquetes (session-controller y llm-pi-ai), que
 * se empaquetan por separado: el estado compartido vive en globalThis.
 */

const KEY = Symbol.for('dpseek-local-updater.ollama-models')

interface LiveOllama {
  /** 0 hasta el primer refresco: mientras, manda la lista de arranque. */
  version: number
  models: readonly unknown[]
  readonly listeners: Set<() => void>
}

function live(): LiveOllama {
  const holder = globalThis as unknown as Record<symbol, LiveOllama | undefined>
  holder[KEY] ??= { version: 0, models: [], listeners: new Set() }
  return holder[KEY]
}

/**
 * Publica una lista nueva de modelos de Ollama y avisa a quien la use.
 * @param models - modelos en el formato de llm-pi-ai (los que da arranque.cjs).
 */
export function publishLiveOllama(models: readonly unknown[]): void {
  const state = live()
  if (JSON.stringify(models) === JSON.stringify(state.models)) return
  state.models = models
  state.version += 1
  for (const listener of state.listeners) {
    try {
      listener()
    } catch {
      // Un oyente que falla no impide avisar a los demás.
    }
  }
}

/**
 * Se suscribe a los cambios de la lista.
 * @param listener - se llama tras cada lista nueva.
 * @returns la función que cancela la suscripción.
 */
export function onLiveOllama(listener: () => void): () => void {
  const state = live()
  state.listeners.add(listener)
  return () => { state.listeners.delete(listener) }
}

let cache: { raw: unknown; version: number; value: unknown } | undefined

/**
 * Los proveedores de la configuración con la lista de Ollama al día. Devuelve el
 * mismo objeto mientras no cambien ni la configuración ni la lista (llm-pi-ai
 * memoriza sus perfiles por identidad).
 * @param raw - `providers` de la configuración de llm-pi-ai.
 * @returns los mismos proveedores, con los modelos de `ollama` actualizados.
 */
export function withLiveOllama<T>(raw: T): T {
  const state = live()
  if (state.version === 0 || raw === null || typeof raw !== 'object') return raw
  if (cache !== undefined && cache.raw === raw && cache.version === state.version) return cache.value as T
  const providers = raw as Record<string, unknown>
  const ollama = providers['ollama']
  if (ollama === null || typeof ollama !== 'object' || state.models.length === 0) return raw
  const value = { ...providers, ollama: { ...ollama as Record<string, unknown>, models: state.models } } as T
  cache = { raw, version: state.version, value }
  return value
}
