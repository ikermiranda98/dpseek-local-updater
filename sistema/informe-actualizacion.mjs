#!/usr/bin/env node
// Prepara local-update-info.json: lo que una versión nueva cambia para nuestras
// funciones. La app lo enseña antes de instalar como un semáforo (sección 18 de
// aplicar-cambios.mjs):
//   🔴 rojo:     se pierde alguna función nuestra que la versión anterior tenía;
//   🟡 ámbar:    DeepSeek ha cambiado ficheros que modifica alguna función nuestra
//                (se ha aplicado, pero conviene probarla), o ahora la trae la oficial;
//   🟢 verde:    nada de lo nuestro se ve afectado.
//
// Uso (lo ejecuta GitHub Actions; ver .github/workflows/compilar.yml):
//   node sistema/informe-actualizacion.mjs --tocados <json de aplicar-cambios>
//     --codigo <clon oficial> --oficial <dsh-vX> --build <versión de la app>
//     --salida <json> [--anterior <Release anterior>] [--anterior-informe <json>]
//     [--notas-oficiales <md>]
// Los textos van en inglés, como la app.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const args = {}
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1] ?? ''
for (const needed of ['tocados', 'codigo', 'oficial', 'build', 'salida']) {
  if (!args[needed]) { console.error(`falta --${needed}`); process.exit(1) }
}

// Nombre en inglés de cada función (el de aplicar-cambios.mjs si no está aquí).
const LABELS = {
  imprescindible: 'Ollama, no sign-in, no telemetry and updates',
  'opción «Eliminar sesión» en el menú de cada chat': 'Delete chats',
  'barra de contexto en el selector de modelo': 'Context bar in the model picker',
  'seleccionar chats como en el Explorador (borrar y mover a un proyecto)': 'Select chats like in Explorer (delete, move to a project)',
  'chats antiguos pasan solos al contexto recomendado': 'Old chats switch to the recommended context',
  'aviso de Windows al terminar una respuesta en segundo plano': 'Windows notification when a reply finishes',
  'no volver a ofrecer una versión retirada': 'Rolled-back versions are not offered again',
  'herramientas de modelos en el selector (optimizar, limpieza y modelos sin usar)': 'Model tools in the picker (optimize, cleanup)',
  'lista de Ollama al día al abrir el selector de modelos': 'Ollama list refreshed when opening the model picker',
  'editar tus mensajes y regenerar respuestas (con versiones)': 'Edit your messages and regenerate replies',
  'al pasar por un chat, solo el menú «⋯»': 'Only the ⋯ menu when hovering a chat',
  'aviso antes de instalar una actualización (semáforo y saltar versión)': 'Update notice before installing',
  'código en vivo en el panel derecho y deshacer por fichero': 'Live code in the right panel and per-file undo',
  subchats: 'Subchats',
  'actualizar Ollama desde la app': 'Update Ollama from the app',
  'cursor normal (flecha) salvo en los enlaces': 'Normal arrow cursor (hand only on links)',
  'el subchat se abre al 40 % de la zona de chat': 'Subchats open at 40% of the chat area',
  'mejorar un mensaje antes de enviarlo': 'Improve a message before sending it',
}
const label = (name) => LABELS[name] ?? name

