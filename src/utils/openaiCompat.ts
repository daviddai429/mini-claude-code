/**
 * OpenAI Chat Completions API compatibility adapter.
 *
 * Intercepts Anthropic SDK fetch calls targeting `/v1/messages` and translates
 * them to OpenAI `/v1/chat/completions` format on the wire. Streaming SSE
 * events are translated back to Anthropic format so the SDK and upper layers
 * are completely unaware of the translation.
 *
 * Enable via `OPENAI_COMPAT=1` environment variable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OpenAITool {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

interface OpenAIRequest {
  model: string
  messages: OpenAIMessage[]
  max_tokens?: number
  temperature?: number
  stream?: boolean
  tools?: OpenAITool[]
  tool_choice?: unknown
}

// Anthropic content‐block shapes (simplified for translation)
interface AnthropicTextBlock {
  type: 'text'
  text: string
  [k: string]: unknown
}
interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  [k: string]: unknown
}
interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: string | unknown[]
  is_error?: boolean
  [k: string]: unknown
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | { type: string; [k: string]: unknown }

// ---------------------------------------------------------------------------
// Request translation  (Anthropic → OpenAI)
// ---------------------------------------------------------------------------

function translateSystemPrompt(
  system: unknown,
): OpenAIMessage[] {
  if (!system) return []
  if (typeof system === 'string') {
    return [{ role: 'system', content: system }]
  }
  if (Array.isArray(system)) {
    // Anthropic system can be an array of {type:"text", text:"..."}
    const text = system
      .filter((b: { type?: string }) => b.type === 'text')
      .map((b: { text?: string }) => b.text ?? '')
      .join('\n')
    if (text) return [{ role: 'system', content: text }]
  }
  return []
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (b: { type?: string }) =>
          b.type === 'text' || b.type === 'tool_result',
      )
      .map((b: { type?: string; text?: string; content?: unknown }) => {
        if (b.type === 'text') return b.text ?? ''
        if (b.type === 'tool_result') return flattenContent(b.content)
        return ''
      })
      .join('')
  }
  return String(content ?? '')
}

function translateMessages(
  messages: unknown[],
): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  for (const msg of messages as Array<{
    role: string
    content: unknown
  }>) {
    const blocks = Array.isArray(msg.content)
      ? (msg.content as AnthropicContentBlock[])
      : null

    // --- tool_result blocks → separate "tool" messages ---
    if (blocks) {
      const toolResults = blocks.filter(
        (b): b is AnthropicToolResultBlock => b.type === 'tool_result',
      )
      const others = blocks.filter((b) => b.type !== 'tool_result')

      // Emit any non-tool-result content first
      if (others.length > 0) {
        const toolUses = others.filter(
          (b): b is AnthropicToolUseBlock => b.type === 'tool_use',
        )
        const textParts = others.filter(
          (b): b is AnthropicTextBlock => b.type === 'text',
        )

        if (msg.role === 'assistant' && toolUses.length > 0) {
          const textContent = textParts.map((b) => b.text).join('') || null
          out.push({
            role: 'assistant',
            content: textContent,
            tool_calls: toolUses.map((tu) => ({
              id: tu.id,
              type: 'function' as const,
              function: {
                name: tu.name,
                arguments:
                  typeof tu.input === 'string'
                    ? tu.input
                    : JSON.stringify(tu.input),
              },
            })),
          })
        } else {
          out.push({
            role: msg.role as 'user' | 'assistant',
            content: flattenContent(others),
          })
        }
      }

      // Emit tool results as role=tool
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: flattenContent(tr.content),
        })
      }
      continue
    }

    // --- assistant with tool_use blocks ---
    if (msg.role === 'assistant' && blocks === null) {
      out.push({
        role: 'assistant',
        content: flattenContent(msg.content),
      })
      continue
    }

    // --- simple text message ---
    out.push({
      role: msg.role as 'user' | 'assistant',
      content: flattenContent(msg.content),
    })
  }
  return out
}

function translateTools(tools: unknown[] | undefined): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools
    .filter((t: any) => {
      // Only translate client-side tools (skip server tools, etc.)
      const type = t.type
      return !type || type === 'custom' || type === 'function'
    })
    .map((t: any) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }))
}

function translateToolChoice(
  toolChoice: unknown,
): unknown {
  if (!toolChoice) return undefined
  const tc = toolChoice as { type?: string; name?: string }
  if (tc.type === 'auto') return 'auto'
  if (tc.type === 'any') return 'required'
  if (tc.type === 'tool' && tc.name) {
    return { type: 'function', function: { name: tc.name } }
  }
  return undefined
}

export function translateRequest(body: Record<string, unknown>): OpenAIRequest {
  const systemMsgs = translateSystemPrompt(body.system)
  const userMsgs = translateMessages(body.messages as unknown[])
  const tools = translateTools(body.tools as unknown[] | undefined)
  const toolChoice = translateToolChoice(body.tool_choice)

  const req: OpenAIRequest = {
    model: body.model as string,
    messages: [...systemMsgs, ...userMsgs],
    stream: body.stream as boolean | undefined,
  }

  if (body.max_tokens != null) req.max_tokens = body.max_tokens as number
  if (body.temperature != null) req.temperature = body.temperature as number
  if (tools && tools.length > 0) req.tools = tools
  if (toolChoice !== undefined) req.tool_choice = toolChoice

  // Add stream_options for usage in streaming mode
  if (req.stream) {
    ;(req as any).stream_options = { include_usage: true }
  }

  return req
}

// ---------------------------------------------------------------------------
// Response translation  (OpenAI → Anthropic)  — non‐streaming
// ---------------------------------------------------------------------------

function mapFinishReason(reason: string | null): string {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    default:
      return 'end_turn'
  }
}

export function translateNonStreamingResponse(openai: any): unknown {
  const choice = openai.choices?.[0]
  if (!choice) {
    return {
      id: openai.id ?? `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      model: openai.model ?? 'unknown',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    }
  }

  const content: unknown[] = []
  const msg = choice.message

  if (msg?.content) {
    content.push({ type: 'text', text: msg.content })
  }

  if (msg?.tool_calls) {
    for (const tc of msg.tool_calls) {
      let parsedInput: unknown = {}
      try {
        parsedInput = JSON.parse(tc.function.arguments)
      } catch {
        parsedInput = {}
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: parsedInput,
      })
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }

  return {
    id: openai.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: openai.model ?? 'unknown',
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openai.usage?.prompt_tokens ?? 0,
      output_tokens: openai.usage?.completion_tokens ?? 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Response translation  (OpenAI → Anthropic)  — streaming
// ---------------------------------------------------------------------------

/**
 * Build a ReadableStream that reads OpenAI SSE chunks from the upstream
 * response body, translates each chunk to one or more Anthropic SSE events,
 * and enqueues them. The resulting stream can be wrapped in a new Response
 * that the Anthropic SDK consumes transparently.
 */
