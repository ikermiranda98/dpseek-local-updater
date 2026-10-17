// Esqueleto de arranque (dpseek-local-updater): tema claro u oscuro desde el primer frame
// y retirada del esqueleto en cuanto la app monta su interfaz.
(() => {
  const KEY = 'dsh-local-boot-theme'
  document.documentElement.classList.add('dsk-on')
  let saved = null
  try { saved = localStorage.getItem(KEY) } catch { /* sin almacenamiento */ }
  // El tema de la última vez (el Host lo confirma o lo corrige al llegar); si no hay, el del sistema.
  const dark = saved === 'dark' || (saved === null && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.toggleAttribute('data-dsk-dark', dark)
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.body.style.setProperty('--dsh-boot-bg', dark ? '#151517' : '#fff')

  // Recordar el tema que aplica la app (al arrancar y si se cambia en Ajustes).
  new MutationObserver(() => {
    try { localStorage.setItem(KEY, document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light') } catch { /* sin almacenamiento */ }
  }).observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })

  // Fuera el esqueleto (va justo antes de #root) cuando en #root aparece algo que no es la
  // pantalla de carga: la interfaz ya está montada.
  const root = document.getElementById('root')
  const skeleton = document.body.querySelector(':scope > .dsk')
  if (!root || !skeleton) return
  const watch = new MutationObserver(() => {
    const mounted = [...root.children].some((child) => !child.hasAttribute('data-dsh-boot'))
    if (mounted || !skeleton.isConnected) {
      skeleton.remove()
      watch.disconnect()
      // Sus estilos también: ya no hacen falta.
      document.getElementById('dsh-local-skeleton-style')?.remove()
      document.documentElement.removeAttribute('data-dsk-dark')
      document.documentElement.classList.remove('dsk-on')
      document.body.style.removeProperty('--dsh-boot-bg')
    }
  })
  watch.observe(root, { childList: true })
})()
