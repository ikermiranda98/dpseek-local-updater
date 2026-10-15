# dpseek-local-updater

Versión local de [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
que se mantiene al día sola:

- usa tus modelos de **Ollama**, sin modelos online ni cuenta de DeepSeek (no gasta saldo),
- **sin inicio de sesión**, sin telemetría ni analítica,
- **nombres cortos** de los modelos (los de Hugging Face sin `hf.co/autor/…-GGUF`),
- arranca **Ollama** si está apagado y **avisa con una notificación** cuando
  termina una respuesta con la ventana en segundo plano,
- permite **eliminar chats** de verdad, uno o varios a la vez (la oficial solo los
  archiva),
- el **contexto lo decide la app**: una barra en el selector de cada chat, con el
  recomendado medido para tu equipo, y el modelo queda **listo mientras la app
  está abierta**,
- se **actualiza automáticamente** con cada versión nueva de DeepSeek, conservando
  estos cambios; si DeepSeek añade una función que ya teníamos, se queda la suya.

> Proyecto personal no oficial; no está afiliado a DeepSeek.

## Instalar

1. Instala [Ollama](https://ollama.com) y descarga el modelo que vayas a usar
   (por defecto `Qwen3.6-35B-A3B-Uncensored:latest`, ver *Modelos*).
2. Descarga el instalador `.exe` del
   [último Release](../../releases/latest)
   (`dsh-v<versión>-local.exe`) y ejecútalo. Como no está firmado, Windows SmartScreen avisará:
   «Más información» → «Ejecutar de todas formas».

La app guarda sus datos en `%USERPROFILE%\.dsh`. Si en ese PC se usó la versión
oficial, el token de su cuenta de DeepSeek puede seguir guardado ahí, pero esta
versión no incluye los modelos online, así que no lo usa.

## Actualizaciones

No hay que hacer nada:

1. Cada 6 horas, GitHub Actions comprueba si DeepSeek ha publicado una versión
   nueva. Si la hay, descarga su código, aplica los cambios de este repositorio,
   crea el instalador y lo publica como Release.
2. Antes de publicarlo, **abre la app compilada y comprueba que arranca**; si no
   carga, no se publica y nadie la recibe.
3. La app instalada lo detecta (Application → Check for Updates, o sola cada
   pocos minutos), lo descarga y se instala con «Install and Restart».

### Volver a la versión anterior

Si una versión te da problemas: descarga `volver-a-version-anterior.ps1` de
cualquier Release (o de [`sistema/`](sistema/volver-a-version-anterior.ps1)) y
ejecútalo (clic derecho → *Ejecutar con PowerShell*). Te enseña las versiones
publicadas, descarga la que elijas, comprueba que es la publicada (sha512), la
instala y anota la versión de la que vienes para que la app **no te la vuelva a
ofrecer** (la siguiente que se publique, sí). Tus chats y ajustes no se tocan.
Con `-Probar` solo descarga y comprueba, sin instalar.

Para forzar una compilación: pestaña **Actions** → *Compilar instalador* →
*Run workflow* (marca «forzar» si ya existe un instalador para esa versión).

### Si DeepSeek cambia algo que tocamos

- **Lo imprescindible** (Ollama, sin cuenta ni inicio de sesión, el instalador y las
  actualizaciones): si ya no encaja, la compilación se detiene con un `ERROR:` y la
  app se queda en la versión anterior, que funciona, hasta que se adapte.
- **Las funciones añadidas** (eliminar chats,
  selección de varios, barra de contexto, chats antiguos al contexto recomendado,
  avisos de respuesta terminada, no volver a ofrecer una versión retirada, botón
  «Optimize»):
  - si DeepSeek añade la misma función, **se queda la oficial** y la nuestra no se
    aplica;
  - si algo suyo ha cambiado y la nuestra no encaja, esa función **se omite entera**
    (nunca a medias) y el resto se aplica igual.

  Lo omitido aparece en las notas de cada Release («Funciones nuestras omitidas en
  esta versión») y en el resumen de la compilación en *Actions*.

## Eliminar chats y proyectos

- **Chat** (también los de «Ungrouped»): menú `⋯` del chat en la barra lateral →
  **Delete session** → confirmar. Se borra del disco la conversación, sus
  subagentes y su historial (`%USERPROFILE%\.dsh\sessions\…`). Los archivos de la
  carpeta de trabajo no se tocan. **No se puede deshacer**: si dudas, usa
  «Archive».
- Si el chat está abierto o se ha usado desde que abriste la app, sigue cargado en memoria: se
  detiene y desaparece de la lista al momento, pero sus ficheros se borran la
  próxima vez que abras la app (así no se corrompe nada si aún estaba escribiendo).
- **Varios a la vez**: menú `⋯` de un chat → **Select several**. Aparece una
  casilla en cada chat y una barra abajo con el número de seleccionados,
  **All** (marca o desmarca todos los visibles), **Delete** y **Cancel**.
  «Delete» pide confirmación con la lista de chats; si alguno no se puede borrar,
  queda seleccionado y se dice cuál.
- **Proyecto** (espacio de trabajo): menú del proyecto → *Delete
  workspace* (ya existía en la oficial). Solo lo quita de la lista; sus chats pasan
  a «Ungrouped», desde donde se pueden eliminar uno a uno o varios a la vez.

## Contexto de cada chat

En el selector de modelo de cada chat, debajo de «Model», hay una **barra de
contexto**: a la izquierda «Faster», a la derecha «More context», un punto por
tamaño (32K, 64K, 128K, 256K, hasta el máximo de cada modelo) y la marca
**«Recommended»**, que es el mejor contexto para tu equipo, medido por la app. Los
chats nuevos empiezan en el recomendado. Los tamaños se cambian en
`config.json` → `contexto.tamanos`.

Cómo funciona:

- Ollama no acepta que se le pida el contexto por la API que usa la app, así que
  cada tamaño es una **variante del modelo** con el contexto fijado
  (`modelo:dsh-ctx-131072`, `modelo:dsh-ctx-auto`…). Las crea la app (ver
  «Automatic variant cleanup» más abajo), **apenas ocupan disco** (comparten los ficheros del modelo) y no aparecen en el
  selector como modelos aparte (la barra elige entre ellas), aunque sí en
  `ollama list`. `OLLAMA_CONTEXT_LENGTH` deja de importar.
- **Recommended** (variante `dsh-ctx-auto`): la primera vez que la app ve un
  modelo (o si cambias de tarjeta gráfica o de versión de Ollama) lo mide en
  segundo plano, solo con Ollama libre: lo carga con cada tamaño de contexto,
  **mide la velocidad real** de generación y elige el mayor tamaño que mantiene al
  menos el 85 % de la velocidad del más rápido. Tarda unos minutos por modelo
  (más en los densos, por el ajuste de capas) y el resultado queda en
  `%USERPROFILE%\.dsh\storages\local-contexto.json`. Hasta medirlo, el
  recomendado es `contexto.porDefecto`; el valor medido se ve en la barra al volver
  a abrir la app.
- **Modelos densos que no caben en la gráfica** (por ejemplo, de 27.000 millones
  de parámetros con 8 GB): Ollama deja libre más memoria de la gráfica de la
  necesaria y el modelo va varias veces más lento. Al medirlos, la app busca para
  cada tamaño de contexto cuántas capas caben en la memoria real de la gráfica
  (con 400 MB de margen) y las fija en sus variantes (`num_gpu`). En una RTX 4060
  de 8 GB, un modelo de 27.000 millones en IQ2_XS pasó de 4,8 a 12,2 tok/s con 32K
  y de unos 4 a 7,6 tok/s con 64K. A los modelos MoE (como Qwen…-A3B) no se les
  toca: Ollama ya los reparte bien.
- **Botón «Optimize»** (el icono de velocímetro junto a cada modelo de la lista
  del selector): vuelve a medir ese modelo ahora, en segundo plano (carga el
  modelo varias veces; unos minutos). Si había un modelo cargado, lo descarga
  primero. Mientras mide, un anillo alrededor del icono se va completando con el
  progreso; al pasar el ratón por encima, el anillo se cambia por el porcentaje. Al dar la vuelta
  entera aparece una marca ✓. Úsalo tras cambiar de gráfica, de versión de Ollama o de ajustes de
  Ollama. Si cierras la app mientras mide, la medición se deja y se repite
  al volver a abrirla; el nuevo recomendado se ve al volver a abrir la app (las capas se
  aplican al momento).
- **Compresión del contexto de Ollama** (`OLLAMA_FLASH_ATTENTION=1` y
  `OLLAMA_KV_CACHE_TYPE=q8_0`, variables de usuario de Windows; hay que reiniciar
  Ollama): reduce la memoria del contexto. En el equipo de pruebas aceleró los
  modelos densos (de 8,5 a 13,1 tok/s con 32K) y no frenó a los MoE (Qwen: 34,3 →
  36,5 tok/s). Si se activa o se quita, la app vuelve a medir los modelos.
- La app sabe el tamaño exacto de cada opción y resume la conversación antes de
  llegar al límite, así que Ollama nunca recorta texto en silencio.
- Cambiar de contexto en mitad de un chat hace que Ollama recargue el modelo
  (unos segundos).
- Los chats creados antes de esta función tenían el modelo sin contexto
  (`modelo:latest`): pasan solos al contexto recomendado de ese modelo, igual que
  el modelo predeterminado si se guardó así. Sus registros no se modifican.
- **Modelo listo mientras la app está abierta**: Ollama descarga un modelo a los
  5 minutos sin uso y el siguiente mensaje tarda en recargarlo. Al abrir la app se
  carga el modelo por defecto con el contexto recomendado (si Ollama no tiene otro
  cargado) y, mientras la app sigue abierta, se mantiene cargado el que estés
  usando; al cerrarla se descarga y se libera la memoria. Se aparta mientras se
  mide el contexto.
- **Automatic variant cleanup** (interruptor al final del menú del
  selector; activado por defecto): solo se guarda en Ollama la variante
  recomendada (`dsh-ctx-auto`). Las demás se crean al enviar el primer mensaje con
  ese tamaño (unos segundos) y se borran al abrir la app si llevan **7 días** sin
  usarse. Así puedes mover la barra cuando quieras sin que `ollama list` se llene
  de variantes. Desactivado, se crean todas al abrir la app y no se borra ninguna.
- **Modelos sin usar**: un modelo que no usas desde hace **30 días** (contando
  desde que lo descargaste o desde que la app empezó a anotar los usos, lo más
  reciente) aparece en la lista del selector con la
  marca «Unused · X GB» y una papelera. El primer clic pide confirmación
  («Delete X GB?», 4 segundos); el segundo lo borra del disco con todas sus
  variantes. Es lo único de la app que borra un modelo descargado, y siempre a
  mano.
- **Limpieza**: si borras un modelo con `ollama rm`, la app borra sus variantes al
  abrirse (si no, seguirían ocupando su espacio en disco). También las de tamaños
  que quites de `contexto.tamanos`. Solo toca nombres `dsh-ctx-`, nunca un modelo
  descargado.

## Modelos y configuración (`config.json`)

**El selector de modelos muestra todos los modelos que tengas en Ollama**: la app
se los pregunta a Ollama cada vez que arranca (descarga uno nuevo con `ollama pull`
y reinicia la app para verlo). Los modelos solo de embeddings no aparecen.

- **Ollama apagado**: al abrirse, la app lo arranca (la aplicación de Ollama, con
  su icono junto al reloj) y espera hasta 12 s. Si aun así no responde, el
  selector muestra los de `modelosManuales` con la etiqueta «Ollama not responding».
- **Nombres**: se muestra un nombre corto. Los de Hugging Face
  (`hf.co/Kujira/Underdog-Saluki-27B-1.0-MTP-Abliterated-GGUF:latest`) se quedan
  en el nombre del modelo (`Underdog-Saluki-27B-1.0-MTP-Abliterated`): sin origen,
  sin `-GGUF` y sin la etiqueta de cuantización. Los de la biblioteca de Ollama
  conservan su etiqueta (`qwen3:8b`), salvo `:latest`. Si dos coincidieran, se
  añade lo justo para distinguirlos (la etiqueta y, si hace falta, el autor). En
  Ollama siguen llamándose igual; para ponerle otro nombre a uno, usa `nombres`.

Editar `config.json` en GitHub (o hacer push) recompila el instalador al momento.

| Campo | Para qué sirve |
|---|---|
| `ollamaUrl` | Dirección de Ollama (`http://127.0.0.1:11434`). |
| `modeloPorDefecto` | Modelo con el que empiezan las sesiones nuevas (con el contexto recomendado). Tiene que existir en tu Ollama con ese nombre exacto. |
| `nombres` | Nombres a mano: `{ "nombre en Ollama": "nombre que se muestra" }`, p. ej. `{ "hf.co/autor/Modelo-GGUF:Q4_K_M": "Modelo rápido" }`. |
| `modelosManuales` | Modelos que aparecen si Ollama está apagado al abrir la app: `id` (nombre en Ollama), `imagenes`, `razonamiento` y, opcionales, `contexto` y `nombre`. |
| `contexto.porDefecto` | Contexto recomendado mientras un modelo no está medido (65536). |
| `contexto.tamanos` | Puntos de la barra de contexto (los mayores que el máximo de un modelo se cambian por ese máximo). |
| `maxTokensSalida` | Máximo de tokens por respuesta. |
| `actualizaciones` | Opcional. Dirección de actualizaciones para compilaciones hechas fuera de GitHub; en GitHub se usa automáticamente la de los Releases de este repositorio. |

Si editas los modelos desde la app (Settings → Models → Ollama), esa lista pasa a
ser fija y deja de actualizarse sola.

### Otros proveedores junto a Ollama (`proveedores-extra.json`)

Para usar también un servidor compatible con OpenAI o Anthropic (un relé, otro
equipo, una API de pago…), créalo en `%USERPROFILE%\.dsh\proveedores-extra.json`
y reinicia la app: sus modelos salen en el selector junto a los de Ollama.

```json
{
  "mi-servidor": {
    "nombre": "Mi servidor",
    "url": "https://servidor.ejemplo/v1",
    "protocolo": "openai-completions",
    "clave": "",
    "modelos": [
      { "id": "nombre-del-modelo", "nombre": "Nombre a mostrar", "contexto": 131072 }
    ]
  }
}
```

- La clave del objeto (`mi-servidor`) es el id del proveedor: minúsculas, números
  y guiones, empezando por letra. `ollama` está reservado.
- `protocolo`: `openai-completions` (por defecto), `openai-responses` o
  `anthropic-messages`. `clave` es opcional; sin clave se manda una ficticia para
  que la app no envíe a ese servidor otra que encuentre en el entorno
  (`OPENAI_API_KEY`…). En `modelos`, `id` es obligatorio; `nombre`, `contexto` y
  `maxTokens`, opcionales.
- Si el fichero tiene un error, se ignora (o ese proveedor) y Ollama sigue igual.
- **No uses «Add model provider» de Settings → Models ni declares `llm-pi-ai` en
  el perfil** (`profiles/desktop/cordis.patch.yml`): la configuración de la app se
  sustituye por filas enteras, así que eso deja la app **sin Ollama**. Este fichero
  existe para evitarlo.
- Todo lo que mandes a un proveedor de fuera (mensajes, código y ficheros que lea
  el agente) sale de tu equipo.

## Qué cambia respecto a la versión oficial

Todo lo hace [`sistema/aplicar-cambios.mjs`](sistema/aplicar-cambios.mjs) sobre el
código oficial, buscando cada pieza por su nombre para sobrevivir a los cambios de
versión (ver *Si DeepSeek cambia algo que tocamos*).

| Cambio | Dónde |
|---|---|
| Ollama como proveedor y modelo por defecto, y proveedores extra de `proveedores-extra.json` | `packages/bundle/base/cordis.patch.yml` |
| Contexto por variantes, recomendado y capas en la gráfica medidos, modelo listo y limpieza de variantes | `packages/bundle/base/cordis.patch.yml`; código en [`sistema/contexto/`](sistema/contexto) (`arranque.cjs`, `calibrar.cjs`, `precarga.cjs`) |
| Barra de contexto en el selector (opcional) | `packages/client/ui-model-selection` (`ContextSlider.tsx`) |
| Botón «Optimize» junto a cada modelo (opcional) | `packages/api/session-controller` (`local-optimize.ts`) + `packages/client/ui-model-selection` (`LocalOptimizeButton.tsx`) |
| Chats antiguos al contexto recomendado (opcional) | `packages/api/session-controller` y `packages/core/agent-default-model` (`local-ollama.ts`) |
| Sin ventana de bienvenida ni inicio de sesión | `apps/desktop/src/welcome-api.ts` |
| Sin menú ni ajustes de la cuenta de DeepSeek | `packages/bundle/web-app/cordis.patch.yml` |
| Sin modelos online de DeepSeek (cuenta y API) | `packages/bundle/base/cordis.patch.yml` |
| Sin telemetría ni analítica | `cordis.patch.yml` |
| Sin búsqueda web (usa la API de DeepSeek); la lectura de páginas se mantiene | bundles y presets |
| «Delete session» en el menú de cada chat (opcional) | `packages/api/session-controller` (método `session.deletePermanently`) + `packages/client/ui-workspace`; código en [`sistema/borrar-chats/`](sistema/borrar-chats) |
| Seleccionar varios chats («Select several») y eliminarlos a la vez (opcional) | `packages/client/ui-workspace` (`BulkDelete.tsx`) |
| Aviso de Windows al terminar una respuesta (opcional) | `packages/client/ui-workspace`; código en [`sistema/avisos/`](sistema/avisos) |
| No volver a ofrecer una versión retirada (opcional) | `apps/desktop/src/update-coordinator.ts` (`local-skip-version.ts`) |
| Instalador sin firma, sin la «actualización obligatoria» de DeepSeek | `apps/desktop/scripts` |
| Actualizaciones desde los Releases de este repositorio | `apps/desktop/scripts/electron-builder-config.mjs` |
| Prueba de arranque antes de publicar | [`sistema/prueba-arranque.mjs`](sistema/prueba-arranque.mjs) en el workflow |

La app va en inglés (o en chino), como la oficial: no se añade ningún idioma.

## Aviso al terminar una respuesta

Si la ventana no está delante (otra app encima o minimizada) cuando un chat
termina de responder, sale una notificación de Windows con el título del chat;
al pulsarla se abre ese chat. Los subagentes no avisan. Se pueden silenciar desde
la configuración de notificaciones de Windows (*DeepSeek Harness*).

## Licencia

MIT. DeepSeek Harness es © DeepSeek, también bajo licencia MIT; los instaladores
publicados aquí incluyen su aviso de licencia.
