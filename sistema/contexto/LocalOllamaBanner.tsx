/**
 * Aviso «Ollama no responde» encima del cuadro de texto (añadido por dpseek-local-updater).
 *
 * Sin Ollama la IA no puede contestar, y antes solo se notaba en el nombre del modelo
 * («Ollama not responding») o al enviar. Este aviso lo dice claro y ofrece abrir
 * Ollama. Una sola comprobación compartida por todos los cuadros de texto (chat y
 * subchat): cada 15 s, y cada 2 s mientras Ollama arranca tras pulsar «Open Ollama».
 * Llega por el puente de local-ollama-bridge.ts, que publica el selector de modelos.
 */
import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { ollamaUpdater, subscribeOllamaUpdater } from './local-ollama-bridge.ts'
import css from './LocalOllamaBanner.module.css'

interface Status {
  /** null hasta la primera comprobación. */
  readonly running: boolean | null
  readonly installed: boolean
  readonly starting: boolean
}

const EVERY_MS = 15_000
const STARTING_EVERY_MS = 2_000
const STARTING_FOR_MS = 60_000

const listeners = new Set<() => void>()
let status: Status = { running: null, installed: false, starting: false }
let timer: ReturnType<typeof setTimeout> | undefined
let startingUntil = 0

const publish = (next: Status): void => {
  if (next.running === status.running && next.installed === status.installed && next.starting === status.starting) return
  status = next
  for (const listener of listeners) listener()
}

async function check(): Promise<void> {
  const host = ollamaUpdater()
  if (host?.status === undefined) return
  try {
    const value = await host.status()
    const starting = !value.running && Date.now() < startingUntil
    publish({ running: value.running, installed: value.installed, starting })
  } catch { /* sin Host: se vuelve a mirar en la siguiente vuelta */ }
}

function schedule(): void {
  if (timer !== undefined) clearTimeout(timer)
  if (listeners.size === 0) { timer = undefined; return }
  // Hasta la primera respuesta (el selector de modelos publica el puente al cargar), cada segundo.
  const delay = status.running === null ? 1_000 : Date.now() < startingUntil ? STARTING_EVERY_MS : EVERY_MS
  timer = setTimeout(() => { void check().finally(schedule) }, delay)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) void check().finally(schedule)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) schedule()
  }
}

/**
 * El aviso, o nada si Ollama responde (o aún no se sabe).
 * @param props - nada: el estado es común a toda la app.
 * @returns el aviso con «Open Ollama» y «Check again».
 */
export function LocalOllamaBanner(): ReactNode {
  const host = useSyncExternalStore(subscribeOllamaUpdater, ollamaUpdater)
  const current = useSyncExternalStore(subscribe, () => status)
  const [error, setError] = useState<string | null>(null)
  if (host?.status === undefined || current.running !== false) return null
  const open = async (): Promise<void> => {
    setError(null)
    try {
      const result = await host.open?.()
      if (result?.opened !== true) { setError('Could not open Ollama; open it from the Start menu.'); return }
      startingUntil = Date.now() + STARTING_FOR_MS
      publish({ ...status, starting: true })
      schedule()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const text = current.starting
    ? 'Starting Ollama…'
    : current.installed
      ? 'Ollama isn’t running, so the AI can’t answer.'
      : 'Ollama isn’t responding, so the AI can’t answer. Install or start Ollama (ollama.com).'
  return (
    <div className={css.banner} role="alert" data-local-ollama-banner={current.starting ? 'starting' : 'down'}>
      <IconWarningOutlineRegular size={14} className={css.icon} />
      <span className={css.text}>{error ?? text}</span>
      {!current.starting && current.installed && (
        <button type="button" className={css.primary} onClick={() => { void open() }}>Open Ollama</button>
      )}
      {!current.starting && (
        <button type="button" className={css.secondary} onClick={() => { void check() }}>Check again</button>
      )}
    </div>
  )
}
