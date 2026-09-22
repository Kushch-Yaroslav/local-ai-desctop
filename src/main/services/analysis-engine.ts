export type ProjectMap = {
  discoveredAreas: string[];
  inspectedAreas: string[];
  importantResources: string[];
  relationships: string[];
  findings: string[];
  unresolvedQuestions: string[];
  evidence: string[];
  coverage: string;
};

const emptyMap = (): ProjectMap => ({ discoveredAreas: [], inspectedAreas: [], importantResources: [], relationships: [], findings: [], unresolvedQuestions: [], evidence: [], coverage: 'не оценено' });

/** A generation-scoped soft budget. A new AnalysisEngine is created for every generation. */
export const MAX_AGENT_STEPS_PER_GENERATION = 100;
export const AGENT_ACTION_BUDGET_EXTENSION = 50;
export const ABSOLUTE_MAX_AGENT_STEPS_PER_GENERATION = 250;

export type AgentActionBudgetInput = {
  actions: number;
  planComplete: boolean;
  stalled: boolean;
  recentProgress: boolean;
};
export type AgentActionBudgetDecision = {
  limit: number;
  extended: boolean;
  shouldFinalize: boolean;
  atAbsoluteCap: boolean;
};

/**
 * Keeps 100 actions as the normal operating budget while allowing a bounded
 * long task to continue only when it is still making progress. Plan completion
 * always wins over another tool-decision turn near a budget boundary.
 */
export class AgentActionBudget {
  private limit = MAX_AGENT_STEPS_PER_GENERATION;

  snapshot(): number { return this.limit; }

  assess(input: AgentActionBudgetInput): AgentActionBudgetDecision {
    const atAbsoluteCap = input.actions >= ABSOLUTE_MAX_AGENT_STEPS_PER_GENERATION;
    if (input.planComplete) return { limit: this.limit, extended: false, shouldFinalize: true, atAbsoluteCap };
    if (input.actions < this.limit) return { limit: this.limit, extended: false, shouldFinalize: false, atAbsoluteCap };
    if (!atAbsoluteCap && !input.stalled && input.recentProgress) {
      this.limit = Math.min(ABSOLUTE_MAX_AGENT_STEPS_PER_GENERATION, this.limit + AGENT_ACTION_BUDGET_EXTENSION);
      return { limit: this.limit, extended: true, shouldFinalize: false, atAbsoluteCap: false };
    }
    return { limit: this.limit, extended: false, shouldFinalize: true, atAbsoluteCap };
  }
}

const addUnique = (target: string[], values: unknown, maximum: number): void => {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const compact = value.replace(/\s+/g, ' ').trim();
    if (compact && !target.includes(compact) && target.length < maximum) target.push(compact);
  }
};

export class AnalysisEngine {
  readonly map = emptyMap();

  get budget(): number { return MAX_AGENT_STEPS_PER_GENERATION; }

  strategy(): string {
    return 'Исследуй основные релевантные области, проследи важные связи и сверь выводы по нескольким источникам. Заверши, когда ответ хорошо подтверждён и основные пробелы закрыты.';
  }

  merge(raw: string): boolean {
    const data = this.parseMap(raw);
    if (!data) return false;
    addUnique(this.map.discoveredAreas, data.discovered_areas, 24);
    addUnique(this.map.inspectedAreas, data.inspected_areas, 24);
    addUnique(this.map.importantResources, data.important_resources, 36);
    addUnique(this.map.relationships, data.relationships, 32);
    addUnique(this.map.findings, data.findings, 32);
    addUnique(this.map.unresolvedQuestions, data.unresolved_questions, 20);
    addUnique(this.map.evidence, data.evidence, 40);
    if (typeof data.coverage === 'string' && data.coverage.trim()) this.map.coverage = data.coverage.trim().slice(0, 500);
    return true;
  }

  record(tool: string, raw: string): void {
    let result: Record<string, unknown> | null = null;
    try { const parsed = JSON.parse(raw) as unknown; result = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { /* Raw evidence remains in the tool message. */ }
    const path = typeof result?.path === 'string' ? result.path : typeof result?.root === 'string' ? result.root : '';
    if (path) addUnique(this.map.importantResources, [path], 36);
    addUnique(this.map.evidence, [`${tool}${path ? `: ${path}` : ''}`], 40);
    if (Array.isArray(result?.entries)) addUnique(this.map.discoveredAreas, result.entries.filter((item): item is string => typeof item === 'string').map((item) => item.split('/')[0] || item), 24);
    if (Array.isArray(result?.matches)) addUnique(this.map.importantResources, result.matches.map((item) => typeof item === 'string' ? item : typeof item === 'object' && item && typeof (item as { path?: unknown }).path === 'string' ? (item as { path: string }).path : '').filter(Boolean), 36);
    if (typeof result?.error === 'string') addUnique(this.map.unresolvedQuestions, [result.error], 20);
    addUnique(this.map.inspectedAreas, [path || tool], 24);
  }

  prompt(): string {
    return `Компактная evidence map проекта (дополняет, но не заменяет доступные выше raw tool results):\n${JSON.stringify(this.map)}\nИспользуй её для синтеза; при необходимости опирайся на релевантные raw evidence из истории инструментов.`;
  }

  compactionInstruction(): string {
    return 'Сформируй только компактный JSON внутренней карты на основе уже полученных результатов. Формат: {"discovered_areas":string[],"inspected_areas":string[],"important_resources":string[],"relationships":string[],"findings":string[],"unresolved_questions":string[],"evidence":string[],"coverage":string}. Используй нейтральные короткие формулировки и пути/ресурсы как доказательства. Не вызывай инструменты, не добавляй Markdown и не отвечай пользователю.';
  }

  private parseMap(raw: string): Record<string, unknown> | null {
    const candidate = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!candidate) return null;
    try {
      const data = JSON.parse(candidate) as unknown;
      return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
    } catch { return null; }
  }
}
