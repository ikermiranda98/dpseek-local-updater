/** Texto de cada página de un PDF, con el mismo lector (y su Worker) que la vista previa. Añadido por dpseek-local-updater. */
import { openPdf } from './runtime.ts'

/**
 * @param data - el PDF completo.
 * @param signal - cancelación.
 * @returns el texto de cada página, en orden.
 */
export async function localPdfText(data: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<string[]> {
  let failure: Error | undefined
  const session = openPdf(data, signal, (error) => { failure = error })
  try {
    const document = await session.document
    const pages: string[] = []
    for (let number = 1; number <= document.numPages; number++) {
      signal.throwIfAborted()
      if (failure !== undefined) throw failure
      const page = await document.getPage(number)
      try {
        const content = await page.getTextContent()
        pages.push(content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join(''))
      } finally {
        page.cleanup()
      }
    }
    return pages
  } finally {
    await session.dispose()
  }
}
