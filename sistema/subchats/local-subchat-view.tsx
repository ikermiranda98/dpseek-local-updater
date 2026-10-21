/**
 * Subchats, cómo se ven (añadido por dpseek-local-updater).
 *
 * - En el subchat: la ventana empieza en la tarea que escribiste. La conversación
 *   copiada del chat principal (su memoria) sigue llegando al modelo, pero no se
 *   pinta; una línea arriba permite verla. Las instrucciones que acompañan a la
 *   tarea (las nuestras y, en los subchats antiguos, las oficiales de send_message)
 *   tampoco se pintan.
 * - En el chat principal: la respuesta de un subchat se ve como una tarjeta
 *   «Subchat · nombre · terminado en …» con sus primeras líneas y «Open subchat».
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutlineRegular, IconTreeCornerRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { localSubchatContext, useLocalSubchatScope } from './local-subchat-button.tsx'
import { openSubchatAside } from './local-subchat-start.ts'
import css from './local-subchat-view.module.css'

/** Marca del bloque de instrucciones (la misma que local-subchat.ts en el Host). */
const MARKER = '[[dsh-local:subchat]]'
/** Instrucciones de los subchats anteriores: iban detrás de la tarea, en el mismo texto. */
const LEGACY = '\n\n---\nYou are a subchat opened from the conversation above.'
/** Instrucciones oficiales que añadía el servicio de subagentes con la entrega al chat padre. */
const OFFICIAL = 'Your parent agent id is "'

interface Block { readonly type: string; readonly text?: string }

/** Si el mensaje es la tarea de un subchat. */
function isTask(content: readonly Block[]): boolean {
  return content.some(block => typeof block.text === 'string' && (block.text.startsWith(MARKER) || block.text.includes(LEGACY)))
}

/**
 * El mensaje sin las instrucciones del subchat (lo que escribió el usuario).
 * @param content - bloques del mensaje.
 * @returns los bloques que se pintan.
 */
export function localVisibleContent<T extends Block>(content: readonly T[]): readonly T[] {
  if (!isTask(content)) return content
  return content.flatMap((block) => {
    if (typeof block.text !== 'string') return [block]
    if (block.text.startsWith(MARKER) || block.text.startsWith(OFFICIAL)) return []
    const legacy = block.text.indexOf(LEGACY)
    return legacy < 0 ? [block] : [{ ...block, text: block.text.slice(0, legacy) }]
  })
}

interface EntryLike { readonly kind: string; readonly key: string }
interface NodeStoreLike { get(key: string): { readonly kind: string; readonly data?: unknown } | undefined }

/**
 * Dónde empieza lo propio del subchat: su tarea. Lo anterior es la conversación copiada.
 * @returns posición de la tarea y cuántos mensajes tuyos hay antes, o nada si no es un subchat.
 */
export function localSubchatSeed(entries: readonly EntryLike[], nodes: NodeStoreLike): { index: number; messages: number } | undefined {
  let messages = 0
  for (const [index, entry] of entries.entries()) {
    if (entry.kind !== 'node') continue
    const node = nodes.get(entry.key)
    if (node?.kind !== 'user') continue
    const content = (node.data as { content?: readonly Block[] } | undefined)?.content ?? []
    if (isTask(content)) return messages === 0 ? undefined : { index, messages }
    messages++
  }
  return undefined
}

/**
 * Línea de arriba del subchat: la conversación copiada está oculta; se puede ver.
 * @returns la línea.
 */
export function LocalSubchatSeedLine({ messages, shown, onToggle }: { messages: number; shown: boolean; onToggle: () => void }): ReactNode {
  return (
    <div className={css.seed} data-local-subchat-seed>
      <IconTreeCornerRegular className={css.seedIcon} />
      <span>Continues from the main chat · {messages} earlier {messages === 1 ? 'message' : 'messages'} it remembers</span>
      <button type="button" className={css.link} onClick={onToggle}>{shown ? 'Hide' : 'Show'}</button>
    </div>
  )
}

/** Lo que marca un aviso como resultado de un subchat. */
interface SubchatNotice {
  readonly childId: string
  readonly label: string
  readonly durationMs?: number
}

/**
 * @param source - origen del aviso.
 * @returns los datos del subchat si el aviso es de uno, o nada.
 */
export function localSubchatNotice(source: unknown): SubchatNotice | undefined {
  const record = typeof source === 'object' && source !== null ? source as Record<string, unknown> : {}
  const local = record.localSubchat as { label?: unknown; durationMs?: unknown } | undefined
  if (record.kind !== 'subagent-settled' || local === undefined || typeof record.senderSessionId !== 'string') return undefined
  return {
    childId: record.senderSessionId,
    label: typeof local.label === 'string' ? local.label : 'Subchat',
    ...typeof local.durationMs === 'number' ? { durationMs: local.durationMs } : {},
  }
}

function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes === 0 ? `${String(seconds)} s` : `${String(minutes)} min ${String(seconds % 60)} s`
}

/**
 * La tarjeta del resultado de un subchat en el chat principal.
 * @param props - aviso, su contenido y su hora.
 * @returns la tarjeta.
 */
export function LocalSubchatResultCard({ notice, content, time }: {
  notice: SubchatNotice
  content: readonly Block[]
  time: string
}): ReactNode {
  const scope = useLocalSubchatScope()
  const [open, setOpen] = useState(false)
  const closing = content.findIndex(block => block.text === 'Its closing message:')
  const text = closing < 0 ? '' : content.slice(closing + 1).map(block => block.text ?? '').join('\n\n').trim()
  const lines = text.split('\n')
  const long = lines.length > 4 || text.length > 400
  const preview = long && !open ? `${lines.slice(0, 4).join('\n').slice(0, 400)}…` : text
  return (
    <section className={css.card} data-local-subchat-result>
      <header className={css.head}>
        <IconTreeCornerRegular className={css.cardIcon} />
        <span className={css.title}>Subchat · {notice.label}</span>
        <span className={css.meta}>{notice.durationMs === undefined ? 'finished' : `finished in ${duration(notice.durationMs)}`} · {time}</span>
      </header>
      <p className={css.text}>{preview === '' ? 'It left no closing message.' : preview}</p>
      <div className={css.actions}>
        {long && (
          <button type="button" className={css.link} aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
            {open ? 'Show less' : 'Show all'} <IconChevronDownOutlineRegular size={11} className={open ? css.up : undefined} />
          </button>
        )}
        {scope !== undefined && (
          <button type="button" className={css.link} onClick={() => {
            const ctx = localSubchatContext()
            if (ctx !== undefined) openSubchatAside(ctx, scope.sessionId, notice.childId)
          }}>Open subchat</button>
        )}
      </div>
    </section>
  )
}
