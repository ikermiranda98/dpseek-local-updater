/**
 * Mejorar un mensaje antes de enviarlo (añadido por dpseek-local-updater), lado del Host.
 *
 * Con el botón «Improve message» de la barra del cuadro de texto, el modelo del chat
 * (u otro, si se indica) convierte lo que has escrito, un documento o ambos en un
 * prompt claro para la IA: qué hacer, con qué ficheros o nombres y qué resultado se
 * espera, sin cambiar lo que pides, sin responderlo y en tu idioma. Para no inventar
 * nombres ve los últimos mensajes del chat y la lista de ficheros del proyecto; si
 * falta algo importante, pregunta en lugar de adivinar. Un documento largo se
 * resume antes por partes. Nada se envía solo.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Un mensaje reciente del chat, como contexto. */
export interface LocalImproveTurn {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** Un documento adjunto, ya en texto (los PDF llevan marcas «[p. N]» por página). */
export interface LocalImproveDocument {
  readonly name: string
  readonly text: string
  readonly pages?: number
}

/** Respuesta del usuario a una pregunta de la sugerencia anterior. */
export interface LocalImproveAnswer {
  readonly question: string
  readonly answer: string
}

/** Lo que se le pasa al modelo además del borrador. */
export interface LocalImproveInput {
  readonly draft: string
  readonly recent: readonly LocalImproveTurn[]
  readonly files: readonly string[]
  readonly document?: LocalImproveDocument
  readonly answers?: readonly LocalImproveAnswer[]
}

/** El prompt sugerido, las preguntas (si falta algo) y una nota sobre el documento. */
export interface LocalImproveResult {
  readonly text: string
  readonly questions: readonly string[]
  readonly note?: string
}

/** Cuánto contexto del chat se le pasa: lo justo para entender las referencias. */
const RECENT_MESSAGES = 6
const MESSAGE_CHARS = 1500

/** Ficheros del proyecto: solo nombres, los suficientes para no inventar ninguno. */
const PROJECT_FILES = 300
const PROJECT_DEPTH = 6
const PROJECT_VISITS = 5000
const SKIPPED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.tox', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.cache', '.idea', '.vscode', 'coverage',
])

/** Un documento hasta este tamaño va entero; uno mayor se resume antes por partes. */
const DIRECT_CHARS = 20_000
const PART_CHARS = 12_000
/** Más allá, solo el principio: resumir cientos de páginas tardaría minutos. */
const DOCUMENT_CHARS = 240_000

const INSTRUCTIONS = [
  'You turn what the user wrote (a draft message, a document, or both) into a clear prompt for an AI coding assistant',
  'that works in the user\'s project.',
  'Rules:',
  '- Keep the user\'s intent and add no requirements of your own: no tests, refactors, files or details (numbers,',
  '  limits, names) the user did not ask for. When a document is given, carry over its goals, requirements and',
  '  constraints faithfully, and nothing else. The examples only show the format: never take details from them.',
  '- Use only names (files, folders, functions, values) that appear in the draft, the recent conversation, the project',
  '  files or the document. Never invent or rename one. If the user refers to a file loosely and the project files',
  '  contain a clear match, write its exact path; otherwise keep the user\'s words. Name only the files the request',
  '  needs, not every related one.',
  '- Size: a simple request (one change or fix, even if it names a file) becomes one or two sentences. A task with',
  '  several separate requirements or conditions, or one that comes from a document, uses short sections: Goal,',
  '  Files, Requirements, Constraints, Done when (in the language of the prompt; leave out empty sections).',
  '- If something essential is missing and cannot be inferred safely (which file, which language, the expected',
  '  behaviour), do not guess: write the prompt with what is known, then a line "QUESTIONS:" and at most two short',
  '  questions, one per line starting with "- ".',
  '- Do not answer or carry out the request. Write in the language of the draft, or of the document if there is no draft.',
  '- Reply with only the prompt (and the QUESTIONS block when needed): no quotes, no preamble, no explanation.',
].join('\n')

