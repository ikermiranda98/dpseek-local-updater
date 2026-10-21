/**
 * Reglas del navegador compartido (añadido por dpseek-local-updater), sin estado ni dependencias de la app: las usan el
 * Host (local-agent-browser.ts) y el proveedor del navegador del agente (local-browser-context.ts), y se prueban solas
 * (sistema/pruebas/navegador.test.mjs, en cada compilación de GitHub).
 *
 * - qué es una web local o de prueba (allí el agente puede hacer de todo sin preguntar);
 * - a qué web pertenece cada contraseña guardada;
 * - qué acciones del agente escriben en la página (el modo «solo mirar» las bloquea en webs reales);
 * - qué clics envían algo (enviar, pagar, borrar, publicar…) y piden permiso al usuario con un botón;
 * - lo que se escribe en la barra de dirección;
 * - la copia de seguridad cifrada de las contraseñas (AES-256-GCM con una frase de paso).
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'

/** Prefijo de las herramientas del navegador del agente (servidor Playwright MCP). */
export const BROWSER_TOOL_PREFIX = 'mcp__playwright-mcp__browser_'

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return undefined
  }
}

/**
 * Webs del propio PC o de prueba: localhost, 127.x, ::1 y los nombres .localhost, .test y .local.
 * @param url - dirección completa.
 */
export function isLocalSite(url: string): boolean {
  const host = hostOf(url)
  if (host === undefined) return false
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host) || /\.(localhost|test|local)$/.test(host)
}

const bareHost = (host: string): string => host.replace(/^www\./, '')

/**
 * Si una página es de la web de una contraseña (la misma o un subdominio; «www.» da igual).
 * @param site - la web anotada con la contraseña («example.com», «https://login.example.com/…»).
 * @param url - la página donde el agente quiere escribirla.
 */
export function siteMatches(site: string, url: string): boolean {
  const wanted = hostOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(site.trim()) ? site.trim() : `https://${site.trim()}`)
  const page = hostOf(url)
  if (wanted === undefined || wanted === '' || page === undefined) return false
  const a = bareHost(wanted)
  const b = bareHost(page)
  return a === b || b.endsWith(`.${a}`)
}

/** Herramientas que cambian algo en la página o en la web: el modo «solo mirar» las bloquea en webs reales. */
const WRITE_TOOLS = new Set([
  'click', 'drag', 'drop', 'select_option', 'check', 'uncheck', 'file_upload', 'fill_form', 'press_key', 'press_sequentially',
  'type', 'keydown', 'keyup', 'mouse_down', 'mouse_up', 'mouse_click_xy', 'mouse_drag_xy', 'evaluate', 'run_code_unsafe',
  'handle_dialog', 'cookie_set', 'cookie_delete', 'cookie_clear', 'localstorage_set', 'localstorage_delete', 'localstorage_clear',
  'sessionstorage_set', 'sessionstorage_delete', 'sessionstorage_clear', 'set_storage_state',
])

/** @returns el nombre corto de una herramienta del navegador («click»), o nada si no es del navegador. */
export function browserAction(toolName: string): string | undefined {
  return toolName.startsWith(BROWSER_TOOL_PREFIX) ? toolName.slice(BROWSER_TOOL_PREFIX.length) : undefined
}

/** @returns si esa acción escribe en la página (pulsar, escribir, rellenar, ejecutar código…). */
export function isWriteAction(action: string): boolean {
  return WRITE_TOOLS.has(action)
}

/** Lo que el agente escribe en los campos (para comprobar las contraseñas guardadas, que van por su nombre). */
export function typedValues(action: string, args: unknown): string[] {
  const record = (args ?? {}) as { text?: unknown; fields?: unknown }
  if ((action === 'type' || action === 'press_sequentially') && typeof record.text === 'string') return [record.text]
  if (action === 'fill_form' && Array.isArray(record.fields)) {
    return record.fields.map(field => (field as { value?: unknown } | null)?.value).filter((value): value is string => typeof value === 'string')
  }
  return []
}

const PASSWORD_FIELD = /pass(word|code)?|contrase|clave|\bpin\b|passwort|mot de passe|senha/i

/**
 * Lo que el agente escribe en campos de contraseña (por el nombre del campo en la página o el que da el modelo): en
 * webs reales solo puede ir el nombre de una contraseña guardada, nunca un valor adivinado.
 */
