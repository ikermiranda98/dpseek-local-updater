/**
 * Aviso de actualizaciones de abajo a la izquierda, con Ollama (añadido por dpseek-local-updater).
 *
 * Un solo botón, «Update», para la app y para Ollama: aparece cuando hay alguna
 * (o ambas, con un contador) y abre un panel con una fila por actualización, con
 * sus novedades y su botón. La de la app sigue su camino oficial (al pulsar su
 * botón sale la confirmación con el semáforo y «Skip this version»); sus novedades
 * son el resumen publicado con cada versión (local-update-info.json). La de Ollama
 * se instala desde aquí (local-ollama-update.ts en el Host, a través de
 * local-ollama-bridge.ts): espera a las respuestas en marcha, descarga, instala en
 * silencio y vuelve a abrir Ollama.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  IconDownloadOutlineRegular, IconLoadingOutlineRegular, Tooltip, useAnchoredPosition, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopUpdatePresentation, DesktopUpdateView } from '../types.ts'
import { updateCopy } from './DesktopUpdateIndicator.tsx'
import indicatorCss from './DesktopUpdateIndicator.module.css'
import {
  ollamaUpdater, subscribeOllamaUpdater, type LocalAppUpdateNotes, type LocalOllamaUpdateInfo,
} from './local-ollama-bridge.ts'
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
 * @returns el botón «Update» (y su panel), o nada si no hay actualizaciones.
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
  const app = view.presentation
  const appShown = view.failed || (app !== undefined && app.phase !== 'idle')
  if (!wide || hidden || (!appShown && !ollamaShown)) return null

  const retry = t('desktop.update.retry')
  const appCopy = app === undefined ? { label: retry, detail: retry } : updateCopy(app, t)
  const appBusy = view.opening || (app !== undefined && APP_BUSY.has(app.phase))
  const error = (appShown && (view.failed || app?.phase === 'error')) || (ollamaShown && phase === 'error')
  const busy = (appShown && appBusy) || ollamaBusy
  const update = t('desktop.update.available')
  const label = appShown && appBusy ? appCopy.label : ollamaBusy ? 'Updating Ollama' : error ? retry : update
  const count = (appShown ? 1 : 0) + (ollamaShown ? 1 : 0)
  const tip = [appShown ? `DeepSeek Harness: ${appCopy.detail}` : '', ollama !== null && ollamaShown ? `Ollama: ${ollamaText(ollama)}` : '']
    .filter((line) => line !== '').join('\n')
  return (
    <span ref={rootRef} className={css.root}>
      <Tooltip label={tip} side="top">
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
            <AppRow state={app} failed={view.failed} busy={appBusy} copy={appCopy} update={update} retry={retry}
              install={() => { setOpen(false); onOpen() }} />
          )}
          {ollama !== null && ollamaShown && <OllamaRow info={ollama} start={startOllama} />}
        </div>,
        document.body,
      )}
    </span>
  )
}

const DOTS = { green: '🟢', amber: '🟡', red: '🔴' } as const

/** Las novedades de la versión nueva de la app, leídas una vez por versión. */
function useAppNotes(version: string | undefined): LocalAppUpdateNotes | null | undefined {
  const updater = useSyncExternalStore(subscribeOllamaUpdater, ollamaUpdater)
  const [notes, setNotes] = useState<{ version: string; notes: LocalAppUpdateNotes | null } | null>(null)
  const known = notes?.version
  useEffect(() => {
    if (updater === undefined || version === undefined || known === version) return
    let alive = true
    // Un fallo al leerlas (también uno síncrono) es «sin novedades», nunca romper el aviso.
    Promise.resolve().then(() => updater.appNotes(version)).then(
      (value) => { if (alive) setNotes({ version, notes: value }) },
      () => { if (alive) setNotes({ version, notes: null }) },
    )
    return () => { alive = false }
  }, [updater, version, known])
  return notes !== null && notes.version === version ? notes.notes : undefined
}

/** La fila de la app: versión, semáforo y novedades, progreso y su botón (la confirmación oficial). */
function AppRow({ state, failed, busy, copy, update, retry, install }: {
  state: DesktopUpdatePresentation | undefined
  failed: boolean
  busy: boolean
  copy: { label: string; detail: string }
  update: string
  retry: string
  install: () => void
}) {
  const [more, setMore] = useState(false)
  const version = state?.version
  const notes = useAppNotes(version)
  const error = failed || state?.phase === 'error'
  const waiting = !error && (state?.phase === 'available' || state?.phase === 'ready')
  return (
    <div className={css.row} data-local-app-update={failed ? 'failed' : state?.phase}>
      <div className={css.head}>
        <span className={css.name}>DeepSeek Harness</span>
        <button type="button" className={css.action} disabled={busy} onClick={install}>
          {busy ? copy.label : error ? retry : update}
        </button>
      </div>
      <p className={css.detail} data-error={error || undefined}>
        {waiting && version !== undefined ? `New version ${version}` : copy.detail}
      </p>
      {state?.phase === 'downloading' && <div className={css.bar}><span style={{ width: `${String(state.percent ?? 0)}%` }} /></div>}
      {waiting && notes !== undefined && (notes === null
        ? <p className={css.hint}>Couldn’t read what this version changes for your local features.</p>
        : <>
          <p className={css.level}><span aria-hidden="true">{DOTS[notes.level]}</span> {notes.headline}</p>
          <button type="button" className={css.notesToggle} aria-expanded={more} onClick={() => { setMore((value) => !value) }}>
            {more ? 'Hide what’s new' : 'What’s new'}
          </button>
          {more && <p className={css.notesText}>{notes.detail}</p>}
        </>)}
      {waiting && <p className={css.hint}>Asks before installing; the app restarts. You can also skip this version there.</p>}
    </div>
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
