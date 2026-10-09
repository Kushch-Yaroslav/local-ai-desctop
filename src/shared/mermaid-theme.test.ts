import assert from 'node:assert/strict';
import { mermaidGitThemeVariables, mermaidLabelColorForContrast, mermaidThemeVariables } from './mermaid-theme';

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

assert.equal(mermaidLabelColorForContrast('#f3f4f6', '#e1f5e1'), '#000000', 'dark-theme label on a custom pale node should switch to black');
assert.equal(mermaidLabelColorForContrast('#1d2733', '#fff4e1'), null, 'light-theme label should remain dark on a custom pale node');
assert.equal(mermaidLabelColorForContrast('#1d2733', '#26392f'), '#ffffff', 'light-theme label on a custom dark node should switch to white');
assert.equal(mermaidLabelColorForContrast('#f3f4f6', '#2a394b'), null, 'dark-theme label should remain light on a dark node');
assert.equal(mermaidLabelColorForContrast('#f3f4f6', 'transparent'), null, 'unknown backgrounds should leave the theme label untouched');
assert.equal(mermaidLabelColorForContrast('#f3f4f6', 'rgba(255, 255, 255, 0.5)', '#f4f6f8'), '#000000', 'translucent light label surfaces should account for their underlay');
assert.equal(mermaidLabelColorForContrast('#f3f4f6', 'rgba(34, 32, 29, 0.5)', '#141311'), null, 'translucent dark label surfaces should retain light text');

for (const theme of ['dark', 'light'] as const) { const git = mermaidGitThemeVariables(theme) as Record<string, string>; assert.equal(new Set([git.git0, git.git1, git.git2]).size, 3); for (let i=0;i<8;i++) assert(contrast(git[`gitBranchLabel${i}`], git[`git${i}`]) >= 4.5, `Git branch ${i} label contrast (${theme})`); }
