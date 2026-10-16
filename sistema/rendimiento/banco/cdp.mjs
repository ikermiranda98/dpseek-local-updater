// Cliente CDP mínimo para el banco de pruebas.
export async function connect(port, { timeoutMs = 60_000 } = {}) {
  const until = Date.now() + timeoutMs
  let page
  while (Date.now() < until) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json`)).json()
      page = targets.find((t) => t.type === 'page' && t.url.startsWith('dsh-app://app'))
      if (page !== undefined) break
    } catch { /* aún no escucha */ }
    await new Promise((r) => { setTimeout(r, 25) })
  }
  if (page === undefined) throw new Error('sin página')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const listeners = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } else if (m.method !== undefined) for (const l of listeners.get(m.method) ?? []) l(m.params)
  }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'error en evaluate')
    return res.result?.result?.value
  }
  const on = (method, fn) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn) }
  return { send, evaluate, on, close: () => ws.close() }
}

/** Espera hasta que `expression` sea verdadera; devuelve los ms que tardó (reloj del banco). */
export async function waitFor(cdp, expression, { timeoutMs = 60_000, everyMs = 16 } = {}) {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    try { if (await cdp.evaluate(expression)) return performance.now() - start } catch { /* recargando */ }
    await new Promise((r) => { setTimeout(r, everyMs) })
  }
  throw new Error(`no se cumplió: ${expression.slice(0, 80)}`)
}
