// Navegador del agente (dpseek-local-updater): arranca el servidor de Playwright MCP conectado a un Edge compartido.
//
// Lo usa el proveedor de navegador como comando de su servidor MCP (node -e con este código). Si el Edge del agente
// no está en marcha, lo arranca sin ventana, con su propio perfil (las sesiones iniciadas se guardan ahí) y un puerto
// de depuración, y lo anota en un fichero de estado; luego carga el servidor de Playwright conectado a él. Todos los
// chats comparten ese Edge, y la app lee el mismo fichero para enseñarlo en la barra lateral.
// Argumentos: <cli.js de @playwright/mcp> <msedge.exe> <carpeta del perfil> <fichero de estado>
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(1).filter((arg) => arg !== '--')
const [cli, edge, profile, stateFile] = args
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

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
        '--window-size=1280,800', 'about:blank',
      ], { detached: true, stdio: 'ignore', windowsHide: true })
      browser.unref()
      let port
      for (let i = 0; i < 150 && port === undefined; i++) {
        await sleep(100)
        try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || undefined } catch { /* aún no */ }
      }
      if (port === undefined) throw new Error('el Edge del agente no ha abierto su puerto de depuración')
      state = { port, pid: browser.pid, startedAt: new Date().toISOString() }
      writeFileSync(stateFile, JSON.stringify(state))
    }
  } finally {
    if (locked) rmSync(lock, { force: true })
  }
}

// El servidor de Playwright, en este mismo proceso, conectado al Edge del agente.
process.argv = [process.argv[0], cli, '--browser', 'chromium', '--cdp-endpoint', `http://127.0.0.1:${String(state.port)}`]
await import(pathToFileURL(cli).href)
