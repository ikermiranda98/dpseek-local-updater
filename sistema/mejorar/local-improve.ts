/**
 * Mejorar un mensaje antes de enviarlo (añadido por dpseek-local-updater), lado del Host.
 *
 * Con el botón «Improve message» de la barra del cuadro de texto, el modelo del chat
 * (u otro, si se indica) reescribe tu borrador para que la IA lo entienda mejor: qué
 * hacer, con qué ficheros o nombres y qué resultado se espera, sin cambiar lo que
 * pides, sin responderlo y en tu idioma. Usa los últimos mensajes del chat solo para
 * resolver referencias («el archivo», «eso»…). Nada se envía solo.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Un mensaje reciente del chat, como contexto. */
export interface LocalImproveTurn {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** Cuánto contexto del chat se le pasa: lo justo para entender las referencias. */
const RECENT_MESSAGES = 6
const MESSAGE_CHARS = 1500

const INSTRUCTIONS = [
  'You improve a message that a user is about to send to an AI coding assistant, so the assistant understands it',
  'without ambiguity. Rewrite the draft so it says clearly what to do, with which files, names or values, and what',
  'result is expected. Keep the user\'s intent and add no new requirements. Use the recent conversation only to',
  'resolve references such as "that file" or "the previous one". Write in the same language as the draft. Do not',
  'answer or carry out the request. Reply with only the rewritten message: no quotes, no preamble, no explanation.',
].join(' ')

function ollamaUrl(): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  try {
    const settings = JSON.parse(readFileSync(join(home, 'storages', 'local-arranque.json'), 'utf8')) as { ollama?: unknown }
    return typeof settings.ollama === 'string' ? settings.ollama : 'http://127.0.0.1:11434'
  } catch {
    return 'http://127.0.0.1:11434'
  }
}

/**
 * Últimos mensajes del chat con texto (los tuyos y las respuestas), para el contexto.
 * @param events - eventos del registro del chat.
 * @returns hasta RECENT_MESSAGES mensajes, recortados.
 */
export function localRecentTurns(events: Iterable<{ readonly type: string; readonly data: unknown }>): LocalImproveTurn[] {
  const turns: LocalImproveTurn[] = []
  const textOf = (content: unknown): string => Array.isArray(content)
    ? content.flatMap((block: { type?: unknown; text?: unknown }) => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
    : ''
  for (const event of events) {
    if (event.type === 'user/message') {
      const data = event.data as { source?: { kind?: unknown }; content?: unknown }
      // Solo lo que escribió el usuario (no el contexto que añade la app).
      if (data.source?.kind !== 'user') continue
      const text = textOf(data.content).trim()
      if (text !== '') turns.push({ role: 'user', text })
    } else if (event.type === 'assistant/message') {
      const text = textOf((event.data as { message?: { content?: unknown } }).message?.content).trim()
      if (text !== '') turns.push({ role: 'assistant', text })
    }
  }
  return turns.slice(-RECENT_MESSAGES).map((turn) => ({
    ...turn,
    text: turn.text.length > MESSAGE_CHARS ? `${turn.text.slice(0, MESSAGE_CHARS)}…` : turn.text,
  }))
}

/** Español, por las letras y palabras más comunes (para decírselo al modelo: los pequeños se pasan al inglés). */
function looksSpanish(text: string): boolean {
  return /[áéíóúñ¿¡]/i.test(text) || (text.match(/\b(que|el|la|los|las|de|del|un|una|en|hasta|para|con|por|haz|crea|cree|archivo)\b/gi)?.length ?? 0) >= 2
}

/** Un ejemplo resuelto: con él, hasta los modelos pequeños entienden qué se pide y el formato. */
const EXAMPLE_DRAFT = 'que cree el archivo calculadora que haga 2+2+2 hasta llegar a 100'
const EXAMPLE_ANSWER = 'Crea un archivo calc.py que sume el número 2 una y otra vez hasta llegar a 100 y muestre el resultado.'

/** Cabeceras que algunos modelos añaden aunque se les pida que no. */
const PREAMBLE = /^(improved|rewritten|improve the|here is|aquí tienes|mensaje mejorado|versión mejorada)[^\n]*:\s*\n?/i

/**
 * Pide la versión mejorada del borrador.
 * @param model - modelo de Ollama (si es el del chat, conviene su variante de contexto para no recargarlo).
 * @param draft - lo que el usuario ha escrito.
 * @param recent - últimos mensajes del chat.
 * @param signal - cancelación.
 * @returns el mensaje reescrito.
 */
export async function localImprovePrompt(model: string, draft: string, recent: readonly LocalImproveTurn[],
  signal: AbortSignal): Promise<string> {
  const conversation = recent.length === 0 ? '(no earlier messages)'
    : recent.map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`).join('\n\n')
  const language = looksSpanish(draft) ? '\n\nThe draft is in Spanish: write the improved message in Spanish.' : ''
  const response = await fetch(`${ollamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      options: { num_predict: 400, temperature: 0 },
      messages: [
        { role: 'system', content: INSTRUCTIONS },
        {
          role: 'user',
          content: `Recent conversation:\n(no earlier messages)\n\nDraft to improve:\n${EXAMPLE_DRAFT}\n\nThe draft is in Spanish: write the improved message in Spanish.`,
        },
        { role: 'assistant', content: EXAMPLE_ANSWER },
        { role: 'user', content: `Recent conversation:\n${conversation}\n\nDraft to improve:\n${draft.trim()}${language}` },
      ],
    }),
  })
  if (!response.ok) throw new Error(`Ollama answered ${String(response.status)}: ${(await response.text()).slice(0, 200)}`)
  const body = await response.json() as { message?: { content?: unknown } }
  const text = typeof body.message?.content === 'string' ? body.message.content : ''
  // Algunos modelos envuelven la respuesta en comillas aunque se les pida que no.
  return text.trim().replace(PREAMBLE, '').trim().replace(/^["“«](.*)["”»]$/s, '$1').trim()
}
