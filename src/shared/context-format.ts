/** Exact, locale-aware values for context diagnostics and tooltips. */
export const formatContextTokens = (tokens: number, locale?: string): string => new Intl.NumberFormat(locale).format(tokens);
