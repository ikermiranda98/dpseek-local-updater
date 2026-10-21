/**
 * Mejorar un mensaje antes de enviarlo (añadido por dpseek-local-updater), lado del Host.
 *
 * Con el botón «Improve message» de la barra del cuadro de texto, el modelo del chat
 * (u otro, si se indica) convierte lo que has escrito, un documento o ambos en un
 * prompt claro para la IA: qué hacer, con qué ficheros o nombres y qué resultado se
 * espera, sin cambiar lo que pides, sin responderlo y en tu idioma. Para no inventar
 * nombres ve los últimos mensajes del chat y la lista de ficheros del proyecto; si
 * falta algo importante, pregunta en lugar de adivinar. Con un documento, el modelo
 * escribe lo que hay que hacer con él y el documento va debajo, palabra por palabra
 * (entero, o solo sus partes clave copiadas literalmente si se pide). Nada se envía solo.
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
  /** Otra versión: más corta, más detallada o en pasos (la sugerida si no se indica). */
  readonly style?: LocalImproveStyle
  /** Con el razonamiento del modelo (más lento, para casos difíciles). */
  readonly think?: boolean
  /** Qué hacer con el documento: implement, review, plan, explain u otra cosa con tus palabras. */
  readonly intent?: string
  /** Solo copiar las partes clave del documento, literalmente (sin escribir el prompt). */
  readonly keyParts?: boolean
  /** Corregir la sugerencia anterior con una frase («más corto», «no toques X»). */
  readonly refine?: LocalImproveRefine
  /** Traducir al inglés, corregir la gramática o pasar al idioma principal las frases en otro idioma. */
  readonly transform?: LocalImproveTransform
}

/** Un texto y qué hacer con él (sin reescribirlo como prompt). */
export interface LocalImproveTransform {
  readonly kind: 'english' | 'grammar' | 'unify'
  readonly text: string
}

/** La sugerencia anterior y lo que el usuario quiere cambiar de ella. */
export interface LocalImproveRefine {
  readonly previous: string
  readonly request: string
}

/** Versiones que se pueden pedir además de la sugerida. */
export type LocalImproveStyle = 'short' | 'detailed' | 'steps'

/** Cómo va una petición: la fase y lo que el modelo lleva escrito (o pensado). */
export type LocalImproveProgress = (phase: string, text: string) => void

/** Cómo va el documento debajo del prompt: sus títulos (en el idioma del prompt) y, si se pidieron, sus partes clave. */
export interface LocalImproveDocumentBlock {
  readonly heading: string
  readonly keyHeading: string
  readonly key?: string
}

