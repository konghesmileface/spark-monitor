import { formatChange } from '@/utils';

interface TreemapItem {
  name: string;
  change: number;
}

interface TreemapRect {
  x: number;
  y: number;
  w: number;
  h: number;
  item: TreemapItem;
}

/**
 * Squarified treemap layout algorithm.
 * Takes items with equal weight and lays them out in a rectangle.
 */
function squarify(items: TreemapItem[], width: number, height: number): TreemapRect[] {
  if (items.length === 0) return [];

  const totalArea = width * height;
  const weightPerItem = totalArea / items.length;

  const rects: TreemapRect[] = [];
  layoutStrip(items.map((item) => ({ item, area: weightPerItem })), 0, 0, width, height, rects);
  return rects;
}

interface WeightedItem {
  item: TreemapItem;
  area: number;
}

function layoutStrip(
  items: WeightedItem[],
  x: number,
  y: number,
  w: number,
  h: number,
  out: TreemapRect[]
): void {
  if (items.length === 0) return;
  if (items.length === 1) {
    out.push({ x, y, w, h, item: items[0]!.item });
    return;
  }

  const totalArea = items.reduce((sum, it) => sum + it.area, 0);
  const isWide = w >= h;

  // Greedily add items to current row until aspect ratio worsens
  let rowArea = 0;
  let bestWorst = Infinity;
  let splitAt = 1;

  for (let i = 0; i < items.length; i++) {
    rowArea += items[i]!.area;

    // Row dimension
    const rowSize = isWide ? (rowArea / totalArea) * w : (rowArea / totalArea) * h;
    if (rowSize === 0) continue;

    // Calculate worst aspect ratio in this row
    let worst = 0;
    for (let j = 0; j <= i; j++) {
      const itemSize = isWide ? h * (items[j]!.area / rowArea) : w * (items[j]!.area / rowArea);
      const aspect = Math.max(rowSize / itemSize, itemSize / rowSize);
      worst = Math.max(worst, aspect);
    }

    if (worst <= bestWorst) {
      bestWorst = worst;
      splitAt = i + 1;
    } else {
      break;
    }
  }

  // Layout the row
  const rowItems = items.slice(0, splitAt);
  const remaining = items.slice(splitAt);
  const rowTotalArea = rowItems.reduce((s, it) => s + it.area, 0);

  if (isWide) {
    const rowW = (rowTotalArea / totalArea) * w;
    let cy = y;
    for (const ri of rowItems) {
      const itemH = h * (ri.area / rowTotalArea);
      out.push({ x, y: cy, w: rowW, h: itemH, item: ri.item });
      cy += itemH;
    }
    layoutStrip(remaining, x + rowW, y, w - rowW, h, out);
  } else {
    const rowH = (rowTotalArea / totalArea) * h;
    let cx = x;
    for (const ri of rowItems) {
      const itemW = w * (ri.area / rowTotalArea);
      out.push({ x: cx, y, w: itemW, h: rowH, item: ri.item });
      cx += itemW;
    }
    layoutStrip(remaining, x, y + rowH, w, h - rowH, out);
  }
}

function getTreemapColor(change: number): string {
  const abs = Math.abs(change);
  if (change >= 0) {
    if (abs >= 3) return '#16a34a';
    if (abs >= 2) return '#22c55e';
    if (abs >= 1) return '#4ade80';
    return '#86efac';
  } else {
    if (abs >= 3) return '#dc2626';
    if (abs >= 2) return '#ef4444';
    if (abs >= 1) return '#f87171';
    return '#fca5a5';
  }
}

function getTextColor(change: number): string {
  const abs = Math.abs(change);
  return abs >= 1 ? '#fff' : '#1a1a2e';
}

export class TreemapModal {
  /** Expose layout utilities as static methods for inline treemap rendering */
  static squarify = squarify;
  static getTreemapColor = getTreemapColor;
  static getTextColor = getTextColor;

  private overlay: HTMLElement | null = null;
  private data: TreemapItem[];

  constructor(data: TreemapItem[]) {
    this.data = data;
  }

  open(): void {
    if (this.overlay) return;

    const overlay = document.createElement('div');
    overlay.className = 'treemap-modal-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });

    const container = document.createElement('div');
    container.className = 'treemap-modal-container';

    const header = document.createElement('div');
    header.className = 'treemap-modal-header';
    header.innerHTML = `
      <span class="treemap-modal-title">板块热力图 <span class="spark-subtitle">SECTOR HEATMAP</span></span>
      <button class="treemap-modal-close" aria-label="Close">
        <i class="bi bi-x-lg"></i>
      </button>
    `;
    header.querySelector('.treemap-modal-close')?.addEventListener('click', () => this.close());

    const svgWrap = document.createElement('div');
    svgWrap.className = 'treemap-svg-wrap';

    container.appendChild(header);
    container.appendChild(svgWrap);
    overlay.appendChild(container);
    document.body.appendChild(overlay);
    this.overlay = overlay;

    // Escape key
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.close();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);

    // Render treemap after layout is ready
    requestAnimationFrame(() => {
      const rect = svgWrap.getBoundingClientRect();
      this.renderSVG(svgWrap, rect.width, rect.height);
    });
  }

  close(): void {
    if (!this.overlay) return;
    this.overlay.remove();
    this.overlay = null;
  }

  private renderSVG(container: HTMLElement, width: number, height: number): void {
    if (width === 0 || height === 0) return;

    const padding = 2;
    const rects = squarify(this.data, width, height);

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.style.width = '100%';
    svg.style.height = '100%';

    for (const r of rects) {
      const g = document.createElementNS(svgNS, 'g');
      g.classList.add('treemap-cell');

      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', String(r.x + padding / 2));
      rect.setAttribute('y', String(r.y + padding / 2));
      rect.setAttribute('width', String(Math.max(0, r.w - padding)));
      rect.setAttribute('height', String(Math.max(0, r.h - padding)));
      rect.setAttribute('rx', '4');
      rect.setAttribute('fill', getTreemapColor(r.item.change));
      g.appendChild(rect);

      const textColor = getTextColor(r.item.change);
      const cellW = r.w - padding;
      const cellH = r.h - padding;

      // Only show text if cell is big enough
      if (cellW > 40 && cellH > 30) {
        const fontSize = Math.max(10, Math.min(16, cellW / 8, cellH / 4));

        const nameText = document.createElementNS(svgNS, 'text');
        nameText.setAttribute('x', String(r.x + r.w / 2));
        nameText.setAttribute('y', String(r.y + r.h / 2 - fontSize * 0.3));
        nameText.setAttribute('text-anchor', 'middle');
        nameText.setAttribute('fill', textColor);
        nameText.setAttribute('font-size', String(fontSize));
        nameText.setAttribute('font-weight', '600');
        nameText.textContent = r.item.name;
        g.appendChild(nameText);

        const changeText = document.createElementNS(svgNS, 'text');
        changeText.setAttribute('x', String(r.x + r.w / 2));
        changeText.setAttribute('y', String(r.y + r.h / 2 + fontSize * 0.9));
        changeText.setAttribute('text-anchor', 'middle');
        changeText.setAttribute('fill', textColor);
        changeText.setAttribute('font-size', String(fontSize * 0.85));
        changeText.setAttribute('opacity', '0.9');
        changeText.textContent = formatChange(r.item.change);
        g.appendChild(changeText);
      }

      // Tooltip on hover
      const title = document.createElementNS(svgNS, 'title');
      title.textContent = `${r.item.name}: ${formatChange(r.item.change)}`;
      g.appendChild(title);

      svg.appendChild(g);
    }

    container.appendChild(svg);
  }
}
