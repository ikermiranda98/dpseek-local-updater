// Captura los diccionarios 'en' registrados en LocaleRuntime enganchando Map.prototype.set
// antes de que cargue la página, y los vuelca a en-dump.json.
import { writeFileSync } from 'node:fs'
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find(t => t.type === 'page' && t.url.startsWith('dsh-app://'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
await new Promise(r => ws.onopen = r)
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await send('Page.enable')
const hook = `(() => {
  const tag = new WeakMap(); const dump = {}; window.__enDump = dump
  const orig = Map.prototype.set
  Map.prototype.set = function (k, v) {
    if (typeof k === 'string' && v instanceof Map) tag.set(v, k)
    else if (k === 'en' && v && typeof v === 'object' && tag.has(this)) {
      const vals = Object.values(v); if (vals.length && vals.every(x => typeof x === 'string')) dump[tag.get(this)] = { ...v }
    }
    return orig.call(this, k, v)
  }
})()`
const reg = await send('Page.addScriptToEvaluateOnNewDocument', { source: hook })
await send('Page.reload', { ignoreCache: true })
await new Promise(r => setTimeout(r, 15000))
const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__enDump ?? null)', returnByValue: true })
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: reg.result.identifier })
const dump = JSON.parse(r.result.result.value)
writeFileSync('en-dump.json', JSON.stringify(dump, null, 1))
const ns = Object.keys(dump); console.log(ns.length, 'namespaces,', ns.reduce((a, n) => a + Object.keys(dump[n]).length, 0), 'keys')
console.log(ns.join(' '))
ws.close()
