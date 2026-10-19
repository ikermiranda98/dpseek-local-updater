// Control de Windows para el agente (dpseek-local-updater): un servidor MCP mínimo por stdio sobre el SDK de Cua Driver.
//
// Va en su propio proceso (si el controlador nativo falla, cae este proceso, no la app) y ofrece solo lo esencial
// para abrir apps y moverse por ellas: listar apps y ventanas, abrir una app, leer una ventana como árbol de elementos
// (texto: vale para un modelo sin visión), pulsar, escribir, teclas y atajos, poner un valor, desplazar, menús, traer
// al frente y el portapapeles. Pulsa por elemento, sin robar el foco ni mover el ratón del usuario.
// Argumentos: <ruta de @trycua/cua-driver (su index.js)>
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

// Con node -e los argumentos empiezan en argv[1]; como fichero, argv[1] es el propio script.
const sdkPath = process.argv.slice(1).find((arg) => /cua-driver/i.test(arg) && /.js$/i.test(arg)) ?? ''

/** Herramientas que se ofrecen (las demás del controlador quedan fuera: grabar, matar procesos, configuración…). */
const ALLOWED = new Set([
  'list_apps', 'list_windows', 'launch_app', 'get_window_state', 'bring_to_front',
  'click', 'double_click', 'right_click', 'type_text', 'press_key', 'hotkey', 'set_value', 'scroll', 'invoke_menu',
  'clipboard_read', 'clipboard_write',
])
/**
 * Las definiciones del controlador pesan unos 45.000 caracteres: cada herramienta se queda con sus parámetros esenciales
 * y descripciones cortas, para no llenar cada petición del modelo local.
 */
const MAX_DESCRIPTION = 360
const MAX_PARAM_DESCRIPTION = 140
const TARGET = ['pid', 'window_id', 'element_index', 'x', 'y', 'delivery_mode']
const KEEP = {
  list_apps: [], list_windows: ['pid', 'on_screen_only'], get_window_state: ['pid', 'window_id', 'query', 'max_elements'],
  launch_app: ['name', 'path', 'urls'], bring_to_front: ['pid', 'window_id'], invoke_menu: ['pid', 'window_id', 'path'],
  click: [...TARGET, 'button', 'count'], double_click: TARGET, right_click: TARGET,
  type_text: ['pid', 'window_id', 'element_index', 'text', 'delivery_mode'],
  press_key: ['pid', 'window_id', 'element_index', 'key', 'modifiers', 'delivery_mode'],
  hotkey: ['pid', 'window_id', 'keys', 'delivery_mode'], set_value: ['pid', 'window_id', 'element_index', 'value'],
  scroll: ['pid', 'window_id', 'element_index', 'direction', 'amount', 'by'], clipboard_read: ['include_text'], clipboard_write: ['text'],
}
const cut = (text, max) => typeof text === 'string' && text.length > max ? `${text.slice(0, max)}…` : text
const slim = (name, schema) => {
  const keep = KEEP[name] ?? []
  const properties = Object.fromEntries(Object.entries(schema?.properties ?? {}).filter(([key]) => keep.includes(key))
    .map(([key, value]) => [key, value.description === undefined ? value : { ...value, description: cut(value.description, MAX_PARAM_DESCRIPTION) }]))
  const required = (schema?.required ?? []).filter((key) => keep.includes(key))
  return { type: 'object', properties, ...required.length === 0 ? {} : { required } }
}

const INSTRUCTIONS = [
  'Windows desktop control. Read before acting:',
  '1. list_windows (or list_apps, then launch_app) to find the app and its pid/window_id.',
  '2. get_window_state(pid, window_id) returns the window as a tree of numbered elements; act with element_index from the latest get_window_state of that window, then read it again to check the result.',
  '3. Prefer element_index over coordinates; type_text types into the focused element; hotkey sends shortcuts like ["ctrl","s"].',
  'Ask the user before closing apps, deleting files or data, sending messages or emails, making purchases or changing system settings.',
  'Never type passwords you were not given; for sign-ins, ask the user to do it themselves.',
].join('\n')

let driver
const getDriver = async () => {
  if (driver !== undefined) return driver
  if (sdkPath === '') throw new Error('Cua Driver is not installed in this build')
  const sdk = await import(pathToFileURL(sdkPath).href)
  driver = sdk.CuaDriver.create(undefined)
  return driver
}

let tools
const listTools = async () => {
  if (tools !== undefined) return tools
  const all = JSON.parse(await (await getDriver()).listToolsJson())
  tools = (all.tools ?? all).filter((tool) => ALLOWED.has(tool.name)).map((tool) => ({
    name: tool.name,
    description: cut(tool.description ?? '', MAX_DESCRIPTION),
    inputSchema: slim(tool.name, tool.inputSchema ?? tool.input_schema),
  }))
  return tools
}

const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`) }
const reply = (id, result) => { send({ jsonrpc: '2.0', id, result }) }
const fail = (id, code, message) => { send({ jsonrpc: '2.0', id, error: { code, message } }) }

const handle = async (message) => {
  const { id, method, params } = message
  if (id === undefined) return // notificaciones (initialized, cancelled…)
  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'desktop', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      })
    } else if (method === 'ping') {
      reply(id, {})
    } else if (method === 'tools/list') {
      reply(id, { tools: await listTools() })
    } else if (method === 'tools/call') {
      const name = params?.name
      if (!ALLOWED.has(name)) { fail(id, -32602, `unknown tool: ${String(name)}`); return }
      const result = await (await getDriver()).callTool(name, JSON.stringify(params?.arguments ?? {}))
      // Solo texto: las capturas no le sirven a un modelo sin visión y llenan el contexto.
      reply(id, { content: [{ type: 'text', text: result.text || (result.isError ? 'The action failed.' : 'Done.') }], isError: result.isError === true })
    } else {
      fail(id, -32601, `method not found: ${String(method)}`)
    }
  } catch (error) {
    if (method === 'tools/call') reply(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true })
    else fail(id, -32603, error instanceof Error ? error.message : String(error))
  }
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  if (line.trim() === '') return
  let message
  try { message = JSON.parse(line) } catch { return }
  void handle(message)
})
lines.on('close', async () => {
  try { await driver?.shutdown() } catch { /* ya cerrado */ }
  process.exit(0)
})
