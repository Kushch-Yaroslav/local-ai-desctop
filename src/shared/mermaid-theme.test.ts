import assert from 'node:assert/strict';
import { mermaidThemeVariables } from './mermaid-theme';

function luminance(color: string): number {
  const channels = color.slice(1).match(/.{2}/g)!.map((channel) => parseInt(channel, 16) / 255).map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + .05) / (darker + .05);
}

for (const theme of ['dark', 'light'] as const) {
  const colors = mermaidThemeVariables(theme);
  for (const [foreground, background, label] of [
    [colors.primaryTextColor, colors.primaryColor, 'primary nodes'],
    [colors.secondaryTextColor, colors.secondaryColor, 'secondary nodes'],
    [colors.tertiaryTextColor, colors.tertiaryColor, 'tertiary nodes'],
    [colors.textColor, colors.clusterBkg, 'subgraphs'],
    [colors.labelTextColor, colors.edgeLabelBackground, 'edge labels'],
    [colors.actorTextColor, colors.actorBkg, 'sequence actors'],
    [colors.noteTextColor, colors.noteBkgColor, 'notes'],
    [colors.taskTextColor, colors.taskBkgColor, 'tasks'],
  ] as const) {
    assert(contrast(foreground, background) >= 4.5, `${theme} ${label} contrast is below WCAG AA`);
  }
}
