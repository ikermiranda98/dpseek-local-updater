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

### Aviso antes de instalar

El semáforo ya se ve en el panel de **Update** (abajo a la izquierda) y, antes de
«Install and Restart», la app te dice qué cambia para las funciones de
esta versión local:

- 🟢 **verde:** nada de lo nuestro se ve afectado;
- 🟡 **ámbar:** DeepSeek ha cambiado código que usa alguna función nuestra (se ha
  aplicado, pero conviene probarla), o ahora la trae la oficial;
- 🔴 **rojo:** se pierde alguna función que tienes ahora.

Debajo van las funciones afectadas y los cambios propios desde la versión anterior.
*View technical details* muestra los ficheros que han cambiado y un extracto de
las notas de DeepSeek. Los botones son **Install and Restart**, **Update later** y
**Skip this version**: con este último, la app no la vuelve a ofrecer, pero sí la
siguiente que se publique.

Lo prepara la compilación ([`sistema/informe-actualizacion.mjs`](sistema/informe-actualizacion.mjs)):
compara los ficheros oficiales que toca cada función entre la versión oficial
anterior y la nueva, y lo publica en cada Release como `local-update-info.json`.
Si la app no puede leerlo (sin conexión, o un Release antiguo), lo dice y enseña
la confirmación normal.

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

## Chats en la barra lateral: seleccionar, borrar y mover

Funcionan como los archivos en el Explorador de Windows:

- **Seleccionar:** clic abre el chat; **Ctrl+clic** añade o quita; **Mayús+clic**
  selecciona un rango; pulsar en un hueco de la barra lateral y **arrastrar** dibuja
  un recuadro que selecciona los chats que toca. Los seleccionados se rellenan con
  el azul del tema. Un clic en un hueco o **Esc** quita la selección.
- **Menú del chat:** el botón derecho y el `⋯` (lo único que aparece al pasar el
  ratón) abren el mismo menú: Open, Pin, Rename (**F2**), Branch, Archive, Move to
  project ▸, Copy session ID y Delete (**Supr**). Con varios seleccionados, actúa
  sobre todos.
- **Delete** pide confirmación y borra del disco la conversación, sus subagentes y
  su historial (`%USERPROFILE%\.dsh\sessions\…`). Los archivos de la carpeta de
  trabajo no se tocan. **No se puede deshacer**: si dudas, usa «Archive». Si el
  chat está abierto o se ha usado desde que abriste la app, desaparece al momento
  pero sus ficheros se borran la próxima vez que la abras (así no se corrompe nada
  si aún estaba escribiendo).
- **Move to project** (solo chats de «Ungrouped»): a un proyecto de la misma
  carpeta de trabajo que el chat, o a uno nuevo para esa carpeta. La app no deja
  meter un chat en un proyecto de otra carpeta, porque sus archivos dejarían de
  encontrarse. También se pueden arrastrar sobre el proyecto.
- **Proyecto** (espacio de trabajo): menú del proyecto → *Delete workspace* (ya
  existía en la oficial). Solo lo quita de la lista; sus chats pasan a «Ungrouped».

## Editar mensajes y regenerar respuestas

Como en Hermes Agent Desktop:

- **Editar:** haz clic en tu mensaje y se edita en el sitio. Enter envía, Mayús+Enter
  salta de línea y Esc cancela; un clic fuera solo cancela si no has cambiado nada.
  Si seleccionas texto del mensaje (para copiarlo) o pulsas un enlace o una imagen,
  no se abre el editor. Las imágenes adjuntas se reenvían; los archivos, no.
- **Regenerar:** icono «Regenerate response» (↻) bajo cada respuesta de la IA,
  también en las antiguas. Usa el modelo que tengas elegido en ese momento.
