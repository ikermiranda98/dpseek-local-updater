// Navegador del agente (dpseek-local-updater): arranca el servidor de Playwright MCP conectado a un Edge compartido.
//
// Lo usa el proveedor de navegador como comando de su servidor MCP (node -e con este código). Si el Edge del agente
// no está en marcha, lo arranca sin ventana, con su propio perfil (las sesiones iniciadas se guardan ahí) y un puerto
// de depuración, y lo anota en un fichero de estado; luego carga el servidor de Playwright conectado a él. Todos los
// chats comparten ese Edge, y la app lee el mismo fichero para enseñarlo en la barra lateral. Lleva los bloqueadores de
// anuncios que la app haya descargado (Adblock Plus y AdGuard).
// Argumentos: <cli.js de @playwright/mcp> <msedge.exe> <carpeta del perfil> <fichero de estado> [carpeta de salida]
// [contraseñas guardadas] (la carpeta de salida guarda páginas y capturas de Playwright; sin ella van a .playwright-mcp
// en la carpeta de trabajo del chat).
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(1).filter((arg) => arg !== '--')
const [cli, configuredEdge, profile, stateFile, outputDir, secretsFile] = args
// Si Edge no está donde dice la configuración, el de 64 bits o el del usuario.
const edge = [configuredEdge, join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ...process.env.LOCALAPPDATA === undefined ? [] : [join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]]
  .find((path) => path !== undefined && existsSync(path)) ?? configuredEdge
// Los bloqueadores de anuncios que la app ya ha descargado (local-agent-browser.ts): Adblock Plus y AdGuard. En una
// carpeta de ruta corta (con rutas largas, Edge no encontraba sus reglas).
const extensionsDir = join(process.env.LOCALAPPDATA ?? dirname(stateFile), 'dsh-ad-blockers')
const extensions = process.env.DSH_LOCAL_NO_AD_BLOCKERS === '1' ? [] : ['cfhdojbkjhnklbpkdaibdccddilifddb', 'bgnkhhnnamicmpeenaelnjfhikgbkllg']
  .map((id) => join(extensionsDir, id)).filter((dir) => existsSync(join(dir, 'manifest.json')))
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Carga los bloqueadores en el Edge recién arrancado, por el protocolo de depuración; sin ellos, el navegador funciona. */
const loadExtensions = async (port) => {
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json()
    const socket = new WebSocket(webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    for (const [index, path] of extensions.entries()) {
      socket.send(JSON.stringify({ id: index + 1, method: 'Extensions.loadUnpacked', params: { path } }))
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 15_000)
        socket.onmessage = (event) => { if (JSON.parse(String(event.data)).id === index + 1) { clearTimeout(timer); resolve() } }
      })
    }
    // Al instalarse abren su página de bienvenida en otra pestaña (el agente y el panel se irían a ella): se cierra en
    // cuanto aparece, sin hacer esperar al arranque.
    void (async () => {
      for (let i = 0; i < 16; i++) {
        await sleep(500)
        const pages = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json().catch(() => [])
        for (const page of pages.filter((target) => target.type === 'page' && WELCOME.test(target.url))) {
          socket.send(JSON.stringify({ id: 100 + i, method: 'Target.closeTarget', params: { targetId: page.id } }))
        }
      }
      socket.close()
    })().catch(() => { socket.close() })
  } catch {
    // Sin bloqueadores esta vez.
  }
}
const WELCOME = /^https:\/\/([a-z0-9-]+\.)*(adguard\.com|adblockplus\.org)\/|^chrome-extension:\/\//i

const alive = async (port) => {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}
const readState = () => {
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    return Number.isInteger(state.port) ? state : undefined
  } catch {
    return undefined
  }
}

// Un solo arranque a la vez: dos chats que empiezan a la vez no abren dos Edge con el mismo perfil.
const lock = `${stateFile}.lock`
const acquire = async () => {
  for (let i = 0; i < 200; i++) {
    try {
      closeSync(openSync(lock, 'wx'))
      return true
    } catch {
      // Un candado de hace más de 30 s es de un arranque que murió.
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true }) } catch { /* ya no está */ }
      await sleep(100)
    }
  }
  return false
}

