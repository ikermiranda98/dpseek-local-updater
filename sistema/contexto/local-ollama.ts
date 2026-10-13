/**
 * Chats anteriores al contexto por chat (añadido por dpseek-local-updater).
 *
 * Desde que cada tamaño de contexto es una variante del modelo de Ollama
 * (`<modelo>:dsh-ctx-<tamaño>`, ver sistema/contexto/arranque.cjs), un chat que
 * guardó el modelo tal cual (`Qwen…:latest`) ya no lo encuentra en el catálogo.
 * Esto lo traduce, al leerlo, a la variante con el contexto recomendado
 * (`Qwen…:dsh-ctx-auto`), sin tocar el registro del chat.
 */

/** Proveedor de Ollama que declara la configuración de la compilación local. */
const OLLAMA_PROVIDER = 'ollama'
const VARIANT = /(:|-)dsh-ctx-(auto|\d+)$/

/**
 * Variante «recomendada» de un modelo de Ollama sin contexto fijado.
 * @param model - id del modelo en Ollama.
 * @returns el id de la variante automática (`modelo:dsh-ctx-auto`).
 */
function autoVariant(model: string): string {
  const i = model.lastIndexOf(':')
  const [base, tag] = i < 0 ? [model, 'latest'] : [model.slice(0, i), model.slice(i + 1)]
  return `${base}:${tag === 'latest' ? '' : tag + '-'}dsh-ctx-auto`
}

/**
 * Traduce una selección de modelo guardada antes del contexto por chat.
 * @param selection - proveedor y modelo guardados (y el resto de campos).
 * @returns la misma selección, o la variante recomendada si es un modelo de Ollama sin contexto.
 */
export function localOllamaSelection<T extends { readonly provider: string; readonly model: string }>(selection: T): T
export function localOllamaSelection<T extends { readonly provider: string; readonly model: string }>(selection: T | null): T | null
export function localOllamaSelection<T extends { readonly provider: string; readonly model: string }>(selection: T | null): T | null {
  if (selection === null || selection.provider !== OLLAMA_PROVIDER || VARIANT.test(selection.model)) return selection
  return { ...selection, model: autoVariant(selection.model) }
}