- **Versiones:** el historial de un chat no se puede recortar, así que editar o
  regenerar copia el chat hasta justo antes de ese mensaje, lo envía allí y archiva
  el original. Bajo tu mensaje aparece «‹ 2/2 ›» para pasar de una versión a otra.
  Cuando escribes un mensaje nuevo en una versión, esa queda como la buena y **las
  demás se borran del todo** (la barra avisa si alguna tenía mensajes posteriores).

## Ver el código que escribe y deshacerlo

- Cuando la IA escribe o edita ficheros, la línea de estado del turno («Deep diving…»
  mientras trabaja, «Completed in…» al acabar) lleva **`</> View code · N files`**.
  Abre a la derecha la pestaña **Live code**: una pestaña por fichero, con colores
  y números de línea; las ediciones se ven como diferencias (rojo lo quitado, verde
  lo añadido). «Follow» la mantiene en el fichero que se está escribiendo. El panel
  no se abre solo.
- **En tiempo real** si el proveedor envía el código por trozos (la API de DeepSeek,
  OpenAI o Anthropic lo hacen). **Ollama lo entrega entero** cuando el modelo termina
  de escribirlo, así que con Ollama el fichero aparece completo de una vez.
- **Deshacer por fichero:** «Review changes and undo» abre la revisión de cambios del
  turno; cada fichero tiene **Undo** (pide confirmación con un segundo clic) y lo deja
  como estaba al empezar el turno: restaura lo editado, quita lo creado y recupera
  lo borrado. Si el fichero se ha tocado después de ese turno, no lo cambia y avisa.
  La revisión solo existe mientras la app sigue abierta desde ese turno.

## Subchats

Para tareas que ocuparían mucho del chat sin llenarlo:

- **Abrir:** icono `└` («Open in subchat») bajo cada respuesta, o selecciona un trozo
  de una respuesta y pulsa **Open in subchat** junto a él (va citado en la tarea). En
  el cuadro hay **tareas rápidas** (Review the code, Write tests, Find the bug…) y la
  casilla **«Let me review the result before it goes back»**. El subchat se abre a la
  derecha, ocupando el 40 % de la zona de chat (luego se redimensiona a mano).
- **Memoria:** empieza con **toda la conversación** del chat (una foto del momento en
  que lo abres) y trabaja con **esfuerzo alto** (y con subagentes si le hacen falta), en
  el mismo modelo y contexto que el chat: así Ollama no recarga el modelo y reutiliza lo
  que ya tenía procesado.
- **Ventana limpia:** el subchat empieza en tu tarea. La conversación copiada no se
  pinta (una línea arriba, «Continues from the main chat · N earlier messages · Show»,
  la enseña) y las instrucciones que acompañan a la tarea llegan al modelo pero no se
  ven.
- **Resultado:** al terminar bien, **solo su respuesta final** vuelve **una vez** al
  chat principal, como la tarjeta **«Subchat · nombre · finished in …»** con sus primeras
  líneas y «Open subchat», y el chat sigue con ella. Si lo paras o falla, no se manda
  nada. Con «review», el resultado espera: lo mandas con el icono ✈ («Send to main
  chat») bajo la respuesta del subchat o desde su menú.
- **Barra lateral:** los subchats salen bajo su chat en un grupo que se **pliega y
  despliega** («▾ 3 subchats»). Punto **azul** mientras trabaja, **ámbar** si espera una
  respuesta o un permiso tuyo, **rojo** si se paró o falló, **violeta** si tiene un
  resultado por revisar y **verde** al terminar; al pasar el ratón, el tiempo, los
  tokens y si comparte el modelo con otro chat en marcha (entonces puede esperar su
  turno). Clic derecho: Open, Open beside, Stop, Send result to main chat, Rename,
  Remove from sidebar y Delete. Se seleccionan como los chats (Ctrl, Mayús, recuadro) y
  se borran varios a la vez con **Supr**.
- **Aviso:** cuando un subchat termina y no lo estás viendo, aviso de Windows.
- **Sugerencia:** con el chat ya lleno, junto al medidor de contexto aparece **«Send
  to a subchat»** (desde el 60 % si estás escribiendo; desde el 80 %, siempre como aviso)
  con las cifras al pasar el ratón. Un clic manda lo que has escrito a un subchat.
