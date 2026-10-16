/**
 * «Update Ollama» en el menú del selector de modelos (añadido por dpseek-local-updater).
 *
 * Solo aparece cuando hay una versión nueva de Ollama (o una actualización en
 * curso): enseña la versión, las novedades y un botón que la instala desde la app
 * (local-ollama-update.ts en el Host): espera a las respuestas en marcha,
 * descarga, instala en silencio, vuelve a abrir Ollama y mide el modelo por defecto.
 */
import { useEffect, useState } from 'react'
import css from './LocalOllamaUpdate.module.css'

/** Estado de la actualización, como lo da el Host. */
export interface LocalOllamaUpdateState {
  readonly phase: 'idle' | 'waiting' | 'downloading' | 'installing' | 'starting' | 'done' | 'error'
  readonly percent?: number
  readonly waitingFor?: number
  readonly message?: string
  readonly version?: string
}

/** Versiones, novedades y estado. */
export interface LocalOllamaUpdateInfo {
  readonly installed: string | null
  readonly latest: string | null
  readonly available: boolean
  readonly highlights: readonly string[]
  readonly url: string | null
  readonly state: LocalOllamaUpdateState
}

/** Llamadas al Host que monta index.ts. */
export interface LocalOllamaUpdater {
  info: (force: boolean) => Promise<LocalOllamaUpdateInfo>
  start: () => Promise<{ readonly started: boolean }>
}

let updater: LocalOllamaUpdater | undefined

/** Lo llama apply() con las llamadas remotas del Host. */
export function setLocalOllamaUpdater(next: LocalOllamaUpdater | undefined): void {
  updater = next
}

const BUSY = new Set(['waiting', 'downloading', 'installing', 'starting'])

function stateText(info: LocalOllamaUpdateInfo): string {
  const { state } = info
  const version = state.version ?? info.latest ?? ''
  switch (state.phase) {
    case 'waiting': {
      const n = state.waitingFor ?? 0
      return `Waiting for ${String(n)} ${n === 1 ? 'reply' : 'replies'} to finish before updating Ollama…`
    }
    case 'downloading': return `Downloading Ollama ${version}… ${String(state.percent ?? 0)}%`
    case 'installing': return `Installing Ollama ${version}…`
    case 'starting': return 'Starting Ollama again…'
    case 'done': return `Ollama updated to ${version}.${state.message === undefined ? '' : ` ${state.message}`}`
    case 'error': return `Ollama could not be updated: ${state.message ?? 'unknown error'}`
    default: return `Ollama ${info.latest ?? ''} is available (you have ${info.installed ?? '?'})`
  }
}

/**
 * La fila de la actualización de Ollama, o nada si está al día.
 * @returns la fila.
 */
export function LocalOllamaUpdate() {
  const [info, setInfo] = useState<LocalOllamaUpdateInfo | null>(null)
  const [notes, setNotes] = useState(false)
  const busy = info !== null && BUSY.has(info.state.phase)
  // Al abrir el menú se consulta; mientras se actualiza, se sigue el progreso.
  useEffect(() => {
    let alive = true
    const load = (): void => {
      updater?.info(false).then((next) => { if (alive) setInfo(next) }, () => undefined)
    }
    load()
    const timer = busy ? setInterval(load, 1500) : undefined
    return () => { alive = false; clearInterval(timer) }
  }, [busy])
  if (updater === undefined || info === null) return null
  const phase = info.state.phase
  if (!info.available && (phase === 'idle')) return null
  const start = (): void => {
    updater?.start().then(() => updater?.info(false)).then((next) => { if (next !== undefined) setInfo(next) }, () => undefined)
  }
  return (
    <div className={css.box} data-local-ollama-update={phase} onClick={(event) => { event.stopPropagation() }}>
      <div className={css.line}>
        <span className={css.text} data-error={phase === 'error' || undefined}>{stateText(info)}</span>
        {(phase === 'idle' || phase === 'error') && info.available && (
          <button type="button" className={css.update} onClick={start}>{phase === 'error' ? 'Retry' : 'Update'}</button>
        )}
      </div>
      {busy && phase === 'downloading' && (
        <div className={css.bar}><span style={{ width: `${String(info.state.percent ?? 0)}%` }} /></div>
      )}
      {phase === 'idle' && info.highlights.length > 0 && (
        <button type="button" className={css.notesToggle} aria-expanded={notes} onClick={() => { setNotes((value) => !value) }}>
          {notes ? 'Hide what’s new' : 'What’s new'}
        </button>
      )}
      {notes && phase === 'idle' && (
        <ul className={css.notes}>
          {info.highlights.map((line, index) => <li key={index}>{line}</li>)}
        </ul>
      )}
      {phase === 'idle' && (
        <p className={css.hint}>Waits for running replies, then installs and reopens Ollama (about a minute).</p>
      )}
    </div>
  )
}
