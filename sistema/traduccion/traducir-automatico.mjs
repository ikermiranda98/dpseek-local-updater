// Traduce al español los textos nuevos de la app con GitHub Models y los añade a
// sistema/es-pack.json (y es-pack.ts). Lo usa la compilación (compilar.yml) con
// los textos sin traducir que encuentra la prueba de arranque.
//
// Uso: node sistema/traduccion/traducir-automatico.mjs <sin-traducir.json> <resumen.md>
//   <sin-traducir.json>: [{ ns, key, text }] (lo escribe prueba-arranque.mjs).
//   <resumen.md>: lista de lo traducido, para las notas del Release.
// Necesita GITHUB_TOKEN con permiso «models: read» (en Actions, el de la propia
// compilación). Modelo: DSH_LOCAL_MODELO_TRADUCCION (por defecto openai/gpt-4.1-mini).
//
// Nunca falla la compilación: si GitHub Models no responde o una traducción no pasa
// las comprobaciones, ese texto se queda en inglés, como hasta ahora. Escribe en
// stdout «traducidos=<n>».
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
// DSH_LOCAL_ES_PACK: otro fichero de traducciones (para probar sin tocar el del repo).
const packFile = process.env.DSH_LOCAL_ES_PACK || join(here, '..', 'es-pack.json')
const [missingFile, summaryFile] = process.argv.slice(2)
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
const model = process.env.DSH_LOCAL_MODELO_TRADUCCION || 'openai/gpt-4.1-mini'
const ENDPOINT = 'https://models.github.ai/inference/chat/completions'
const BATCH = 40

const missing = JSON.parse(readFileSync(missingFile, 'utf8'))
const pack = JSON.parse(readFileSync(packFile, 'utf8'))

function finish(added) {
  if (added.length > 0) {
    writeFileSync(packFile, JSON.stringify(pack, null, 1) + '\n')
    if (!process.env.DSH_LOCAL_ES_PACK) spawnSync(process.execPath, [join(here, 'generar-es-pack.mjs')], { stdio: 'inherit' })
  }
  if (summaryFile) {
    const lines = added.length === 0 ? [] : [
      `**${added.length} textos nuevos traducidos automáticamente** (con ${model}; revísalos en \`sistema/es-pack.json\`):`,
      '',
      ...added.slice(0, 40).map((a) => `- \`${a.ns}\` · \`${a.key}\`: ${a.es.replace(/\s+/g, ' ').slice(0, 90)}`),
      ...(added.length > 40 ? [`- … y ${added.length - 40} más`] : []),
    ]
    writeFileSync(summaryFile, lines.length === 0 ? '' : lines.join('\n') + '\n')
  }
  console.log(`traducidos=${added.length}`)
}

if (missing.length === 0) {
  finish([])
  process.exit(0)
}
if (!token) {
  console.log('::warning::Sin GITHUB_TOKEN: los textos nuevos se quedan en inglés.')
  finish([])
  process.exit(0)
}

// Variables que la app sustituye ({name}, $DSH_HOME…): deben quedar idénticas.
const tokens = (s) => [...s.matchAll(/\{\w+\}|\$[A-Za-z_]\w*/g)].map((m) => m[0]).sort().join(' ')

/** Unos textos ya traducidos del mismo apartado, para mantener el estilo. */
function examples(namespaces) {
  const out = []
  for (const ns of namespaces) {
    for (const value of Object.values(pack[ns] ?? {}).slice(0, 12)) out.push(value)
  }
  return out.slice(0, 40)
}

const SYSTEM = [
  'Traduces al español de España los textos de la interfaz de una aplicación de escritorio',
  '(un agente de programación con IA que funciona con modelos locales de Ollama).',
  'Reglas:',
  '- Tutea al usuario («Inténtalo de nuevo», no «Inténtelo»). Frases cortas y naturales, como en una app.',
  '- Deja exactamente igual las variables entre llaves ({name}, {count}…) y las que empiezan por $ ($DSH_HOME…).',
  '- No traduzcas nombres de productos ni de apps (DSH, DeepSeek, Ollama, VS Code…), ni rutas, comandos o código.',
  '- Usa comillas latinas «» y conserva la puntuación final del original.',
  '- Si el texto es solo un nombre propio, un símbolo o una variable, devuélvelo igual.',
  'Responde solo con un objeto JSON: cada clave es el id recibido y su valor, la traducción.',
].join('\n')

async function translate(batch) {
  const items = Object.fromEntries(batch.map((m, i) => [String(i), m.text]))
  const style = examples([...new Set(batch.map((m) => m.ns))])
  const user = [
    style.length === 0 ? '' : `Textos ya traducidos de la app, como referencia de estilo:\n${style.map((s) => `- ${s}`).join('\n')}\n`,
    `Traduce estos textos (id → inglés):\n${JSON.stringify(items, null, 1)}`,
  ].join('\n')
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`GitHub Models: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
  const body = await response.json()
  return JSON.parse(body.choices?.[0]?.message?.content ?? '{}')
}

const added = []
for (let start = 0; start < missing.length; start += BATCH) {
  const batch = missing.slice(start, start + BATCH)
  let result
  try {
    result = await translate(batch)
  } catch (error) {
    console.log(`::warning::No se han podido traducir ${batch.length} textos: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  batch.forEach((m, i) => {
    const es = result[String(i)]
    const ok = typeof es === 'string' && es.trim() !== '' && tokens(es) === tokens(m.text) && es.length <= m.text.length * 3 + 20
    if (!ok) {
      console.log(`::warning::Traducción descartada (${m.ns} · ${m.key}): ${JSON.stringify(es)}`)
      return
    }
    pack[m.ns] ??= {}
    if (pack[m.ns][m.key] !== undefined) return
    pack[m.ns][m.key] = es.trim()
    added.push({ ns: m.ns, key: m.key, es: es.trim() })
  })
}
finish(added)
