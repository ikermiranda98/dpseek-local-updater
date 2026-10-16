/**
 * Subchats, lado del Host (añadido por dpseek-local-updater).
 *
 * Un subchat es un subagente «fork» oficial lanzado desde la app en vez de por el
 * modelo: empieza con los turnos terminados del chat, trabaja con esfuerzo alto
 * en el mismo modelo y contexto que el chat (así no hay que recargar el modelo) y,
 * al acabar, el servicio de subagentes entrega su respuesta final al chat
 * principal, que sigue con ella.
 */

/** Lo que hace falta del servicio de subagentes. */
export interface LocalSubagents {
  startActivation(spec: unknown): Promise<{ readonly childId: string }>
}

/** Proveedor de subagentes que empieza con la conversación del chat. */
const FORK_PROVIDER = 'fork'

/**
 * El mensaje inicial del subchat: la tarea y cómo debe devolver el resultado.
 * @param task - lo que escribió el usuario.
 * @returns el texto que recibe el subchat.
 */
export function localSubchatPrompt(task: string): string {
  return [
    task.trim(),
    '',
    '---',
    'You are a subchat opened from the conversation above. Do this task on your own; use subagents when it helps.',
    'When you finish, reply with only the final solution or result, complete and ready to use, without your reasoning',
    'or intermediate steps: that reply is what goes back to the main conversation.',
  ].join('\n')
}

/**
 * Lanza un subchat.
 * @param subagents - servicio de subagentes del Host.
 * @param parent - agente del chat principal.
 * @param task - tarea del subchat.
 * @param label - nombre corto del subchat.
 * @param signal - cancela solo el arranque; después el subchat sigue aunque la app se desconecte.
 * @returns la sesión del subchat.
 */
export async function localStartSubchat(subagents: LocalSubagents, parent: unknown, task: string, label: string,
  signal: AbortSignal): Promise<string> {
  const started = await subagents.startActivation({
    provider: FORK_PROVIDER,
    label,
    delivery: 'parent',
    signal,
    request: {
      parent,
      prompt: [{ type: 'text', text: localSubchatPrompt(task) }],
      agentOptions: { reasoningEffort: 'high' },
    },
  })
  return started.childId
}
