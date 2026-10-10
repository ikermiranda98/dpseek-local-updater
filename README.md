# dpseek-local-updater

Versión local de [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
que se mantiene al día sola:

- usa tus modelos de **Ollama**, sin modelos online ni cuenta de DeepSeek (no gasta saldo),
- **sin inicio de sesión**, sin telemetría ni analítica,
- interfaz en **español** (Ajustes → General → Idioma → Español),
- permite **eliminar chats** de verdad (la oficial solo los archiva),
- el **contexto lo decide la app**: una barra en el selector de cada chat, con el
  recomendado medido para tu equipo,
- se **actualiza automáticamente** con cada versión nueva de DeepSeek, conservando
  estos cambios.

> Proyecto personal no oficial; no está afiliado a DeepSeek.

## Instalar

1. Instala [Ollama](https://ollama.com) y descarga el modelo que vayas a usar
   (por defecto `Qwen3.6-35B-A3B-Uncensored:latest`, ver *Modelos*).
2. Descarga el instalador `.exe` del
   [último Release](../../releases/latest)
   (`dsh-v<versión>-local.exe`) y ejecútalo. Como no está firmado, Windows SmartScreen avisará:
   «Más información» → «Ejecutar de todas formas».
3. En la app: Ajustes → General → Idioma → **Español**.

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

## Eliminar chats y proyectos

- **Chat** (también los de «Sin agrupar»): menú `⋯` del chat en la barra lateral →
  **Eliminar sesión** → confirmar. Se borra del disco la conversación, sus
  subagentes y su historial (`%USERPROFILE%\.dsh\sessions\…`). Los archivos de la
  carpeta de trabajo no se tocan. **No se puede deshacer**: si dudas, usa
  «Archivar».
- Si el chat está abierto o se ha usado desde que abriste la app, sigue cargado en memoria: se
  detiene y desaparece de la lista al momento, pero sus ficheros se borran la
  próxima vez que abras la app (así no se corrompe nada si aún estaba escribiendo).
- **Proyecto** (espacio de trabajo): menú del proyecto → *Eliminar espacio de
  trabajo* (ya existía en la oficial). Solo lo quita de la lista; sus chats pasan
  a «Sin agrupar», desde donde se pueden eliminar uno a uno.

## Contexto de cada chat

En el selector de modelo de cada chat, debajo de «Modelo», hay una **barra de
contexto**: a la izquierda «Más rápido», a la derecha «Más contexto», un punto por
tamaño (32K, 64K, 128K, 256K, hasta el máximo de cada modelo) y la marca
**«Recomendado»**, que es el mejor contexto para tu equipo, medido por la app. Los
chats nuevos empiezan en el recomendado. Los tamaños se cambian en
`config.json` → `contexto.tamanos`.

Cómo funciona:

- Ollama no acepta que se le pida el contexto por la API que usa la app, así que
  cada tamaño es una **variante del modelo** con el contexto fijado
  (`modelo:dsh-ctx-131072`, `modelo:dsh-ctx-auto`…). Se crean solas al abrir la
  app, **no ocupan disco** (comparten los ficheros del modelo) y no aparecen en el
  selector como modelos aparte (la barra elige entre ellas), aunque sí en
  `ollama list`. `OLLAMA_CONTEXT_LENGTH` deja de importar.
- **Recomendado** (variante `dsh-ctx-auto`): la primera vez que la app ve un
  modelo (o si cambias de tarjeta gráfica o de versión de Ollama) lo mide en
  segundo plano, solo con Ollama libre:
  lo carga con varios contextos y elige el mayor con el que la parte del modelo
  que va en la gráfica no se reduce (más allá, Ollama mueve capas a la CPU y va
  más lento). Tarda alrededor de un minuto y el resultado queda en
  `%USERPROFILE%\.dsh\storages\local-contexto.json` (bórralo para volver a
  medir). Hasta medirlo, el recomendado es `contexto.porDefecto`; el valor medido
  se ve en la barra al volver a abrir la app.
- La app sabe el tamaño exacto de cada opción y resume la conversación antes de
  llegar al límite, así que Ollama nunca recorta texto en silencio.
- Cambiar de contexto en mitad de un chat hace que Ollama recargue el modelo
  (unos segundos).
- Los chats creados antes de esta función tenían el modelo sin contexto
  (`modelo:latest`): al escribir en ellos la app pide elegir un modelo; elige el
  que quieras en el selector y sigue.

## Modelos y configuración (`config.json`)

**El selector de modelos muestra todos los modelos que tengas en Ollama**: la app
se los pregunta a Ollama cada vez que arranca (descarga uno nuevo con `ollama pull`
y reinicia la app para verlo). Los modelos solo de embeddings no aparecen. Si
Ollama no está en marcha al abrir la app, solo aparecen los de `modelosManuales`.

Editar `config.json` en GitHub (o hacer push) recompila el instalador al momento.

| Campo | Para qué sirve |
|---|---|
| `ollamaUrl` | Dirección de Ollama (`http://127.0.0.1:11434`). |
| `modeloPorDefecto` | Modelo con el que empiezan las sesiones nuevas (con el contexto recomendado). Tiene que existir en tu Ollama con ese nombre exacto. |
| `modelosManuales` | Modelos que aparecen si Ollama está apagado al abrir la app: `id` (nombre en Ollama), `imagenes`, `razonamiento` y, opcionales, `contexto` y `nombre`. |
| `contexto.porDefecto` | Contexto recomendado mientras un modelo no está medido (65536). |
| `contexto.tamanos` | Puntos de la barra de contexto (los mayores que el máximo de un modelo se cambian por ese máximo). |
| `maxTokensSalida` | Máximo de tokens por respuesta. |
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
| Contexto elegible por chat (barra en el selector) y recomendado medido para el equipo | `packages/bundle/base/cordis.patch.yml` + `packages/client/ui-model-selection`; código en [`sistema/contexto/`](sistema/contexto) |
| Sin ventana de bienvenida ni inicio de sesión | `apps/desktop/src/welcome-api.ts` |
| Sin menú ni ajustes de la cuenta de DeepSeek | `packages/bundle/web-app/cordis.patch.yml` |
| Sin modelos online de DeepSeek (cuenta y API) | `packages/bundle/base/cordis.patch.yml` |
| Sin telemetría ni analítica | `cordis.patch.yml` |
| Sin búsqueda web (usa la API de DeepSeek); la lectura de páginas se mantiene | bundles y presets |
| Idioma español | `packages/client/locale` + [`sistema/es-pack.json`](sistema/es-pack.json) |
| «Eliminar sesión» en el menú de cada chat (borrado definitivo, con confirmación) | `packages/api/session-controller` (método `session.deletePermanently`) + `packages/client/ui-workspace`; código en [`sistema/borrar-chats/`](sistema/borrar-chats) |
| Instalador sin firma, sin la «actualización obligatoria» de DeepSeek | `apps/desktop/scripts` |
| Actualizaciones desde los Releases de este repositorio | `apps/desktop/scripts/electron-builder-config.mjs` |

Los textos que añadan versiones nuevas aparecen en inglés hasta que se traduzcan en
`sistema/es-pack.json` (en `sistema/traduccion/` están los scripts para extraer
los textos de la app y validar la traducción). Los menús nativos de la ventana
(*Application/Edit*) solo existen en inglés y chino.

## Licencia

MIT. DeepSeek Harness es © DeepSeek, también bajo licencia MIT; los instaladores
publicados aquí incluyen su aviso de licencia.
