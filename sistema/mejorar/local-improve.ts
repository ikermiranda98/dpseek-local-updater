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
  /** Otra versión: más corta, más detallada o en pasos (la sugerida si no se indica). */
  readonly style?: LocalImproveStyle
  /** Con el razonamiento del modelo (más lento, para casos difíciles). */
  readonly think?: boolean
}

/** Versiones que se pueden pedir además de la sugerida. */
export type LocalImproveStyle = 'short' | 'detailed' | 'steps'

/** Cómo va una petición: la fase y lo que el modelo lleva escrito (o pensado). */
export type LocalImproveProgress = (phase: string, text: string) => void

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

/**
 * Un borrador así ya es un prompt hecho (muchas líneas o mucho texto): se reorganiza y se
 * hace más robusto, nunca se resume.
 */
const LONG_CHARS = 1200
const LONG_LINES = 20

/** @returns si el borrador se trata como un prompt largo que hay que reorganizar. */
export function localIsLongPrompt(draft: string): boolean {
  const text = draft.trim()
  return text.length > LONG_CHARS || text.split('\n').filter((line) => line.trim() !== '').length > LONG_LINES
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
const NOTES = /^\s*\**\s*(NOTES|NOTAS)\s*\**\s*:\s*$/im

/**
 * Una petición a Ollama. Con `onText`, en streaming: avisa de lo que lleva escrito (o
 * pensado, con `think`) para que la tarjeta lo enseñe mientras llega.
 */
async function chat(model: string, messages: readonly { role: string; content: string }[], predict: number,
  signal: AbortSignal, options: { timeoutMs?: number; think?: boolean; onText?: (text: string, thinking: string) => void } = {}): Promise<string> {
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
async function documentText(model: string, document: LocalImproveDocument, signal: AbortSignal,
  progress?: LocalImproveProgress): Promise<{ text: string; note?: string }> {
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
    ], 600, signal, { onText: reporter(progress, `reading part ${String(index + 1)} of ${String(pieces.length)}`) })
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
    ...input.style === undefined ? [] : [STYLES[input.style]],
  ]
  const source = draft !== '' ? draft : document?.text ?? ''
  if (looksSpanish(source)) sections.push('Write the prompt in Spanish.')
  return sections.join('\n\n')
}

/**
 * Pide el prompt mejorado.
 * @param model - modelo de Ollama (si es el del chat, conviene su variante de contexto para no recargarlo).
 * @param input - borrador, mensajes recientes, ficheros del proyecto, documento, respuestas, versión y razonamiento.
 * @param signal - cancelación.
 * @param progress - avisa de la fase y de lo que lleva escrito (la tarjeta lo enseña mientras llega).
 * @returns el prompt, las preguntas que hagan falta y una nota si el documento se resumió.
 */
export async function localImprovePrompt(model: string, input: LocalImproveInput, signal: AbortSignal,
  progress?: LocalImproveProgress): Promise<LocalImproveResult> {
  if (input.document === undefined && localIsLongPrompt(input.draft)) return restructure(model, input, signal, progress)
  const document = input.document === undefined ? undefined : await documentText(model, input.document, signal, progress)
  const text = await chat(model, [
    { role: 'system', content: INSTRUCTIONS },
    // Con razonamiento, sin los ejemplos: respuestas resueltas sin pensar le enseñan a no pensar.
    ...input.think === true ? [] : EXAMPLES.flatMap((example) => [
      { role: 'user', content: userMessage(example.input) },
      { role: 'assistant', content: example.answer },
    ]),
    { role: 'user', content: userMessage(input, document === undefined || input.document === undefined
      ? undefined : { name: input.document.name, text: document.text }) },
  ], input.document === undefined && input.style !== 'detailed' ? 500 : 900, signal,
  { think: input.think === true, onText: reporter(progress, 'writing') })
  const answer = splitAnswer(text)
  return { text: answer.body, questions: answer.questions, ...document?.note === undefined ? {} : { note: document.note } }
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
    const next = marks.find((other) => other.index > mark.index)
    return clean.slice(mark.index + mark[0].length, next?.index).split('\n')
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter((line) => line !== '')
  }
  return { body, questions: lines(QUESTIONS.exec(clean)).slice(0, 2), notes: lines(NOTES.exec(clean)).slice(0, 3) }
}

/**
 * Un prompt largo: se reorganiza entero, nunca se resume. Si el modelo devuelve mucho menos
 * texto que el original, se le pide otra vez; si sigue corto, se avisa en la nota.
 */
async function restructure(model: string, input: LocalImproveInput, signal: AbortSignal,
  progress?: LocalImproveProgress): Promise<LocalImproveResult> {
  const draft = input.draft.trim()
  // Unos 3,5 caracteres por token en español: margen de sobra para no cortar la respuesta.
  const predict = Math.min(16_000, Math.ceil(draft.length / 2.5) + 800)
  const timeoutMs = Math.max(180_000, predict * 60) * (input.think === true ? 2 : 1)
  const language = looksSpanish(draft) ? '\n\nWrite it in Spanish, like the original.' : ''
  // Primero, qué hay que corregir (rápido: poca salida); después, la reescritura entera aplicándolo.
  const review = (await chat(model, [
    { role: 'system', content: REVIEW_INSTRUCTIONS },
    { role: 'user', content: `Prompt to review:\n\n${draft}${looksSpanish(draft) ? '\n\nWrite the list in Spanish.' : ''}` },
  ], 900, signal, { think: input.think === true, onText: reporter(progress, 'reviewing') })).trim()
  const fixes = review === '-' ? [] : review.split('\n').map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((line) => line !== '')
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: RESTRUCTURE_INSTRUCTIONS },
    {
      role: 'user',
      content: `Prompt to restructure (${String(draft.length)} characters):\n\n${draft}`
        + (fixes.length === 0 ? '' : `\n\nApply these fixes while restructuring:\n${fixes.map((fix) => `- ${fix}`).join('\n')}`)
        + language,
    },
  ]
  let answer = splitAnswer(await chat(model, messages, predict, signal, { timeoutMs, onText: reporter(progress, 'rewriting') }))
  if (answer.body.length < draft.length * 0.8) {
    messages.push({ role: 'assistant', content: answer.body }, {
      role: 'user',
      content: `Your version has ${String(answer.body.length)} characters and the original ${String(draft.length)}: you dropped content. `
        + 'Restructure it again keeping every rule, list item, number, template and table of the original.',
    })
    const retry = splitAnswer(await chat(model, messages, predict, signal, { timeoutMs, onText: reporter(progress, 'rewriting again (it came out short)') }))
    if (retry.body.length > answer.body.length) answer = retry
  }
  const ratio = answer.body.length / draft.length
  const short = ratio < 0.8
    ? [`Shorter than your prompt (${String(Math.round(ratio * 100))}% of its length): check nothing important is missing.`] : []
  // En la tarjeta: si ha quedado corto y qué se ha corregido (la revisión, o las notas del modelo).
  const changed = fixes.length > 0
    ? [`Fixed ${String(fixes.length)} issue${fixes.length === 1 ? '' : 's'}: ${fixes.slice(0, 3).join(' · ')}${fixes.length > 3 ? ' …' : ''}`]
    : answer.notes
  const note = [...short, ...changed].join(' ')
  return { text: answer.body, questions: answer.questions, ...note === '' ? {} : { note } }
}
