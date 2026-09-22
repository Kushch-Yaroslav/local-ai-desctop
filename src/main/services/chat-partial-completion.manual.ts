/**
 * Manual regression fixture: run this prompt in Chat mode with no selected
 * project and Web off. It intentionally asks for an audit whose source files
 * are unavailable. The answer must state that limitation once, retain the
 * requested headings where useful, separate confirmed facts from hypotheses,
 * and provide a useful partial report instead of only asking for files.
 */
export const inaccessibleFilesystemAuditPrompt = `Prepare a technical audit of the local application in this structure:
1. Architecture
2. Main components
3. Confirmed problems
4. Unconfirmed risks and hypotheses
5. First fixes
6. Conclusion

Create a short Task Plan and Task Notes. Clearly separate facts confirmed from source code from generic technical hypotheses. If you cannot access the project files, do not invent findings, but still complete the most useful structured partial report possible and explain exactly what would be needed to verify it.`;

export const expectedPartialCompletion = [
  'States the lack of filesystem access once and does not claim to inspect files.',
  'Substantially retains the six requested sections plus the requested plan and notes.',
  'Marks code-specific claims as unconfirmed and distinguishes them from generic guidance.',
  'Offers a useful partial deliverable before listing the files needed for verification.',
];
