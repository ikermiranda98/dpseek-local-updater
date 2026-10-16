/**
 * Aviso de actualizaciones de abajo a la izquierda, con Ollama (añadido por dpseek-local-updater).
 *
 * Si solo hay actualización de la app, es el botón oficial tal cual. Si hay de
 * Ollama (sola o junto con la de la app), el mismo botón abre un panel con una
 * fila por actualización: la de la app sigue su camino oficial (con el aviso
 * antes de instalar) y la de Ollama se instala desde aquí (local-ollama-update.ts
 * en el Host, a través de local-ollama-bridge.ts): espera a las respuestas en
 * marcha, descarga, instala en silencio y vuelve a abrir Ollama.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  IconDownloadOutlineRegular, IconLoadingOutlineRegular, Tooltip, useAnchoredPosition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopUpdateView } from '../types.ts'
import { DesktopUpdateIndicator, updateCopy } from './DesktopUpdateIndicator.tsx'
import indicatorCss from './DesktopUpdateIndicator.module.css'
import { ollamaUpdater, subscribeOllamaUpdater, type LocalOllamaUpdateInfo } from './local-ollama-bridge.ts'
import css from './LocalUpdatesIndicator.module.css'

type SettingsTranslate = PropsLocale<'settings'>['t']

/** Cada cuánto se mira si hay Ollama nuevo (el Host solo pregunta a GitHub cada 6 horas). */
const CHECK_EVERY_MS = 30 * 60_000
const OLLAMA_BUSY = new Set(['waiting', 'downloading', 'installing', 'starting'])
const APP_BUSY = new Set(['checking', 'downloading', 'verifying', 'installing'])

function ollamaText(info: LocalOllamaUpdateInfo): string {
  const { state } = info
  const version = state.version ?? info.latest ?? ''
  switch (state.phase) {
    case 'waiting': {
      const n = state.waitingFor ?? 0
      return `Waiting for ${String(n)} ${n === 1 ? 'reply' : 'replies'} to finish…`
    }
    case 'downloading': return `Downloading ${version}… ${String(state.percent ?? 0)}%`
    case 'installing': return `Installing ${version}…`
    case 'starting': return 'Starting Ollama again…'
    case 'done': return `Updated to ${version}.${state.message === undefined ? '' : ` ${state.message}`}`
    case 'error': return `Could not update: ${state.message ?? 'unknown error'}`
    default: return `${info.installed ?? '?'} → ${info.latest ?? ''}`
  }
}