/** El prompt sugerido, las preguntas (si falta algo), una nota y cómo va el documento. */
export interface LocalImproveResult {
  readonly text: string
  readonly questions: readonly string[]
  readonly note?: string
  readonly document?: LocalImproveDocumentBlock
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

/** Lo que lee el modelo para escribir el prompt: hasta aquí entero; de un documento mayor, el principio y sus títulos. */
const HEADER_CHARS = 40_000
const OUTLINE_CHARS = 4000
/** Las partes clave se eligen por trozos de este tamaño (el modelo solo contesta números: pueden ser grandes). */
const PART_CHARS = 24_000
/** Lo que cabe en el mensaje (el lector de documentos ya corta ahí). */
const DOCUMENT_CHARS = 240_000

/** Qué hacer con el documento, si el usuario elige uno de los botones de la tarjeta. */
const INTENTS: Readonly<Record<string, string>> = {
  implement: 'Implement in the project what the document describes.',
  review: 'Review the document itself before anything is built: find gaps, contradictions, ambiguities, risks and'
    + ' missing acceptance criteria, and propose fixes. Do not write code.',
  plan: 'Turn the document into an ordered plan of small tasks, each with how to check it is done. Do not implement'
    + ' anything yet.',
  explain: 'Explain the document in plain words: its purpose, its main parts and the decisions it asks for.',
}

const INSTRUCTIONS = [
  'You turn what the user wrote (a draft message, a document, or both) into a clear prompt for an AI coding assistant',
  'that works in the user\'s project.',
  'Rules:',
  '- Keep the user\'s intent and add no requirements of your own: no tests, refactors, files or details (numbers,',
  '  limits, names) the user did not ask for. When a document is given, keep to what it and the user ask for.',
  '  The examples only show the format: never take details from them.',
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

/**
 * Un borrador así ya es un prompt hecho (muchas líneas o mucho texto): se reorganiza y se
 * hace más robusto, nunca se resume.
 */
const LONG_CHARS = 1200
const LONG_LINES = 20

/** @returns si el borrador se trata como un prompt largo que hay que reorganizar. */
export function localIsLongPrompt(draft: string): boolean {
  const text = draft.trim()
  return text.length > LONG_CHARS || text.split('\n').filter(line => line.trim() !== '').length > LONG_LINES
}

const RESTRUCTURE_INSTRUCTIONS = [
  'You restructure a long prompt that a user wrote for an AI assistant, to make it clearer and more robust.',
  'It is a finished prompt, not a draft to shorten.',
  'Rules:',
  '- Keep ALL of its content: every role, rule, step, list item, number, threshold, example, quoted phrase, template,',
  '  table and column. Do not summarise, do not merge items away, do not drop anything. The result is at least as long',
  '  as the original.',
  '- Never replace content with a reference to another file or document, and do not mention any file that is not in',
  '  the text: the prompt must stay self-contained.',
  '- Improve the organisation: one section per topic in a logical order (role, goal, principles, process or phases,',
  '  output format, checklists), consistent numbering and headings, bullet lists for enumerations, tables kept as',
  '  Markdown tables.',
  '- Make it more robust: turn vague wording into precise, checkable instructions; make the order of the steps and',
  '  the condition to move to the next one explicit; where two parts repeat or contradict each other, keep the',
  '  meaning and resolve it explicitly; fix cross-references that point to the wrong section.',
  '- Keep the author\'s intent, tone and language. Add no requirements beyond making the existing ones explicit.',
  '- Do not answer or carry out the prompt.',
  '- Reply with only the restructured prompt in Markdown. After it, only if you resolved contradictions or fixed',
  '  references, a line "NOTES:" and up to 3 short lines saying what.',
].join('\n')

/** Primer paso con un prompt largo: una lista corta de problemas concretos que la reescritura corrige. */
const REVIEW_INSTRUCTIONS = [
  'You review a long prompt that a user wrote for an AI assistant before it is restructured. List the concrete',
  'problems to fix, each one actionable and quoting the exact words or section numbers involved:',
  '- cross-references that point to the wrong section (say which section is right);',
  '- parts that repeat or contradict each other (where, and how to resolve it);',
  '- vague instructions that should be precise or checkable (quote them and say what is missing);',
  '- steps whose order, or the condition to move to the next one, is unclear;',
  '- content that belongs in another section (what to move where), and missing pieces the prompt itself relies on',
  '  (for example, an output format it mentions but never defines).',
  'Write at most 12 bullet lines, in the language of the prompt. No praise, no rewrite, no preamble.',
  'If there is nothing to fix, reply "-".',
].join('\n')

/** Con un documento, el prompt va delante de él: no lo repite. */
const DOCUMENT_RULES = [
  'About the document: it is attached word for word right after your prompt, so the assistant will read all of it there.',
  'Your prompt goes before it and only frames the work: what to do with the document (the user\'s intent), which project',
  'files are involved, the user\'s own constraints and how to check that it is done. Refer to it as "the document below".',
  'Do not restate its requirements, values or steps (write, for example, "Requirements: those in the document below"),',
  'do not list the document itself as a project file, and do not add instructions about how you wrote the prompt.',
  'Name project files only when the document or the user names them or they clearly match what it describes;',
  'otherwise leave the files out.',
].join(' ')

/**
 * Partes clave de un documento largo: el modelo solo dice qué bloques (párrafos, listas, tablas)
 * sobran, por su número, y el resto se copia del original tal cual. Así no se puede cambiar ni una
 * palabra y es rápido (apenas escribe). Se le pregunta qué sobra, no qué se queda: ante la duda, se queda.
 */
const KEY_INSTRUCTIONS = [
  'You trim one part of a document that a user will give to an AI assistant, to save space. Each block starts with',
  'its number in brackets, like [12]. List only the blocks the assistant clearly does not need: cover and title-page',
  'text, table of contents, acknowledgements, background or narrative with no instruction or fact to act on,',
  'passages that repeat an earlier block, and legal boilerplate. Never list a block that states a goal, requirement,',
  'rule, criterion, constraint, value, threshold, name (files, functions, fields), command, interface, step or result,',
  'and never list a table. Headings are handled for you: do not list them. When unsure, do not list a block.',
  'Reply only with the numbers of the blocks to leave out, as ranges like "3, 7-9", or "-" if every block is needed.',
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
  return turns.slice(-RECENT_MESSAGES).map(turn => ({
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
  return /[áéíóúñ¿¡]/i.test(text)
    || (text.match(/\b(que|el|la|los|las|de|del|un|una|en|hasta|para|con|por|haz|crea|cree|archivo)\b/gi)?.length ?? 0) >= 2
}

/** Cabeceras que algunos modelos añaden aunque se les pida que no. */
const PREAMBLE = new RegExp('^(improved|rewritten|improve the|here is|aquí tienes|mensaje mejorado|versión mejorada|prompt mejorado|prompt)'
  + '[^\\n]*:\\s*\\n?', 'i')
const QUESTIONS = /^\s*\**\s*(QUESTIONS|PREGUNTAS)\s*\**\s*:\s*$/im
const NOTES = /^\s*\**\s*(NOTES|NOTAS)\s*\**\s*:\s*$/im

/**
 * Una petición a Ollama. Con `onText`, en streaming: avisa de lo que lleva escrito (o
 * pensado, con `think`) para que la tarjeta lo enseñe mientras llega.
 */
async function chat(model: string, messages: readonly { role: string; content: string }[], predict: number,
  signal: AbortSignal,
  options: { timeoutMs?: number; think?: boolean; onText?: (text: string, thinking: string) => void } = {},
): Promise<string> {
  const stream = options.onText !== undefined
  const response = await fetch(`${ollamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 180_000)]),
    body: JSON.stringify({
      model, stream, think: options.think === true,
      // El razonamiento también cuenta en num_predict: margen para él.
      options: { num_predict: predict + (options.think === true ? 6000 : 0), temperature: 0 },
      messages,
    }),
  })
  if (!response.ok) throw new Error(`Ollama answered ${String(response.status)}: ${(await response.text()).slice(0, 200)}`)
  if (!stream || response.body === null) {
    const body = await response.json() as { message?: { content?: unknown } }
    return typeof body.message?.content === 'string' ? body.message.content.trim() : ''
  }
  // NDJSON: una línea por trozo, con message.content y, si piensa, message.thinking.
  let text = ''
  let thinking = ''
  let pending = ''
  const decoder = new TextDecoder()
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() === '') continue
      const part = JSON.parse(line) as { message?: { content?: unknown; thinking?: unknown }; error?: unknown }
      if (typeof part.error === 'string') throw new Error(part.error)
      if (typeof part.message?.content === 'string') text += part.message.content
      if (typeof part.message?.thinking === 'string') thinking += part.message.thinking
    }
    options.onText?.(text, thinking)
  }
  return text.trim()
}

/** Peticiones en curso, por id: su cancelación y lo que llevan escrito (para la tarjeta). */
const jobs = new Map<string, { readonly controller: AbortController; phase: string; text: string }>()

/**
 * Ejecuta una petición con id: se puede seguir (localImproveJobProgress) y cancelar de
 * verdad (localImproveJobCancel), lo que corta también la generación en Ollama.
 * @param jobId - id que elige la tarjeta; sin él, sin seguimiento.
 * @param signal - cancelación de quien llama.
 * @param run - la petición, con su señal y su aviso de progreso.
 */
export async function localImproveJob<T>(jobId: string | undefined, signal: AbortSignal,
  run: (signal: AbortSignal, progress: LocalImproveProgress) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const job = { controller, phase: '', text: '' }
  if (jobId !== undefined) jobs.set(jobId, job)
  try {
    return await run(AbortSignal.any([signal, controller.signal]), (phase, text) => { job.phase = phase; job.text = text })
  } finally {
    // Un momento más, por si la tarjeta pregunta justo al terminar.
    if (jobId !== undefined) setTimeout(() => { if (jobs.get(jobId) === job) jobs.delete(jobId) }, 5000)
  }
}

/** @returns la fase y el texto que lleva la petición, o null si no existe (o ya acabó hace rato). */
export function localImproveJobProgress(jobId: string): { readonly phase: string; readonly text: string } | null {
  const job = jobs.get(jobId)
  return job === undefined ? null : { phase: job.phase, text: job.text }
}

/** @returns si había una petición con ese id y se ha cortado. */
export function localImproveJobCancel(jobId: string): boolean {
  const job = jobs.get(jobId)
  if (job === undefined) return false
  job.controller.abort(new Error('cancelled'))
  jobs.delete(jobId)
  return true
}

/** Lo que se avisa mientras el modelo escribe: «pensando» hasta que empieza el texto. */
const reporter = (progress: LocalImproveProgress | undefined, phase: string) =>
  (text: string, thinking: string): void => {
    if (progress === undefined) return
    if (text === '' && thinking !== '') progress('thinking', thinking)
    else progress(phase, text)
  }

/** Partes clave ya elegidas, por documento: cambiar de versión no las vuelve a pedir. */
const keyCache = new Map<string, { key: string; note: string }>()

const words = (text: string): number => text.split(/\s+/).filter(word => word !== '').length

/** Un bloque más largo que esto (una lista larga) se parte por sus elementos para poder quedarse con parte. */
const BLOCK_CHARS = 1200

/**
 * Los bloques del documento: lo que va entre líneas en blanco (un párrafo, una lista, una tabla),
 * cada título aparte y las listas largas por elementos (con sus subelementos).
 */
function blocks(text: string): string[] {
  const result: string[] = []
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
    let current: string[] = []
    const flush = (): void => {
      const value = current.join('\n').replace(/\s+$/, '')
      if (value.trim() !== '') result.push(value)
      current = []
    }
    const lines = block.split('\n')
    const long = block.length > BLOCK_CHARS && !lines.every(line => line.trimStart().startsWith('|'))
    for (const line of lines) {
      const heading = /^#{1,6} /.test(line)
      if (heading || (long && current.length > 0 && /^(?:[-*•+]|\d+[.)])\s/.test(line))) flush()
      current.push(line)
      if (heading) flush()
    }
    flush()
  }
  return result
}

/** Los bloques en grupos de como mucho `size` caracteres, sin partir ninguno. */
function groups(list: readonly string[], size: number): { first: number; blocks: string[] }[] {
  const result: { first: number; blocks: string[] }[] = []
  let current: { first: number; blocks: string[] } | null = null
  let length = 0
  for (const [index, block] of list.entries()) {
    if (current === null || (length + block.length > size && current.blocks.length > 0)) {
      current = { first: index, blocks: [] }
      result.push(current)
      length = 0
    }
    current.blocks.push(block)
    length += block.length + 8
  }
  return result
}

/** @returns los números de «1-4, 7, 9-12», o null si la respuesta no trae ninguno. */
function ranges(reply: string): Set<number> | null {
  const found = new Set<number>()
  for (const match of reply.matchAll(/(\d+)\s*(?:[-–—]|to|a)\s*(\d+)|(\d+)/g)) {
    const from = Number(match[1] ?? match[3])
    const to = Number(match[2] ?? match[3])
    for (let value = from; value <= Math.min(to, from + 5000); value++) found.add(value)
  }
  return found.size === 0 ? null : found
}

/**
 * Las partes clave de un documento: el modelo elige los bloques por su número y se copian del
 * original tal cual, en su orden, con el título de su sección y «[…]» donde se ha quitado algo.
 * @returns el texto y una nota con cuánto se ha quedado.
 */
async function keyParts(model: string, document: LocalImproveDocument, signal: AbortSignal,
  progress?: LocalImproveProgress): Promise<{ key: string; note: string }> {
  const hash = createHash('sha256').update(model).update('\0').update(document.text).digest('hex')
  const known = keyCache.get(hash)
  if (known !== undefined) return known
  const list = blocks(document.text.slice(0, DOCUMENT_CHARS))
  const chunks = groups(list, PART_CHARS)
  const keep = new Set<number>()
  let unsure = 0
  for (const [index, chunk] of chunks.entries()) {
    const numbered = chunk.blocks.map((block, offset) => `[${String(chunk.first + offset + 1)}] ${block}`).join('\n\n')
    const reply = await chat(model, [
      { role: 'system', content: KEY_INSTRUCTIONS },
      { role: 'user', content: `Part ${String(index + 1)} of ${String(chunks.length)} of "${document.name}" (blocks ${String(chunk.first + 1)}–${String(chunk.first + chunk.blocks.length)}):\n\n${numbered}` },
    ], 400, signal, {
      timeoutMs: 300_000,
      onText: reporter(progress, `choosing the key parts (part ${String(index + 1)} of ${String(chunks.length)})`),
    })
    const dropped = reply.trim() === '-' ? new Set<number>() : ranges(reply)
    // Sin una respuesta que se entienda, el trozo se queda entero: nunca se pierde nada por un fallo.
    if (dropped === null) unsure++
    for (let offset = 0; offset < chunk.blocks.length; offset++) {
      const number = chunk.first + offset + 1
      const block = chunk.blocks[offset] ?? ''
      // Los títulos, no: se quedan solo si queda algo de su sección (abajo).
      if (/^#{1,6} /.test(block)) continue
      // Las tablas, aunque el modelo las quite: son datos que el prompt no puede recuperar de otro sitio.
      if (dropped === null || !dropped.has(number) || block.trimStart().startsWith('|')) keep.add(number - 1)
    }
  }
  if (keep.size === 0) throw new Error('the model found no key parts in the document')
  // Cada bloque que se queda lleva los títulos de sus secciones (el suyo y los de encima).
  const open: (number | undefined)[] = []
  for (const [index, block] of list.entries()) {
    const level = /^(#{1,6}) /.exec(block)?.[1]?.length
    if (level !== undefined) {
      open.length = Math.min(open.length, level - 1)
      open[level - 1] = index
    } else if (keep.has(index)) {
      for (const heading of open) if (heading !== undefined) keep.add(heading)
    }
  }
  const out: string[] = []
  let previous = -1
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (index > previous + 1) out.push('[…]')
    out.push(list[index] ?? '')
    previous = index
  }
  if (previous < list.length - 1) out.push('[…]')
  const key = out.join('\n\n')
  const share = Math.round(words(key) / Math.max(1, words(document.text)) * 100)
  const result = {
    key,
    note: `Key parts: ${String(share)}% of the document, copied as they are (${String(keep.size)} of ${String(list.length)} blocks).`
      + (unsure > 0 ? ` ${String(unsure)} part${unsure === 1 ? '' : 's'} kept whole: the model's choice was unclear.` : ''),
  }
  keyCache.set(hash, result)
  if (keyCache.size > 5) keyCache.delete(keyCache.keys().next().value as string)
  return result
}

/** Lo que lee el modelo del documento para escribir el prompt: entero, o el principio y los títulos del resto. */
function documentForPrompt(document: LocalImproveDocument): string {
  if (document.text.length <= HEADER_CHARS) return document.text
  const at = document.text.lastIndexOf('\n', HEADER_CHARS)
  const cut = at > HEADER_CHARS / 2 ? at : HEADER_CHARS
  let outline = document.text.slice(cut).split('\n').filter(line => /^#{1,6} /.test(line)).join('\n')
  if (outline.length > OUTLINE_CHARS) outline = `${outline.slice(0, outline.lastIndexOf('\n', OUTLINE_CHARS))}\n…`
  return `${document.text.slice(0, cut)}\n\n[… the document goes on${outline === '' ? '' : `; headings of the rest:\n${outline}`}]`
}

/** Los títulos con los que va el documento debajo del prompt, en su idioma. */
function documentBlock(document: LocalImproveDocument, spanish: boolean): LocalImproveDocumentBlock {
  const count = document.pages === undefined ? '' : ` (${String(document.pages)} ${spanish ? 'páginas' : 'pages'})`
  return spanish
    ? { heading: `Documento: ${document.name}${count}`, keyHeading: `Documento: ${document.name}, partes clave copiadas literalmente` }
    : { heading: `Document: ${document.name}${count}`, keyHeading: `Document: ${document.name}, key passages copied word for word` }
}

/** Lo que pide cada versión además de las reglas de siempre. */
const STYLES: Readonly<Record<LocalImproveStyle, string>> = {
  short: 'Version requested: SHORT. As few words as possible while keeping every essential detail (names, values,'
    + ' expected result): one or two sentences, no sections.',
  detailed: 'Version requested: DETAILED. Use short sections (goal, files, requirements, constraints, done when) with'
    + ' their headings written in the language of the prompt, and spell out each requirement and how to check it.'
    + ' Leave out any section with nothing real to say: never fill one with generic rules or with requirements the'
    + ' user did not ask for.',
  steps: 'Version requested: STEP BY STEP. Write it as numbered steps the assistant should follow in order, then a'
    + ' last line saying how to check that it is done.',
}

/** El mensaje para el modelo con todo lo que tiene que ver. */
function userMessage(input: LocalImproveInput): string {
  const conversation = input.recent.length === 0 ? '(no earlier messages)'
    : input.recent.map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`).join('\n\n')
  const files = input.files.length === 0 ? '(none listed)' : input.files.join('\n')
  const draft = input.draft.trim()
  const document = input.document
  const intent = input.intent === undefined || input.intent.trim() === '' ? undefined
    : INTENTS[input.intent] ?? `In the user's words: "${input.intent.trim()}"`
  const spanish = isSpanish(input)
  const sections = [
    `Recent conversation:\n${conversation}`,
    `Project files:\n${files}`,
    ...document === undefined ? [] : [
      `Document "${document.name}" (attached after your prompt under the heading "${documentBlock(document, spanish).heading}"):\n`
        + documentForPrompt(document),
      DOCUMENT_RULES,
    ],
    ...intent === undefined ? [] : [`What the user wants to do with the document: ${intent}`],
    draft !== '' ? `Draft to improve:\n${draft}`
      : document === undefined ? 'Draft: (empty)' : 'Draft: (empty: write the prompt from the user\'s intent and the document)',
    ...input.answers === undefined || input.answers.length === 0 ? [] : [
      'The user answered your questions (use the answers and do not ask them again):\n'
        + input.answers.map(item => `- ${item.question} → ${item.answer}`).join('\n'),
    ],
    ...input.style === undefined ? [] : [STYLES[input.style]],
  ]
  if (spanish) sections.push('Write the prompt in Spanish.')
  return sections.join('\n\n')
}

/** El idioma del prompt: el del borrador, el de lo que pidió con sus palabras o el del documento. */
function isSpanish(input: LocalImproveInput): boolean {
  const own = input.intent !== undefined && INTENTS[input.intent] === undefined ? input.intent.trim() : ''
  const source = input.draft.trim() || own || input.document?.text.slice(0, 20_000) || ''
  return looksSpanish(source)
}

/**
 * Pide el prompt mejorado.
 * @param model - modelo de Ollama (si es el del chat, conviene su variante de contexto para no recargarlo).
 * @param input - borrador, mensajes recientes, ficheros del proyecto, documento, qué hacer con él, respuestas,
 *   versión y razonamiento.
 * @param signal - cancelación.
 * @param progress - avisa de la fase y de lo que lleva escrito (la tarjeta lo enseña mientras llega).
 * @returns el prompt, las preguntas que hagan falta y, con un documento, cómo va debajo del prompt.
 */
export async function localImprovePrompt(model: string, input: LocalImproveInput, signal: AbortSignal,
  progress?: LocalImproveProgress): Promise<LocalImproveResult> {
  const document = input.document
  if (input.transform !== undefined) return transform(model, input.transform, signal, progress)
  if (input.refine !== undefined) return refine(model, input, input.refine, signal, progress)
  if (document === undefined && localIsLongPrompt(input.draft)) return restructure(model, input, signal, progress)
  const block = document === undefined ? undefined : documentBlock(document, isSpanish(input))
  if (input.keyParts === true && document !== undefined && block !== undefined) {
    const { key, note } = await keyParts(model, document, signal, progress)
    return { text: '', questions: [], note, document: { ...block, key } }
  }
  const text = await chat(model, [
    { role: 'system', content: INSTRUCTIONS },
    // Con razonamiento, sin los ejemplos: respuestas resueltas sin pensar le enseñan a no pensar.
    ...input.think === true ? [] : EXAMPLES.flatMap(example => [
      { role: 'user', content: userMessage(example.input) },
      { role: 'assistant', content: example.answer },
    ]),
    { role: 'user', content: userMessage(input) },
  ], input.style === 'detailed' || (document !== undefined && input.style !== 'short') ? 900 : 500, signal, {
    think: input.think === true, onText: reporter(progress, 'writing'),
    // Leer un documento largo antes de escribir lleva su tiempo.
    ...document === undefined ? {} : { timeoutMs: 300_000 },
  })
  const answer = splitAnswer(text)
  return { text: answer.body, questions: answer.questions, ...block === undefined ? {} : { document: block } }
}

/** Lo que escribe el modelo, sin cabeceras ni comillas, separado de sus preguntas y notas. */
function splitAnswer(text: string): { body: string; questions: string[]; notes: string[] } {
  const clean = text.replace(PREAMBLE, '').trim()
  const marks = [QUESTIONS.exec(clean), NOTES.exec(clean)]
    .filter((mark): mark is RegExpExecArray => mark !== null).sort((a, b) => a.index - b.index)
  const first = marks[0]
  // Algunos modelos envuelven la respuesta en comillas aunque se les pida que no.
  const body = (first === undefined ? clean : clean.slice(0, first.index)).trim().replace(/^["“«](.*)["”»]$/s, '$1').trim()
  const lines = (mark: RegExpExecArray | null): string[] => {
    if (mark === null) return []
    const next = marks.find(other => other.index > mark.index)
    return clean.slice(mark.index + mark[0].length, next?.index).split('\n')
      .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(line => line !== '')
  }
  return { body, questions: lines(QUESTIONS.exec(clean)).slice(0, 2), notes: lines(NOTES.exec(clean)).slice(0, 3) }
}

/** Instrucciones de cada transformación: siempre fieles, sin mejorar ni resumir nada. */
const TRANSFORM_INSTRUCTIONS: Readonly<Record<LocalImproveTransform['kind'], string>> = {
  english: [
    'Translate the text into English as faithfully as possible: same meaning, tone, structure and formatting (headings,',
    'lists, tables, line breaks). Keep code, file names, paths, identifiers, numbers, units and quoted strings exactly as',
    'they are. Do not add, drop, summarise, reorder or improve anything. Reply with only the translation.',
  ].join(' '),
  grammar: [
    'Fix the spelling, grammar and punctuation of the text without changing its meaning, structure, formatting, wording',
    'choices or tone, and without adding or removing formatting (backticks, bold, quotes). Detect the language of each',
    'sentence and fix it in that language. Technical terms and English words',
    'commonly used inside Spanish technical writing (merge, commit, backtest, prompt, script, deploy…), names, code, paths',
    'and identifiers are not mistakes: leave them. If some whole sentences are written in a different language from the',
    'rest of the text, keep them in their language and, after the text, add a line "NOTES:" and one line',
    '"- <number> sentences in <language>". Reply with only the corrected text (and that NOTES block when needed).',
  ].join(' '),
  unify: [
    'Find the main language of the text. Translate into it, faithfully, only the sentences written in another language;',
    'leave everything else exactly as it is, including technical terms, names, code, paths and identifiers. Reply with',
    'only the resulting text.',
  ].join(' '),
}

/** Para un texto largo, trozos de este tamaño (la salida de una petición tiene un tope). */
const TRANSFORM_PART_CHARS = 12_000

/**
 * Traduce, corrige o unifica el idioma de un texto, por trozos si es largo (es un cambio local:
 * cada trozo se puede hacer aparte sin perder nada).
 */
async function transform(model: string, job: LocalImproveTransform, signal: AbortSignal,
  progress?: LocalImproveProgress): Promise<LocalImproveResult> {
  const chunks = job.text.length <= TRANSFORM_PART_CHARS ? [job.text] : groups(blocks(job.text), TRANSFORM_PART_CHARS).map(group => group.blocks.join('\n\n'))
  const out: string[] = []
  const notes: string[] = []
  const phase = job.kind === 'english' ? 'translating' : job.kind === 'grammar' ? 'fixing the grammar' : 'translating the other sentences'
  for (const [index, chunk] of chunks.entries()) {
    const predict = Math.min(16_000, Math.ceil(chunk.length / 2.5) + 300)
    const done = out.join('\n\n')
    const answer = splitAnswer(await chat(model, [
      { role: 'system', content: TRANSFORM_INSTRUCTIONS[job.kind] },
      { role: 'user', content: `Text:\n\n${chunk}` },
    ], predict, signal, {
      timeoutMs: Math.max(180_000, predict * 60),
      onText: (text, thinking) => {
        if (progress === undefined) return
        const label = chunks.length === 1 ? phase : `${phase} (part ${String(index + 1)} of ${String(chunks.length)})`
        progress(text === '' && thinking !== '' ? 'thinking' : label, done === '' ? text : `${done}\n\n${text}`)
      },
    }))
    out.push(answer.body)
    notes.push(...answer.notes)
  }
  // Varios trozos pueden decir lo mismo: «2 sentences in English» + «1 sentences in English» → 3.
  const counted = new Map<string, number>()
  for (const note of notes) {
    const match = /(\d+)\s+sentences?\s+in\s+([\p{L} ]+)/iu.exec(note)
    if (match !== null) counted.set(match[2]?.trim() ?? '', (counted.get(match[2]?.trim() ?? '') ?? 0) + Number(match[1]))
  }
  const note = [...counted].map(([language, count]) => `${String(count)} sentence${count === 1 ? '' : 's'} in ${language}`).join(', ')
  return { text: out.join('\n\n'), questions: [], ...note === '' ? {} : { note: `Mixed languages: ${note}.` } }
}

/**
 * Corrige la sugerencia anterior con lo que pide el usuario y deja el resto igual. Si es un
 * prompt largo, con las reglas de reorganizar (sin perder nada).
 */
async function refine(model: string, input: LocalImproveInput, change: LocalImproveRefine, signal: AbortSignal,
  progress?: LocalImproveProgress): Promise<LocalImproveResult> {
  const long = input.document === undefined && localIsLongPrompt(change.previous)
  const predict = long ? Math.min(16_000, Math.ceil(change.previous.length / 2.5) + 800) : 900
  const context = long ? `Original prompt:\n\n${input.draft.trim()}` : userMessage({ ...input, think: false })
  const text = await chat(model, [
    { role: 'system', content: long ? RESTRUCTURE_INSTRUCTIONS : INSTRUCTIONS },
    {
      role: 'user',
      content: `${context}\n\nYour previous version:\n\n${change.previous}\n\nThe user wants this changed: ${change.request}\n\n`
        + 'Rewrite your previous version applying only that change; keep everything else exactly as it is. Reply with the'
        + ' whole new version only.' + (looksSpanish(change.previous) ? ' Write it in Spanish.' : ''),
    },
  ], predict, signal, {
    think: input.think === true, onText: reporter(progress, 'writing'),
    timeoutMs: Math.max(180_000, predict * 60),
  })
  const answer = splitAnswer(text)
  const block = input.document === undefined ? undefined : documentBlock(input.document, isSpanish(input))
  return { text: answer.body, questions: answer.questions, ...block === undefined ? {} : { document: block } }
}

/** Lo que el modelo reescribe entero sin recortar: medido con un prompt de 68.000 caracteres, hacia los 23.000 deja de escribir. */
const RESTRUCTURE_PART_CHARS = 12_000

/**
 * Un prompt largo: se reorganiza entero, nunca se resume. Primero se revisa entero (referencias,
 * contradicciones, vaguedades); después se reescribe aplicando esas correcciones, de una vez o, si
 * es muy largo, por partes que se juntan en orden. Si una parte sale mucho más corta que la
 * original, se pide otra vez; si sigue corta, se avisa en la nota.
 */
async function restructure(model: string, input: LocalImproveInput, signal: AbortSignal,
  progress?: LocalImproveProgress): Promise<LocalImproveResult> {
  const draft = input.draft.trim()
  const spanish = looksSpanish(draft)
  // Primero, qué hay que corregir (rápido: poca salida); después, la reescritura entera aplicándolo.
  const review = (await chat(model, [
    { role: 'system', content: REVIEW_INSTRUCTIONS },
    { role: 'user', content: `Prompt to review:\n\n${draft}${spanish ? '\n\nWrite the list in Spanish.' : ''}` },
  ], 900, signal, { think: input.think === true, onText: reporter(progress, 'reviewing'), timeoutMs: 600_000 })).trim()
  const fixes = review === '-' ? [] : review.split('\n').map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(line => line !== '')
  const pieces = draft.length <= RESTRUCTURE_PART_CHARS * 1.5 ? [draft]
    : groups(blocks(draft), RESTRUCTURE_PART_CHARS).map(group => group.blocks.join('\n\n'))
  const out: string[] = []
  const questions: string[] = []
  const notes: string[] = []
  for (const [index, piece] of pieces.entries()) {
    const total = pieces.length
    const label = total === 1 ? '' : ` (part ${String(index + 1)} of ${String(total)})`
    // Unos 3,5 caracteres por token en español: margen de sobra para no cortar la respuesta.
    const predict = Math.min(16_000, Math.ceil(piece.length / 2.5) + 800)
    const timeoutMs = Math.max(180_000, predict * 60) * (input.think === true ? 2 : 1)
    const done = out.join('\n\n')
    const live = (phase: string) => (text: string, thinking: string): void => {
      if (progress === undefined) return
      if (text === '' && thinking !== '') progress('thinking', thinking)
      else progress(phase, done === '' ? text : `${done}\n\n${text}`)
    }
    const context = total === 1
      ? `Prompt to restructure (${String(piece.length)} characters):\n\n${piece}`
      : `This is part ${String(index + 1)} of ${String(total)} of a longer prompt; the other parts are restructured separately `
        + 'and joined in order. Restructure only this part and keep all of it, with its section numbers and headings consistent '
        + 'with the rest of the prompt; do not add an introduction, a conclusion or a summary of the other parts.'
        + `\n\nPart ${String(index + 1)} of ${String(total)} (${String(piece.length)} characters):\n\n${piece}`
    const messages: { role: string; content: string }[] = [
      { role: 'system', content: RESTRUCTURE_INSTRUCTIONS },
      {
        role: 'user',
        content: context
          + (fixes.length === 0 ? '' : `\n\nApply these fixes while restructuring${total === 1 ? '' : ' (only those that concern this part)'}:\n${fixes.map(fix => `- ${fix}`).join('\n')}`)
          + (spanish ? '\n\nWrite it in Spanish, like the original.' : ''),
      },
    ]
    let answer = splitAnswer(await chat(model, messages, predict, signal, { timeoutMs, onText: live(`rewriting${label}`) }))
    if (answer.body.length < piece.length * 0.8) {
      messages.push({ role: 'assistant', content: answer.body }, {
        role: 'user',
        content: `Your version has ${String(answer.body.length)} characters and the original ${String(piece.length)}: you dropped content. `
          + 'Restructure it again keeping every rule, list item, number, template and table of the original.',
      })
      const retry = splitAnswer(await chat(model, messages, predict, signal, { timeoutMs, onText: live(`rewriting again${label} (it came out short)`) }))
      if (retry.body.length > answer.body.length) answer = retry
    }
    out.push(answer.body)
    questions.push(...answer.questions)
    notes.push(...answer.notes)
  }
  const text = out.join('\n\n')
  const ratio = text.length / draft.length
  const short = ratio < 0.8
    ? [`Shorter than your prompt (${String(Math.round(ratio * 100))}% of its length): check nothing important is missing.`] : []
  const parted = pieces.length > 1 ? [`Reorganized in ${String(pieces.length)} parts.`] : []
  // En la tarjeta: si ha quedado corto y qué se ha corregido (la revisión, o las notas del modelo), en corto.
  const brief = (line: string): string => (line.length > 120 ? `${line.slice(0, 117)}…` : line)
  const changed = fixes.length > 0
    ? [`Fixed ${String(fixes.length)} issue${fixes.length === 1 ? '' : 's'}: ${fixes.slice(0, 3).map(brief).join(' · ')}${fixes.length > 3 ? ' …' : ''}`]
    : notes.slice(0, 3).map(brief)
  const note = [...short, ...parted, ...changed].join(' ')
  return { text, questions: questions.slice(0, 2), ...note === '' ? {} : { note } }
}
