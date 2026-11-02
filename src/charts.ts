import { escapeHtml } from "./page";

// Every chart is a string of SVG coloured through the stylesheet's custom properties, so both
// themes come free and the page keeps its no-script content security policy.

export interface Series {
  label: string;
  color: string;
  values: number[];
}

export interface Bar {
  label: string;
  value: number;
  text: string;
}

export interface HeatCell {
  weekday: number;
  hour: number;
  sessions: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const dayLabel = (day: string, withMonth: boolean): string => {
  const date = Number(day.slice(8, 10));
  const month = MONTHS[Number(day.slice(5, 7)) - 1] ?? "";
  return withMonth ? `${month} ${date}` : String(date);
};

const n = (value: number): string => String(Math.round(value * 10) / 10);

const svg = (viewBox: string, label: string, body: string): string =>
  `<svg viewBox="${viewBox}" width="100%" role="img" aria-label="${escapeHtml(label)}" style="display:block">${body}</svg>`;

const GRID_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1_000, 2_000, 2_500, 5_000];

// Three gridlines above the baseline, on a step a reader recognises.
const niceTop = (max: number): number => {
  const step = GRID_STEPS.find((candidate) => candidate * 3 >= max) ?? Math.ceil(max / 3);
  return step * 3;
};

const grid = (
  left: number,
  right: number,
  base: number,
  top: number,
  high: number,
  tick: (value: number) => string,
): string =>
  [0, 1, 2, 3]
    .map((index) => {
      const value = (high / 3) * index;
      const y = base - (base - top) * (index / 3);
      return `<line x1="${left}" y1="${n(y)}" x2="${right}" y2="${n(y)}" style="stroke:var(--grid);stroke-width:1"/><text x="${left - 5}" y="${n(y + 3)}" text-anchor="end" class="cl-ax">${escapeHtml(tick(value))}</text>`;
    })
    .join("");

const axis = (left: number, right: number, y: number): string =>
  `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" style="stroke:var(--axis);stroke-width:1"/>`;

// A bar whose top two corners are rounded, falling back to a plain rectangle when the bar is
// shorter than the radius and the curve would swallow it.
const capped = (x: number, width: number, top: number, bottom: number, radius: number, color: string): string => {
  if (bottom - top <= radius) {
    return `<rect x="${n(x)}" y="${n(top)}" width="${n(width)}" height="${n(Math.max(bottom - top, 0))}" style="fill:${color}"/>`;
  }
  const right = x + width;
  return `<path d="M${n(x)},${n(bottom)} L${n(x)},${n(top + radius)} Q${n(x)},${n(top)} ${n(x + radius)},${n(top)} L${n(right - radius)},${n(top)} Q${n(right)},${n(top)} ${n(right)},${n(top + radius)} L${n(right)},${n(bottom)} Z" style="fill:${color}"/>`;
};

const STACK_GAP = 2;

export const stackedBars = (
  days: string[],
  series: Series[],
  label: string,
  money: (value: number) => string,
): string => {
  const left = 34;
  const right = 394;
  const base = 212;
  const top = 18;
  const totals = days.map((_, index) => series.reduce((sum, band) => sum + (band.values[index] ?? 0), 0));
  const high = niceTop(Math.max(...totals, 0));
  const step = (right - left) / Math.max(days.length, 1);
  const width = step * 0.618;
  const bars = days
    .map((day, index) => {
      const x = left + (step - width) / 2 + index * step;
      const present = series.filter((band) => (band.values[index] ?? 0) > 0);
      let bottom = base;
      let highest = base;
      const drawn = present.map((band, place) => {
        const height = ((band.values[index] ?? 0) / high) * (base - top);
        const segmentTop = bottom - height;
        highest = segmentTop;
        const shape =
          place === present.length - 1
            ? capped(x, width, segmentTop, bottom, 3, band.color)
            : `<rect x="${n(x)}" y="${n(segmentTop)}" width="${n(width)}" height="${n(height)}" style="fill:${band.color}"/>`;
        bottom = segmentTop - STACK_GAP;
        return shape;
      });
      const center = x + width / 2;
      const tick =
        index % 3 === 0
          ? `<text x="${n(center)}" y="${base + 13}" text-anchor="middle" class="cl-ax">${escapeHtml(dayLabel(day, index === 0 || day.endsWith("-01")))}</text>`
          : "";
      const value =
        index === days.length - 1 && totals[index] !== undefined && (totals[index] ?? 0) > 0
          ? `<text x="${n(center)}" y="${n(highest - 6)}" text-anchor="middle" class="cl-val">${escapeHtml(money(totals[index] ?? 0))}</text>`
          : "";
      return `${drawn.join("")}${tick}${value}`;
    })
    .join("");
  return svg("0 0 400 230", label, `${grid(left, right, base, top, high, money)}${bars}${axis(left, right, base)}`);
};

