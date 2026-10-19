/**
 * Selector de modelo dentro de la barra (añadido por dpseek-local-updater).
 *
 * Al pulsar el chip del modelo («Qwen3.6 · 128K») no se abre un menú flotante: arriba de la barra sale una fila con
 * un bloque por modelo (el actual y los usados hace menos), «+N» si hay más (buscador y una tira que se desplaza) y,
 * a la derecha, los tamaños de contexto. Al pasar el ratón por un bloque aparecen sus herramientas (optimizar y, si
 * lleva tiempo sin usarse, borrar). Debajo, el recordatorio de la rueda y la limpieza automática de variantes.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { ContextSlider, contextLabel, contextListModels, contextShortName, sameContextModel } from './ContextSlider.tsx'
import { LocalCleanupSwitch, LocalModelExtras, baseModel, gigabytes, useLocal } from './LocalOptimizeButton.tsx'
import css from './LocalModelDrawer.module.css'

interface DrawerModel {
  readonly id: string
  readonly name: string
  readonly reasoning?: unknown
}

interface DrawerGroup {
  readonly id: string
  readonly models: readonly DrawerModel[]
}

interface Entry {
  readonly provider: string
  readonly model: DrawerModel
  readonly full: string
  readonly size: string | undefined
  readonly current: boolean
}

/** Bloques a la vista antes de «+N». */
const VISIBLE = 3

const CHECK = (
  <svg className={css.icon} viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
)
const WHEEL = (
  <svg className={css.icon} viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="5" /><path d="M12 7v3" /></svg>
)
const BACK = (
  <svg className={css.icon} viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
)

/** «35B», «1.5B»… sacado del nombre, si lo lleva. */
function params(name: string): string | undefined {
  const match = /(\d+(?:\.\d+)?)\s*[bB](?![a-z])/.exec(name)
  return match === null ? undefined : `${match[1] ?? ''}B`
}

/**
 * La fila de modelos de la barra.
 * @param props - si está abierta, el botón del chip (lo de fuera la cierra), los modelos, el elegido y cómo cambiarlos.
 * @returns la fila dentro de la barra, o nada cerrada.
 */
export function LocalModelDrawer({ open, onClose, anchor, groups, current, busy, onChoose, onContext, t }: {
  open: boolean
  onClose: () => void
  anchor: HTMLElement | null
  groups: readonly DrawerGroup[]
  current: { readonly provider: string; readonly model: string } | null
  busy: boolean
  onChoose: (provider: string, model: string) => void
  onContext: (model: string) => void
} & Pick<PropsLocale<'model'>, 't'>): ReactNode {
  const local = useLocal()
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const box = useRef<HTMLDivElement | null>(null)

  // Un hueco al principio de la barra (encima del texto), solo mientras está abierta.
  useEffect(() => {
    const card = anchor?.closest<HTMLElement>('[data-composer-card]')
    if (!open || card == null) return undefined
    const slot = document.createElement('div')
    slot.setAttribute('data-local-model-drawer', '')
    card.prepend(slot)
    setHost(slot)
    return () => {
      slot.remove()
      setHost(null)
      setSearching(false)
      setQuery('')
    }
  }, [open, anchor])

  // Se cierra con Esc o al pulsar fuera de la fila y del chip.
  useEffect(() => {
    if (!open) return undefined
    const down = (event: MouseEvent): void => {
      const target = event.target as Node
      if (box.current?.contains(target) === true || anchor?.contains(target) === true) return
      onClose()
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (searching) setSearching(false)
      else onClose()
    }
    document.addEventListener('mousedown', down, true)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [open, anchor, onClose, searching])

  if (!open || host === null) return null

  const lastUsed = (id: string): number => {
    const info = local.models[baseModel(id)]
    return info?.lastUsed == null ? 0 : Date.parse(info.lastUsed)
  }
  const unused = (id: string): boolean => local.models[baseModel(id)]?.unused === true
  const entries: Entry[] = groups.flatMap(group => contextListModels(group.models).map((model) => {
    const on = current !== null && current.provider === group.id && sameContextModel(current.model, model.id)
    const original = group.models.find(item => item.id === model.id) ?? model
    const live = on && current !== null ? group.models.find(item => item.id === current.model) ?? original : original
    return { provider: group.id, model, full: model.name, size: contextLabel(live), current: on }
  }))
    // El actual primero; luego los usados hace menos; los que llevan tiempo sin usarse, al final.
    .sort((a, b) => Number(b.current) - Number(a.current)
      || Number(unused(a.model.id)) - Number(unused(b.model.id))
      || lastUsed(b.model.id) - lastUsed(a.model.id))
  const found = entries.filter(entry => entry.full.toLowerCase().includes(query.trim().toLowerCase()))
  const shown = searching ? found : entries.slice(0, VISIBLE)
  const more = entries.length - VISIBLE
  const currentGroup = groups.find(group => group.id === current?.provider)

  const block = (entry: Entry): ReactNode => {
    const info = local.models[baseModel(entry.model.id)]
    const idle = info?.unused === true
    const meta = idle
      ? `Unused · ${gigabytes(info.sizeBytes)}`
      : [params(entry.full), entry.model.reasoning === undefined ? undefined : 'reasons', entry.size].filter(Boolean).join(' · ')
    return (
      <div key={`${entry.provider}:${entry.model.id}`} className={clsx(css.block, entry.current && css.on, idle && css.idle)}
        data-model-block={entry.model.id}>
        <Tooltip label={entry.full} side="top" delayMs={700}>
          <button type="button" className={css.pick} aria-pressed={entry.current} disabled={busy}
            onClick={() => { if (!entry.current) onChoose(entry.provider, entry.model.id) }}>
            <span className={css.name}>{contextShortName(entry.full)}</span>
            <span className={css.meta}>{meta}</span>
          </button>
        </Tooltip>
        {entry.current
          ? <span className={css.check}>{CHECK}</span>
          : <span className={css.tools}><LocalModelExtras model={entry.model.id} t={t} compact /></span>}
      </div>
    )
  }

  return createPortal(
    <div ref={box} className={css.drawer} role="group" aria-label={t('menu.aria')}>
      <div className={css.top}>
        {searching
          ? (
            <div className={css.search}>
              <button type="button" className={css.back} aria-label="Back" onClick={() => { setSearching(false); setQuery('') }}>{BACK}</button>
              <input className={css.query} value={query} autoFocus placeholder={t('search.placeholder')}
                aria-label={t('search.placeholder')} onChange={(event) => { setQuery(event.target.value) }} />
              <div className={css.strip}>{found.map(block)}</div>
            </div>
          )
          : (
            <div className={css.blocks} style={{ gridTemplateColumns: `repeat(${String(shown.length)}, minmax(0, 1fr))${more > 0 ? ' 64px' : ''}` }}>
              {shown.map(block)}
              {more > 0 && (
                <button type="button" className={css.more} onClick={() => { setSearching(true) }} aria-label={`${String(more)} more models`}>
                  <span className={css.moreCount}>+{more}</span>
                  <span className={css.meta}>more</span>
                </button>
              )}
            </div>
          )}
        {!searching && current !== null && currentGroup !== undefined && (
          <div className={css.context}>
            <span className={css.label}>{t('local.context.label')}</span>
            <ContextSlider models={currentGroup.models} current={current.model} disabled={busy} onSelect={onContext} t={t} />
          </div>
        )}
      </div>
      <div className={css.foot}>
        <span className={css.hint}>{WHEEL}Scroll on the chip to change the context</span>
        <span className={css.cleanup}><LocalCleanupSwitch t={t} /></span>
      </div>
    </div>,
    host,
  )
}
