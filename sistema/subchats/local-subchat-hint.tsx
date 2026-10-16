/**
 * Sugerencia de subchat junto al medidor de contexto (añadido por dpseek-local-updater).
 *
 * Cuando el chat ya ocupa mucho de su contexto, avisa con las cifras y ofrece
 * mandar lo que estás escribiendo a un subchat: trabaja aparte y aquí solo vuelve
 * su respuesta, así el chat no se llena ni tiene que resumirse. Aparece desde el
 * 60 % si has escrito algo, y desde el 80 % siempre.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { IconTreeCornerRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { contextOccupancy } from '../context-occupancy.ts'
import { startSubchat } from './local-subchat-store.ts'
import css from './local-subchat-hint.module.css'

/** Porcentaje de contexto a partir del cual se sugiere, con texto escrito o sin él. */
const WITH_DRAFT = 60
const ALWAYS = 80

const tokens = (value: number): string => value >= 1000 ? `${String(Math.round(value / 1000))}K` : String(value)

/**
 * La sugerencia, o nada si el contexto aún va holgado.
 * @param props - chat, contexto, lo escrito y cómo vaciarlo.
 * @returns el aviso con su botón.
 */
export function LocalSubchatHint({ sessionId, useProjection, draft, subagent, clearDraft }: {
  sessionId: string | undefined
  useProjection: UseProjection
  draft: string
  /** Dentro de un subchat o subagente no se sugiere otro. */
  subagent: boolean
  clearDraft: () => void
}): ReactNode {
  const context = contextOccupancy(useProjection('contextPressure'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (sessionId === undefined || subagent || context === null) return null
  const task = draft.trim()
  if (context.percent < (task === '' ? ALWAYS : WITH_DRAFT)) return null
  const figures = `${String(context.percent)}% of this chat's context is used (${tokens(context.usedTokens)} of ${tokens(context.contextWindow)} tokens).`
  const help = task === ''
    ? `${figures} A long task here can fill it and force a summary. Write the task and click here to send it to a subchat: it works apart and only its answer comes back.`
    : `${figures} A long task here can fill it and force a summary. Click to send what you wrote to a subchat: it starts with this conversation, works apart and only its answer comes back here.`
  const send = async (): Promise<void> => {
    if (task === '') return
    setBusy(true)
    setError(null)
    try {
      await startSubchat(sessionId, task)
      clearDraft()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Tooltip label={error ?? help} side="top">
      <button type="button" className={css.hint} data-local-subchat-hint data-level={context.percent >= ALWAYS ? 'high' : 'medium'}
        data-error={error === null ? undefined : ''} disabled={busy} aria-disabled={task === '' || undefined} aria-label={help}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => { void send() }}>
        <IconTreeCornerRegular className={css.icon} />
        <span>{busy ? 'Starting subchat…' : task === '' ? `${String(context.percent)}% used · use a subchat` : 'Send to a subchat'}</span>
      </button>
    </Tooltip>
  )
}
