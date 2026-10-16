/**
 * «Load earlier» que carga solo (añadido por dpseek-local-updater).
 *
 * El botón oficial pide una página de mensajes anteriores cada vez que se pulsa. Este
 * es el mismo botón, pero además pide la página cuando el lector, que ha subido por el
 * chat, llega a menos de MARGIN píxeles de lo ya cargado: el historial antiguo aparece
 * mientras se sube, sin pulsar nada. Nunca carga mientras se sigue el final del chat
 * (la carga pausa el seguimiento y el texto que llega dejaría de verse).
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

/** Cuánto antes de llegar arriba se pide la página siguiente. */
const MARGIN = 1500

/**
 * @param props - si está cargando, si se sigue el final, cómo cargar y el texto del botón.
 * @returns el botón «Load earlier».
 */
export function LocalOlderButton({ loading, followingTail, onLoad, children }: {
  loading: boolean
  followingTail: boolean
  onLoad: () => void
  children: ReactNode
}): ReactNode {
  const button = useRef<HTMLButtonElement | null>(null)
  const latest = useRef({ loading, followingTail, onLoad })
  latest.current = { loading, followingTail, onLoad }

  const maybeLoad = (): void => {
    const state = latest.current
    const element = button.current
    if (state.loading || state.followingTail || element === null) return
    const root = element.closest('[data-conversation-scroll]')
    const top = root === null ? 0 : root.getBoundingClientRect().top
    if (element.getBoundingClientRect().bottom > top - MARGIN) state.onLoad()
  }

  useEffect(() => {
    const element = button.current
    if (element === null) return undefined
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) maybeLoad()
    }, { root: element.closest('[data-conversation-scroll]'), rootMargin: `${String(MARGIN)}px 0px 0px 0px` })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  // Al terminar una página (o dejar de seguir el final), si aún se está cerca de arriba, la siguiente.
  useEffect(() => {
    if (loading) return undefined
    const frame = requestAnimationFrame(maybeLoad)
    return () => { cancelAnimationFrame(frame) }
  }, [loading, followingTail])

  return <button ref={button} type="button" disabled={loading} onClick={onLoad}>{children}</button>
}
