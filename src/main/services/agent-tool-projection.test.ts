import assert from 'node:assert/strict';
import { projectAgentTools } from './agent-tool-projection';
import type { ProjectToolDefinition } from '../tools/project-tools';

const names = ['list_directory', 'write_file', 'create_file', 'apply_patch', 'run_terminal', 'task_plan', 'task_notes', 'report_progress', 'git_status', 'git_diff', 'recall_previous_tool_result', 'web_search'];
const registry = names.map((name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } })) as ProjectToolDefinition[];
export function runAgentToolProjectionRegression(): void {
  const simple = projectAgentTools(registry, { taskIntent: 'greenfield', turn: 'execution', explicitWeb: false, webAvailable: true, projectCount: 1 }).map((tool) => tool.function.name);
  assert(simple.includes('write_file') && simple.includes('task_plan') && simple.includes('task_notes'));
  assert(!simple.includes('web_search') && !simple.includes('git_status'));
  const web = projectAgentTools(registry, { taskIntent: 'action', turn: 'execution', explicitWeb: true, webAvailable: true, projectCount: 1 }).map((tool) => tool.function.name);
  assert(web.includes('web_search'));
  const analysis = projectAgentTools(registry, { taskIntent: 'analysis', turn: 'investigation', explicitWeb: false, webAvailable: true, projectCount: 1 }).map((tool) => tool.function.name);
  assert(analysis.includes('git_status') && analysis.includes('recall_previous_tool_result') && analysis.includes('task_notes'));
}
if (require.main === module) runAgentToolProjectionRegression();