export function passwordValues(action: string, args: unknown, snapshot: string): string[] {
  const isPassword = (target: unknown, ...names: unknown[]): boolean => {
    const element = typeof target === 'string' ? snapshotElement(snapshot, target) : undefined
    return [element?.name, ...names].some(name => typeof name === 'string' && PASSWORD_FIELD.test(name))
  }
  const record = (args ?? {}) as { text?: unknown; target?: unknown; ref?: unknown; element?: unknown; fields?: unknown }
  if ((action === 'type' || action === 'press_sequentially') && typeof record.text === 'string') {
    return isPassword(record.target ?? record.ref, record.element) ? [record.text] : []
  }
  if (action === 'fill_form' && Array.isArray(record.fields)) {
    return record.fields.map(field => (field ?? {}) as { name?: unknown; target?: unknown; ref?: unknown; value?: unknown })
      .filter(field => typeof field.value === 'string' && isPassword(field.target ?? field.ref, field.name))
      .map(field => field.value as string)
  }
  return []
}

/**
 * Botones que envían, pagan, borran o publican algo. No están «continuar», «siguiente», «iniciar sesión» ni los de
 * las cookies: no crean ni cambian nada en la web.
 */
const RISKY_LABEL = new RegExp([
  'submit', 'send', 'post', 'publish', 'pay', 'purchase', 'buy', 'order', 'checkout', 'check out', 'confirm', 'delete', 'remove',
  'erase', 'destroy', 'unsubscribe', 'transfer', 'donate', 'book', 'reserve', 'sign up', 'register', 'create', 'save', 'update',
  'apply', 'share', 'reply', 'comment', 'upload', 'enviar', 'envía', 'publicar', 'pagar', 'comprar', 'pedir', 'pedido',
  'tramitar', 'confirmar', 'eliminar', 'borrar', 'quitar', 'transferir', 'donar', 'reservar', 'registr', 'crear', 'guardar',
  'actualizar', 'aplicar', 'compartir', 'responder', 'comentar', 'subir', 'suscrib', 'darse de baja', 'dar de baja',
].map(word => word.replace(/ /g, '\\s+')).join('|'), 'i')

/** Un elemento de la página según la última instantánea del agente: su papel y su nombre. */
export function snapshotElement(snapshot: string, ref: string): { role: string; name: string } | undefined {
  const plain = ref.replace(/^ref=/, '')
  const line = snapshot.split('\n').find(row => row.includes(`[ref=${plain}]`))
  const match = line === undefined ? null : /-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(line)
  return match === null ? undefined : { role: match[1] ?? '', name: (match[2] ?? '').replace(/\\"/g, '"') }
}

/**
 * Si un clic del agente envía algo (un botón «Enviar», «Pagar», «Borrar»…): en webs reales pide permiso al usuario.
 * @param action - herramienta («click»).
 * @param args - sus argumentos (`target` con la referencia y `element` con la descripción del modelo).
 * @param snapshot - la última página que vio el agente.
 * @returns el texto del botón, o nada si no hace falta preguntar.
 */
export function riskyClick(action: string, args: unknown, snapshot: string): string | undefined {
  if (action !== 'click') return undefined
  const record = (args ?? {}) as { target?: unknown; ref?: unknown; element?: unknown }
  const ref = typeof record.target === 'string' ? record.target : typeof record.ref === 'string' ? record.ref : undefined
  const element = ref === undefined ? undefined : snapshotElement(snapshot, ref)
  const description = typeof record.element === 'string' ? record.element : ''
  // Con la página a mano, solo los botones (un enlace solo abre otra página); sin ella, por lo que dice el modelo.
  if (element !== undefined) {
    if (element.role !== 'button') return undefined
    const label = element.name !== '' ? element.name : description
    return RISKY_LABEL.test(label) && !/cookie/i.test(label) ? label : undefined
  }
  return RISKY_LABEL.test(description) && !/cookie|link|enlace/i.test(description) ? description : undefined
}

/** Código que pulsa, envía o cambia la página: por script se podría esquivar el permiso de los botones. */
const ACTING_SCRIPT = new RegExp([
  String.raw`\.click\s*\(`, String.raw`\.submit\s*\(`, 'requestSubmit', 'dispatchEvent', String.raw`\bfetch\s*\(`, 'XMLHttpRequest', 'sendBeacon',
  String.raw`\.(value|checked|selected|innerText|textContent|innerHTML)\s*=[^=]`, String.raw`location(\.href)?\s*=[^=]`,
  String.raw`\.(fill|type|press|check|tap|selectOption|setInputFiles)\s*\(`,
].join('|'))

/**
 * Otras formas de enviar algo en webs reales, que también piden permiso: un script que pulsa, escribe o envía, o la
 * tecla Enter en una página con un botón que envía (mandaría el formulario).
 * @param action - herramienta («evaluate», «run_code_unsafe», «press_key»).
 * @param args - sus argumentos (el código en `function` o `code`; la tecla en `key`).
 * @param snapshot - la última página que vio el agente.
 * @returns lo que quiere hacer (para la tarjeta de permiso), o nada si no hace falta preguntar.
 */
export function riskyAction(action: string, args: unknown, snapshot: string): string | undefined {
  const record = (args ?? {}) as Record<string, unknown>
  if (action === 'evaluate' || action === 'run_code_unsafe') {
    const code = Object.values(record).filter((value): value is string => typeof value === 'string').join('\n')
    return ACTING_SCRIPT.test(code) ? 'run a script that clicks, types or sends something on the page' : undefined
  }
  if (action === 'press_key' && typeof record.key === 'string' && /^(enter|numpadenter)$/i.test(record.key)) {
    const button = snapshot.split('\n').map(line => /-\s+button\s+"((?:[^"\\]|\\.)*)"/.exec(line)?.[1])
      .find((name): name is string => name !== undefined && RISKY_LABEL.test(name) && !/cookie/i.test(name))
    return button === undefined ? undefined : `press Enter, which may send the form («${button}»)`
  }
  return undefined
}

