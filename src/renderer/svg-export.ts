/** Inline computed theme styles so exported SVGs retain contrast outside Electron. */
export function downloadSvg(svg: SVGSVGElement, title: string, captions: Array<{ label: string; color?: string }> = []): void {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const originals = [svg, ...svg.querySelectorAll('*')];
  const clones = [copy, ...copy.querySelectorAll('*')];
  for (let index = 0; index < originals.length; index++) {
    const style = getComputedStyle(originals[index]);
    for (const property of ['fill', 'stroke', 'stroke-width', 'color', 'font-family', 'font-size', 'font-weight', 'background-color']) {
      (clones[index] as SVGElement).style.setProperty(property, style.getPropertyValue(property));
    }
  }
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const bounds = svg.viewBox.baseVal;
  const width = bounds.width || svg.getBoundingClientRect().width;
  const height = bounds.height || svg.getBoundingClientRect().height;
  const surface = svg.closest('.rich-chart, .mermaid-block');
  let captionHeight = 0;
  const characters = Math.max(12, Math.floor((width - 48) / 8));
  for (const { label, color } of captions.slice(0, 200)) {
    const lines = label.replace(/\s+/g, ' ').match(new RegExp(`.{1,${characters}}`, 'gu')) ?? [];
    for (let index = 0; index < lines.length; index++) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.textContent = lines[index]; text.setAttribute('x', String(bounds.x + 28));
      text.setAttribute('y', String(bounds.y + height + 22 + captionHeight));
      text.style.cssText = `font:13px system-ui;fill:${getComputedStyle(surface ?? svg).color}`;
      copy.append(text);
      if (color && index === 0) {
        const swatch = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        swatch.setAttribute('x', String(bounds.x + 10)); swatch.setAttribute('y', String(bounds.y + height + 12 + captionHeight));
        swatch.setAttribute('width', '10'); swatch.setAttribute('height', '10'); swatch.setAttribute('fill', color); copy.append(swatch);
      }
      captionHeight += 20;
    }
  }
  if (captionHeight) { copy.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${width} ${height + captionHeight + 12}`); copy.setAttribute('height', String(height + captionHeight + 12)); }
  if (surface) {
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    background.setAttribute('x', String(bounds.x)); background.setAttribute('y', String(bounds.y));
    background.setAttribute('width', String(width));
    background.setAttribute('height', String(height + (captionHeight ? captionHeight + 12 : 0)));
    background.setAttribute('fill', getComputedStyle(surface).backgroundColor);
    copy.prepend(background);
  }
  const heading = document.createElementNS('http://www.w3.org/2000/svg', 'title'); heading.textContent = title; copy.prepend(heading);
  const href = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = href; anchor.download = `${title.replace(/[^\p{L}\p{N}-]+/gu, '-').slice(0, 60) || 'diagram'}.svg`; anchor.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
}
