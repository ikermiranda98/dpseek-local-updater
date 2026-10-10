# dpseek-local-updater

Versión local de [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
que se mantiene al día sola:

- usa tus modelos de **Ollama**, sin modelos online ni cuenta de DeepSeek (no gasta saldo),
- **sin inicio de sesión**, sin telemetría ni analítica,
- interfaz en **español** (Ajustes → General → Idioma → Español),
- se **actualiza automáticamente** con cada versión nueva de DeepSeek, conservando
  estos cambios.

> Proyecto personal no oficial; no está afiliado a DeepSeek.

## Instalar

1. Instala [Ollama](https://ollama.com) y descarga el modelo que vayas a usar
   (por defecto `Qwen3.6-35B-A3B-Uncensored:latest`, ver *Modelos*).
2. Fija el contexto de Ollama (una vez; luego reinicia Ollama):
   ```
   setx OLLAMA_CONTEXT_LENGTH 65536
   ```
3. Descarga el instalador `.exe` del
   [último Release](../../releases/latest)
   (`dsh-v<versión>-local.exe`) y ejecútalo. Como no está firmado, Windows SmartScreen avisará:
   «Más información» → «Ejecutar de todas formas».
4. En la app: Ajustes → General → Idioma → **Español**.

La app guarda sus datos en `%USERPROFILE%\.dsh`. Si en ese PC se usó la versión
oficial, el token de su cuenta de DeepSeek puede seguir guardado ahí, pero esta
versión no incluye los modelos online, así que no lo usa.

## Actualizaciones

No hay que hacer nada:

1. Cada 6 horas, GitHub Actions comprueba si DeepSeek ha publicado una versión
   nueva. Si la hay, descarga su código, aplica los cambios de este repositorio,
   crea el instalador y lo publica como Release.
2. La app instalada lo detecta (Application → Check for Updates, o sola cada
   pocos minutos), lo descarga y se instala con «Install and Restart».

Para forzar una compilación: pestaña **Actions** → *Compilar instalador* →
*Run workflow* (marca «forzar» si ya existe un instalador para esa versión).

## Modelos y configuración (`config.json`)

**El selector de modelos muestra todos los modelos que tengas en Ollama**: la app
se los pregunta a Ollama cada vez que arranca (descarga uno nuevo con `ollama pull`
y reinicia la app para verlo). Los modelos solo de embeddings no aparecen. Si
Ollama no está en marcha al abrir la app, solo aparecen los de `modelosManuales`.

Editar `config.json` en GitHub (o hacer push) recompila el instalador al momento.

| Campo | Para qué sirve |
|---|---|
| `ollamaUrl` | Dirección de Ollama (`http://127.0.0.1:11434`). |
| `modeloPorDefecto` | Modelo con el que empiezan las sesiones nuevas. Tiene que existir en tu Ollama con ese nombre exacto. |
| `modelosManuales` | Modelos que aparecen siempre, aunque Ollama esté apagado: `id` (nombre en Ollama), `nombre`, `contexto`, `imagenes`, `razonamiento`. |
| `contextoMaximo` | Ventana de contexto declarada (también para los modelos detectados). **No debe superar `OLLAMA_CONTEXT_LENGTH`**, o Ollama recorta el prompt sin avisar. |
| `maxTokensSalida` | Máximo de tokens por respuesta. |
| `detectarModelosDeOllama` | Al compilar en un PC con Ollama, toma de allí los datos de los modelos fijos (en GitHub no hay Ollama y no hace falta). |
| `actualizaciones` | Opcional. Dirección de actualizaciones para compilaciones hechas fuera de GitHub; en GitHub se usa automáticamente la de los Releases de este repositorio. |

Si editas los modelos desde la app (Ajustes → Modelos → Ollama), esa lista pasa a
ser fija y deja de actualizarse sola.

## Qué cambia respecto a la versión oficial

Todo lo hace [`sistema/aplicar-cambios.mjs`](sistema/aplicar-cambios.mjs) sobre el
código oficial, buscando cada pieza por su nombre para sobrevivir a los cambios de
versión. Si una versión nueva cambia algo imprescindible, la compilación falla con
un `ERROR:` que explica qué falta (y la app sigue en la versión anterior).

| Cambio | Dónde |
|---|---|
| Ollama como proveedor y modelo por defecto | `packages/bundle/base/cordis.patch.yml` |
| Sin ventana de bienvenida ni inicio de sesión | `apps/desktop/src/welcome-api.ts` |
| Sin menú ni ajustes de la cuenta de DeepSeek | `packages/bundle/web-app/cordis.patch.yml` |
| Sin modelos online de DeepSeek (cuenta y API) | `packages/bundle/base/cordis.patch.yml` |
| Sin telemetría ni analítica | `cordis.patch.yml` |
| Sin búsqueda web (usa la API de DeepSeek); la lectura de páginas se mantiene | bundles y presets |
| Idioma español | `packages/client/locale` + [`sistema/es-pack.json`](sistema/es-pack.json) |
| Instalador sin firma, sin la «actualización obligatoria» de DeepSeek | `apps/desktop/scripts` |
| Actualizaciones desde los Releases de este repositorio | `apps/desktop/scripts/electron-builder-config.mjs` |

Los textos que añadan versiones nuevas aparecen en inglés hasta que se traduzcan en
`sistema/es-pack.json` (en `sistema/traduccion/` están los scripts para extraer
los textos de la app y validar la traducción). Los menús nativos de la ventana
(*Application/Edit*) solo existen en inglés y chino.

## Licencia

MIT. DeepSeek Harness es © DeepSeek, también bajo licencia MIT; los instaladores
publicados aquí incluyen su aviso de licencia.
