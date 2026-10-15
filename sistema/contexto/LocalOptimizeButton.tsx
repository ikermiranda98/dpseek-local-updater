/**
 * Herramientas de cada modelo del selector (añadido por dpseek-local-updater):
 *   - «Optimizar»: vuelve a medir el modelo en este equipo (contexto recomendado
 *     y, en los modelos densos, capas en la gráfica). Mientras dura, un anillo
 *     alrededor del icono se completa con el progreso y, al pasar el ratón, el
 *     anillo deja paso al porcentaje; al terminar, una marca.
 *   - Modelos sin usar en 30 días: se marcan con lo que ocupan y se pueden borrar
 *     del disco (dos clics: el primero pide confirmación).
 *   - Interruptor «Limpieza automática de variantes» (en el menú del selector).
 *     Al abrir el menú se vuelve a listar Ollama, así que los modelos borrados o
 *     descargados se ven sin reiniciar la app.
 * Todo lo hace el Host (local-optimize.ts) a través de las llamadas que monta
 * index.ts con setLocalOptimizer.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  IconCheckOutlineRegular, IconGaugeOutlineRegular, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './LocalOptimizeButton.module.css'

/** Estado que devuelve el Host: medición en curso y limpieza activada. */
export interface LocalStatus {
  running: string | null
  progress: number | null
  cleanup: boolean
}

/** Un modelo de Ollama: lo que ocupa y si lleva 30 días sin usarse. */
export interface LocalModelInfo {
  id: string
  sizeBytes: number
  lastUsed: string | null
  idleDays: number
  unused: boolean
}

/** Llamadas al Host que monta index.ts al arrancar el plugin. */
export interface LocalOptimizer {
  optimize: (model: string) => Promise<{ started: boolean; running: string | null }>
  status: () => Promise<LocalStatus>
  setCleanup: (enabled: boolean) => Promise<{ cleanup: boolean }>
  models: () => Promise<{ models: readonly LocalModelInfo[] }>
  deleteModel: (model: string) => Promise<{ deleted: readonly string[] }>
  /** Vuelve a listar Ollama; la lista del selector se recarga sola al terminar. */
  refresh: () => Promise<{ models: number }>
}

let optimizer: LocalOptimizer | undefined

/** Lo llama apply() con las llamadas remotas del Host. */
export function setLocalOptimizer(next: LocalOptimizer | undefined): void {
  optimizer = next
}

const VARIANT = /^(.*):(?:(.+)-)?dsh-ctx-(?:auto|\d+)$/
const baseModel = (id: string): string => {
  const match = VARIANT.exec(id)
  return match === null ? id : `${match[1] ?? ''}:${match[2] ?? 'latest'}`
}
const gigabytes = (bytes: number): string => `${(bytes / 1e9).toFixed(1).replace('.', ',')} GB`

// ── Estado compartido: una sola consulta periódica para todas las filas ──────

interface Snapshot {
  status: LocalStatus
  models: Readonly<Record<string, LocalModelInfo>>
  deleted: ReadonlySet<string>
}

let snapshot: Snapshot = { status: { running: null, progress: null, cleanup: true }, models: {}, deleted: new Set() }
const listeners = new Set<() => void>()
let timers: ReturnType<typeof setInterval>[] = []

function update(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next }
  for (const listener of listeners) listener()
}
function pollStatus(): void {
  optimizer?.status().then((status) => { update({ status }) }, () => undefined)
}
function pollModels(): void {
  optimizer?.models().then(({ models }) => {
    update({ models: Object.fromEntries(models.map(model => [model.id, model])) })
  }, () => undefined)
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    pollStatus()
    pollModels()
    timers = [setInterval(pollStatus, 1500), setInterval(pollModels, 20_000)]
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      for (const timer of timers) clearInterval(timer)
      timers = []
    }
  }
}
function useLocal(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot)
}

// ── Anillo de progreso ────────────────────────────────────────────────────────

const RADIUS = 10
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function ProgressRing({ progress }: { progress: number }) {
  const filled = Math.max(0.03, Math.min(1, progress)) * CIRCUMFERENCE
  return (
    <svg className={css.ring} viewBox="0 0 24 24" aria-hidden="true">
      <circle className={css.ringTrack} cx="12" cy="12" r={RADIUS} />
      <circle
        className={css.ringFill}
        cx="12"
        cy="12"
        r={RADIUS}
        strokeDasharray={`${String(filled)} ${String(CIRCUMFERENCE)}`}
      />
    </svg>
  )
}

type T = Pick<PropsLocale<'model'>, 't'>

