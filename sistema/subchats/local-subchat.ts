/**
 * Subchats, lado del Host (añadido por dpseek-local-updater).
 *
 * Un subchat es un subagente «fork» oficial lanzado desde la app: empieza con los
 * turnos terminados del chat (su memoria), trabaja con esfuerzo alto en el mismo
 * modelo y contexto (así Ollama no recarga el modelo y reutiliza lo procesado) y su
 * respuesta final vuelve al chat principal una sola vez.
 *
 * Se lanza con entrega «caller»: el servicio oficial no añade sus instrucciones de
 * send_message (que podían duplicar el resultado) ni avisa él al chat; lo hace esta
 * función, con el mismo tipo de aviso oficial (subagent-settled) marcado como
 * subchat para que la app lo pinte como su tarjeta. Con «revisar antes de devolver»
 * no se entrega solo: lo manda el usuario desde el subchat.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Lo que hace falta del servicio de subagentes. */
export interface LocalSubagents {
  startActivation(spec: unknown): Promise<{
    readonly childId: string
    readonly result: Promise<{ readonly stopReason: string; readonly output: readonly { readonly type: string; readonly text?: string }[] }>
  }>
  interrupt(childId: string, authority: { readonly kind: 'user'; readonly parentSessionId: string }): void
}

/** Lo que hace falta de un agente para recibir el resultado. */
export interface LocalParentAgent {
  readonly status: string
  followup(message: never): void
  steer(message: never): void
}

/**
 * Marca del bloque de instrucciones del subchat. La app no pinta el bloque que
 * empieza así (sigue llegando al modelo, al final del mensaje, para no tocar lo que
 * Ollama ya tiene procesado de la conversación).
 */
export const LOCAL_SUBCHAT_MARKER = '[[dsh-local:subchat]]'

const FORK_PROVIDER = 'fork'

/**
 * El mensaje inicial del subchat: la tarea tal cual y, aparte, cómo devolver el resultado.
 * @param task - lo que escribió el usuario.
 * @returns los bloques que recibe el subchat.
 */
export function localSubchatPrompt(task: string): { type: 'text'; text: string }[] {
  return [
    { type: 'text', text: task.trim() },
    {
      type: 'text',
      text: `${LOCAL_SUBCHAT_MARKER} You are a subchat opened from the conversation above. Do this task on your own; `
        + 'use subagents if they help. Your final reply goes back to the main conversation automatically, so end with '
        + 'only the final result, complete and ready to use, without your reasoning or intermediate steps.',
    },
  ]
}

/** Texto de una salida (sin razonamiento ni llamadas a herramientas). */
export function localClosingText(blocks: readonly { readonly type: string; readonly text?: string }[]): string {
  return blocks.flatMap(block => block.type === 'text' && typeof block.text === 'string' && block.text !== '' ? [block.text] : [])
    .join('\n\n')
}

/**
 * Aviso para el chat principal con la respuesta de un subchat, del mismo tipo que el
 * oficial y marcado como subchat (nombre y duración) para su tarjeta.
 */
export function localSubchatNotice(childId: string, label: string, text: string, durationMs?: number): unknown {
  const summary = `Subchat "${label}" finished.`
  const source = {
    kind: 'subagent-settled',
    form: 'notice',
    summary,
    senderSessionId: childId,
    localSubchat: { label, ...durationMs === undefined ? {} : { durationMs } },
  }
  return createUserMessage({
    content: [
      { type: 'text', text: `${summary} (subchat session ${childId})` },
      ...text === ''
        ? [{ type: 'text' as const, text: 'It left no closing message.' }]
        : [{ type: 'text' as const, text: 'Its closing message:' }, { type: 'text' as const, text }],
    ],
    source: source as never,
  })
}

/**
 * Entrega el aviso al chat principal: abre un turno si está quieto; si está
 * trabajando, entra en el turno en marcha.
 */
export function localDeliverNotice(parent: LocalParentAgent, notice: unknown): void {
  if (parent.status === 'idle') parent.followup(notice as never)
  else parent.steer(notice as never)
}

/**
 * Lanza un subchat.
 * @param subagents - servicio de subagentes del Host.
 * @param parent - agente del chat principal.
 * @param task - tarea del subchat.
 * @param label - nombre corto del subchat.
 * @param signal - cancela solo el arranque.
 * @returns la sesión del subchat y su resultado (la primera respuesta final y si terminó bien).
 */
export async function localStartSubchat(subagents: LocalSubagents, parent: unknown, task: string, label: string,
  signal: AbortSignal,
): Promise<{ readonly childId: string; readonly result: Promise<{ readonly text: string; readonly completed: boolean }> }> {
  const started = await subagents.startActivation({
    provider: FORK_PROVIDER,
    label,
    // El resultado lo entrega localStartSubchat (una vez, con su tarjeta), no el servicio.
    delivery: 'caller',
    signal,
    request: {
      parent,
      prompt: localSubchatPrompt(task),
      agentOptions: { reasoningEffort: 'high' },
    },
  })
  return {
    childId: started.childId,
    // Parado por el usuario o con error, no se manda nada solo (se puede mandar a mano).
    result: started.result.then(result => ({ text: localClosingText(result.output), completed: result.stopReason === 'completed' })),
  }
}
