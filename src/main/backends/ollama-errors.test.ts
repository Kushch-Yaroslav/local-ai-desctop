import assert from 'node:assert/strict';
import { OllamaRequestError, classifyOllamaError } from './ollama-errors';

const observedOllamaParserFailure = "Value looks like object, but can't find closing '}' symbol";

export function runOllamaErrorRegression(): void {
  const malformed = classifyOllamaError(new OllamaRequestError(
    'http_error',
    `Ollama вернул HTTP 400: ${observedOllamaParserFailure}`,
    { status: 400, causeDetail: observedOllamaParserFailure },
  ));
  assert.equal(malformed.kind, 'malformed_tool_arguments', 'Ollama generated-tool parser failure was not normalized');
  assert.equal(malformed.status, 400);

  const unrelated = classifyOllamaError(new OllamaRequestError(
    'http_error',
    'Ollama вернул HTTP 400: invalid request option',
    { status: 400, causeDetail: 'invalid request option: num_ctx' },
  ));
  assert.equal(unrelated.kind, 'http_error', 'unrelated Ollama HTTP 400 became a malformed tool recovery');

  const llama = classifyOllamaError(Object.assign(new Error('llama.cpp rejected tool arguments'), {
    request: { status: 500, serverError: 'Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] invalid string: missing closing quote' },
  }));
  assert.equal(llama.kind, 'malformed_tool_arguments', 'existing llama.cpp malformed-tool classification regressed');
}

if (require.main === module) runOllamaErrorRegression();