/** Ejemplos resueltos: el formato, no inventar nombres, preguntar y estructurar lo grande. */
const EXAMPLES: readonly { readonly input: LocalImproveInput; readonly answer: string }[] = [
  {
    input: { draft: 'haz un script que renombre las fotos por fecha', recent: [], files: [] },
    answer: 'Crea un script que renombre las fotos según su fecha.\n'
      + 'QUESTIONS:\n- ¿En qué lenguaje lo hago (por ejemplo, Python)?\n- ¿En qué carpeta están las fotos?',
  },
  {
    input: { draft: 'cambia el color del boton de enviar a verde', recent: [], files: ['index.html', 'src/styles.css'] },
    answer: 'En src/styles.css, cambia el color del botón de enviar a verde.',
  },
  {
    input: {
      draft: 'añade que se puedan borrar usuarios en la base de datos, con su test y que no se rompa nada',
      recent: [],
      files: ['README.md', 'src/app.py', 'src/db.py', 'tests/test_db.py'],
    },
    answer: 'Objetivo: poder borrar usuarios de la base de datos.\n\n'
      + 'Ficheros: src/db.py y tests/test_db.py.\n\n'
      + 'Requisitos:\n- En src/db.py, una función que borre un usuario.\n- En tests/test_db.py, un test que compruebe el borrado.\n\n'
      + 'Hecho cuando: el test nuevo y los que ya había pasan.',
  },
]

const SUMMARY_INSTRUCTIONS = [
  'You read one part of a document that a user wants to turn into a task for an AI coding assistant.',
  'Extract everything relevant for that task: goals, requirements, constraints, names (files, functions, fields, values),',
  'expected results and acceptance criteria. Keep the page markers like [p. 3] next to what they refer to. Be concise:',
  'short bullet points, in the language of the document, no commentary. If the part has nothing relevant, reply "-".',
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

/**
 * Ficheros del proyecto, por nombre (sin dependencias, compilados ni carpetas ocultas de herramientas).
 * @param root - carpeta del chat.
 * @returns rutas relativas con «/», ordenadas, como mucho PROJECT_FILES.
 */
export function localProjectFiles(root: string | undefined): string[] {
  if (root === undefined || root === '') return []
  const files: string[] = []
  let visits = 0
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > PROJECT_DEPTH || files.length >= PROJECT_FILES) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    // Primero los ficheros de esta carpeta: los de arriba suelen ser los que se nombran.
    for (const entry of entries) {
      if (++visits > PROJECT_VISITS || files.length >= PROJECT_FILES) return
      if (entry.isFile()) files.push(prefix + entry.name)
    }
    for (const entry of entries) {
      if (visits > PROJECT_VISITS || files.length >= PROJECT_FILES) return
      if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        walk(join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1)
      }
    }
  }
  walk(root, '', 0)
  return files.sort()
}

/** Español, por las letras y palabras más comunes (para decírselo al modelo: los pequeños se pasan al inglés). */
function looksSpanish(text: string): boolean {
  return /[áéíóúñ¿¡]/i.test(text) || (text.match(/\b(que|el|la|los|las|de|del|un|una|en|hasta|para|con|por|haz|crea|cree|archivo)\b/gi)?.length ?? 0) >= 2
}

/** Cabeceras que algunos modelos añaden aunque se les pida que no. */
const PREAMBLE = /^(improved|rewritten|improve the|here is|aquí tienes|mensaje mejorado|versión mejorada|prompt mejorado|prompt)[^\n]*:\s*\n?/i
const QUESTIONS = /^\s*\**\s*(QUESTIONS|PREGUNTAS)\s*\**\s*:\s*$/im

