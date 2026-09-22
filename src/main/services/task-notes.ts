import type { ProjectToolCall, ProjectToolDefinition } from '../tools/project-tools';

const maximumTaskNotesLength = 4_000;

export const taskNotesToolDefinition: ProjectToolDefinition = {
  type: 'function',
  function: {
    name: 'task_notes',
    description: 'Временный блокнот только для текущей Agent-задачи. Используй в длинных или сложных задачах, чтобы сохранить краткие рабочие факты: цель, найденные файлы и их роли, решения, неизвестные вопросы и следующий шаг. action=read читает текущие заметки. action=update полностью заменяет их новым кратким состоянием. Не помещай исходники, большие tool outputs или подробные логи.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'update'] },
        notes: { type: 'string', maxLength: maximumTaskNotesLength, description: 'Краткие заметки для action=update: цель, находки, решения, неизвестное и следующий шаг.' },
      },
      required: ['action'],
    },
  },
};

export function isTaskNotesCall(call: ProjectToolCall): boolean { return call.name === 'task_notes'; }

/** Kept in an Agent stream only; it is never sent to SQLite or a later run. */
export class TaskNotes {
  private notes = '';

  /** The context manager reuses the Agent's own notes as durable working memory. */
  snapshot(): string { return this.notes; }

  execute(call: ProjectToolCall): string {
    const action = call.arguments.action;
    if (action === 'read') return JSON.stringify({ notes: this.notes, empty: !this.notes });
    if (action !== 'update') return JSON.stringify({ error: 'task_notes требует action=read или action=update' });
    if (typeof call.arguments.notes !== 'string') return JSON.stringify({ error: 'Для task_notes action=update нужны текстовые notes' });
    const notes = call.arguments.notes.trim();
    if (notes.length > maximumTaskNotesLength) return JSON.stringify({ error: `Task Notes ограничены ${maximumTaskNotesLength} символами` });
    this.notes = notes;
    return JSON.stringify({ updated: true, notes: this.notes, empty: !this.notes });
  }
}