/** La dirección de la página donde está el agente, según el resultado de su última acción. */
export function agentPageUrl(resultText: string): string | undefined {
  return /Page URL: (\S+)/.exec(resultText)?.[1]
}

/**
 * Lo escrito en la barra de dirección (o un enlace del chat): una web, con o sin http(s)://, o, si no lo parece, una
 * búsqueda. Solo webs: ni file: (abriría ficheros del PC, que el agente podría leer) ni javascript: ni otros esquemas.
 */
export function localAddressToUrl(text: string): string {
  const value = text.trim()
  if (value === '') return ''
  if (/^https?:\/\//i.test(value) || value === 'about:blank') return value
  // localhost:3000 o 127.0.0.1:8080 parecen un esquema («localhost:»), pero son una web local.
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i.test(value)) return `http://${value}`
  if (!/\s/.test(value) && /^[^/:]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(value)) return `https://${value}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/\s/.test(value)) throw new Error('Only web addresses (http or https) can be opened here.')
  return `https://www.bing.com/search?q=${encodeURIComponent(value)}`
}

/** Una contraseña en claro, solo dentro de la copia de seguridad cifrada. */
export interface PlainSecret {
  readonly name: string
  readonly site: string
  readonly value: string
}

const BACKUP_FORMAT = 'dsh-local-passwords'
const ITERATIONS = 310_000

/**
 * Copia de seguridad de las contraseñas, cifrada con una frase de paso (sirve en otro PC, a diferencia de DPAPI).
 * @returns el fichero (JSON) con la sal, el vector inicial, la etiqueta y el contenido cifrado.
 */
export function sealSecrets(secrets: readonly PlainSecret[], passphrase: string): string {
  if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = pbkdf2Sync(passphrase, salt, ITERATIONS, 32, 'sha256')
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()])
  return JSON.stringify({
    format: BACKUP_FORMAT, version: 1, kdf: 'pbkdf2-sha256', iterations: ITERATIONS,
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  }, null, 2)
}

/**
 * Abre una copia de seguridad hecha con sealSecrets.
 * @returns las contraseñas, o un error si el fichero no es una copia o la frase de paso no es la buena.
 */
export function openSecrets(file: string, passphrase: string): PlainSecret[] {
  let backup: { format?: unknown; iterations?: unknown; salt?: unknown; iv?: unknown; tag?: unknown; data?: unknown }
  try {
    backup = JSON.parse(file) as typeof backup
  } catch {
    throw new Error('This file is not a passwords backup.')
  }
  if (backup.format !== BACKUP_FORMAT || typeof backup.salt !== 'string' || typeof backup.iv !== 'string'
    || typeof backup.tag !== 'string' || typeof backup.data !== 'string') throw new Error('This file is not a passwords backup.')
  const iterations = typeof backup.iterations === 'number' && backup.iterations >= 100_000 ? backup.iterations : ITERATIONS
  const key = pbkdf2Sync(passphrase, Buffer.from(backup.salt, 'base64'), iterations, 32, 'sha256')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(backup.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(backup.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(backup.data, 'base64')), decipher.final()]).toString('utf8')
    const list = JSON.parse(plain) as unknown
    if (!Array.isArray(list)) throw new Error('vacío')
    return list.filter((item): item is PlainSecret => typeof (item as PlainSecret | null)?.name === 'string'
      && typeof (item as PlainSecret).value === 'string')
      .map(item => ({ name: item.name, site: typeof item.site === 'string' ? item.site : '', value: item.value }))
  } catch {
    throw new Error('Wrong passphrase, or the file is damaged.')
  }
}
