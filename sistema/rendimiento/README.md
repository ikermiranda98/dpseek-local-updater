# Rendimiento: mediciones y mejoras

Banco de pruebas en [`banco/`](banco). Cada medida arranca la app empaquetada (win-unpacked)
con una copia de un `DSH_HOME` de prueba y la controla por CDP; se repite 5 veces y se da la
mediana. Las mediciones de abajo son de un Windows 11 con 32 hilos, con la app en caliente
(segundo arranque en adelante).

## Datos de prueba

`banco/generar-home.cjs` construye el home a partir de los turnos de un chat real (mensajes,
llamadas a herramientas, resultados): 150 chats cortos, 3 de 48 turnos y uno de **400
turnos**. `banco/calentar.mjs` abre cada chat una vez para que la app calcule sus títulos y
cachés, como en un uso normal; ese estado («base caliente») es el punto de partida de cada
repetición.

## Qué se mide (`banco/bench.mjs`)

| Medida | Qué es |
|---|---|
| arranque | desde lanzar el ejecutable hasta ver la lista de chats y el cuadro de texto |
| abrir chat | clic en la barra lateral hasta ver el último mensaje (largo, mediano, corto, volver) |
| antiguos | desde el final del chat largo hasta tener cargado su primer mensaje |
| scroll | rueda arriba y abajo por el chat largo entero: frame p99, frames >34 ms y tareas largas (>50 ms) |
| pantallas | Ajustes y Plugins |

## Dónde estaba el tiempo

- **Arranque.** La ventana sale a los 0,2 s, pero el Host bloqueaba el arranque: evalúa la
  configuración 9 veces y cada vez lanzaba, de forma síncrona, el proceso que lista los modelos
  de Ollama (`contexto/arranque.cjs`, ~150–200 ms cada uno). Visto con `banco/procesos.ps1`.
  El resto del arranque del Host (~2 s) es carga de módulos del núcleo oficial.
- **Scroll.** Con el historial cargado, cada frame volvía a maquetar ~37 000 elementos (hasta
  110 ms por frame; traza con `banco/traza-scroll.mjs`).
- **Mensajes antiguos.** «Load earlier» trae 2 turnos por clic: 27 clics para llegar al principio
  del chat de 400 turnos, cada uno con su viaje al Host y una medición del chat entero.
- Abrir chats (55–160 ms) y las pantallas (25–60 ms) ya iban rápido: no se han tocado.

## Mejoras y resultado de cada una

**1. La lista de modelos, una vez por proceso** (`aplicar-cambios.mjs`, `runtimeModelsExpression`).

| | antes | después |
|---|---|---|
| arranque hasta poder usar la app | 4,09 s | **3,04 s** (−26 %) |
| procesos lanzados al arrancar | 9 | 1 |

Con Ollama lento al responder, la diferencia es mayor: cada evaluación esperaba por su cuenta.

**2. Chat más ligero** (sección 25: `content-visibility` en cada bloque del chat, «Load earlier»
que carga solo al subir y páginas de al menos 6 turnos).

| | antes | después |
|---|---|---|
| llegar al principio del chat largo (pulsando) | 5,71 s, 27 clics | **2,19 s, 9 clics** (−62 %) |
| tiempo bloqueado mientras carga | 3,84 s | **0,80 s** (−79 %) |
| llegar al principio solo con la rueda | no carga | **3,76 s, sin clics** |
| scroll, primera pasada: frame p99 | 103 ms | **42 ms** (18 ms subiendo con la rueda) |
| scroll, tareas largas | 2,8 s | **0** |
| scroll, segunda pasada: tareas largas | 0,39 s | **0** |
| memoria (heap) con el chat entero | 165 MB | **130 MB** |
| abrir el chat largo / volver a él | 162 / 63 ms | 149 / 54 ms |

`content-visibility: auto` recorta lo que sobresale de cada bloque; para no cortar las tablas
anchas (que ocupan el ancho del contenedor del chat, `100cqw`), el bloque se ensancha hasta ese
ancho con margen negativo y el mismo relleno, así el contenido queda donde estaba.

**Probado y descartado:** `NODE_COMPILE_CACHE` para el Host (casi no lo usa y no mejora).

## Repetir las mediciones

```
node banco/generar-home.cjs <session.v4.jsonl.zstd de un chat real> banco/base
# abrir la app con banco/base/home (explorar.mjs) y ejecutar calentar.mjs; copiar el resultado a banco/base-caliente
node banco/bench.mjs "<win-unpacked>/DeepSeek Harness.exe" <etiqueta> 5
```

`BENCH_CSS='…'` prueba una regla CSS sin recompilar; `BENCH_SOLO_RUEDA=1` sube por el chat solo
con la rueda. La app se arranca con `DSH_LOCAL_SIN_AYUDANTES=1` para no tocar las variantes de
modelo de Ollama del equipo.
