import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { buildSystemPrompt } from './system-prompt.js'
import { buildToolSchemas, createToolDispatcher, type ChatToolDeps } from './tools.js'

export interface ChatRouteDeps extends ChatToolDeps {
  subreddit?: string
  communityContext?: string
}

export interface ChatRequestMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatRequestContext {
  view?: 'alerts' | 'items' | 'clusters'
  detailTab?: 'overview' | 'explore' | 'chat'
  focus?: { kind: 'alert' | 'item' | 'topic'; id: string; label: string }
}

const ALLOWED_MODELS = new Set(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano'])

function buildContextMessage(ctx?: ChatRequestContext): string | null {
  if (!ctx) return null
  const lines: string[] = ['# Current view']
  if (ctx.view) {
    const viewName = ctx.view === 'clusters' ? 'topics' : ctx.view
    lines.push(`The moderator is on the ${viewName} tab.`)
  }
  if (ctx.focus) {
    lines.push(`Selected ${ctx.focus.kind}: "${ctx.focus.label}" (id: ${ctx.focus.id}).`)
    lines.push(`When the moderator says "this ${ctx.focus.kind}" or "this one", they mean the selected ${ctx.focus.kind}.`)
  }
  return lines.length > 1 ? lines.join('\n') : null
}

export function createChatHandler(deps: ChatRouteDeps) {
  const tools = buildToolSchemas()
  const { dispatch } = createToolDispatcher(deps)
  const systemPrompt = buildSystemPrompt(deps.subreddit)

  return async function handler(c: Context) {
    const body = await c.req.json<{ messages: ChatRequestMessage[]; model?: string; context?: ChatRequestContext }>()
    const model = body.model && ALLOWED_MODELS.has(body.model) ? body.model : 'gpt-5.5'
    const userMessages = (body.messages ?? []).map(m => ({ role: m.role, content: m.content }))
    const contextMessage = buildContextMessage(body.context)

    const communityBlock = deps.communityContext
      ? `# Community context\n${deps.communityContext}`
      : null

    const input: any[] = [
      { role: 'developer', content: systemPrompt },
      ...(communityBlock ? [{ role: 'developer', content: communityBlock }] : []),
      ...(contextMessage ? [{ role: 'developer', content: contextMessage }] : []),
      ...userMessages,
    ]

    // Hint proxies/gateways not to buffer or transform the SSE stream.
    c.header('X-Accel-Buffering', 'no')

    return streamSSE(c, async (stream) => {
      const send = async (event: string, data: unknown) => {
        await stream.writeSSE({ event, data: JSON.stringify(data) })
      }

      try {
        let safety = 0
        while (safety++ < 6) {
          const response = await deps.openai.responses.create({
            model,
            input,
            tools: tools as any,
            reasoning: { effort: 'low' },
            text: { verbosity: 'low' } as any,
            stream: true,
          })

          const pendingArgs = new Map<string, string>()
          const pendingNames = new Map<string, string>()
          const functionCalls: Array<{ id: string; call_id: string; name: string; args: string }> = []
          const responseOutput: any[] = []

          for await (const event of response as any) {
            const t = event.type
            if (t === 'response.output_item.added' && event.item?.type === 'function_call') {
              const item = event.item
              pendingArgs.set(item.id, '')
              pendingNames.set(item.id, item.name)
              await send('tool_start', { tool_call_id: item.id, name: item.name })
            } else if (t === 'response.function_call_arguments.delta') {
              const cur = pendingArgs.get(event.item_id) ?? ''
              pendingArgs.set(event.item_id, cur + (event.delta ?? ''))
            } else if (t === 'response.function_call_arguments.done') {
              pendingArgs.set(event.item_id, event.arguments ?? pendingArgs.get(event.item_id) ?? '')
            } else if (t === 'response.output_item.done' && event.item?.type === 'function_call') {
              const item = event.item
              const name = item.name ?? pendingNames.get(item.id) ?? ''
              const args = item.arguments ?? pendingArgs.get(item.id) ?? ''
              functionCalls.push({ id: item.id, call_id: item.call_id, name, args })
              responseOutput.push(item)
            } else if (t === 'response.output_item.done' && event.item) {
              responseOutput.push(event.item)
            } else if (t === 'response.output_text.delta') {
              await send('text_delta', { delta: event.delta ?? '' })
            } else if (t === 'response.error' || t === 'error') {
              await send('error', { message: event.error?.message ?? 'stream error' })
            }
          }

          if (functionCalls.length === 0) {
            await send('done', {})
            return
          }

          for (const item of responseOutput) input.push(item)

          for (const call of functionCalls) {
            let resultPayload: unknown
            let summary = ''
            let preview: string | undefined
            let sideEffect: unknown
            try {
              const out = await dispatch(call.name, call.args)
              resultPayload = out.result
              summary = out.summary
              preview = out.preview
              sideEffect = out.sideEffect
            } catch (err) {
              resultPayload = { error: String(err) }
              summary = 'error'
            }
            const parsedArgs = (() => { try { return JSON.parse(call.args) } catch { return {} } })()
            await send('tool_done', {
              tool_call_id: call.id,
              name: call.name,
              args: parsedArgs,
              summary,
              preview,
              side_effect: sideEffect,
            })
            input.push({
              type: 'function_call_output',
              call_id: call.call_id,
              output: JSON.stringify(resultPayload),
            })
          }
        }

        await send('done', {})
      } catch (err) {
        console.error('[chat] handler error:', err)
        await send('error', { message: String(err) })
        await send('done', {})
      }
    })
  }
}
