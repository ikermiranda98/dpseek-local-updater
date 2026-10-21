/**
 * Navegador del agente: menos pasos y menos contexto (añadido por dpseek-local-updater).
 *
 * Playwright MCP, tras cada acción (abrir, pulsar, elegir…), no devuelve la página sino un enlace a un fichero
 * `.yml`: el modelo tenía que gastar otra llamada en browser_snapshot o actuaba con referencias viejas. Aquí:
 * - cada resultado lleva la página en línea (el contenido de ese fichero), sin el eco del código ni los avisos
 *   de consola;
 * - antes de cada petición al modelo, en el historial solo queda entera la última página; las anteriores se
 *   quedan en su dirección y título (el original sigue en el registro de la sesión);
 * - unas instrucciones cortas de uso del navegador en el prompt del sistema;
 * - el panel sigue la pestaña del agente: cada resultado dice en qué página está;
 * - en webs reales (no locales ni de prueba): con el modo «solo mirar», el agente no puede pulsar, escribir ni rellenar;
 *   las contraseñas guardadas solo se escriben en su web; y los clics que envían algo (enviar, pagar, borrar,
 *   publicar…) esperan a que el usuario los permita con un botón en el panel del navegador.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  agentPageUrl, browserAction, isLocalSite, isWriteAction, passwordValues, riskyAction, riskyClick, siteMatches, typedValues,
} from './local-browser-rules.ts'

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
  '- On real (non-local) websites, buttons that send, pay, delete or publish something (also scripts that click or send, and Enter in such a form) wait until the user allows them with a button in the app; do not ask in the chat. If the user declines, stop and tell them; never work around it.',
  '- Never ask for passwords, 2FA codes or captcha answers in the chat. When a site needs one, tell the user to do it in the Browser panel (clicking the page gives them control, and "Resume agent" or their next message gives it back; passwords can also be saved under the key icon for next time). Your browser actions wait while the user is in control.',
  '- Keep text between tool calls to one short line at most (no narration of what you see or plan). Every step must end with either a tool call or your final answer; after an error, try another way or tell the user.',
  '- When done, answer with the result in 1-3 short sentences (what you did and anything the user must know). Give details or step lists only if the user asks.',
].join('\n')

/** Lo que comparte con el Host (local-agent-browser.ts), que está en el mismo proceso. */
interface SharedControl {
  /** El usuario tiene el control del navegador desde el panel. */
  active?: boolean
  lookOnly?: boolean
  agentUrl?: string
  agentAt?: number
  confirm?: { id: string; label: string; site: string; answer?: boolean }
  allowedSites?: Set<string>
}
const shared = (): SharedControl =>
  ((globalThis as Record<symbol, unknown>)[Symbol.for('dpseek-local-updater.agent-browser-control')] ??= { active: false })
const userControl = (): boolean => shared().active === true

/** Lo más que espera un clic al permiso del usuario. */
const CONFIRM_TIMEOUT_MS = 10 * 60_000

/** Un resultado de error para el modelo, sin llegar a ejecutar la acción. */
const refused = (message: string): ExecResult & { error: { message: string } } =>
  ({ isError: true, content: [{ type: 'text', text: `Error: ${message}` }], error: { message } })

const hostName = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** Pide permiso al usuario (botón en el panel del navegador) y espera su respuesta. */
async function askUser(label: string, site: string, signal: AbortSignal): Promise<boolean> {
  const control = shared()
  const id = randomUUID()
  control.confirm = { id, label, site }
  const until = Date.now() + CONFIRM_TIMEOUT_MS
  try {
    for (;;) {
      signal.throwIfAborted()
      const pending = shared().confirm
      const answer = pending?.id === id ? pending.answer : false
      if (answer !== undefined) return answer
      if (Date.now() > until) return false
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  } finally {
    if (shared().confirm?.id === id) delete shared().confirm
  }
}

/** Las contraseñas guardadas por nombre y su web (sin valores; el fichero es pequeño y se lee en cada acción). */
function savedSecretSites(): Map<string, string> {
  const sites = new Map<string, string>()
  try {
    const list = JSON.parse(readFileSync(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'local-secrets.json'), 'utf8')) as unknown
    if (Array.isArray(list)) {
      for (const item of list as ({ name?: unknown; site?: unknown } | null)[]) {
        if (typeof item?.name === 'string') sites.set(item.name, typeof item.site === 'string' ? item.site : '')
      }
    }
  } catch {
    // Sin contraseñas guardadas.
  }
  return sites
}