export function buildAnthropicSSEStream(
  upstreamBody: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  // Mutable state across chunks
  let sentMessageStart = false
  let textBlockStarted = false
  let textBlockIndex = 0
  // Track tool call blocks: openai index -> { anthropicIndex, started }
  const toolCallState = new Map<
    number,
    { anthropicIndex: number; id: string; name: string; started: boolean }
  >()
  let nextBlockIndex = 0
  let buffer = '' // for partial SSE lines

  function sse(event: string, data: unknown): Uint8Array {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  function emitMessageStart(): Uint8Array[] {
    if (sentMessageStart) return []
    sentMessageStart = true
    return [
      sse('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ]
  }

  function emitTextBlockStart(): Uint8Array[] {
    if (textBlockStarted) return []
    textBlockStarted = true
    textBlockIndex = nextBlockIndex++
    return [
      sse('content_block_start', {
        type: 'content_block_start',
        index: textBlockIndex,
        content_block: { type: 'text', text: '' },
      }),
    ]
  }

  function processChunk(chunk: any): Uint8Array[] {
    const parts: Uint8Array[] = []

    // Ensure message_start is sent
    parts.push(...emitMessageStart())

    const choice = chunk.choices?.[0]
    if (!choice) {
      // usage-only chunk (stream_options include_usage)
      if (chunk.usage) {
        // Close open text block first
        if (textBlockStarted) {
          parts.push(
            sse('content_block_stop', {
              type: 'content_block_stop',
              index: textBlockIndex,
            }),
          )
          textBlockStarted = false
        }
        parts.push(
          sse('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: {
              output_tokens: chunk.usage.completion_tokens ?? 0,
              input_tokens: chunk.usage.prompt_tokens ?? 0,
            },
          }),
        )
        parts.push(
          sse('message_stop', { type: 'message_stop' }),
        )
      }
      return parts
    }

    const delta = choice.delta
    if (!delta) return parts

    // --- text content ---
    if (delta.content != null && delta.content !== '') {
      parts.push(...emitTextBlockStart())
      parts.push(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: textBlockIndex,
          delta: { type: 'text_delta', text: delta.content },
        }),
      )
    }

    // --- tool calls ---
    if (delta.tool_calls) {
      // Close text block if open
      if (textBlockStarted) {
        parts.push(
          sse('content_block_stop', {
            type: 'content_block_stop',
            index: textBlockIndex,
          }),
        )
        textBlockStarted = false
      }

      for (const tc of delta.tool_calls) {
        const tcIndex: number = tc.index ?? 0
        let state = toolCallState.get(tcIndex)

        if (!state && tc.id) {
          // New tool call
          state = {
            anthropicIndex: nextBlockIndex++,
            id: tc.id,
            name: tc.function?.name ?? '',
            started: false,
          }
          toolCallState.set(tcIndex, state)
        }

        if (!state) continue

        // Update name if provided
        if (tc.function?.name) {
          state.name = tc.function.name
        }

        if (!state.started) {
          state.started = true
          parts.push(
            sse('content_block_start', {
              type: 'content_block_start',
              index: state.anthropicIndex,
              content_block: {
                type: 'tool_use',
                id: state.id,
                name: state.name,
                input: {},
              },
            }),
          )
        }

        // Stream arguments as input_json_delta
        if (tc.function?.arguments) {
          parts.push(
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: state.anthropicIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: tc.function.arguments,
              },
            }),
          )
        }
      }
    }

    // --- finish ---
    if (choice.finish_reason != null) {
      // Close text block
      if (textBlockStarted) {
        parts.push(
          sse('content_block_stop', {
            type: 'content_block_stop',
            index: textBlockIndex,
          }),
        )
        textBlockStarted = false
      }

      // Close all tool call blocks
      for (const [, state] of toolCallState) {
        if (state.started) {
          parts.push(
            sse('content_block_stop', {
              type: 'content_block_stop',
              index: state.anthropicIndex,
            }),
          )
        }
      }
      toolCallState.clear()

      // If no usage-only chunk will follow, emit delta+stop now
      parts.push(
        sse('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: mapFinishReason(choice.finish_reason),
            stop_sequence: null,
          },
          usage: { output_tokens: 0 },
        }),
      )
      parts.push(sse('message_stop', { type: 'message_stop' }))
    }

    return parts
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstreamBody.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            // If stream ends without finish_reason, close gracefully
            if (sentMessageStart) {
              if (textBlockStarted) {
                controller.enqueue(
                  sse('content_block_stop', {
                    type: 'content_block_stop',
                    index: textBlockIndex,
                  }),
                )
              }
              controller.enqueue(
                sse('message_delta', {
                  type: 'message_delta',
                  delta: { stop_reason: 'end_turn', stop_sequence: null },
                  usage: { output_tokens: 0 },
                }),
              )
              controller.enqueue(
                sse('message_stop', { type: 'message_stop' }),
              )
            }
            controller.close()
            return
          }

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          // Keep the last potentially incomplete line in the buffer
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith(':')) continue
            if (trimmed === 'data: [DONE]') continue
            if (!trimmed.startsWith('data: ')) continue

            const jsonStr = trimmed.slice(6)
            try {
              const chunk = JSON.parse(jsonStr)
              const parts = processChunk(chunk)
              for (const part of parts) {
                controller.enqueue(part)
              }
            } catch {
              // Skip unparseable chunks
            }
          }
        }
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Fetch wrapper — the main entry point
// ---------------------------------------------------------------------------

