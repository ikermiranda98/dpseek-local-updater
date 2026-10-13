/**
 * Versión de la que se ha vuelto atrás (añadido por dpseek-local-updater).
 *
 * El script «volver-a-version-anterior» deja en
 * `<DSH_HOME>/storages/local-saltar-version.txt` la versión que se ha retirado.
 * La app no vuelve a ofrecer esa versión; sí la siguiente que se publique.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * @param version - versión que ofrece el canal de actualizaciones.
 * @returns si es la versión retirada con el script.
 */
export function localSkippedVersion(version: string): boolean {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  try {
    return readFileSync(join(home, 'storages', 'local-saltar-version.txt'), 'utf8').trim() === version
  } catch {
    return false
  }
}