function OptimizeButton({ base, t, local }: { base: string; local: Snapshot } & T) {
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [starting, setStarting] = useState(false)
  const wasMine = useRef(false)
  const { running, progress } = local.status
  const mine = starting || (running !== null && (running === base || running === ''))
  // Al terminar la medición de este modelo, una marca de hecho durante unos segundos.
  useEffect(() => {
    if (mine) {
      wasMine.current = true
      return
    }
    if (!wasMine.current) return
    wasMine.current = false
    setDone(true)
    const timer = setTimeout(() => { setDone(false) }, 5000)
    return () => { clearTimeout(timer) }
  }, [mine])
  useEffect(() => {
    if (starting && running !== null) setStarting(false)
  }, [starting, running])
  const busy = running !== null
  const percent = progress === null ? null : Math.round(progress * 100)
  const title = error ?? (mine
    ? t('local.optimize.running', { percent: percent === null ? '…' : `${String(percent)} %` })
    : done ? t('local.optimize.done') : busy ? t('local.optimize.other') : t('local.optimize.title'))
  return (
    <button
      type="button"
      className={css.optimize}
      // Midiendo, el porcentaje ya se ve al pasar el ratón: sin globo de texto.
      title={mine ? undefined : title}
      aria-label={title}
      disabled={busy && !mine}
      data-error={error === null ? undefined : ''}
      data-running={mine ? '' : undefined}
      onClick={(event) => {
        event.stopPropagation()
        if (busy || mine || optimizer === undefined) return
        setError(null)
        setDone(false)
        setStarting(true)
        optimizer.optimize(base).then(
          () => { pollStatus() },
          (reason: unknown) => {
            setStarting(false)
            setError(reason instanceof Error ? reason.message : String(reason))
          },
        )
      }}
    >
      {mine && <ProgressRing progress={running === null ? 0 : (progress ?? 0)} />}
      {mine && <span className={css.percent}>{percent === null ? '…' : `${String(percent)}%`}</span>}
      <span className={css.icon}>
        {done && !mine
          ? <IconCheckOutlineRegular size={14} />
          : <IconGaugeOutlineRegular size={mine ? 12 : 14} />}
      </span>
    </button>
  )
}

function DeleteButton({ info, t }: { info: LocalModelInfo } & T) {
  const [armed, setArmed] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => { setArmed(false) }, 4000)
    return () => { clearTimeout(timer) }
  }, [armed])
  const size = gigabytes(info.sizeBytes)
  const title = error ?? (armed ? t('local.delete.confirm', { size }) : t('local.delete.title', { size }))
  return (
    <button
      type="button"
      className={armed ? css.deleteArmed : css.optimize}
      title={title}
      aria-label={title}
      disabled={deleting}
      data-error={error === null ? undefined : ''}
      onClick={(event) => {
        event.stopPropagation()
        if (optimizer === undefined) return
        if (!armed) {
          setArmed(true)
          return
        }
        setDeleting(true)
        optimizer.deleteModel(info.id).then(
          () => { update({ deleted: new Set([...snapshot.deleted, info.id]) }) },
          (reason: unknown) => {
            setDeleting(false)
            setArmed(false)
            setError(reason instanceof Error ? reason.message : String(reason))
          },
        )
      }}
    >
      {armed ? t('local.delete.confirm', { size }) : <IconTrashOutlineRegular size={14} />}
    </button>
  )
}

/**
 * Herramientas junto a una fila de la lista de modelos.
 * @param props - id del modelo (o de su variante) y los textos del selector.
 * @returns la marca de «sin usar», la papelera y «Optimizar», o null sin Host.
 */
export function LocalModelExtras({ model, t }: { model: string } & T) {
  const local = useLocal()
  if (optimizer === undefined) return null
  const base = baseModel(model)
  if (local.deleted.has(base)) return <span className={css.badge}>{t('local.delete.done')}</span>
  const info = local.models[base]
  return (
    <>
      {info?.unused === true && (
        <>
          <span
            className={css.badge}
            title={t('local.unused.title', { days: String(info.idleDays), size: gigabytes(info.sizeBytes) })}
          >
            {t('local.unused.badge', { size: gigabytes(info.sizeBytes) })}
          </span>
          <DeleteButton info={info} t={t} />
        </>
      )}
      <OptimizeButton base={base} local={local} t={t} />
    </>
  )
}

/**
 * Interruptor «Limpieza automática de variantes» del menú del selector.
 * @param props - los textos del selector.
 * @returns la fila con el interruptor, o null sin Host.
 */
export function LocalCleanupSwitch({ t }: T) {
  const local = useLocal()
  // Va en el menú del selector: al abrirlo, se vuelve a listar Ollama (modelos
  // borrados o descargados sin reiniciar la app).
  useEffect(() => {
    optimizer?.refresh().then(() => { pollModels() }, () => undefined)
  }, [])
  if (optimizer === undefined) return null
  const on = local.status.cleanup
  return (
    <div className={css.cleanupRow} title={t('local.cleanup.hint')}>
      <span className={css.cleanupLabel}>{t('local.cleanup.label')}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={t('local.cleanup.label')}
        className={css.switch}
        data-on={on ? '' : undefined}
        onClick={(event) => {
          event.stopPropagation()
          update({ status: { ...local.status, cleanup: !on } })
          optimizer?.setCleanup(!on).then(
            ({ cleanup }) => { update({ status: { ...snapshot.status, cleanup } }) },
            () => { pollStatus() },
          )
        }}
      >
        <span className={css.switchKnob} />
      </button>
    </div>
  )
}