/** La última página entera que vio el agente (para saber qué botón pulsa por su referencia). */
let lastSnapshot = ''

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
interface Exec { readonly name: string; readonly agent?: unknown; readonly arguments?: unknown; signal: AbortSignal }
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

  // Con el usuario a los mandos, el agente no toca la página. Cada contraseña guardada, solo en su web. En webs reales,
  // además: el modo «solo mirar» y el permiso del usuario para los clics que envían algo.
  loose.on('tools/execute', async (exec, next) => {
    if (!exec.name.startsWith(toolPrefix)) return next()
    await waitForUserControl(exec.signal)
    const action = browserAction(exec.name)
    const control = shared()
    const url = control.agentUrl ?? ''
    if (action === undefined || url === '') return next()
    const sites = savedSecretSites()
    const stop = 'Stop: do not try to type it any other way and do not guess passwords; tell the user in your answer.'
    for (const value of typedValues(action, exec.arguments)) {
      const site = sites.get(value)
      if (site === undefined) {
        // Los modelos pequeños cambian las mayúsculas del nombre, y entonces el navegador escribe el nombre tal cual.
        const named = [...sites.keys()].find(name => name.toLowerCase() === value.trim().toLowerCase())
        if (named !== undefined) return refused(`Saved password names are case-sensitive: type ${named} exactly, not ${value}.`)
        continue
      }
      if (site === '') return refused(`The saved password ${value} has no site set. Ask the user to add its site under the key icon of the Browser panel. ${stop}`)
      if (!siteMatches(site, url)) return refused(`The saved password ${value} is only for ${site}, and this page is on ${hostName(url)}. ${stop}`)
    }
    if (isLocalSite(url)) return next()
    // En webs reales, en un campo de contraseña solo va el nombre de una guardada: probar valores puede bloquear la cuenta.
    if (passwordValues(action, exec.arguments, lastSnapshot).some(value => !sites.has(value))) {
      return refused('Only the user can enter passwords on real websites: type the NAME of a saved password for this site, or, if there '
        + 'is none, tell the user to sign in themselves in the Browser panel or save the password under its key icon. Never guess passwords.')
    }
    if (control.lookOnly === true && isWriteAction(action)) {
      return refused('Look-only mode is on (the user turned it on with the eye button in the Browser panel): on real websites you can open, read, '
        + 'search and scroll pages, but not click, type or fill in forms. Open links with browser_navigate (use the /url from the snapshot). '
        + 'Tell the user what you would do and that they can turn look-only mode off with the eye button if they want you to do it.')
    }
    const button = riskyClick(action, exec.arguments, lastSnapshot)
    const label = button === undefined ? riskyAction(action, exec.arguments, lastSnapshot) : `click «${button}»`
    const site = hostName(url)
    if (label !== undefined && control.allowedSites?.has(site) !== true) {
      if (!await askUser(label, site, exec.signal)) {
        return refused(`The user did not allow this on ${site} (${label}). Do not try again in any other way (scripts, keys or `
          + 'other elements); tell the user it was not sent.')
      }
    }
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
      // La página donde está el agente (el panel la sigue) y, si va entera, para saber qué pulsa después.
      const page = agentPageUrl(text)
      if (page !== undefined) {
        shared().agentUrl = page
        shared().agentAt = Date.now()
      }
      if (hasFullSnapshot(text)) lastSnapshot = text
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
    const lookOnly = shared().lookOnly === true
      ? '\n- Look-only mode is on (the user set it): on real websites you can open, read, search and scroll pages, but not click, type or fill in forms. Open links with browser_navigate using their /url.'
      : ''
    return { ...assembly, sections: [...assembly.sections, { name: 'local:browser-tips', text: TIPS + lookOnly + savedPasswordsTip(), interpolate: false }] }
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
      '  fills in the real value, which you never see (results show <secret>NAME</secret>). Each one only works on its site.',
      '  If the site rejects it, do not try other values: tell the user.',
      ...rows,
    ].join('\n')
  } catch {
    return ''
  }
}