- Dentro de un subchat no se abre otro.

## Mejorar un mensaje antes de enviarlo

En la barra del cuadro de texto, junto al **+**, el botón ✨ (**Improve message**)
reescribe tu mensaje para que la IA lo entienda sin ambigüedad (qué hacer, con qué
ficheros o nombres y qué resultado esperas), sin cambiar lo que pides, sin responderlo
y en tu idioma. La sugerencia sale en una tarjeta pequeña encima del cuadro y se puede
retocar: **Use** la pone en el cuadro (no la envía) y ✕ deja lo tuyo. La tarjeta es
mínima: las versiones en una línea, el texto, un solo botón y lo demás como enlaces.

- **No inventa nombres:** ve los últimos mensajes del chat y la lista de ficheros del
  proyecto (solo los nombres), así que «el archivo de la calculadora» pasa a ser
  `calculadora.py` si existe; si no, deja tus palabras.
- **Pregunta en vez de adivinar:** si falta algo importante (qué lenguaje, qué
  fichero…), la tarjeta trae una o dos preguntas; contéstalas y **Update with answers**
  rehace la sugerencia.
- **Según el tamaño:** una petición sencilla queda en una o dos frases; una tarea
  grande, en apartados cortos (objetivo, ficheros, requisitos, restricciones y cuándo
  está hecha).
- **Prompts largos, reorganizados y sin perder nada:** si lo que has escrito ya es un
  prompt largo (más de unas 1.200 letras o 20 líneas), ✨ no lo resume: primero lista sus
  problemas concretos (referencias a la sección equivocada, duplicados, contradicciones,
  instrucciones vagas, pasos sin orden claro) y después lo reescribe entero, ordenado en
  secciones, con todas sus reglas, cifras, tablas y plantillas, corrigiendo esos problemas.
  Si la versión nueva sale mucho más corta que la tuya, lo repite y, si sigue corta, avisa.
  Tarda unos minutos; la tarjeta dice qué ha corregido.
- **Mientras escribe:** la tarjeta enseña el texto según llega (y, en los prompts largos,
  la fase: revisando o reescribiendo); **Cancel** corta la petición también en Ollama.
- **Otras versiones:** **Suggested · Short · Detailed · Step by step**, en una línea; cada una
  se pide al pulsarla y se guarda, así cambiar entre ellas es inmediato.
- **Corregir con una frase:** en **Not quite?** escribes lo que no te convence («más corto»,
  «en Python», «no toques la parte de X») y la rehace a partir de la sugerencia, no desde cero.
- **Volver:** después de **Use**, una flecha junto a ✨ devuelve tu texto de antes, con sus
  documentos y la tarjeta como estaban (desaparece en cuanto cambias el texto).
- **Cada chat guarda su tarjeta:** si cambias de chat a mitad, al volver la encuentras igual,
  también si seguía trabajando.
- **Think deeper:** repite la versión actual con el razonamiento del modelo activado; mejor
  para casos difíciles, pero tarda alrededor de un minuto (se ve el razonamiento mientras).
- **Changes:** marca palabra a palabra lo añadido (verde) y lo quitado (tachado)
  respecto a tu texto; los cambios solo de formato (viñetas, negritas) no cuentan.
- **El botón avisa:** si lo que has escrito es vago («arregla eso», «no va», «hazlo como te
  dije») o acabas de pegar un texto largo que conviene reorganizar, el ✨ se pone de color con
  un punto. No cambia nada solo.
