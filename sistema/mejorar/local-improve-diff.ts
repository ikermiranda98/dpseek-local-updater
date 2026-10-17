/**
 * Cambios entre tu texto y la sugerencia, para «Show changes» (añadido por dpseek-local-updater).
 *
 * Palabra a palabra (LCS). Al comparar se ignora el formato Markdown (asteriscos,
 * almohadillas, viñetas, comillas invertidas) y las mayúsculas: pasar «Cero fe» a
 * «**Cero fe**» no es un cambio de contenido. Se enseña el texto nuevo con lo añadido
 * marcado y lo quitado tachado. Un texto enorme se compara por líneas.
 */

/** Un trozo del resultado: igual, añadido o quitado. */
export interface LocalDiffPart {
  readonly kind: 'same' | 'add' | 'del'
  readonly text: string
}

/** Celdas de la tabla LCS por palabras (2 bytes cada una): ~50 MB como mucho, y solo un momento. */
const MAX_CELLS = 25_000_000

const normalize = (token: string): string => token.replace(/[*_#`>]/g, '').replace(/^\s*[-•]\s*$/, '').trim().toLowerCase()

/** Palabras con el espacio que las sigue (al unirlas vuelve el texto tal cual). */
const words = (text: string): string[] => text.match(/\S+\s*|\s+/g) ?? []

/** Pares (i, j) de claves iguales en orden. */
function lcs(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length
  const m = b.length
  const width = m + 1
  const table = Math.min(n, m) < 65_535 ? new Uint16Array((n + 1) * width) : new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[i]!
    const row = i * width
    const next = row + width
    for (let j = m - 1; j >= 0; j--) {
      table[row + j] = ai !== '' && ai === b[j] ? table[next + j + 1]! + 1 : Math.max(table[next + j]!, table[row + j + 1]!)
    }
  }
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] !== '' && a[i] === b[j]) { pairs.push([i, j]); i++; j++ } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++
    else j++
  }
  return pairs
}

function build(a: readonly string[], b: readonly string[], pairs: readonly [number, number][], join: string): LocalDiffPart[] {
  const out: LocalDiffPart[] = []
  const push = (wanted: LocalDiffPart['kind'], text: string): void => {
    // Solo formato (viñetas, almohadillas, numeración): no es un cambio de contenido.
    const formatting = /^(?:\s|[*_#`>\-•]+|\d+[.)])*$/.test(text)
    if (text === '' || (wanted === 'del' && formatting)) return
    const kind = wanted === 'add' && formatting ? 'same' : wanted
    const last = out[out.length - 1]
    if (last !== undefined && last.kind === kind) out[out.length - 1] = { kind, text: last.text + text }
    else out.push({ kind, text })
  }
  let i = 0
  let j = 0
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    push('del', a.slice(i, pi).join(join) + (pi > i && join !== '' ? join : ''))
    push('add', b.slice(j, pj).join(join) + (pj > j && join !== '' ? join : ''))
    if (pj < b.length) push('same', b[pj]! + (join !== '' && pj < b.length - 1 ? join : ''))
    i = pi + 1
    j = pj + 1
  }
  return out
}

/**
 * @param before - tu texto.
 * @param after - la sugerencia.
 * @returns los trozos de la sugerencia, con lo añadido y lo quitado marcados.
 */
export function localDiff(before: string, after: string): LocalDiffPart[] {
  const a = words(before)
  const b = words(after)
  if ((a.length + 1) * (b.length + 1) <= MAX_CELLS) {
    return build(a, b, lcs(a.map(normalize), b.map(normalize)), '')
  }
  const la = before.split('\n')
  const lb = after.split('\n')
  return build(la, lb, lcs(la.map(normalize), lb.map(normalize)), '\n')
}

/** @returns cuántas palabras se han añadido y quitado (para el botón «Show changes»). */
export function localDiffCount(parts: readonly LocalDiffPart[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const part of parts) {
    const count = part.text.trim() === '' ? 0 : part.text.trim().split(/\s+/).length
    if (part.kind === 'add') added += count
    if (part.kind === 'del') removed += count
  }
  return { added, removed }
}