export const stackedArea = (
  days: string[],
  series: Series[],
  label: string,
  money: (value: number) => string,
): string => {
  const left = 34;
  const right = 394;
  const base = 212;
  const top = 12;
  const totals = days.map((_, index) => series.reduce((sum, band) => sum + (band.values[index] ?? 0), 0));
  const high = niceTop(Math.max(...totals, 0));
  const span = Math.max(days.length - 1, 1);
  const x = (index: number): number => left + (index / span) * (right - left);
  const y = (value: number): number => base - (value / high) * (base - top);
  const running = days.map(() => 0);
  const lines: string[][] = [];
  for (const band of series) {
    days.forEach((_, index) => {
      running[index] = (running[index] ?? 0) + (band.values[index] ?? 0);
    });
    lines.push(days.map((_, index) => `${n(x(index))},${n(y(running[index] ?? 0))}`));
  }
  const floor = days.map((_, index) => `${n(x(index))},${base}`);
  const bands = series
    .map((band, place) => {
      const under = place === 0 ? floor : (lines[place - 1] ?? floor);
      const points = [...(lines[place] ?? []), ...[...under].reverse()].join(" ");
      return `<polygon points="${points}" style="fill:${band.color}"/>`;
    })
    .join("");
  const seams = lines
    .slice(0, -1)
    .map((line) => `<polyline points="${line.join(" ")}" style="fill:none;stroke:var(--surface);stroke-width:2"/>`)
    .join("");
  const ticks = days
    .map((day, index) => {
      if (index === 0) {
        return `<text x="${left}" y="${base + 14}" text-anchor="start" class="cl-ax">${escapeHtml(dayLabel(day, true))}</text>`;
      }
      if (index === days.length - 1) {
        return `<text x="${right}" y="${base + 14}" text-anchor="end" class="cl-ax">${escapeHtml(dayLabel(day, true))}</text>`;
      }
      if (index % 7 !== 0) return "";
      return `<text x="${n(x(index))}" y="${base + 14}" text-anchor="middle" class="cl-ax">${escapeHtml(dayLabel(day, day.endsWith("-01")))}</text>`;
    })
    .join("");
  return svg(
    "0 0 400 230",
    label,
    `${grid(left, right, base, top, high, money)}${bands}${seams}${ticks}${axis(left, right, base)}`,
  );
};

export const miniBars = (days: string[], values: number[], label: string, last: string): string => {
  const left = 2;
  const right = 438;
  const base = 136;
  const top = 16;
  const high = Math.max(...values, 0);
  const step = (right - left) / Math.max(days.length, 1);
  const width = step * 0.578;
  const bars = values
    .map((value, index) => {
      const x = left + (step - width) / 2 + index * step;
      const barTop = high === 0 ? base : base - (value / high) * (base - top);
      return capped(x, width, barTop, base, 2, "var(--bar)");
    })
    .join("");
  const lastTop = high === 0 ? base : base - ((values.at(-1) ?? 0) / high) * (base - top);
  const center = left + (step - width) / 2 + (values.length - 1) * step + width / 2;
  const value =
    high === 0
      ? ""
      : `<text x="${n(center)}" y="${n(lastTop - 7)}" text-anchor="middle" class="cl-val">${escapeHtml(last)}</text>`;
  const first = days[0] ?? "";
  const final = days.at(-1) ?? "";
  const ticks = `<text x="${left}" y="${base + 12}" class="cl-ax">${escapeHtml(dayLabel(first, true))}</text><text x="${right}" y="${base + 12}" text-anchor="end" class="cl-ax">${escapeHtml(dayLabel(final, true))}</text>`;
  return svg("0 0 440 150", label, `${bars}${value}${axis(left, right, base)}${ticks}`);
};