- **De documentos a un prompt:** con el cuadro vacío, ✨ pide los ficheros (PDF, DOCX o
  texto; uno o varios). Al arrastrar ficheros ya no sale la capa a pantalla completa: la
  barra se marca con un borde («Drop to attach») y ✨ se convierte en **Make prompt**.
  Soltarlos en la barra los adjunta al mensaje, como siempre; soltarlos en ✨ los carga
  para el prompt. Los documentos cargados se ven encima del texto como píldoras con ✨ (y
  ✨ dice cuántos hay). Lo que escribas en el cuadro es la instrucción: pulsa ✨ y la usa;
  con el cuadro vacío, la tarjeta ofrece **Implement**, **Review**, **Plan the tasks** o
  **Explain** en una fila. Se leen en tu equipo, sin internet (los PDF con el mismo
  lector que las vistas previas); la píldora dice páginas o palabras y avisa (⚠) si se
  ha cortado o hay páginas sin texto (escaneadas).
- **Los documentos van enteros, sin resumir:** el modelo escribe solo lo que hay que hacer
  con ellos (objetivo, ficheros, restricciones, cuándo está hecho) y van debajo del prompt,
  palabra por palabra, cada uno con su título. **Use** pone solo el prompt en el cuadro: los
  documentos se quedan como una píldora con un clip (📎) y se añaden debajo del mensaje al
  enviarlo, así la barra no se llena de páginas (✕ en la píldora los quita). Si son largos (más de unas 10 páginas),
  **Key parts** quita lo que la IA no necesita (portada, índice, agradecimientos,
  narrativa, repeticiones) para gastar menos contexto del chat: el modelo solo dice qué
  párrafos sobran y el resto se copia del original tal cual, sin cambiar una palabra; las
  tablas, las reglas y las cifras se quedan siempre, y «[…]» marca lo quitado (alrededor de
  un minuto por cada 45.000 caracteres). **Preview** enseña lo que irá debajo.
- **Word bien leído:** títulos como «#» (con su numeración), listas numeradas o con
  viñetas, tablas como tablas, notas al pie; sin el texto borrado del control de cambios,
  sin el índice y sin los códigos de los campos.

Lo escribe el **modelo del chat**, en su misma variante de contexto: Ollama no lo
recarga y, medido, el siguiente mensaje tarda lo mismo que sin usar el botón (unos 2–5 s
la sugerencia con Qwen3.6-35B; el prompt de un documento, unos 5–10 s).

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

## Actualizar Ollama desde la app

Las actualizaciones de la app y de Ollama comparten un solo botón, **Update**, abajo a
la izquierda: sale cuando hay alguna (con un «2» si hay de las dos) y abre un panel con
una fila por actualización, cada una con su botón y sus novedades en «What's new».
En la fila de la app, las novedades son el semáforo y el resumen de lo que la versión
nueva cambia para las funciones locales, y su botón lleva a la confirmación de siempre
(instalar y reiniciar, más tarde o saltar esa versión).
**Update** en la fila de Ollama:

1. espera a que terminen las respuestas en marcha (el instalador cierra Ollama);
2. descarga `OllamaSetup.exe` del Release oficial y lo instala en silencio, con los
   mismos parámetros que usa el actualizador del propio Ollama;
3. vuelve a abrir Ollama, refresca la lista de modelos y vuelve a medir el modelo por
   defecto para la versión nueva (los demás se miden solos al abrir la app).

La app consulta GitHub como mucho cada 6 horas. Solo en Windows.

## Modelos y configuración (`config.json`)

**El selector de modelos muestra todos los modelos que tengas en Ollama**: la app
se los pregunta a Ollama al arrancar y **cada vez que abres el selector**, así que
un modelo descargado con `ollama pull` o borrado con `ollama rm` se ve (o deja de
verse) al abrirlo, sin reiniciar la app; si es nuevo, se mide en segundo plano
como al arrancar. Los modelos solo de embeddings no aparecen.

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

## Rendimiento

Medido con un banco de pruebas propio (150 chats y uno de 400 turnos; detalles y cómo
repetirlo en [`sistema/rendimiento/`](sistema/rendimiento)):

- **Arranque:** la lista de modelos de Ollama se pide una vez, no nueve: de 4,1 s a 3,0 s
  hasta poder usar la app.
