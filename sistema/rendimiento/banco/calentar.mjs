// Abre una vez cada chat del home de prueba (puerto 9555) para que la app calcule sus títulos y cachés, como en un uso real.
import { connect, waitFor } from './cdp.mjs'
const c = await connect(9555)
const expand = async () => {
  await c.evaluate(`(() => { for (const b of document.querySelectorAll('button, [role=button]')) if (/^Show \\d+ more sessions$/.test(b.textContent.trim())) b.click() })()`)
}
await expand()
await new Promise((r) => { setTimeout(r, 1000) })
const total = await c.evaluate(`document.querySelectorAll('[class*="_title"]').length`)
console.log('filas', total)
let opened = 0
for (let i = 0; i < 400; i++) {
  await expand()
  // La siguiente fila sin título calculado.
  const clicked = await c.evaluate(`(() => {
    const el = [...document.querySelectorAll('span')].find((e) => e.children.length === 0 && e.textContent === 'Untitled')
    if (!el) return false
    el.scrollIntoView({ block: 'center' }); el.click(); return true
  })()`)
  if (!clicked) break
  try { await waitFor(c, `document.title.startsWith('BENCH')`, { timeoutMs: 15000 }) } catch { console.log('sin abrir', i) }
  await waitFor(c, `!document.title.startsWith('BENCH') || [...document.querySelectorAll('span')].filter((e) => e.textContent === 'Untitled').length >= 0`, { timeoutMs: 1000 })
  opened++
  // Vuelve a «New Session» para que el siguiente clic cambie el título de la ventana.
  await c.evaluate(`document.title = ''`)
  if (opened % 20 === 0) console.log('abiertos', opened)
}
console.log('abiertos', opened)
c.close()
