/**
 * Barra de contexto del selector de modelo (añadido por dpseek-local-updater).
 *
 * Cada tamaño de contexto es una variante del modelo en Ollama
 * (`<modelo>:dsh-ctx-131072`, `<modelo>:dsh-ctx-auto`; ver
 * sistema/contexto/arranque.cjs). La lista de modelos muestra una sola entrada
 * por modelo (la automática) y esta barra cambia entre sus variantes: cada punto
 * es un tamaño y «Recomendado» marca el óptimo medido para el equipo, que
 * selecciona la variante automática.
 */
import clsx from 'clsx'
import type { CSSProperties, KeyboardEvent } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ContextSlider.module.css'

const VARIANT = /(:|-)dsh-ctx-(auto|\d+)$/
/** Nombre de la variante automática: «<modelo> · Auto 128K» (+ « (sin medir)»). */
const AUTO_NAME = / · Auto (\d+K?)( \(sin medir\))?$/

interface NamedModel {
  readonly id: string
  readonly name: string
}

/** Tamaño de una variante: 'auto', tokens, o undefined si no es una variante. */
export function contextOf(id: string): 'auto' | number | undefined {
  const match = VARIANT.exec(id)
  if (match === null) return undefined
  return match[2] === 'auto' ? 'auto' : Number(match[2])
}

function contextBase(id: string): string {
  return id.replace(VARIANT, '')
}

function tokens(label: string): number {
  return label.endsWith('K') ? Number(label.slice(0, -1)) * 1024 : Number(label)
}

function kilo(n: number): string {
  return n % 1024 === 0 ? `${String(n / 1024)}K` : String(n)
}

/** Lista de modelos del selector: una entrada por modelo, sin el sufijo «Auto». */
export function contextListModels<M extends NamedModel>(models: readonly M[]): M[] {
  return models
    .filter(model => typeof contextOf(model.id) !== 'number')
    .map(model => contextOf(model.id) === 'auto' ? { ...model, name: model.name.replace(AUTO_NAME, '') } : model)
}

/** Texto del botón: «<modelo> · 128K» también para la variante automática. */
export function contextTriggerName(name: string | undefined): string | undefined {
  return name?.replace(AUTO_NAME, ' · $1')
}

/** Si dos ids son el mismo modelo (con cualquier contexto). */
export function sameContextModel(a: string, b: string): boolean {
  if (a === b) return true
  return contextOf(a) !== undefined && contextOf(b) !== undefined && contextBase(a) === contextBase(b)
}

interface Step {
  readonly ctx: number
  readonly id: string
  readonly recommended: boolean
}

function stepsFor(models: readonly NamedModel[], current: string): Step[] {
  const base = contextBase(current)
  const siblings = models.filter(model => contextOf(model.id) !== undefined && contextBase(model.id) === base)
  const auto = siblings.find(model => contextOf(model.id) === 'auto')
  const autoLabel = auto === undefined ? undefined : AUTO_NAME.exec(auto.name)?.[1]
  const autoCtx = autoLabel === undefined ? undefined : tokens(autoLabel)
  const steps: Step[] = []
  for (const model of siblings) {
    const ctx = contextOf(model.id)
    if (typeof ctx !== 'number') continue
    // La posición recomendada elige la variante automática, que sigue al
    // óptimo aunque cambie en una medición posterior.
    const recommended = auto !== undefined && ctx === autoCtx
    steps.push({ ctx, id: recommended ? auto.id : model.id, recommended })
  }
  if (auto !== undefined && autoCtx !== undefined && !steps.some(step => step.recommended)) {
    steps.push({ ctx: autoCtx, id: auto.id, recommended: true })
  }
  return steps.sort((a, b) => a.ctx - b.ctx)
}

/** Posición horizontal (en %) del paso `index` de `count`. */
function at(index: number, count: number): string {
  return count < 2 ? '50%' : `calc(14px + (100% - 28px) * ${String(index / (count - 1))})`
}

/** Posición de «Recomendado»: centrada en su punto, salvo en los extremos (no se sale de la tarjeta). */
function edgeStyle(index: number, count: number): CSSProperties {
  if (count >= 2 && index === 0) return { left: 0, transform: 'none' }
  if (count >= 2 && index === count - 1) return { right: 0, transform: 'none' }
  return { left: at(index, count) }
}

/**
 * Barra de contexto bajo la fila «Modelo».
 * @param props - modelos del proveedor actual, modelo elegido y la acción de elegir otro.
 * @returns la barra, o null si el modelo actual no tiene variantes de contexto.
 */
export function ContextSlider({ models, current, disabled, onSelect, t }: {
  models: readonly NamedModel[]
  current: string | undefined
  disabled: boolean
  onSelect: (modelId: string) => void
} & Pick<PropsLocale<'model'>, 't'>) {
  if (current === undefined || contextOf(current) === undefined) return null
  const steps = stepsFor(models, current)
  if (steps.length < 2) return null
  const value = contextOf(current)
  const index = Math.max(0, steps.findIndex(step => (value === 'auto' ? step.recommended : step.ctx === value)))
  const recommended = steps.findIndex(step => step.recommended)
  const choose = (next: number): void => {
    const step = steps[next]
    if (step === undefined || disabled || next === index) return
    onSelect(step.id)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    choose(index + (event.key === 'ArrowRight' ? 1 : -1))
  }
  const selected = steps[index]
  return (
    <div className={css.root}>
      <div className={css.head}>
        <span>{t('local.context.label')}</span>
        <span className={css.value}>
          {selected === undefined ? '' : kilo(selected.ctx)}
          {selected?.recommended === true && <span className={css.valueNote}> · {t('local.context.recommended')}</span>}
        </span>
      </div>
      <div className={css.ends}>
        <span>{t('local.context.faster')}</span>
        <span>{t('local.context.more')}</span>
      </div>
      <div className={clsx(css.track, disabled && css.disabled)}>
        {recommended >= 0 && recommended !== index && (
          <span className={css.tick} style={{ left: at(recommended, steps.length) }} />
        )}
        {steps.map((step, i) => (
          <button
            key={step.id + String(step.ctx)}
            type="button"
            role="radio"
            aria-checked={i === index}
            aria-label={`${t('local.context.label')} ${kilo(step.ctx)}${step.recommended ? ` (${t('local.context.recommended')})` : ''}`}
            tabIndex={i === index ? 0 : -1}
            className={css.step}
            style={{ left: at(i, steps.length) }}
            disabled={disabled}
            onClick={() => { choose(i) }}
            onKeyDown={onKeyDown}
          >
            <span className={css.dot} />
          </button>
        ))}
        <span className={css.thumb} style={{ left: at(index, steps.length) }} />
      </div>
      <div className={css.labels}>
        {recommended >= 0 && (
          <span className={css.recommended} style={edgeStyle(recommended, steps.length)}>{t('local.context.recommended')}</span>
        )}
      </div>
    </div>
  )
}