- **Chats largos:** el navegador ya no maqueta lo que no se ve. El scroll con todo el
  historial pasa de frames de hasta 110 ms a ninguna tarea larga, y usa menos memoria.
- **Mensajes antiguos:** se cargan solos al subir, en páginas más grandes. Llegar al
  principio de un chat de 400 turnos pasa de 27 clics y 5,7 s a hacerlo con la rueda en
  3,8 s (o 2,2 s pulsando «Load earlier»).
- **Sin pantalla en blanco al abrir:** desde el primer instante se ve el esqueleto de la
  interfaz (barra lateral, panel y cuadro de texto) con tu tema claro u oscuro, en vez de
  la pantalla de carga sobre fondo blanco y el destello al pasar a oscuro.

## Otras mejoras pequeñas

- **Aviso si Ollama no responde:** encima del cuadro de texto, «Ollama isn't running, so
  the AI can't answer», con **Open Ollama** (abre su aplicación) y **Check again**. Se
  quita solo cuando Ollama vuelve.
- **«Show N more sessions» despliega todos los chats** del proyecto de una vez (antes, de
  5 en 5); **Show less** los vuelve a recoger.
- **El cuadro de texto no se come la pantalla:** con un texto largo crece como mucho hasta
  un tercio de la ventana (antes, 14 líneas aunque la ventana fuera baja) y luego hace scroll.
- **Corrector en español:** el corrector ortográfico usa el idioma de Windows además del
  inglés (antes subrayaba en rojo todo lo escrito en español), con los diccionarios del
  propio Windows: nunca descarga nada.

## Qué cambia respecto a la versión oficial

Todo lo hace [`sistema/aplicar-cambios.mjs`](sistema/aplicar-cambios.mjs) sobre el
código oficial, buscando cada pieza por su nombre para sobrevivir a los cambios de
versión (ver *Si DeepSeek cambia algo que tocamos*).

