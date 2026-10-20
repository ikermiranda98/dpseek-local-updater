/**
 * Navegador del agente: menos pasos y menos contexto (añadido por dpseek-local-updater).
 *
 * Playwright MCP, tras cada acción (abrir, pulsar, elegir…), no devuelve la página sino un enlace a un fichero
 * `.yml`: el modelo tenía que gastar otra llamada en browser_snapshot o actuaba con referencias viejas. Aquí:
 * - cada resultado lleva la página en línea (el contenido de ese fichero), sin el eco del código ni los avisos
 *   de consola;
 * - antes de cada petición al modelo, en el historial solo queda entera la última página; las anteriores se
 *   quedan en su dirección y título (el original sigue en el registro de la sesión);
 * - unas instrucciones cortas de uso del navegador en el prompt del sistema.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** Páginas más grandes que esto se quedan en enlace (el modelo puede buscar en ellas con browser_find). */
const MAX_INLINE_CHARS = 60_000
/** Una página sustituida se queda en esto. */
const PRUNED_NOTE = '(Older page snapshot removed to save context; the latest one is further down. Call browser_snapshot to read the page again.)'

const TIPS = [
  '# Browser',
  '- Each browser action result already includes the page snapshot after the action: do not call browser_snapshot right after an action.',
  '- Only the latest snapshot is kept in full; use element refs from it, never from older ones.',
  '- To act on an element, pass only its ref as target: for `link "Login" [ref=e11]` use target "e11" (not "ref=e11").',
  '- Always finish with a written answer for the user, even after an error.',
  '- Fill a whole form with one browser_fill_form call, then press the submit button.',
  '- In long pages, use browser_find to locate text instead of reading the whole snapshot again.',
  '- Do not take screenshots unless the user asks for one; you read pages through snapshots.',
  '- Before submitting a form that creates, changes or deletes data on a real (non-local) website, confirm with the user unless they explicitly asked for exactly that.',
  '- Never ask for passwords, 2FA codes or captcha answers in the chat. When a site needs one, tell the user to do it in the Browser panel (clicking the page gives them control, and "Resume agent" or their next message gives it back; passwords can also be saved under the key icon for next time). Your browser actions wait while the user is in control.',
  '- Keep text between tool calls to one short line at most (no narration of what you see or plan). Every step must end with either a tool call or your final answer; after an error, try another way or tell the user.',
  '- When done, answer with the result in 1-3 short sentences (what you did and anything the user must know). Give details or step lists only if the user asks.',
].join('\n')

/** El usuario tiene el control del navegador desde el panel (lo pone el Host, local-agent-browser.ts). */
const userControl = (): boolean =>
  ((globalThis as Record<symbol, unknown>)[Symbol.for('dpseek-local-updater.agent-browser-control')] as { active?: boolean } | undefined)?.active === true

