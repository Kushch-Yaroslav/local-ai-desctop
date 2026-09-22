import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { OllamaBackend } from '../backends/ollama-backend';
import { ProjectChatService } from './project-chat';
import { WebBrowserService } from '../web/web-tools';
import { Database } from './database';
import type { StreamEvent } from '../../shared/types';

const model = 'qwen3.8:27b-q4_K_M';
const contextWindow = 32_768;
const runTimeoutMs = 30 * 60_000;
// 72 required primary reads plus 20 deliberately narrow audit rereads leave
// Qwen enough room for its normal Plan/Notes/search/verification calls to
// cross the 100-action soft budget, without turning this regression into an
// hour-long 200+ action soak test.
const flowCount = 36;
const auditRereadCount = 10;

async function fixture(root: string, product: 'A' | 'B', auditNonce: string): Promise<string[]> {
  await mkdir(join(root, 'src'), { recursive: true }); await mkdir(join(root, 'docs'), { recursive: true });
  const auditCodes: string[] = [];
  const filler = (name: string, fact: string): string => `# ${name}\n\n${`${name} implementation detail and product flow evidence.\n`.repeat(260)}\nCritical business fact: ${fact}\n`;
  for (let index = 1; index <= flowCount; index += 1) {
    const code = `${product}-AUDIT-${index}-${auditNonce}`;
    auditCodes.push(code);
    await writeFile(join(root, 'docs', `flow-${index}.md`), filler(`${product} flow ${index}`, `${product}-FACT-${index}: audit_code=${code}; owner=${product === 'A' ? 'checkout' : 'fulfilment'}; state=${index % 2 ? 'review' : 'approved'}.`));
  }
  const source = (name: string, fact: string): string => `// ${name}\n${`// ${name} implementation detail and integration evidence.\n`.repeat(220)}\nexport const evidence = ${JSON.stringify(fact)};\n`;
  await writeFile(join(root, 'src', 'business.ts'), source(`${product} business implementation`, `${product}-BUSINESS: retry strategy is ${product === 'A' ? 'idempotent payment key' : 'inventory reservation token'}.`));
  await writeFile(join(root, 'src', 'integration.ts'), source(`${product} integration`, `${product}-INTEGRATION: event contract version v${product === 'A' ? '3' : '5'}.`));
  await writeFile(join(root, 'docs', 'failed-approach.log'), `${'ordinary diagnostic output\n'.repeat(600)}ERROR: FAILED APPROACH: querying the legacy endpoint returns stale data; do not use legacy endpoint.\n${'tail diagnostic output\n'.repeat(80)}`);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: `stress-${product.toLowerCase()}`, private: true, scripts: { test: 'node --check src/business.ts && node --check src/integration.ts' } }, null, 2));
  return auditCodes;
}