/**
 * Wraps a fetch function to translate Anthropic API calls to OpenAI format.
 * Only intercepts requests whose URL path contains `/v1/messages`.
 * All other requests are passed through unchanged.
 */
export function wrapFetchForOpenAICompat(
  innerFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    // Only intercept Anthropic messages endpoint
    if (!url.includes('/v1/messages')) {
      return innerFetch(input, init)
    }

    // Parse original request body
    let bodyStr = ''
    if (init?.body) {
      if (typeof init.body === 'string') {
        bodyStr = init.body
      } else if (init.body instanceof ArrayBuffer) {
        bodyStr = new TextDecoder().decode(init.body)
      } else if (init.body instanceof Uint8Array) {
        bodyStr = new TextDecoder().decode(init.body)
      } else {
        // ReadableStream or other — read it
        const resp = new Response(init.body)
        bodyStr = await resp.text()
      }
    }

    let anthropicBody: Record<string, unknown>
    try {
      anthropicBody = JSON.parse(bodyStr)
    } catch {
      // If we can't parse, pass through unchanged
      return innerFetch(input, init)
    }

    const isStreaming = anthropicBody.stream === true
    const model = anthropicBody.model as string

    // Translate request
    const openaiBody = translateRequest(anthropicBody)

    // Build new URL: replace /v1/messages with /v1/chat/completions
    const newUrl = url.replace(/\/v1\/messages(\?.*)?$/, '/v1/chat/completions')

    // Build new headers — keep auth, remove Anthropic-specific headers
    const headers = new Headers(init?.headers)
    // Remove Anthropic-specific headers that OpenAI endpoints don't understand
    headers.delete('anthropic-version')
    headers.delete('anthropic-beta')
    headers.delete('x-api-key')
    // Ensure content type
    headers.set('content-type', 'application/json')

    // If x-api-key was the auth method, convert to Bearer
    // (already handled if Authorization header exists)
    if (!headers.has('authorization')) {
      const apiKey =
        globalThis.process?.env?.ANTHROPIC_API_KEY ||
        globalThis.process?.env?.ANTHROPIC_AUTH_TOKEN
      if (apiKey) {
        headers.set('authorization', `Bearer ${apiKey}`)
      }
    }

    // Send to OpenAI endpoint
    const response = await innerFetch(newUrl, {
      ...init,
      method: 'POST',
      headers,
      body: JSON.stringify(openaiBody),
    })

    if (!response.ok) {
      // Pass error through — the SDK will handle it
      return response
    }

    // --- Non-streaming ---
    if (!isStreaming) {
      const openaiJson = await response.json()
      const anthropicJson = translateNonStreamingResponse(openaiJson)
      return new Response(JSON.stringify(anthropicJson), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'request-id': response.headers.get('x-request-id') ?? `req_${Date.now()}`,
        },
      })
    }

    // --- Streaming ---
    if (!response.body) {
      return new Response('No response body', { status: 502 })
    }

    const anthropicStream = buildAnthropicSSEStream(response.body, model)
    return new Response(anthropicStream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'request-id': response.headers.get('x-request-id') ?? `req_${Date.now()}`,
      },
    })
  }
}