/** Espera a que el usuario devuelva el control; se corta si se cancela la llamada. */
async function waitForUserControl(signal: AbortSignal): Promise<void> {
  while (userControl()) {
    signal.throwIfAborted()
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

interface TextBlock { readonly type: 'text'; readonly text: string }
interface Block { readonly type: string; readonly text?: string }
interface ExecResult { readonly isError: boolean; readonly content: Block[] }
type PostDecision =
  | { readonly kind: 'accept'; readonly content?: Block[]; readonly value?: unknown; readonly additionalContexts?: unknown[] }
  | { readonly kind: 'block'; readonly feedback: Block[]; readonly additionalContexts?: unknown[] }
interface Exec { readonly name: string; readonly agent?: unknown; signal: AbortSignal }
interface WorkingDirectory { ensure(agent: unknown, signal: AbortSignal): Promise<string> }
interface SessionEvent { readonly type: string; readonly data: { readonly message: { readonly content: readonly Block[] } } }
interface Session {
  readonly surface: { readonly nodes: Iterable<number> }
  eventAt(seq: number): SessionEvent | undefined
  deriveEventMessage(event: SessionEvent): { readonly content: readonly Block[] }
  append(type: string, data: unknown, options?: unknown): { readonly seq: number }
}
interface Assembly { readonly sections: readonly { readonly name: string }[] }
interface Tools { schemas(agent: unknown): readonly { readonly name: string }[] }
interface LooseContext {
  on(name: 'tools/execute', listener: (exec: Exec, next: () => Promise<ExecResult>) => Promise<ExecResult>): void
  on(name: 'tools/post-execute', listener: (exec: Exec, result: ExecResult, next: () => Promise<PostDecision>) => Promise<PostDecision>): void
  on(name: 'agent/pre-step', listener: (args: { agent: { session: Session }; signal: AbortSignal }, next: () => Promise<unknown>) => Promise<unknown>): void
  on(name: 'system-prompt/assemble', listener: (assembly: Assembly, info: { agent?: unknown }, next: () => Promise<Assembly>) => Promise<Assembly>): void
  get(name: string): unknown
}

const textOf = (blocks: readonly Block[]): string => blocks.map(block => block.type === 'text' ? block.text ?? '' : '').join('')

/** Sin el eco del código de Playwright ni la sección de eventos de consola. */
export function tidyBrowserText(text: string): string {
  return text
    .replace(/### Ran Playwright code\n```js\n[\s\S]*?\n```\n?/g, '')
    .replace(/### Events\n(?:- .*\n?)*/g, '')
    .trimEnd()
}

/** Una página completa en línea (no un enlace). */
const hasFullSnapshot = (text: string): boolean => /### Snapshot\n```yaml\n/.test(text)

/** La misma página reducida a su dirección y título. */
export function pruneSnapshotText(text: string): string {
  const at = text.indexOf('### Snapshot\n```yaml\n')
  return `${text.slice(0, at)}### Snapshot\n${PRUNED_NOTE}`
}

/**
 * Engancha las tres mejoras al proveedor del navegador.
 * @param ctx - contexto del proveedor.
 * @param toolPrefix - prefijo de las herramientas del servidor («mcp__playwright-mcp__»).
 */
export function setupLocalBrowserContext(ctx: Context, toolPrefix: string): void {
  const loose = ctx as unknown as LooseContext
  const workingDirectory = loose.get('workingDirectory') as WorkingDirectory | undefined

  // Con el usuario a los mandos, el agente no toca la página.
  loose.on('tools/execute', async (exec, next) => {
    if (exec.name.startsWith(toolPrefix)) await waitForUserControl(exec.signal)
    return next()
  })

  // El contenido que ve el modelo se cambia aquí (en tools/execute el registro lo vuelve a generar desde el valor).
  loose.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!exec.name.startsWith(toolPrefix) || result.isError || decision.kind !== 'accept' || decision.value !== undefined) return decision
    const content: Block[] = []
    for (const block of decision.content ?? result.content) {
      if (block.type !== 'text' || block.text === undefined) {
        content.push(block)
        continue
      }
      let text = tidyBrowserText(block.text)
      const link = /### Snapshot\n- \[Snapshot\]\(([^)\n]+)\)/.exec(text)
      if (link !== null && workingDirectory !== undefined && exec.agent !== undefined) {
        try {
          const path = link[1] ?? ''
          const file = isAbsolute(path) ? path : join(await workingDirectory.ensure(exec.agent, exec.signal), path)
          const yaml = (await readFile(file, 'utf8')).trimEnd()
          if (yaml.length <= MAX_INLINE_CHARS) text = text.replace(link[0], `### Snapshot\n\`\`\`yaml\n${yaml}\n\`\`\``)
        } catch {
          // Sin el fichero, se queda el enlace.
        }
      }
      // Acciones como browser_type solo devuelven el eco del código: sin él no queda nada, y un resultado vacío hacía que
      // el modelo se parase.
      content.push({ type: 'text', text: text.trim() === '' ? 'Done.' : text } satisfies TextBlock)
    }
    return { ...decision, content }
  })

  loose.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (!signal.aborted) {
      try {
        pruneOlderSnapshots(agent.session, loose.get('tokenMeter') as { estimateMessage(message: unknown): number } | undefined)
      } catch (error) {
        console.warn('local browser context: no se pudieron recortar las páginas antiguas', error)
      }
    }
    return next()
  })

  // Solo para los chats que tienen las herramientas del navegador.
  loose.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    const tools = loose.get('tools') as Tools | undefined
    if (agent === undefined || tools?.schemas(agent).some(tool => tool.name.startsWith(toolPrefix)) !== true) return assembly
    return { ...assembly, sections: [...assembly.sections, { name: 'local:browser-tips', text: TIPS + savedPasswordsTip(), interpolate: false }] }
  })
}

/** Deja entera solo la última página del historial visible; las anteriores, en su dirección y título. */
function pruneOlderSnapshots(session: Session, tokenMeter: { estimateMessage(message: unknown): number } | undefined): void {
  const pages: { seq: number; event: SessionEvent }[] = []
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (event?.type === 'tool/result' && hasFullSnapshot(textOf(event.data.message.content))) pages.push({ seq, event })
  }
  for (const { seq, event } of pages.slice(0, -1)) {
    const original = session.deriveEventMessage(event)
    const content = original.content.map(block => block.type === 'text' && block.text !== undefined && hasFullSnapshot(block.text)
      ? { ...block, text: pruneSnapshotText(block.text) }
      : block)
    const message = deepFreeze(structuredClone({ ...original, content }))
    // Mismo protocolo que el podador oficial: el aviso de recorte y su sustituto, juntos y en este orden.
    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq],
      shadowedTokenCount: tokenMeter?.estimateMessage(original) ?? 0,
    })
    session.append('tool/result', { ...event.data, message }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
  }
}

/** Como el freezeMessage oficial: los mensajes del registro son inmutables. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Las contraseñas guardadas por el usuario («Saved passwords»), solo por su nombre y su web: el modelo escribe el
 * nombre y el navegador pone el valor (que el modelo nunca ve; en las respuestas sale como <secret>NOMBRE</secret>).
 */
function savedPasswordsTip(): string {
  try {
    const file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'local-secrets.json')
    const list = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!Array.isArray(list) || list.length === 0) return ''
    const rows = list
      .filter((item): item is { name: string; site?: string } => typeof (item as { name?: unknown } | null)?.name === 'string')
      .map(item => `  - ${item.name}${item.site === undefined || item.site === '' ? '' : ` (${item.site})`}`)
    return [
      '',
      '- Saved passwords: to enter one, type its NAME exactly as the value (browser_type or browser_fill_form); the browser',
      '  fills in the real value, which you never see (results show <secret>NAME</secret>). Use them only on their site.',
      ...rows,
    ].join('\n')
  } catch {
    return ''
  }
}
