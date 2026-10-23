import { z } from 'zod'

/** Deliberately small subset of codex-cli 0.154.0-alpha.6.2's generated protocol. */
export const RpcEnvelope = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).passthrough().optional() })
export const ThreadItem = z.object({ type: z.string(), id: z.string(), text: z.string().optional(), phase: z.string().nullable().optional(), clientId: z.string().nullable().optional() }).passthrough()
export const Turn = z.object({ id: z.string(), status: z.enum(['inProgress', 'completed', 'interrupted', 'failed']), items: z.array(ThreadItem).default([]) }).passthrough()
export const ThreadResponse = z.object({ thread: z.object({ id: z.string() }).passthrough() })
export const TurnsPage = z.object({ data: z.array(Turn), nextCursor: z.string().nullable() })
export const ItemsPage = z.object({ data: z.array(z.object({ turnId: z.string(), item: ThreadItem })), nextCursor: z.string().nullable() })
export const ModelsPage = z.object({ data: z.array(z.object({ id: z.string(), model: z.string(), displayName: z.string(), hidden: z.boolean(), supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })) })), nextCursor: z.string().nullable() })
export const AccountResponse = z.object({ account: z.object({ type: z.string() }).passthrough().nullable() })
export const LocalStart = z.object({ type: z.literal('turn.start'), method: z.literal('turn/start'), params: z.object({ threadId: z.string(), clientUserMessageId: z.string(), input: z.array(z.object({ type: z.literal('text'), text: z.string(), text_elements: z.array(z.unknown()) })), effort: z.literal('low'), model: z.string(), serviceTierForTurn: z.literal('default'), summary: z.literal('none') }) })
export type NativeTurn = z.infer<typeof Turn>
export type NativeItem = z.infer<typeof ThreadItem>
export class CodexRpcError extends Error {
  constructor(readonly code: number, readonly detail: string) { super(code === -32601 || code === -32602 ? 'Установленный Codex несовместим с протоколом приложения. Обновите CLI или выберите другой codex.exe.' : `Codex отклонил команду (${code}). Проверьте авторизацию и доступность модели.`) }
}
export function parseProtocol<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error('Установленный Codex вернул несовместимый формат протокола. Обновите CLI или выберите другой codex.exe.')
  return result.data
}
