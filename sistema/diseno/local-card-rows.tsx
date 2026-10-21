/**
 * Ajustes de la zona de trabajo como tarjeta flotante (añadido por dpseek-local-updater): el radio de las esquinas y
 * el margen con el borde de la ventana, en Ajustes → General con el mismo selector que las demás filas.
 *
 * Se guardan en este navegador de la app (localStorage) y se aplican como variables CSS en la raíz del documento, que
 * lee la tarjeta flotante (AppFrame.module.css, sección 40 del parcheador).
 */
import { useSyncExternalStore } from 'react'
import { PreferenceRow } from './PreferenceRow.tsx'

interface CardChoice {
  readonly id: string
  readonly label: string
  readonly px: number
}

const RADIUS: readonly CardChoice[] = [
  { id: 'none', label: 'Square', px: 0 },
  { id: 'small', label: 'Small', px: 8 },
  { id: 'medium', label: 'Medium', px: 12 },
  { id: 'large', label: 'Large (default)', px: 16 },
  { id: 'xlarge', label: 'Extra large', px: 22 },
]
const GAP: readonly CardChoice[] = [
  { id: 'none', label: 'None', px: 0 },
  { id: 'small', label: 'Small', px: 6 },
  { id: 'medium', label: 'Medium (default)', px: 12 },
  { id: 'large', label: 'Large', px: 20 },
]
const KEYS = { radius: 'dsh-local-card-radius', gap: 'dsh-local-card-gap' } as const
const VARIABLES = { radius: '--dsh-local-user-card-radius', gap: '--dsh-local-user-card-gap' } as const
const DEFAULTS = { radius: 'large', gap: 'medium' } as const
const CHOICES = { radius: RADIUS, gap: GAP } as const

type Setting = keyof typeof KEYS

const listeners = new Set<() => void>()

const read = (setting: Setting): string => {
  try {
    const saved = localStorage.getItem(KEYS[setting])
    if (saved !== null && CHOICES[setting].some(choice => choice.id === saved)) return saved
  } catch {
    // Sin almacenamiento: el valor por defecto.
  }
  return DEFAULTS[setting]
}

/** Pone las variables CSS de lo guardado (al cargar la app y en cada cambio). */
function apply(): void {
  for (const setting of ['radius', 'gap'] as const) {
    const choice = CHOICES[setting].find(entry => entry.id === read(setting))
    if (choice !== undefined) document.documentElement.style.setProperty(VARIABLES[setting], `${String(choice.px)}px`)
  }
}
apply()

function write(setting: Setting, id: string): void {
  try {
    localStorage.setItem(KEYS[setting], id)
  } catch {
    // Vale para esta vez.
  }
  apply()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function CardRow({ setting, title, description }: { setting: Setting; title: string; description: string }) {
  const value = useSyncExternalStore(subscribe, () => read(setting))
  const choices = CHOICES[setting]
  return (
    <PreferenceRow title={title} description={description} value={value}
      selectedLabel={choices.find(choice => choice.id === value)?.label ?? value}
      options={choices.map(({ id, label }) => ({ id, label }))}
      onSelect={(id) => { write(setting, id) }} />
  )
}

/** Radio de las esquinas de la tarjeta (el chat y el panel derecho). */
export function LocalCardRadiusRow() {
  return <CardRow setting="radius" title="Corner radius" description="How round the corners of the chat and the right panel are." />
}

/** Margen de la tarjeta con el borde de la ventana. */
export function LocalCardGapRow() {
  return <CardRow setting="gap" title="Card margin" description="Space between the chat and right panel and the edge of the window." />
}
