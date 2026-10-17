/**
 * Texto de un documento para «Improve message» (añadido por dpseek-local-updater).
 *
 * Todo se lee en el equipo, sin internet: los ficheros de texto tal cual, los PDF
 * con el lector de PDF de las vistas previas de la app (local-pdf-bridge.ts, que lo
 * publica en un símbolo global) y los .docx con un lector mínimo de ZIP y de su XML:
 * títulos como «#», listas con su numeración, tablas como tablas Markdown y notas al
 * pie; sin el texto borrado del control de cambios, sin los códigos de los campos
 * (índices, enlaces) y sin el índice.
 */
import type { LocalImproveDocument } from './local-improve-bridge.ts'

/** Más grande no tiene sentido para un prompt. */
const MAX_BYTES = 50 * 1024 * 1024
/** Lo que cabe en el mensaje (unos 70k tokens de los 131k del chat): de ahí en adelante se corta. */
export const DOCUMENT_MAX_CHARS = 240_000

const TEXT = new Set([
  'txt', 'md', 'markdown', 'rst', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'xml', 'html', 'htm',
  'log', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php',
  'swift', 'sql', 'sh', 'ps1', 'bat', 'css', 'scss', 'vue', 'svelte',
])

/** Lo que admite el selector de ficheros. */
export const DOCUMENT_ACCEPT = ['.pdf', '.docx', ...[...TEXT].map((ext) => `.${ext}`)].join(',')

/** El documento leído, con lo que la tarjeta cuenta de él. */
export interface LocalDocument extends LocalImproveDocument {
  readonly words: number
  /** Si no cabía entero: qué parte se ha leído («pages 1–80 of 200»). */
  readonly cut?: string
  /** Páginas de un PDF sin texto (escaneadas). */
  readonly blank?: number
}

