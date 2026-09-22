export type TaskNotesBlock = { kind: 'paragraph' | 'unordered' | 'ordered'; lines: string[] };

/** Presentation-only parsing: preserves note text while grouping blank-line paragraphs and simple lists. */
export function parseTaskNotes(text: string): TaskNotesBlock[] {
  const lines = text.split('\n'); const blocks: TaskNotesBlock[] = []; let index = 0;
  while (index < lines.length) {
    while (index < lines.length && !lines[index].trim()) index += 1;
    if (index >= lines.length) break;
    const unordered = /^\s*[-*]\s+(.+)$/; const ordered = /^\s*\d+[.)]\s+(.+)$/;
    const match = lines[index].match(unordered) ?? lines[index].match(ordered);
    if (match) {
      const kind = lines[index].match(unordered) ? 'unordered' : 'ordered'; const values: string[] = [];
      while (index < lines.length) { const item = lines[index].match(kind === 'unordered' ? unordered : ordered); if (!item) break; values.push(item[1]); index += 1; }
      blocks.push({ kind, lines: values }); continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !lines[index].match(unordered) && !lines[index].match(ordered)) { paragraph.push(lines[index]); index += 1; }
    blocks.push({ kind: 'paragraph', lines: paragraph });
  }
  return blocks;
}
