/**
 * Cerebro junto al selector de modelo (añadido por dpseek-local-updater): el esfuerzo de razonamiento en un solo
 * botón de la barra, sin abrir el menú. Cada clic pasa al siguiente modo:
 *
 * - «Pensar» (azul): lo que la app hacía con «Default»; no se envía ningún nivel y el modelo piensa como siempre.
 * - «Pensar a fondo» (rosa, con un anillo de estrellas): el nivel `high`. Con Qwen en Ollama razona bastante más
 *   (medido: unas 2-3 veces más texto de razonamiento y más tiempo).
 * - «Sin pensar» (gris): el nivel `off`; responde enseguida, sin razonar.
 *
 * Los niveles salen del modelo: si no declara `off` o `high`, ese modo no aparece; sin niveles, no hay cerebro.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ModelReasoningEffort } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './LocalThinkButton.module.css'

/** 0 sin pensar, 1 pensar (por defecto), 2 pensar a fondo. */
type Mode = 0 | 1 | 2

const BRAIN = [
  'M15.5 13a3.5 3.5 0 0 0 -3.5 3.5v1a3.5 3.5 0 0 0 7 0v-1.8',
  'M8.5 13a3.5 3.5 0 0 1 3.5 3.5v1a3.5 3.5 0 0 1 -7 0v-1.8',
  'M17.5 16a3.5 3.5 0 0 0 0 -7h-.5',
  'M19 9.3v-2.8a3.5 3.5 0 0 0 -7 0',
  'M6.5 16a3.5 3.5 0 0 1 0 -7h.5',
  'M5 9.3v-2.8a3.5 3.5 0 0 1 7 0v10',
]

/** Estrella de cuatro puntas centrada en (x, y) con radio s. */
function star(x: number, y: number, s: number): string {
  const k = s * 0.25
  return `M${String(x)} ${String(y - s)}L${String(x + k)} ${String(y - k)}L${String(x + s)} ${String(y)}L${String(x + k)} ${String(y + k)}`
    + `L${String(x)} ${String(y + s)}L${String(x - k)} ${String(y + k)}L${String(x - s)} ${String(y)}L${String(x - k)} ${String(y - k)}Z`
}

/** Destellos de «Pensar», en las esquinas del botón (por fuera del icono, donde se ven). */
const TWINKLES: readonly (readonly [number, number, number, string, string])[] = [
  [23, 0, 4.2, '1.5s', '0s'],
  [25, 17, 3, '1.8s', '.6s'],
  [-1, 23, 3.4, '1.6s', '1s'],
]

/** Anillo de «Pensar a fondo»: seis estrellas alrededor del botón. */
const RING = Array.from({ length: 6 }, (_, i) => {
  const a = (i * 60 * Math.PI) / 180
  return [12 + 21 * Math.cos(a), 12 + 21 * Math.sin(a), i % 2 === 1 ? 2.9 : 4.2, `${String(1 + (i % 3) * 0.25)}s`, `${String(i * 0.12)}s`] as const
})

/** Estallido al entrar en «Pensar a fondo». */
const BURST = Array.from({ length: 10 }, (_, i) => {
  const a = (i * 36 * Math.PI) / 180
  return { r: i % 2 === 1 ? 1.2 : 1.7, x: `${(Math.cos(a) * 24).toFixed(1)}px`, y: `${(Math.sin(a) * 24).toFixed(1)}px` }
})

const round = (n: number): number => Math.round(n * 100) / 100

/**
 * El botón del cerebro.
 * @param props - niveles del modelo, el nivel elegido (undefined = el de siempre), si está bloqueado y cómo cambiarlo.
 * @returns el botón, o nada si el modelo no razona.
 */
export function LocalThinkButton({ efforts, effort, disabled, onChange, t }: {
  efforts: readonly ModelReasoningEffort[] | undefined
  effort: string | undefined
  disabled: boolean
  onChange: (effort: string | undefined) => void
} & Pick<PropsLocale<'model'>, 't'>) {
  const offId = efforts?.find(level => level.id === 'off')?.id
  const highId = efforts?.find(level => level.id === 'high')?.id
  const actual: Mode = effort !== undefined && effort === offId ? 0 : effort !== undefined && effort === highId ? 2 : 1
  // El cambio se ve al momento; la selección real llega un instante después (o no, si falla: entonces vuelve).
  const [wanted, setWanted] = useState<Mode | null>(null)
  const [anim, setAnim] = useState<{ key: number; kind: 'wake' | 'pop' | null }>({ key: 0, kind: null })
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => { setWanted(null) }, [effort])
  useEffect(() => () => { clearTimeout(timer.current) }, [])
  if (efforts === undefined || efforts.length === 0) return null

  const mode = wanted ?? actual
  const available = (m: Mode): boolean => m === 1 || (m === 0 ? offId !== undefined : highId !== undefined)
  const labels = [t('local.think.off'), t('local.think.on'), t('local.think.hard')] as const
  const next = (): Mode => {
    let m = mode
    do m = ((m + 1) % 3) as Mode
    while (!available(m))
    return m
  }
  const click = (): void => {
    const m = next()
    if (m === mode) return
    setWanted(m)
    setAnim(current => ({ key: current.key + 1, kind: m === 1 ? 'wake' : m === 2 ? 'pop' : null }))
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { setWanted(null) }, 4000)
    onChange(m === 0 ? offId : m === 2 ? highId : undefined)
  }

  return (
    <Tooltip label={`${labels[mode]} · ${labels[next()]} ›`} side="top" delayMs={500}>
      <button
        type="button"
        className={css.button}
        data-mode={mode}
        data-anim={anim.kind ?? undefined}
        aria-label={labels[mode]}
        disabled={disabled}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={click}
      >
        {/* La clave reinicia las animaciones de entrada en cada cambio. */}
        <svg key={anim.key} className={css.icon} viewBox="0 0 24 24" aria-hidden="true">
          <g className={css.twinkles}>
            {TWINKLES.map(([x, y, s, d, w]) => (
              <path key={`${String(x)}-${String(y)}`} className={css.star} d={star(x, y, s)} style={{ animationDuration: d, animationDelay: w }} />
            ))}
          </g>
          <g className={css.ring}>
            <g className={css.spin}>
              {RING.map(([x, y, s, d, w]) => (
                <path key={`${String(round(x))}-${String(round(y))}`} className={css.star} d={star(round(x), round(y), s)} style={{ animationDuration: d, animationDelay: w }} />
              ))}
            </g>
          </g>
          <g className={css.burst}>
            {BURST.map((p, i) => (
              <circle key={i} cx="12" cy="12" r={p.r} style={{ '--bx': p.x, '--by': p.y } as CSSProperties} />
            ))}
          </g>
          <g className={css.brain}>
            {BRAIN.map(d => <path key={d} className={css.line} d={d} />)}
            {BRAIN.map(d => <path key={`draw-${d}`} className={css.draw} pathLength={1} d={d} />)}
          </g>
        </svg>
      </button>
    </Tooltip>
  )
}