type PdfText = (data: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<string[]>
const PDF_KEY = Symbol.for('dpseek-local-updater.pdf-text')

/**
 * @param file - el fichero elegido o soltado.
 * @param signal - cancelación.
 * @returns su texto (los PDF con «[p. N]» al principio de cada página).
 */
export async function localDocumentText(file: File, signal: AbortSignal): Promise<LocalDocument> {
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 50 MB`)
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  let text: string
  let pages: number | undefined
  let blank = 0
  let cut: string | undefined
  if (ext === 'pdf') {
    const read = (globalThis as Record<symbol, unknown>)[PDF_KEY] as PdfText | undefined
    if (read === undefined) throw new Error('the PDF reader is not available')
    const list = await read(new Uint8Array(await file.arrayBuffer()), signal)
    pages = list.length
    blank = list.filter((page) => page.trim() === '').length
    if (blank === list.length) throw new Error(`${file.name} has no text to read (it may be a scanned image)`)
    // Por páginas enteras: así se puede decir hasta dónde se ha leído.
    const kept: string[] = []
    let size = 0
    for (const [index, page] of list.entries()) {
      const block = `[p. ${String(index + 1)}]\n${tidy(page)}`
      if (size + block.length > DOCUMENT_MAX_CHARS && kept.length > 0) {
        cut = `pages 1–${String(index)} of ${String(list.length)}`
        break
      }
      kept.push(block)
      size += block.length + 2
    }
    text = kept.join('\n\n')
  } else if (ext === 'docx') {
    text = await docxText(new Uint8Array(await file.arrayBuffer()))
  } else if (TEXT.has(ext) || file.type.startsWith('text/')) {
    text = await file.text()
  } else {
    throw new Error(`.${ext} files are not supported (use PDF, DOCX or a text file)`)
  }
  signal.throwIfAborted()
  text = tidy(text)
  if (text === '') throw new Error(`${file.name} is empty`)
  if (text.length > DOCUMENT_MAX_CHARS) {
    const at = text.lastIndexOf('\n', DOCUMENT_MAX_CHARS)
    text = text.slice(0, at > DOCUMENT_MAX_CHARS / 2 ? at : DOCUMENT_MAX_CHARS)
    cut = `the first ${String(Math.round(DOCUMENT_MAX_CHARS / 1000))}k characters`
  }
  const words = text.split(/\s+/).filter((word) => word !== '' && !/^\[p\.$|^\d+\]$/.test(word)).length
  return {
    name: file.name, text, words,
    ...pages === undefined ? {} : { pages }, ...cut === undefined ? {} : { cut }, ...blank === 0 ? {} : { blank },
  }
}

function tidy(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Texto de un .docx en Markdown sencillo. */
export async function docxText(zip: Uint8Array): Promise<string> {
  const decode = (bytes: Uint8Array | null): string => (bytes === null ? '' : new TextDecoder().decode(bytes))
  const body = await zipEntry(zip, 'word/document.xml')
  if (body === null) throw new Error('not a valid DOCX file (no word/document.xml)')
  const reader = new DocxReader(decode(await zipEntry(zip, 'word/styles.xml')), decode(await zipEntry(zip, 'word/numbering.xml')))
  const parts = [reader.read(decode(body))]
  for (const [file, tag, prefix] of [['word/footnotes.xml', 'footnote', ''], ['word/endnotes.xml', 'endnote', 'e']] as const) {
    const notes = reader.notes(decode(await zipEntry(zip, file)), tag, prefix)
    if (notes !== '') parts.push(notes)
  }
  return parts.join('\n\n')
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' }
const unescape = (text: string): string => text
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name] ?? '')
  .replace(/&#(x?)([0-9a-f]+);/gi, (_, hex: string, code: string) => String.fromCodePoint(Number.parseInt(code, hex === '' ? 10 : 16)))

const attribute = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

/**
 * Lo que no es texto del documento: lo borrado o movido con control de cambios, la
 * versión alternativa de los cuadros de texto (repite el texto), la configuración de
 * la sección y los formatos anteriores a un cambio (traen otro estilo de párrafo).
 */
const SKIPPED = new Set([
  'w:del', 'w:moveFrom', 'mc:Fallback', 'w:sectPr', 'w:pPrChange', 'w:rPrChange', 'w:tblPrChange', 'w:trPrChange',
  'w:tcPrChange', 'w:numberingChange', 'w:tblGrid',
])

/** Marca de los elementos de lista: los seguidos van sin línea en blanco entre ellos. */
const ITEM = '\u0000'

interface Paragraph { text: string; style?: string; numId?: string; ilvl: number; outline?: number }
interface Cell { readonly blocks: string[] }
interface Table { readonly rows: string[][]; row: string[] | null; cell: Cell | null; readonly parentCell: Cell | null }
interface Style { readonly name: string; readonly outline?: number; readonly numId?: string; readonly ilvl?: number; readonly basedOn?: string }
interface Resolved { readonly name: string; readonly outline: number | undefined; readonly numId: string | undefined; readonly ilvl: number | undefined }
interface Level { readonly format: string; readonly text: string; readonly start: number }

class DocxReader {
  private readonly styles = new Map<string, Style>()
  private readonly numbering = new Map<string, Map<number, Level>>()
  private counters = new Map<string, number[]>()

  constructor(styles: string, numbering: string) {
    for (const match of styles.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
      const id = attribute(match[1] ?? '', 'w:styleId')
      const inner = match[2] ?? ''
      if (id === undefined) continue
      const outline = /<w:outlineLvl w:val="(\d)"/.exec(inner)?.[1]
      const numId = /<w:numId w:val="(\d+)"/.exec(inner)?.[1]
      const ilvl = /<w:ilvl w:val="(\d)"/.exec(inner)?.[1]
      const basedOn = /<w:basedOn w:val="([^"]+)"/.exec(inner)?.[1]
      this.styles.set(id, {
        // Los estilos de Word guardan su nombre en inglés aunque la interfaz esté en otro idioma («heading 1»).
        name: (/<w:name w:val="([^"]+)"/.exec(inner)?.[1] ?? id).toLowerCase(),
        ...outline === undefined || Number(outline) > 8 ? {} : { outline: Number(outline) },
        ...numId === undefined ? {} : { numId },
        ...ilvl === undefined ? {} : { ilvl: Number(ilvl) },
        ...basedOn === undefined ? {} : { basedOn },
      })
    }
    const abstract = new Map<string, Map<number, Level>>()
    for (const match of numbering.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
      const levels = new Map<number, Level>()
      for (const level of (match[2] ?? '').matchAll(/<w:lvl\b[^>]*w:ilvl="(\d)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
        const inner = level[2] ?? ''
        levels.set(Number(level[1]), {
          format: /<w:numFmt w:val="([^"]+)"/.exec(inner)?.[1] ?? 'decimal',
          text: unescape(/<w:lvlText w:val="([^"]*)"/.exec(inner)?.[1] ?? ''),
          start: Number(/<w:start w:val="(\d+)"/.exec(inner)?.[1] ?? '1'),
        })
      }
      abstract.set(match[1] ?? '', levels)
    }
    for (const match of numbering.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
      const id = /<w:abstractNumId w:val="(\d+)"/.exec(match[2] ?? '')?.[1]
      const levels = id === undefined ? undefined : abstract.get(id)
      if (levels !== undefined) this.numbering.set(match[1] ?? '', levels)
    }
  }

  /** El estilo con lo que hereda de sus bases (un título propio suele basarse en «heading N»). */
  private style(id: string | undefined): Resolved | undefined {
    const chain: Style[] = []
    const seen = new Set<string>()
    for (let current = id; current !== undefined && !seen.has(current);) {
      seen.add(current)
      const style = this.styles.get(current)
      if (style === undefined) break
      chain.push(style)
      current = style.basedOn
    }
    const own = chain[0]
    if (own === undefined) return undefined
    const heading = chain.map((style) => /^heading (\d)$/.exec(style.name)).find((match) => match !== null)
    const numbered = chain.find((style) => style.numId !== undefined)
    return {
      name: own.name,
      outline: chain.find((style) => style.outline !== undefined)?.outline ?? (heading == null ? undefined : Number(heading[1]) - 1),
      numId: numbered?.numId,
      ilvl: numbered?.ilvl,
    }
  }

  /** «1.2.», «a)» o «-» para un elemento de lista, llevando la cuenta por lista y nivel. */
  private marker(numId: string, ilvl: number): string | null {
    const levels = this.numbering.get(numId)
    const level = levels?.get(ilvl)
    if (levels === undefined || level === undefined || level.format === 'none') return null
    if (level.format === 'bullet') return '-'
    const counts = this.counters.get(numId) ?? []
    counts[ilvl] = (counts[ilvl] ?? level.start - 1) + 1
    counts.length = ilvl + 1
    this.counters.set(numId, counts)
    const text = level.text.replace(/%(\d)/g, (_, n: string) => {
      const at = Number(n) - 1
      return formatNumber(counts[at] ?? levels.get(at)?.start ?? 1, levels.get(at)?.format ?? 'decimal')
    }).trim()
    return text === '' ? '-' : text
  }

  /** @returns el párrafo en Markdown, '' si está vacío o null si sobra (el índice). */
  private finish(paragraph: Paragraph): string | null {
    const style = this.style(paragraph.style)
    if (style !== undefined && /^(toc \d|toc heading)$/.test(style.name)) return null
    const text = paragraph.text.replace(/[ \t]+/g, (space) => (space.includes('\t') ? '\t' : ' ')).trim()
    if (text === '') return ''
    const outline = paragraph.outline ?? style?.outline ?? (style?.name === 'title' ? 0 : undefined)
    const numId = paragraph.numId ?? style?.numId
    const ilvl = paragraph.numId === undefined ? style?.ilvl ?? paragraph.ilvl : paragraph.ilvl
    const marker = numId === undefined || numId === '0' ? null : this.marker(numId, ilvl)
    if (outline !== undefined && outline < 6) {
      return `${'#'.repeat(outline + 1)} ${marker === null || marker === '-' ? '' : `${marker} `}${text}`
    }
    if (marker !== null) return `${ITEM}${'  '.repeat(ilvl)}${marker} ${text}`
    return text
  }

  /** @returns el texto de un trozo de WordprocessingML (el cuerpo o una nota). */
  read(xml: string): string {
    this.counters = new Map()
    const blocks: string[] = []
    const paragraphs: Paragraph[] = []
    const tables: Table[] = []
    // Un campo (índice, enlace, número de página) es «código» hasta separate y «resultado» hasta end.
    const fields: { instr: string; result: boolean }[] = []
    // Bloques de contenido; true si es el índice.
    const sdt: boolean[] = []
    let skip = 0
    let inText = false
    let inInstr = false
    const emit = (block: string): void => {
      const cell = tables.at(-1)?.cell
      if (cell != null) cell.blocks.push(block)
      else blocks.push(block)
    }
    const collecting = (): boolean => !sdt.some(Boolean)
      && fields.every((field) => field.result && !/^\s*TOC\b/.test(field.instr))
    for (const match of xml.matchAll(/<([^>]*)>|([^<]+)/g)) {
      const tag = match[1]
      if (tag === undefined) {
        if (skip > 0) continue
        const value = unescape(match[2] ?? '')
        const field = fields.at(-1)
        const paragraph = paragraphs.at(-1)
        if (inInstr) { if (field !== undefined) field.instr += value }
        else if (inText && paragraph !== undefined && collecting()) paragraph.text += value
        continue
      }
      if (tag.startsWith('?') || tag.startsWith('!')) continue
      const closing = tag.startsWith('/')
      const selfClosing = tag.endsWith('/')
      const name = (closing ? tag.slice(1) : tag).split(/[\s/]/, 1)[0] ?? ''
      if (skip > 0) {
        if (closing) skip--
        else if (!selfClosing) skip++
        continue
      }
      if (!closing && SKIPPED.has(name)) {
        if (!selfClosing) skip = 1
        continue
      }
      const paragraph = paragraphs.at(-1)
      const table = tables.at(-1)
      if (closing) {
        if (name === 'w:t') inText = false
        else if (name === 'w:instrText') inInstr = false
        else if (name === 'w:p') {
          const done = paragraphs.pop()
          const text = done === undefined || sdt.some(Boolean) ? null : this.finish(done)
          if (text !== null) emit(text)
        } else if (name === 'w:tc') {
          if (table?.cell != null && table.row !== null) {
            table.row.push(table.cell.blocks.filter((block) => block !== '').map((block) => block.replace(ITEM, ''))
              .join('<br>').replace(/\|/g, '\\|'))
          }
          if (table !== undefined) table.cell = null
        } else if (name === 'w:tr') {
          if (table?.row != null) table.rows.push(table.row)
          if (table !== undefined) table.row = null
        } else if (name === 'w:tbl') {
          tables.pop()
          const rendered = table === undefined ? '' : renderTable(table.rows)
          if (rendered === '') continue
          if (table?.parentCell != null) table.parentCell.blocks.push(...rendered.split('\n'))
          else blocks.push(rendered)
        } else if (name === 'w:sdt') sdt.pop()
        continue
      }
      const text = paragraph !== undefined && collecting()
      switch (name) {
        case 'w:p': paragraphs.push({ text: '', ilvl: 0 }); break
        case 'w:t': if (!selfClosing) inText = true; break
        case 'w:instrText': if (!selfClosing) inInstr = true; break
        // Con w:val es una tabulación de la regla (formato del párrafo), no un tabulador del texto.
        case 'w:tab': if (text && attribute(tag, 'w:val') === undefined) paragraph.text += '\t'; break
        case 'w:br': case 'w:cr': if (text) paragraph.text += '\n'; break
        case 'w:noBreakHyphen': if (text) paragraph.text += '-'; break
        case 'w:pStyle': { const value = attribute(tag, 'w:val'); if (paragraph !== undefined && value !== undefined) paragraph.style = value; break }
        case 'w:numId': { const value = attribute(tag, 'w:val'); if (paragraph !== undefined && value !== undefined) paragraph.numId = value; break }
        case 'w:ilvl': if (paragraph !== undefined) paragraph.ilvl = Number(attribute(tag, 'w:val') ?? '0'); break
        case 'w:outlineLvl': {
          const value = Number(attribute(tag, 'w:val') ?? '9')
          if (paragraph !== undefined && value < 9) paragraph.outline = value
          break
        }
        case 'w:fldChar': {
          const type = attribute(tag, 'w:fldCharType')
          const field = fields.at(-1)
          if (type === 'begin') fields.push({ instr: '', result: false })
          else if (type === 'separate' && field !== undefined) field.result = true
          else if (type === 'end') fields.pop()
          break
        }
        case 'w:footnoteReference': case 'w:endnoteReference':
          if (text) paragraph.text += `[^${name === 'w:endnoteReference' ? 'e' : ''}${attribute(tag, 'w:id') ?? ''}]`
          break
        case 'w:sdt': if (!selfClosing) sdt.push(false); break
        case 'w:docPartGallery':
          if (sdt.length > 0 && /Table of Contents/i.test(attribute(tag, 'w:val') ?? '')) sdt[sdt.length - 1] = true
          break
        case 'w:tbl': tables.push({ rows: [], row: null, cell: null, parentCell: table?.cell ?? null }); break
        case 'w:tr': if (table !== undefined) table.row = []; break
        case 'w:tc': if (table !== undefined) table.cell = { blocks: [] }; break
        default: break
      }
    }
    // Párrafos separados por una línea en blanco; los elementos seguidos de una lista, juntos.
    let out = ''
    let previousItem = false
    for (const block of blocks) {
      if (block === '') continue
      const item = block.startsWith(ITEM)
      const value = item ? block.slice(ITEM.length) : block
      out += out === '' ? value : (item && previousItem ? '\n' : '\n\n') + value
      previousItem = item
    }
    return out
  }

  /** @returns las notas al pie (o finales) como «[^N]: texto». */
  notes(xml: string, tag: 'footnote' | 'endnote', prefix: string): string {
    const lines: string[] = []
    for (const match of xml.matchAll(new RegExp(`<w:${tag}\\b([^>]*)>([\\s\\S]*?)</w:${tag}>`, 'g'))) {
      const head = match[1] ?? ''
      if (/w:type="(separator|continuationSeparator|continuationNotice)"/.test(head)) continue
      const text = this.read(match[2] ?? '').replace(/\s*\n+\s*/g, ' ').trim()
      if (text !== '') lines.push(`[^${prefix}${attribute(head, 'w:id') ?? ''}]: ${text}`)
    }
    return lines.join('\n')
  }
}

/** Una tabla Markdown; las de una sola columna (cuadros o maquetación), como párrafos. */
function renderTable(rows: readonly string[][]): string {
  const filled = rows.filter((row) => row.some((cell) => cell.trim() !== ''))
  const first = filled[0]
  if (first === undefined) return ''
  const columns = Math.max(...filled.map((row) => row.length))
  if (columns <= 1) return filled.map((row) => (row[0] ?? '').replace(/<br>/g, '\n').replace(/\\\|/g, '|')).join('\n\n')
  const line = (row: readonly string[]): string =>
    `| ${Array.from({ length: columns }, (_, index) => (row[index] ?? '').trim()).join(' | ')} |`
  return [line(first), `|${' --- |'.repeat(columns)}`, ...filled.slice(1).map(line)].join('\n')
}

function formatNumber(value: number, format: string): string {
  switch (format) {
    case 'lowerLetter': return letters(value).toLowerCase()
    case 'upperLetter': return letters(value)
    case 'lowerRoman': return roman(value).toLowerCase()
    case 'upperRoman': return roman(value)
    default: return String(value)
  }
}

function letters(value: number): string {
  let rest = Math.max(1, value)
  let text = ''
  while (rest > 0) {
    rest--
    text = String.fromCharCode(65 + (rest % 26)) + text
    rest = Math.floor(rest / 26)
  }
  return text
}

function roman(value: number): string {
  const marks: readonly (readonly [number, string])[] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'],
    [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
  let rest = Math.max(1, value)
  let text = ''
  for (const [size, mark] of marks) {
    while (rest >= size) {
      text += mark
      rest -= size
    }
  }
  return text
}

/** Un fichero de un ZIP, por el directorio central (sin librerías: DecompressionStream inflará el deflate). */
async function zipEntry(zip: Uint8Array, name: string): Promise<Uint8Array | null> {
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
    // Algunos programas guardan las rutas con «\».
    const entry = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength)).replaceAll('\\', '/')
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
  return null
}
