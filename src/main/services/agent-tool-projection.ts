import type { ProjectToolDefinition } from '../tools/project-tools';

export type ToolProjectionInput = { taskIntent: 'chat' | 'analysis' | 'action' | 'greenfield'; turn: 'planning' | 'execution' | 'investigation' | 'repair' | 'synthesis'; explicitWeb: boolean; webAvailable: boolean; projectCount: number };

const essentialFilesystem = new Set(['list_directory', 'find_files', 'search_text', 'read_file', 'inspect_package_json', 'apply_patch', 'write_file', 'create_file']);
const executionTools = new Set([...essentialFilesystem, 'run_terminal', 'task_plan', 'task_notes', 'report_progress']);
const analysisTools = new Set(['list_directory', 'find_files', 'search_text', 'read_file', 'inspect_package_json', 'git_status', 'git_diff', 'run_terminal', 'task_plan', 'task_notes', 'report_progress', 'recall_previous_tool_result']);

/** Exposure is a request projection only. Registration and approval remain the
 * complete runtime registry; a later turn can expand to web or diagnostic tools. */
export function projectAgentTools(all: ProjectToolDefinition[], input: ToolProjectionInput): ProjectToolDefinition[] {
  if (input.turn === 'synthesis') return [];
  const names = input.taskIntent === 'analysis' ? analysisTools : executionTools;
  const web = input.webAvailable && (input.explicitWeb || input.taskIntent === 'analysis');
  return all.filter((tool) => names.has(tool.function.name) || (web && tool.function.name.startsWith('web_')));
}

export function isExplicitWebTask(text: string): boolean {
  return /\b(web|internet|online|browser|сайт|интернет|веб|найди в сети|погугли)\b/i.test(text);
}
