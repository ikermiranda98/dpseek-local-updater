/**
 * Si la ventana está a la vista (añadido por dpseek-local-updater).
 *
 * Cerrar la ventana solo la esconde: la app sigue viva en la bandeja para terminar lo que
 * esté haciendo. El mantenedor del modelo (precarga.cjs) lee este fichero: con la ventana
 * escondida un rato descarga el modelo de Ollama (libera la RAM y la gráfica) y deja de
 * cargarlo; al volver a abrirla, lo carga enseguida.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { BrowserWindow } from 'electron'

const file = (): string => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', 'local-ventana.json')

function write(visible: boolean): void {
  try {
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify({ visible, at: Date.now() }))
  } catch {
    // Solo lo usa el mantenedor del modelo: sin el fichero, el modelo se queda cargado como antes.
  }
}

/** @param window - la ventana principal: se anota cada vez que se esconde o se vuelve a enseñar. */
export function localTrackWindow(window: BrowserWindow): void {
  window.on('hide', () => { write(false) })
  window.on('show', () => { write(true) })
}