export const horizontalBars = (bars: Bar[], label: string): string => {
  const rowHeight = 30;
  const trackLeft = 100;
  const trackRight = 346;
  const high = Math.max(...bars.map((bar) => bar.value), 0);
  const rows = bars
    .map((bar, index) => {
      const top = 9 + index * rowHeight;
      const baseline = 19 + index * rowHeight;
      const width = high === 0 ? 0 : ((trackRight - trackLeft) * bar.value) / high;
      const shape =
        width <= 3
          ? `<rect x="${trackLeft}" y="${top}" width="${n(Math.max(width, 1))}" height="12" style="fill:var(--bar)"/>`
          : `<path d="M${trackLeft},${top} L${n(trackLeft + width - 3)},${top} Q${n(trackLeft + width)},${top} ${n(trackLeft + width)},${top + 3} L${n(trackLeft + width)},${top + 9} Q${n(trackLeft + width)},${top + 12} ${n(trackLeft + width - 3)},${top + 12} L${trackLeft},${top + 12} Z" style="fill:var(--bar)"/>`;
      return `<text x="0" y="${baseline}" class="cl-bl">${escapeHtml(bar.label)}</text>${shape}<text x="400" y="${baseline}" text-anchor="end" class="cl-val">${escapeHtml(bar.text)}</text>`;
    })
    .join("");
  return svg(`0 0 400 ${bars.length * rowHeight + 4}`, label, rows);
};

export interface Slice {
  label: string;
  color: string;
  value: number;
}

const SLICE_GAP = 1.4;

export const donut = (slices: Slice[], hero: string, sub: string, label: string): string => {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  let cursor = 0;
  const arcs = slices
    .map((slice) => {
      const share = total === 0 ? 0 : (slice.value / total) * 100;
      const length = Math.max(share - SLICE_GAP, 0.4);
      const offset = cursor + SLICE_GAP / 2;
      cursor += share;
      return `<circle cx="75" cy="75" r="61" pathLength="100" transform="rotate(-90 75 75)" style="fill:none;stroke:${slice.color};stroke-width:24" stroke-dasharray="${n(length)} ${n(100 - length)}" stroke-dashoffset="-${n(offset)}"/>`;
    })
    .join("");
  return svg(
    "0 0 150 150",
    label,
    `${arcs}<text x="75" y="77" text-anchor="middle" class="cl-hero">${escapeHtml(hero)}</text><text x="75" y="93" text-anchor="middle" class="cl-sub">${escapeHtml(sub)}</text>`,
  );
};

const WEEKDAY_ROWS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HEAT_LEVELS = ["var(--h0)", "var(--h1)", "var(--h2)", "var(--h3)", "var(--h4)", "var(--h5)"];

// Monday-first rows, one column an hour. A cell with no session stays on the coldest step so the
// grid reads as a week rather than as scattered marks.
export const heatmap = (cells: HeatCell[], label: string): string => {
  const counts = WEEKDAY_ROWS.map(() => new Array<number>(24).fill(0));
  for (const cell of cells) {
    const row = (cell.weekday + 6) % 7;
    const line = counts[row];
    if (line && cell.hour >= 0 && cell.hour < 24) line[cell.hour] = cell.sessions;
  }
  const high = Math.max(...counts.flat(), 0);
  const top = 5;
  const rowStep = 21.8;
  const cellStep = 30.3;
  const rows = counts
    .map((line, row) => {
      const y = top + row * rowStep;
      const squares = line
        .map((count, hour) => {
          const level = count === 0 || high === 0 ? 0 : 1 + Math.floor(((count - 1) / high) * 5);
          const fill = HEAT_LEVELS[Math.min(level, 5)] ?? HEAT_LEVELS[0];
          return `<rect x="${n(31 + hour * cellStep)}" y="${n(y)}" width="28.3" height="19.8" rx="2" style="fill:${fill}"/>`;
        })
        .join("");
      return `<text x="0" y="${n(y + 12.9)}" class="cl-ax">${WEEKDAY_ROWS[row]}</text>${squares}`;
    })
    .join("");
  const hours = [0, 3, 6, 9, 12, 15, 18, 21]
    .map(
      (hour) =>
        `<text x="${n(31 + hour * cellStep + 14.15)}" y="${n(top + 7 * rowStep + 12)}" text-anchor="middle" class="cl-ax">${String(hour).padStart(2, "0")}</text>`,
    )
    .join("");
  return svg(`0 0 760 ${n(top + 7 * rowStep + 15)}`, label, `${rows}${hours}`);
};