const git = (cwd, ...params) => {
  try {
    return execFileSync('git', params, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}
const readJson = (file) => {
  try { return file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined } catch { return undefined }
}

const touched = readJson(args.tocados)
if (touched === undefined) { console.error(`no se puede leer ${args.tocados}`); process.exit(1) }
const previousReport = readJson(args['anterior-informe'])

// Release anterior: dsh-v<oficial>-local[-N]. De ahí sale la versión oficial anterior.
const previousRelease = args.anterior || ''
const previousOfficial = /^(dsh-v.+?)-local(?:-\d+)?$/.exec(previousRelease)?.[1]
const official = args.oficial
const version = (tag) => tag.replace(/^dsh-v/, '')
const officialChanged = previousOfficial !== undefined && previousOfficial !== official

// Ficheros oficiales que han cambiado entre las dos versiones (de los que tocamos).
const changes = new Map() // fichero → "+a −b"
let officialStat = ''
if (officialChanged) {
  git(args.codigo, 'fetch', '--depth', '1', 'origin', 'tag', previousOfficial)
  const files = [...new Set(touched.applied.flatMap((feature) => feature.files))]
  const numstat = git(args.codigo, 'diff', '--numstat', previousOfficial, 'HEAD', '--', ...files)
  if (numstat === undefined) {
    officialStat = `Could not compare with ${previousOfficial}.`
  } else {
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [added, removed, file] = line.split('\t')
      changes.set(file, `+${added} −${removed}`)
    }
    officialStat = git(args.codigo, 'diff', '--shortstat', previousOfficial, 'HEAD') ?? ''
  }
}
const comparable = !officialChanged || officialStat !== `Could not compare with ${previousOfficial}.`

const affected = touched.applied
  .map((feature) => ({ ...feature, changedFiles: feature.files.filter((file) => changes.has(file)) }))
  .filter((feature) => feature.changedFiles.length > 0)
// Lo imprescindible no cambia el semáforo: si no encaja, la compilación se detiene y
// no se publica nada (y la prueba de arranque lo confirma). Va solo en los detalles.
// Las que la versión anterior no tenía son nuevas: no hay nada que comparar.
const previouslyApplied = previousReport?.applied === undefined ? undefined : new Set(previousReport.applied)
const isNew = (feature) => previouslyApplied !== undefined && !previouslyApplied.has(feature.name)
const added = touched.applied.filter((feature) => feature.name !== 'imprescindible' && isNew(feature))
// Retoques visuales que tocan muchos ficheros: si DeepSeek cambia alguno, no hay
// nada que probar a mano (se aplican igual); van solo en los detalles.
const COSMETIC = new Set(['cursor normal (flecha) salvo en los enlaces'])
const changed = affected.filter((feature) => feature.name !== 'imprescindible' && !COSMETIC.has(feature.name) && !isNew(feature))

// Omitidas que la versión anterior sí tenía (sin informe anterior, todas cuentan).
const previouslyOmitted = new Set((previousReport?.omitted ?? []).map((feature) => feature.name))
const lost = touched.omitted.filter((feature) => !feature.official && !previouslyOmitted.has(feature.name))
const replaced = touched.omitted.filter((feature) => feature.official && !previouslyOmitted.has(feature.name))
const stillMissing = touched.omitted.filter((feature) => previouslyOmitted.has(feature.name))

const level = lost.length > 0 ? 'red' : changed.length > 0 || replaced.length > 0 || !comparable ? 'amber' : 'green'
const headline = {
  red: lost.length === 1 ? 'This version loses a local feature you have now' : `This version loses ${lost.length} local features you have now`,
  amber: changed.length > 0 ? 'DeepSeek changed code that some local features rely on' : 'Some local features changed with this version',
  green: 'Your local features carry over unchanged',
}[level]

// Cambios propios desde el Release anterior (asuntos de los commits).
const ownLog = previousRelease
  ? git(process.cwd(), 'log', '--no-merges', '--format=%s', `${previousRelease}..HEAD`, '--', 'sistema', 'config.json')
  : undefined
// Sin los commits revertidos ni los que los revierten.
const subjects = (ownLog ?? '').split('\n').filter(Boolean).map((line) => line.replace(/\s*\[skip ci\]/g, ''))
const reverted = new Set(subjects.map((line) => /^Revert "(.+)"$/.exec(line)?.[1]).filter(Boolean))
const ownChanges = subjects.filter((line) => !line.startsWith('Revert "') && !reverted.has(line))

const bullets = (items) => items.map((item) => `• ${item}`).join('\n')
const sections = []
sections.push(officialChanged
  ? `DeepSeek ${version(previousOfficial)} → ${version(official)}.`
  : previousOfficial !== undefined ? `Same DeepSeek version (${version(official)}); only local build changes.` : `DeepSeek ${version(official)}.`)
if (lost.length > 0) sections.push(`Lost in this version (they don't fit DeepSeek's new code):\n${bullets(lost.map((f) => label(f.name)))}`)
if (changed.length > 0) {
  sections.push(`Applied, but worth testing after updating:\n${bullets(changed.map((f) =>
    `${label(f.name)} · ${f.changedFiles.length} file${f.changedFiles.length === 1 ? '' : 's'}`))}`)
}
if (replaced.length > 0) sections.push(`Now provided by DeepSeek (theirs replaces ours):\n${bullets(replaced.map((f) => label(f.name)))}`)
if (!comparable) sections.push(`Couldn't compare DeepSeek's code with ${version(previousOfficial)}; test your local features after updating.`)
if (added.length > 0) sections.push(`New local features:\n${bullets(added.map((f) => label(f.name)))}`)
if (ownChanges.length > 0) {
  const shown = ownChanges.slice(0, 6)
  const more = ownChanges.length - shown.length
  sections.push(`Local build changes:\n${bullets(shown)}${more > 0 ? `\n• …and ${more} more (see the technical details)` : ''}`)
}
if (level !== 'green') sections.push('If something breaks, volver-a-version-anterior.ps1 (in each release) goes back to the previous version.')

const technical = []
technical.push(`Version ${args.build} (${official})${previousRelease ? `, previous release ${previousRelease}` : ''}.`)
if (officialStat) technical.push(`DeepSeek ${previousOfficial} → ${official}: ${officialStat}`)
for (const feature of affected) {
  technical.push(`${label(feature.name)}:\n${feature.changedFiles.map((file) => `  ${file} ${changes.get(file)}`).join('\n')}`)
}
if (ownChanges.length > 6) technical.push(`Local build changes:\n${bullets(ownChanges)}`)
for (const feature of [...lost, ...replaced, ...stillMissing]) technical.push(`Not applied — ${label(feature.name)}: ${feature.reason}`)
const notesFile = args['notas-oficiales']
const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, 'utf8').trim() : ''
if (officialChanged && notes) {
  technical.push(`DeepSeek's release notes:\n${notes.length > 1500 ? `${notes.slice(0, 1500)}…` : notes}`)
}
if (officialChanged) technical.push(`https://github.com/deepseek-ai/deepseek-harness/releases/tag/${official}`)

const report = {
  version: args.build,
  official: version(official),
  previousRelease: previousRelease || null,
  level,
  headline,
  detail: sections.join('\n\n'),
  technical: technical.join('\n\n'),
  applied: touched.applied.map((feature) => feature.name),
  omitted: touched.omitted.map(({ name, official: isOfficial }) => ({ name, official: isOfficial })),
}
writeFileSync(args.salida, JSON.stringify(report, null, 2) + '\n')
console.log(`Semáforo: ${level} — ${headline}`)
console.log(report.detail)