| Cambio | Dónde |
|---|---|
| Ollama como proveedor y modelo por defecto | `packages/bundle/base/cordis.patch.yml` |
| Contexto por variantes, recomendado y capas en la gráfica medidos, modelo listo y limpieza de variantes | `packages/bundle/base/cordis.patch.yml`; código en [`sistema/contexto/`](sistema/contexto) (`arranque.cjs`, `calibrar.cjs`, `precarga.cjs`) |
| Barra de contexto en el selector (opcional) | `packages/client/ui-model-selection` (`ContextSlider.tsx`) |
| Botón «Optimize» junto a cada modelo y lista de Ollama al día al abrir el selector (opcional) | `packages/api/session-controller` (`local-optimize.ts`, `local-ollama-live.ts`) + `packages/llm/llm-pi-ai` + `packages/client/ui-model-selection` (`LocalOptimizeButton.tsx`) |
| Chats antiguos al contexto recomendado (opcional) | `packages/api/session-controller` y `packages/core/agent-default-model` (`local-ollama.ts`) |
| Sin ventana de bienvenida ni inicio de sesión | `apps/desktop/src/welcome-api.ts` |
| Sin menú ni ajustes de la cuenta de DeepSeek | `packages/bundle/web-app/cordis.patch.yml` |
| Sin modelos online de DeepSeek (cuenta y API) | `packages/bundle/base/cordis.patch.yml` |
| Sin telemetría ni analítica | `cordis.patch.yml` |
| Sin búsqueda web (usa la API de DeepSeek); la lectura de páginas se mantiene | bundles y presets |
| «Delete session» en el menú de cada chat (opcional) | `packages/api/session-controller` (método `session.deletePermanently`) + `packages/client/ui-workspace`; código en [`sistema/borrar-chats/`](sistema/borrar-chats) |
| Seleccionar chats como en el Explorador, menú contextual y mover a un proyecto (opcional) | `packages/client/ui-workspace` (`LocalSelection.tsx`) + `packages/api/workspace-controller` (`localAttachSession`) |
| Al pasar por un chat, solo el menú `⋯` (opcional) | `packages/client/ui-workspace` |
| Editar mensajes y regenerar respuestas, con versiones (opcional) | `packages/client/ui-chat`; código en [`sistema/regenerar/`](sistema/regenerar) |
| Aviso de Windows al terminar una respuesta (opcional) | `packages/client/ui-workspace`; código en [`sistema/avisos/`](sistema/avisos) |
| No volver a ofrecer una versión retirada (opcional) | `apps/desktop/src/update-coordinator.ts` (`local-skip-version.ts`) |
| Código de cada turno a la derecha («View code») y deshacer por fichero (opcional) | `packages/client/ui-chat`, `ui-deliverables` y `packages/api/session-controller` (`localUndoTurnFile`); código en [`sistema/codigo-vivo/`](sistema/codigo-vivo) |
| Subchats: «Open in subchat», anidados en la barra lateral y sugerencia junto al medidor de contexto (opcional) | `packages/client/ui-chat`, `ui-workspace`, `ui-conversation` y `packages/api/session-controller` (`localStartSubchat`); código en [`sistema/subchats/`](sistema/subchats) |
| Actualizar Ollama desde la app, en el aviso de actualizaciones de abajo a la izquierda (opcional) | `packages/client/ui-settings-general` (`LocalUpdatesIndicator.tsx`) + `packages/client/ui-model-selection` (`local-ollama-bridge.ts`) + `packages/api/session-controller` (`local-ollama-update.ts`) |
| Cursor normal (flecha) en toda la interfaz; la mano solo en los enlaces (opcional) | estilos `.css` de `packages/client`, `packages/extensions` y `apps/desktop/renderer` |
| El subchat se abre al 40 % de la zona de chat (opcional) | `packages/client/ui-layout` (`localSetRightbarShare`) |
| Mejorar un mensaje antes de enviarlo: botón ✨ «Improve message» junto al «+», también desde un PDF, DOCX o texto (opcional) | `packages/client/ui-conversation` (`LocalImprove.tsx`) + `packages/client/ui-chat` (`local-improve-bridge.ts`) + `packages/api/session-controller` (`local-improve.ts`); código en [`sistema/mejorar/`](sistema/mejorar) |
| Aviso antes de instalar: semáforo, detalles y «Skip this version» (opcional) | `apps/desktop/src/main.ts` y `update-coordinator.ts` (`local-update-notice.ts`); el informe, [`sistema/informe-actualizacion.mjs`](sistema/informe-actualizacion.mjs) en el workflow |
| Instalador sin firma, sin la «actualización obligatoria» de DeepSeek | `apps/desktop/scripts` |
| Actualizaciones desde los Releases de este repositorio | `apps/desktop/scripts/electron-builder-config.mjs` |
| Arranque: la lista de modelos de Ollama, una vez por proceso | `packages/bundle/base/cordis.patch.yml` |
| Chat más ligero: `content-visibility`, «Load earlier» que carga solo y páginas más grandes (opcional) | `packages/client/ui-chat` (`ChatView.module.css`, `LocalOlderButton.tsx`) + `packages/api/session-controller` (`session.ts`) |
| Esqueleto de la interfaz al arrancar, con el tema de la última vez (opcional) | `apps/web/index.html`; código en [`sistema/esqueleto/`](sistema/esqueleto) |
| Aviso si Ollama no responde, con «Open Ollama» (opcional) | `packages/client/ui-conversation` (`LocalOllamaBanner.tsx`) + `packages/api/session-controller` (`localOllamaStatus`) |
| «Show N more sessions» despliega todos los chats (opcional) | `packages/client/ui-workspace` (`WorkspaceBrowser.tsx`) |
| Corrector ortográfico también en el idioma del sistema, sin descargar diccionarios (opcional) | `apps/desktop` (`main.ts`) |
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
