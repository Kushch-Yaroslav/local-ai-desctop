export type OllamaFailureKind =
  | 'cancelled'
  | 'context_exhausted'
  | 'connection_failure'
  | 'connection_reset'
  | 'stream_interrupted'
  | 'timeout'
  | 'process_failure'
  | 'malformed_response'
  | 'empty_response'
  | 'output_limit'
  | 'malformed_tool_arguments'
  | 'http_error'
  | 'internal';

export class OllamaRequestError extends Error {
  constructor(
    readonly kind: OllamaFailureKind,
    message: string,
    readonly options: { retryable?: boolean; status?: number; causeDetail?: string } = {},
  ) {
    super(message);
    this.name = 'OllamaRequestError';
  }

  get retryable(): boolean { return this.options.retryable === true; }
  get status(): number | undefined { return this.options.status; }
  get causeDetail(): string | undefined { return this.options.causeDetail; }
}

function details(error: unknown): string {
  const values: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      values.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else if (typeof current === 'object') {
      const candidate = current as { message?: unknown; code?: unknown; cause?: unknown };
      if (typeof candidate.message === 'string') values.push(candidate.message);
      if (typeof candidate.code === 'string') values.push(candidate.code);
      current = candidate.cause;
    } else {
      values.push(String(current));
      break;
    }
  }
  return values.filter(Boolean).join(' <- ') || String(error);
}

/**
 * Both local runtimes can reject a model-generated tool argument before they
 * return an assistant message. These are deliberately narrow server-parser
 * signatures, not broad status-code handling.
 */
function malformedToolArguments(status: number | undefined, detail: string): OllamaRequestError | undefined {
  if (status === 500 && /failed to parse tool call arguments as json/i.test(detail)) {
    return new OllamaRequestError('malformed_tool_arguments', 'Локальный inference runtime отклонил некорректные JSON-аргументы вызова инструмента', { status, causeDetail: detail.slice(0, 500) });
  }
  if (status === 400 && /value looks like object, but can(?:no|'t|not) find closing ['"]?\}/i.test(detail)) {
    return new OllamaRequestError('malformed_tool_arguments', 'Локальный inference runtime отклонил некорректные JSON-аргументы вызова инструмента', { status, causeDetail: detail.slice(0, 500) });
  }
  return undefined;
}

/** Preserve the transport cause so callers can distinguish runtime transport from a model answer. */
export function classifyOllamaError(error: unknown, signal?: AbortSignal): OllamaRequestError {
  if (error instanceof OllamaRequestError) {
    return malformedToolArguments(error.status, error.causeDetail ?? error.message) ?? error;
  }
  const detail = details(error);
  const lower = detail.toLowerCase();
  if (signal?.aborted || error instanceof DOMException && error.name === 'AbortError' || lower.includes('aborterror')) {
    return new OllamaRequestError('cancelled', 'Запрос к Ollama отменён', { causeDetail: detail });
  }
  // A backend can reject generated tool-call JSON before it returns a
  // ChatCompletion. Only explicit parser rejections are safe to hand back to
  // the model for a corrected decision; unrelated 4xx/5xx responses are not.
  const request = error && typeof error === 'object' ? (error as { request?: { status?: unknown; serverError?: unknown } }).request : undefined;
  const serverError = typeof request?.serverError === 'string' ? request.serverError : '';
  const malformed = malformedToolArguments(typeof request?.status === 'number' ? request.status : undefined, serverError);
  if (malformed) return malformed;
  if (lower.includes('контекстное окно заполнено') || lower.includes('context window') || lower.includes('num_ctx')) {
    return new OllamaRequestError('context_exhausted', 'Контекстное окно заполнено. Уменьшите историю или выберите больший контекст, затем продолжите ответ.', { causeDetail: detail });
  }
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('etimedout')) {
    return new OllamaRequestError('timeout', 'Ollama не ответил вовремя', { retryable: true, causeDetail: detail });
  }
  if (lower.includes('econnreset') || lower.includes('socket hang up') || lower.includes('connection reset')) {
    return new OllamaRequestError('connection_reset', 'Соединение с Ollama было сброшено', { retryable: true, causeDetail: detail });
  }
  if (lower.includes('terminated') || lower.includes('premature close') || lower.includes('stream')) {
    return new OllamaRequestError('stream_interrupted', 'Поток ответа Ollama был прерван', { retryable: true, causeDetail: detail });
  }
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('ehostunreach') || lower.includes('fetch failed') || lower.includes('network')) {
    return new OllamaRequestError('connection_failure', 'Не удалось подключиться к локальному inference runtime.', { retryable: true, causeDetail: detail });
  }
  return new OllamaRequestError('internal', detail, { causeDetail: detail });
}

export function ollamaErrorDiagnostics(error: unknown): Record<string, unknown> {
  const classified = classifyOllamaError(error);
  return { kind: classified.kind, retryable: classified.retryable, status: classified.status, message: classified.message, cause: classified.causeDetail };
}
