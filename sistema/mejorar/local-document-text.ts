/**
 * Texto de un documento para «Improve message» (añadido por dpseek-local-updater).
 *
 * Todo se lee en el equipo, sin internet: los ficheros de texto tal cual, los PDF
 * con el lector de PDF de las vistas previas de la app (local-pdf-bridge.ts, que lo
 * publica en un símbolo global) y los .docx con un lector mínimo de ZIP (el texto
 * está en word/document.xml).
 */
import type { LocalImproveDocument } from './local-improve-bridge.ts'

/** Más grande no tiene sentido para un prompt (y el Host solo lee el principio). */
const MAX_BYTES = 50 * 1024 * 1024
const MAX_CHARS = 400_000

const TEXT = new Set([
  'txt', 'md', 'markdown', 'rst', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'xml', 'html', 'htm',
  'log', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php',
  'swift', 'sql', 'sh', 'ps1', 'bat', 'css', 'scss', 'vue', 'svelte',
])

/** Lo que admite el selector de ficheros. */
export const DOCUMENT_ACCEPT = ['.pdf', '.docx', ...[...TEXT].map((ext) => `.${ext}`)].join(',')

type PdfText = (data: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<string[]>
const PDF_KEY = Symbol.for('dpseek-local-updater.pdf-text')

/**
 * @param file - el fichero elegido o soltado.
 * @param signal - cancelación.
 * @returns su texto (los PDF con «[p. N]» al principio de cada página).
 */
export async function localDocumentText(file: File, signal: AbortSignal): Promise<LocalImproveDocument> {
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 50 MB`)
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  let text: string
  let pages: number | undefined
  if (ext === 'pdf') {
    const read = (globalThis as Record<symbol, unknown>)[PDF_KEY] as PdfText | undefined
    if (read === undefined) throw new Error('the PDF reader is not available')
    const list = await read(new Uint8Array(await file.arrayBuffer()), signal)
    pages = list.length
    text = list.map((page, index) => `[p. ${String(index + 1)}]\n${page.trim()}`).join('\n\n')
    if (list.every((page) => page.trim() === '')) {
      throw new Error(`${file.name} has no text to read (it may be a scanned image)`)
    }
  } else if (ext === 'docx') {
    text = await docxText(new Uint8Array(await file.arrayBuffer()))
  } else if (TEXT.has(ext) || file.type.startsWith('text/')) {
    text = await file.text()
  } else {
    throw new Error(`.${ext} files are not supported (use PDF, DOCX or a text file)`)
  }
  signal.throwIfAborted()
  text = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (text === '') throw new Error(`${file.name} is empty`)
  return { name: file.name, text: text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text, ...pages === undefined ? {} : { pages } }
}

/** Texto de un .docx: word/document.xml sin etiquetas, con un salto por párrafo. */
async function docxText(zip: Uint8Array): Promise<string> {
  const xml = new TextDecoder().decode(await zipEntry(zip, 'word/document.xml'))
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' }
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:(br|cr)\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => entities[name] ?? '')
    .replace(/&#(x?)([0-9a-f]+);/gi, (_, hex: string, code: string) => String.fromCodePoint(Number.parseInt(code, hex === '' ? 10 : 16)))
}

/** Un fichero de un ZIP, por el directorio central (sin librerías: DecompressionStream inflará el deflate). */
async function zipEntry(zip: Uint8Array, name: string): Promise<Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let end = -1
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 65_557); at--) {
    if (view.getUint32(at, true) === 0x06054b50) { end = at; break }
  }
  if (end < 0) throw new Error('not a valid DOCX file')
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  for (let index = 0; index < count && view.getUint32(at, true) === 0x02014b50; index++) {
    const method = view.getUint16(at + 10, true)
    const compressed = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const extra = view.getUint16(at + 30, true)
    const comment = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const entry = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength))
    if (entry === name) {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
      const data = zip.slice(start, start + compressed)
      if (method === 0) return data
      if (method !== 8) throw new Error('unsupported DOCX compression')
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      return new Uint8Array(await new Response(stream).arrayBuffer())
    }
    at += 46 + nameLength + extra + comment
  }
  throw new Error('not a valid DOCX file (no word/document.xml)')
}
