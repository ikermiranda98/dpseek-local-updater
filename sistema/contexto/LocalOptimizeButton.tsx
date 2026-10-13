/**
 * Botón «Optimizar» junto a cada modelo del selector (añadido por dpseek-local-updater).
 *
 * Pide al Host (session.optimizeLocalModel, local-optimize.ts) que vuelva a medir
 * el modelo en este equipo: contexto recomendado y, en los modelos densos,
 * cuántas capas caben en la gráfica. La medición va en segundo plano; mientras
 * dura, el botón del modelo que se mide muestra que está trabajando.
 */
import { useEffect, useState } from 'react'
import { IconGaugeOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './LocalOptimizeButton.module.css'

/** Acciones del Host que monta index.ts al arrancar el plugin. */
export interface LocalOptimizer {
  optimize: (model: string) => Promise<{ started: boolean; running: string | null }>
  status: () => Promise<{ running: string | null }>
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

/**
 * Botón de un modelo de la lista.
 * @param props - id del modelo (o de su variante) y los textos del selector.
 * @returns el botón, o null si el Host no ofrece la optimización.
 */
export function LocalOptimizeButton({ model, t }: { model: string } & Pick<PropsLocale<'model'>, 't'>) {
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const base = baseModel(model)
  useEffect(() => {
    if (optimizer === undefined) return
    let stop = false
    const poll = (): void => {
      optimizer?.status().then((state) => { if (!stop) setRunning(state.running) }, () => undefined)
    }
    poll()
    const timer = setInterval(poll, 3000)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [])
  if (optimizer === undefined) return null
  const mine = running !== null && (running === base || running === '')
  const busy = running !== null
  const title = error ?? (mine
    ? t('local.optimize.running')
    : busy ? t('local.optimize.other') : t('local.optimize.title'))
  return (
    <button
      type="button"
      className={css.optimize}
      title={title}
      aria-label={title}
      disabled={busy && !mine}
      data-error={error === null ? undefined : ''}
      onClick={(event) => {
        event.stopPropagation()
        if (busy || optimizer === undefined) return
        setError(null)
        optimizer.optimize(base).then(
          (result) => { setRunning(result.running) },
          (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) },
        )
      }}
    >
      {mine ? <StateDot state="ongoing" /> : <IconGaugeOutlineRegular size={14} />}
    </button>
  )
}