export async function runQwenStress(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'local-ai-qwen-context-stress-'));
  const projectA = join(base, 'project-a'); const projectB = join(base, 'project-b');
  const databasePath = join(base, 'agent-run.sqlite');
  const startedAt = Date.now();
  try {
    const auditNonce = randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
    const auditCodesA = await fixture(projectA, 'A', auditNonce); const auditCodesB = await fixture(projectB, 'B', auditNonce);
    const auditCodes = [...auditCodesA, ...auditCodesB];
    const backend = new OllamaBackend(); const service = new ProjectChatService(backend, new WebBrowserService());
    const database = new Database(databasePath); const chat = database.createConversation(model); const run = database.createAnalysisRun(chat.id, 'fast');
    const history = [{ id: 'stress-user', conversationId: chat.id, role: 'user' as const, createdAt: new Date().toISOString(), content: `Compare the two synthetic products in Project 1 and Project 2 and create report.md in Project 1. This is an investigation and implementation task: create and maintain a structured Plan and Task Notes. The harness checks the executed tool event log, not just report text. Strict order: create a concise report.md skeleton in Project 1 before reading any flow file, then use apply_patch after each block of at most 8 primary flow reads to add that block's audit rows. Do not postpone file changes until research is complete. The harness requires a separate read_file call at least once for every docs/flow-1.md through docs/flow-${flowCount}.md in EACH project (${flowCount * 2} primary reads). Each flow contains an opaque, per-run audit code; codes cannot be inferred from their paths. Then include every exact code in an audit matrix in the report. After the matrix, independently verify the tail fact by a separate narrow-range read_file reread of docs/flow-1.md through docs/flow-${auditRereadCount}.md in BOTH projects (${auditRereadCount * 2} additional reads); add those ${auditRereadCount * 2} codes to an Audit verification section. Terminal output, search results, globbing, and generated assumptions do not count as required reads. Do not use terminal to inspect, grep, concatenate, or generate flow data: use it only once for the package test after the report is written. Also inspect both business and integration implementations, search both projects, inspect the failed-approach log and remember why the legacy endpoint must not be used. The report must name the concrete business owners, retry strategies, event contract versions, opaque audit codes, the verification result, and the failed approach. Before finalizing, update every Plan step to completed, then finish with a concise user-facing summary.` }];
    const projects = [{ id: 'project-a', slot: 1 as const, root: projectA, label: 'Project 1' }, { id: 'project-b', slot: 2 as const, root: projectB, label: 'Project 2' }];
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, runTimeoutMs);
    try {
      for await (const event of service.stream(model, history, projects, controller.signal, contextWindow, 'fast', 'off', async () => ({ approved: true as const, reason: 'once' as const }))) {
        events.push(event);
        if (event.type === 'tool') database.addAnalysisAction(run.id, event.activity);
      }
    } finally {
      clearTimeout(timeout);
    }
    database.finishAnalysisRun(run.id, 'completed', null); database.close();
    const compactions = events.filter((event): event is Extract<StreamEvent, { type: 'tool' }> => event.type === 'tool' && event.activity.kind === 'context').map((event) => event.activity);
    // Every budgeted tool call first yields a `running` activity. Finished UI
    // events additionally include Plan/Notes/Context/Progress statuses, so
    // they are not evidence of the action-budget counter.
    const budgetedActions = events.filter((event): event is Extract<StreamEvent, { type: 'tool' }> => event.type === 'tool' && event.activity.state === 'running').length;
    const usages = events.filter((event): event is Extract<StreamEvent, { type: 'context-usage' }> => event.type === 'context-usage');
    const finalUsage = usages.at(-1);
    const diagnostics = events.filter((event): event is Extract<StreamEvent, { type: 'diagnostics' }> => event.type === 'diagnostics').at(-1)?.diagnostics;
    const finalText = events.filter((event): event is Extract<StreamEvent, { type: 'token' }> => event.type === 'token').map((event) => event.content).join('');
    const report = await readFile(join(projectA, 'report.md'), 'utf8').catch(() => '');
    const restoredDatabase = new Database(databasePath); const restored = restoredDatabase.listAnalysisRuns(chat.id)[0]; restoredDatabase.close();
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const rawToolOutputs = (inspection.prepare("SELECT count(*) AS count FROM analysis_actions WHERE data LIKE '%rawOutput%'").get() as { count: number }).count;
    inspection.close();
    const persistedPlan = restored.actions.find((action) => action.kind === 'planning' && action.plan)?.plan;
    const persistedNotes = restored.actions.filter((action) => action.kind === 'notes').at(-1)?.output;
    const readActions = events.filter((event): event is Extract<StreamEvent, { type: 'tool' }> => event.type === 'tool' && event.activity.kind === 'file_read' && event.activity.state === 'running').length;
    const extensions: Array<Record<string, string | number | boolean | null>> = events.flatMap((event, index) => event.type === 'tool' && event.activity.label === 'Бюджет действий расширен' ? [{
      ...event.activity.metadata,
      budgeted_actions_before_extension: events.slice(0, index).filter((previous): previous is Extract<StreamEvent, { type: 'tool' }> => previous.type === 'tool' && previous.activity.state === 'running').length,
    }] : []);
    const effectiveCompactions = compactions.filter((activity) => activity.metadata?.meaningful_savings === true);
    const ineffectiveCompactions = compactions.filter((activity) => activity.metadata?.meaningful_savings === false);
    const maxInputTokens = Math.max(0, ...usages.map((usage) => usage.used), ...compactions.map((activity) => Number(activity.metadata?.input_tokens_before) || 0));
    const errors = events.filter((event): event is Extract<StreamEvent, { type: 'error' }> => event.type === 'error').map((event) => ({ message: event.message, details: event.details }));
    const done = events.filter((event): event is Extract<StreamEvent, { type: 'done' }> => event.type === 'done').map((event) => event.finishReason);
    const planFinalState = persistedPlan?.steps.map((step) => ({ id: step.id, status: step.status })) ?? [];
    const finalBudget = Number(extensions.at(-1)?.action_budget) || 100;
    const stalledGuardTriggered = errors.some((error) => error.details?.includes('agent_stalled_exploration'));
    const terminalOrRuntimeError = errors.length > 0 || events.some((event): event is Extract<StreamEvent, { type: 'tool' }> => event.type === 'tool' && event.activity.kind === 'terminal' && event.activity.state === 'error');
    const auditMatrixComplete = auditCodes.every((code) => report.includes(code));
    const verificationComplete = [...auditCodesA.slice(0, auditRereadCount), ...auditCodesB.slice(0, auditRereadCount)].every((code) => report.includes(code));
    const extensionValidated = extensions.some((extension) => extension.previous_budget === 100 && extension.action_budget === 150 && extension.budgeted_actions_before_extension === 100);
    const validationPassed = !timedOut && extensionValidated && budgetedActions > 100 && Boolean(finalText.trim()) && !terminalOrRuntimeError && !stalledGuardTriggered;
    console.log(JSON.stringify({ model, backend: 'ollama', contextWindow, timeoutMs: runTimeoutMs, timedOut, initialActionBudget: 100, extensionsGranted: extensions.length, extensionPoints: extensions, finalBudget, finalBudgetedActionCount: budgetedActions, persistedActivityCount: restored.actions.length, durationMs: Date.now() - startedAt, readActions, effectiveCompactionCount: effectiveCompactions.length, ineffectiveCompactionCount: ineffectiveCompactions.length, compactions: compactions.map((activity) => activity.metadata), maxInputTokens, finalInputTokens: finalUsage?.used ?? null, finalOutputReserve: diagnostics?.effectiveMaxOutputTokens ?? null, planFinalState, finalSynthesisProduced: Boolean(finalText.trim()), terminalOrRuntimeError, stalledGuardTriggered, errors, done, reportWritten: Boolean(report), auditMatrixComplete, verificationComplete, extensionValidated, validationPassed, finalText, report, persistence: { planPersisted: Boolean(persistedPlan), notesPersisted: Boolean(persistedNotes), compactionPersisted: restored.actions.some((action) => action.kind === 'context'), rawOutputStoredInSqlite: rawToolOutputs > 0, rawOutputExposedToUi: restored.actions.some((action) => 'rawOutput' in action) } }, null, 2));
    if (!validationPassed) process.exitCode = 1;
  } finally { await rm(base, { recursive: true, force: true }); }
}

if (require.main === module) void runQwenStress().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