/** Ollama: versiones y estado, al arrancar, cada media hora y, mientras se actualiza, cada segundo y medio. */
function useOllama(): [LocalOllamaUpdateInfo | null, () => void] {
  const updater = useSyncExternalStore(subscribeOllamaUpdater, ollamaUpdater)
  const [info, setInfo] = useState<LocalOllamaUpdateInfo | null>(null)
  const busy = info !== null && OLLAMA_BUSY.has(info.state.phase)
  useEffect(() => {
    if (updater === undefined) return
    let alive = true
    const load = (): void => { updater.info(false).then((next) => { if (alive) setInfo(next) }, () => undefined) }
    load()
    const timer = setInterval(load, busy ? 1500 : CHECK_EVERY_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [updater, busy])
  const start = (): void => {
    updater?.start().then(() => updater.info(false)).then((next) => { setInfo(next) }, () => undefined)
  }
  return [info, start]
}

/**
 * El aviso de actualizaciones, en lugar del oficial.
 * @param props - las del aviso oficial.
 * @returns el botón (y su panel), o nada si no hay actualizaciones.
 */
export function LocalUpdatesIndicator({ wide, hidden, t, view, onOpen }: {
  wide: boolean
  hidden: boolean
  t: SettingsTranslate
  view: DesktopUpdateView
  onOpen: () => void
}) {
  const [ollama, startOllama] = useOllama()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  // Fuera de la barra lateral (que recorta lo que sobresale), anclado encima del botón.
  const position = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', align: 'start', gap: 8, margin: 12 })
  const phase = ollama?.state.phase ?? 'idle'
  const ollamaBusy = OLLAMA_BUSY.has(phase)
  // «Hecho» solo se enseña si el panel ya estaba abierto: luego el aviso se va.
  const ollamaShown = ollama !== null && (ollama.available || ollamaBusy || phase === 'error' || (phase === 'done' && open))
  // Sin Ollama de por medio, el botón oficial tal cual.
  if (!ollamaShown) return <DesktopUpdateIndicator wide={wide} hidden={hidden} t={t} view={view} onOpen={onOpen} />
  if (!wide || hidden) return null

  const app = view.presentation
  const appShown = view.failed || (app !== undefined && app.phase !== 'idle')
  const retry = t('desktop.update.retry')
  const appCopy = app === undefined ? { label: retry, detail: retry } : updateCopy(app, t)
  const appLabel = view.failed ? retry : appCopy.label
  const appBusy = view.opening || (app !== undefined && APP_BUSY.has(app.phase))
  const error = view.failed || app?.phase === 'error' || phase === 'error'
  const busy = (appShown && appBusy) || ollamaBusy
  const label = appShown ? appLabel : ollamaBusy ? 'Updating Ollama' : t('desktop.update.available')
  const count = (appShown ? 1 : 0) + 1
  return (
    <span ref={rootRef} className={css.root}>
      <Tooltip label={appShown ? `${appCopy.detail}\nOllama: ${ollamaText(ollama)}` : `Ollama: ${ollamaText(ollama)}`} side="top">
        <button type="button" className={indicatorCss.indicator} aria-label={label} aria-haspopup="dialog" aria-expanded={open}
          data-local-updates onClick={() => { setOpen((value) => !value) }}>
          <span className={indicatorCss.icon} aria-hidden="true">
            {error ? <span className={indicatorCss.errorDot} />
              : busy ? <IconLoadingOutlineRegular className={indicatorCss.spinner} size={14} /> : <IconDownloadOutlineRegular size={14} />}
          </span>
          <span>{label}{count > 1 && <span className={css.count}>{count}</span>}</span>
        </button>
      </Tooltip>
      {open && createPortal(
        <div ref={panelRef} className={css.panel} role="dialog" aria-label="Updates" data-local-updates-panel
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}>
          {appShown && (
            <div className={css.row}>
              <div className={css.head}>
                <span className={css.name}>DeepSeek Harness</span>
                <button type="button" className={css.action} disabled={appBusy}
                  onClick={() => { setOpen(false); onOpen() }}>{appLabel}</button>
              </div>
              <p className={css.detail}>{appCopy.detail}</p>
            </div>
          )}
          <OllamaRow info={ollama} start={startOllama} />
        </div>,
        document.body,
      )}
    </span>
  )
}

/** La fila de Ollama del panel: versiones, novedades, botón y progreso. */
function OllamaRow({ info, start }: { info: LocalOllamaUpdateInfo; start: () => void }) {
  const [notes, setNotes] = useState(false)
  const phase = info.state.phase
  return (
    <div className={css.row} data-local-ollama-update={phase}>
      <div className={css.head}>
        <span className={css.name}>Ollama</span>
        {(phase === 'idle' || phase === 'error') && info.available && (
          <button type="button" className={css.action} onClick={start}>{phase === 'error' ? 'Retry' : 'Update'}</button>
        )}
      </div>
      <p className={css.detail} data-error={phase === 'error' || undefined}>{ollamaText(info)}</p>
      {phase === 'downloading' && <div className={css.bar}><span style={{ width: `${String(info.state.percent ?? 0)}%` }} /></div>}
      {phase === 'idle' && info.highlights.length > 0 && (
        <button type="button" className={css.notesToggle} aria-expanded={notes} onClick={() => { setNotes((value) => !value) }}>
          {notes ? 'Hide what’s new' : 'What’s new'}
        </button>
      )}
      {notes && phase === 'idle' && (
        <ul className={css.notes}>{info.highlights.map((line, index) => <li key={index}>{line}</li>)}</ul>
      )}
      {phase === 'idle' && <p className={css.hint}>Waits for running replies, then installs and reopens Ollama (about a minute).</p>}
    </div>
  )
}
