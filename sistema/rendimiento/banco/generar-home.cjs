// Genera un DSH_HOME de prueba de rendimiento a partir de los turnos de un chat real:
// muchos chats cortos, algunos medianos y uno muy largo, en un proyecto propio.
// Uso: node generar-home.cjs <session.v4.jsonl.zstd de origen> <carpeta destino>
'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { randomUUID, randomBytes } = require('crypto')

const [source, target] = process.argv.slice(2)
const SHORT = 150
const MEDIUM = 3
const MEDIUM_TURNS = 48
const LONG_TURNS = 400

function readEvents(file) {
  const b = fs.readFileSync(file)
  const offs = []
  for (let i = 0; i < b.length - 3; i++) if (b[i] === 0x28 && b[i + 1] === 0xb5 && b[i + 2] === 0x2f && b[i + 3] === 0xfd) offs.push(i)
  let text = ''
  for (let k = 0; k < offs.length; k++) text += zlib.zstdDecompressSync(b.subarray(offs[k], offs[k + 1] ?? b.length)).toString('utf8')
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

const events = readEvents(source)
const header = events[0]
const preamble = events.filter((e) => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(e.type))
const DROP = new Set(['session/end-seed', 'subagent/catalog', 'workspace/changes', 'session/title-llm-request'])
// Bloques de turno: desde el mensaje del usuario en la cola hasta turn/end.
const blocks = []
let current = null
for (const e of events.slice(1)) {
  if (e.type === 'agent/inbox/spliced' && (e.data.inserted ?? []).length > 0 && current === null) current = []
  if (current === null) continue
  if (!DROP.has(e.type)) current.push(e)
  if (e.type === 'turn/end') { blocks.push(current); current = null }
}
if (blocks.length === 0) throw new Error('sin turnos')
console.log('turnos de origen:', blocks.length)

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const CALL = /"(?:id|callId|toolCallId)":"([A-Za-z0-9]{32})"/g
const alnum = () => randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(32, 'x').slice(0, 32)

/** Copia un turno con ids nuevos, seq y número de turno renumerados y un texto de usuario opcional. */
function copyBlock(block, state, userText, title) {
  const ids = new Map()
  const calls = new Map()
  const seqs = new Map()
  const out = []
  for (const e of block) {
    // El título solo en el primer turno, con el texto de este chat.
    if (e.type === 'session/title' && (title === undefined || e.data.source?.kind !== 'provider')) continue
    let json = JSON.stringify(e)
      .replace(UUID, (id) => { if (!ids.has(id)) ids.set(id, randomUUID()); return ids.get(id) })
      .replace(CALL, (all, id) => { if (!calls.has(id)) calls.set(id, alnum()); return all.replace(id, calls.get(id)) })
    const copy = JSON.parse(json)
    seqs.set(e.seq, state.seq)
    copy.seq = state.seq++
    state.time += 400
    copy.time = state.time
    if (copy.data && typeof copy.data.turn === 'number') copy.data.turn = state.turn
    if (copy.type === 'session/title') { copy.data.title = title; copy.data.messageSeqs = copy.data.messageSeqs.map((s) => seqs.get(s) ?? s) }
    if (Array.isArray(copy.sourceEventSeqs)) copy.sourceEventSeqs = copy.sourceEventSeqs.map((s) => seqs.get(s) ?? s)
    if (userText !== undefined) {
      if (copy.type === 'user/message' && copy.data.source?.kind === 'user') copy.data.content = [{ type: 'text', text: userText }]
      if (copy.type === 'agent/inbox/spliced') for (const m of copy.data.inserted ?? []) if (m.source?.kind === 'user') m.content = [{ type: 'text', text: userText }]
    }
    out.push(copy)
  }
  state.turn++
  return out
}

function writeSession(dir, id, cwd, title, turns, markers) {
  const state = { seq: 0, time: Date.UTC(2026, 8, 1) + Math.floor(Math.random() * 1e9), turn: 1 }
  const lines = [{ ...header, id, cwd, createdAt: state.time }]
  for (const e of preamble) lines.push({ ...e, seq: state.seq++, time: state.time })
  for (let t = 0; t < turns; t++) {
    const text = t === 0 ? markers?.first : t === turns - 1 ? markers?.last : undefined
    lines.push(...copyBlock(blocks[t % blocks.length], state, text, t === 0 ? title : undefined))
  }
  // Un frame zstd cada pocos eventos, como la app al ir añadiendo.
  // La cabecera va sola en el primer frame: la lista de chats solo lee ese.
  const frames = [zlib.zstdCompressSync(Buffer.from(JSON.stringify(lines[0]) + '\n'))]
  for (let i = 1; i < lines.length; i += 8) {
    frames.push(zlib.zstdCompressSync(Buffer.from(lines.slice(i, i + 8).map((l) => JSON.stringify(l)).join('\n') + '\n')))
  }
  fs.mkdirSync(path.join(dir, id), { recursive: true })
  fs.writeFileSync(path.join(dir, id, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
  return lines.length
}

const project = path.join(target, 'proyecto')
fs.mkdirSync(project, { recursive: true })
for (const name of ['calculadora.py', 'notas.txt', 'README.md']) fs.writeFileSync(path.join(project, name), `# ${name}\n`)
const home = path.join(target, 'home')
const encoded = '--' + project.replace(/:/g, '').replace(/[\\/]/g, '-') + '--'
const sessionsDir = path.join(home, 'sessions', encoded)
fs.mkdirSync(sessionsDir, { recursive: true })
const ids = []
let total = 0
const longId = `session-${randomUUID()}`
total += writeSession(sessionsDir, longId, project, 'BENCH chat largo', LONG_TURNS, { first: 'INICIO-DEL-CHAT-LARGO', last: 'FIN-DEL-CHAT-LARGO' })
ids.push(longId)
for (let m = 0; m < MEDIUM; m++) {
  const id = `session-${randomUUID()}`
  total += writeSession(sessionsDir, id, project, `BENCH chat mediano ${m + 1}`, MEDIUM_TURNS, { last: `FIN-DEL-CHAT-MEDIANO-${m + 1}` })
  ids.push(id)
}
for (let s = 0; s < SHORT; s++) {
  const id = `session-${randomUUID()}`
  total += writeSession(sessionsDir, id, project, `BENCH chat corto ${s + 1}`, 2, { last: `FIN-DEL-CHAT-CORTO-${s + 1}` })
  ids.push(id)
}
const workspaceId = randomUUID()
const now = new Date().toISOString()
fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, defaultWorkspaceId: workspaceId, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [] },
  tables: { workspaces: { [workspaceId]: { path: project, title: 'bench-proyecto', sessionIds: ids, createdAt: now, updatedAt: now } } },
}, null, 2))
fs.writeFileSync(path.join(target, 'bench.json'), JSON.stringify({ longId, ids: ids.length, events: total }, null, 2))
console.log('chats:', ids.length, 'eventos:', total, 'largo:', longId)