let state = readState()
if (state === undefined || !await alive(state.port)) {
  mkdirSync(dirname(stateFile), { recursive: true })
  const locked = await acquire()
  try {
    state = readState()
    if (state === undefined || !await alive(state.port)) {
      mkdirSync(profile, { recursive: true })
      rmSync(join(profile, 'DevToolsActivePort'), { force: true })
      const browser = spawn(edge, [
        '--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-features=msEdgeSidebarV2,msUndersideButton',
        // Los bloqueadores se cargan por el protocolo (el Edge de marca ignora --load-extension); solo escucha en 127.0.0.1.
        '--enable-unsafe-extension-debugging', '--window-size=1280,800', 'about:blank',
      ], { detached: true, stdio: 'ignore', windowsHide: true })
      browser.unref()
      let port
      for (let i = 0; i < 150 && port === undefined; i++) {
        await sleep(100)
        try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || undefined } catch { /* aún no */ }
      }
      if (port === undefined) throw new Error('el Edge del agente no ha abierto su puerto de depuración')
      await loadExtensions(port)
      state = { port, pid: browser.pid, startedAt: new Date().toISOString() }
      writeFileSync(stateFile, JSON.stringify(state))
    }
  } finally {
    if (locked) rmSync(lock, { force: true })
  }
}

// Contraseñas guardadas («Saved passwords», cifradas con DPAPI): se descifran aquí y Playwright las recibe en un
// fichero temporal que lee al arrancar y que se borra en seguida. El modelo escribe el nombre; Playwright pone el valor
// en la página y lo tapa en todo lo que devuelve.
let secretsTemp
try {
  const stored = secretsFile === undefined ? [] : JSON.parse(readFileSync(secretsFile, 'utf8'))
  if (Array.isArray(stored) && stored.length > 0) {
    const script = '[Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8; '
      + 'Add-Type -AssemblyName System.Security; $items = [Console]::In.ReadToEnd() | ConvertFrom-Json; '
      + '$out = foreach ($i in $items) { try { [pscustomobject]@{ name = $i.name; value = [Text.Encoding]::UTF8.GetString('
      + "[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($i.value), $null, 'CurrentUser')) } } catch { } }; "
      + 'ConvertTo-Json -InputObject @($out) -Compress'
    const plain = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: JSON.stringify(stored), windowsHide: true, timeout: 20_000,
    }).toString('utf8') || '[]')
    // dotenv: comillas simples (literal) salvo que el valor las tenga; entonces otra comilla que no aparezca.
    const quote = (value) => [`'`, '`', '"'].map(q => value.includes(q) ? undefined : `${q}${value}${q}`).find(v => v !== undefined) ?? `'${value.replace(/'/g, '')}'`
    const lines = plain.filter(item => /^[A-Z0-9_]+$/.test(item.name) && !/[\r\n]/.test(item.value)).map(item => `${item.name}=${quote(item.value)}`)
    if (lines.length > 0) {
      secretsTemp = join(tmpdir(), `dsh-agent-secrets-${randomUUID()}.env`)
      writeFileSync(secretsTemp, lines.join('\n') + '\n', { mode: 0o600 })
      const remove = () => { try { rmSync(secretsTemp, { force: true }) } catch { /* ya no está */ } }
      setTimeout(remove, 5000).unref()
      process.once('exit', remove)
    }
  }
} catch {
  // Sin contraseñas guardadas (o sin poder descifrarlas): el navegador funciona igual.
}

// El servidor de Playwright, en este mismo proceso, conectado al Edge del agente.
process.argv = [process.argv[0], cli, '--browser', 'chromium', '--cdp-endpoint', `http://127.0.0.1:${String(state.port)}`,
  ...outputDir === undefined ? [] : ['--output-dir', outputDir, '--output-max-size', String(50 * 1024 * 1024)],
  ...secretsTemp === undefined ? [] : ['--secrets', secretsTemp]]
await import(pathToFileURL(cli).href)
