/**
 * Texto de un PDF para «Improve message» (añadido por dpseek-local-updater).
 *
 * Las vistas previas ya traen el lector de PDF; aquí se publica en un símbolo global
 * para que el botón del cuadro de texto (otro paquete) lo use. El lector solo se
 * carga la primera vez que hace falta, y desde el mismo trozo diferido que la vista
 * previa (pdf.tsx lo reexporta): otro import diferido crearía un trozo compartido
 * que el cargador de módulos de la app no conoce.
 */
const KEY = Symbol.for('dpseek-local-updater.pdf-text')

/** @returns cómo retirarlo al descargarse las vistas previas. */
export function setLocalPdfText(): () => void {
  const read = async (data: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<string[]> =>
    (await import('./pdf.tsx')).localPdfText(data, signal)
  ;(globalThis as Record<symbol, unknown>)[KEY] = read
  return () => {
    if ((globalThis as Record<symbol, unknown>)[KEY] === read) Reflect.deleteProperty(globalThis, KEY)
  }
}