async function chat(model: string, messages: readonly { role: string; content: string }[], predict: number,
  signal: AbortSignal): Promise<string> {
  const response = await fetch(`${ollamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
    body: JSON.stringify({ model, stream: false, think: false, options: { num_predict: predict, temperature: 0 }, messages }),
  })
  if (!response.ok) throw new Error(`Ollama answered ${String(response.status)}: ${(await response.text()).slice(0, 200)}`)
  const body = await response.json() as { message?: { content?: unknown } }
  return typeof body.message?.content === 'string' ? body.message.content.trim() : ''
}

/** Resúmenes ya hechos, por documento: al responder a las preguntas no se vuelve a leer entero. */
const summaries = new Map<string, { text: string; note?: string }>()

/** Trozos de como mucho `size` caracteres, cortando por párrafos cuando se puede. */
function parts(text: string, size: number): string[] {
  const result: string[] = []
  let rest = text
  while (rest.length > size) {
    const cut = rest.lastIndexOf('\n\n', size)
    const at = cut > size / 2 ? cut : (rest.lastIndexOf('\n', size) > size / 2 ? rest.lastIndexOf('\n', size) : size)
    result.push(rest.slice(0, at))
    rest = rest.slice(at)
  }
  if (rest.trim() !== '') result.push(rest)
  return result
}

/** Última página citada en un texto con marcas «[p. N]». */
function lastPage(text: string): number | undefined {
  const pages = [...text.matchAll(/\[p\. (\d+)\]/g)].map((match) => Number(match[1]))
  return pages.length === 0 ? undefined : Math.max(...pages)
}

/**
 * El documento listo para el prompt: entero si es corto; si no, resumido por partes.
 * @returns el texto que ve el modelo y, si se ha resumido o recortado, una nota para el usuario.
 */
async function documentText(model: string, document: LocalImproveDocument, signal: AbortSignal): Promise<{ text: string; note?: string }> {
  if (document.text.length <= DIRECT_CHARS) return { text: document.text }
  const key = createHash('sha256').update(model).update('\0').update(document.text).digest('hex')
  const known = summaries.get(key)
  if (known !== undefined) return known
  const cut = document.text.length > DOCUMENT_CHARS
  const used = cut ? document.text.slice(0, DOCUMENT_CHARS) : document.text
  const pieces = parts(used, PART_CHARS)
  const notes: string[] = []
  for (const [index, piece] of pieces.entries()) {
    const summary = await chat(model, [
      { role: 'system', content: SUMMARY_INSTRUCTIONS },
      { role: 'user', content: `Part ${String(index + 1)} of ${String(pieces.length)} of "${document.name}":\n\n${piece}` },
    ], 600, signal)
    if (summary !== '' && summary !== '-') notes.push(summary)
  }
  const until = cut ? lastPage(used) : undefined
  const scope = cut
    ? (until !== undefined && document.pages !== undefined
      ? `pages 1–${String(until)} of ${String(document.pages)}`
      : `the first ${String(Math.round(DOCUMENT_CHARS / 1000))}k characters`)
    : 'the whole document'
  const result = {
    text: `(Summary of ${scope}, made part by part.)\n\n${notes.join('\n\n')}`,
    note: `Long document: read ${scope}, summarised in ${String(pieces.length)} parts.`,
  }
  summaries.set(key, result)
  if (summaries.size > 5) summaries.delete(summaries.keys().next().value as string)
  return result
}

/** El mensaje para el modelo con todo lo que tiene que ver. */
function userMessage(input: LocalImproveInput, document?: { name: string; text: string }): string {
  const conversation = input.recent.length === 0 ? '(no earlier messages)'
    : input.recent.map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`).join('\n\n')
  const files = input.files.length === 0 ? '(none listed)' : input.files.join('\n')
  const draft = input.draft.trim()
  const sections = [
    `Recent conversation:\n${conversation}`,
    `Project files:\n${files}`,
    ...document === undefined ? [] : [`Document "${document.name}":\n${document.text}`],
    draft === '' ? 'Draft: (empty: turn the document into the prompt)' : `Draft to improve:\n${draft}`,
    ...input.answers === undefined || input.answers.length === 0 ? [] : [
      'The user answered your questions (use the answers and do not ask them again):\n'
        + input.answers.map((item) => `- ${item.question} → ${item.answer}`).join('\n'),
    ],
  ]
  const source = draft !== '' ? draft : document?.text ?? ''
  if (looksSpanish(source)) sections.push('Write the prompt in Spanish.')
  return sections.join('\n\n')
}

/**
 * Pide el prompt mejorado.
 * @param model - modelo de Ollama (si es el del chat, conviene su variante de contexto para no recargarlo).
 * @param input - borrador, mensajes recientes, ficheros del proyecto, documento y respuestas.
 * @param signal - cancelación.
 * @returns el prompt, las preguntas que hagan falta y una nota si el documento se resumió.
 */
export async function localImprovePrompt(model: string, input: LocalImproveInput, signal: AbortSignal): Promise<LocalImproveResult> {
  const document = input.document === undefined ? undefined : await documentText(model, input.document, signal)
  const text = await chat(model, [
    { role: 'system', content: INSTRUCTIONS },
    ...EXAMPLES.flatMap((example) => [
      { role: 'user', content: userMessage(example.input) },
      { role: 'assistant', content: example.answer },
    ]),
    { role: 'user', content: userMessage(input, document === undefined || input.document === undefined
      ? undefined : { name: input.document.name, text: document.text }) },
  ], input.document === undefined ? 500 : 900, signal)
  const clean = text.replace(PREAMBLE, '').trim()
  const split = QUESTIONS.exec(clean)
  const prompt = (split === null ? clean : clean.slice(0, split.index)).trim()
    // Algunos modelos envuelven la respuesta en comillas aunque se les pida que no.
    .replace(/^["“«](.*)["”»]$/s, '$1').trim()
  const questions = split === null ? [] : clean.slice(split.index + split[0].length).split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter((line) => line !== '').slice(0, 2)
  return { text: prompt, questions, ...document?.note === undefined ? {} : { note: document.note } }
}
