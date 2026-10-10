/** Mermaid does not expose horizontal commit-label spacing. Preserve its graph
 * geometry, but use numbered references when measured descriptions collide. */
export function layoutGitLabels(svg: SVGSVGElement): string[] {
  const labels = [...svg.querySelectorAll<SVGTextElement>('.commit-label')];
  const intersects = (a: DOMRect, b: DOMRect) => a.left < b.right + 4 && b.left < a.right + 4 && a.top < b.bottom && b.top < a.bottom;
  const boxes = labels.map(label => label.getBoundingClientRect());
  const branchBoxes = [...svg.querySelectorAll('.branchLabel')].map(label => label.getBoundingClientRect());
  const collision = boxes.some((box, index) => boxes.slice(index + 1).some(other => intersects(box, other)) || branchBoxes.some(other => intersects(box, other)));
  if (!collision) return [];
  const descriptions = labels.map(label => label.textContent ?? '');
  labels.forEach((label, index) => {
    const old = label.getBBox(); const center = old.x + old.width / 2;
    label.textContent = String(index + 1); label.setAttribute('x', String(center)); label.setAttribute('text-anchor', 'middle');
    label.setAttribute('aria-label', `${index + 1}: ${descriptions[index]}`); label.setAttribute('tabindex', '0');
    const tooltip = document.createElementNS('http://www.w3.org/2000/svg', 'title'); tooltip.textContent = descriptions[index]; label.parentElement?.append(tooltip);
    const background = label.parentElement?.querySelector('.commit-label-bkg'); const box = label.getBBox();
    background?.setAttribute('x', String(box.x - 4)); background?.setAttribute('width', String(box.width + 8));
  });
  const bounds = svg.getBBox();
  svg.setAttribute('viewBox', `${bounds.x - 12} ${bounds.y - 12} ${bounds.width + 24} ${bounds.height + 24}`);
  return descriptions;
}
