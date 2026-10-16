// Abre la app con el home de prueba y deja CDP en 9555 para explorar. Uso: node explorar.mjs <exe> <home> <userdata>
import { spawn } from 'node:child_process'
const [exe, home, userData] = process.argv.slice(2)
const child = spawn(exe, ['--remote-debugging-port=9555', `--user-data-dir=${userData}`], {
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_OPEN_DEVTOOLS: '0' }, detached: true, stdio: 'ignore',
})
child.unref()
console.log('pid', child.pid)
