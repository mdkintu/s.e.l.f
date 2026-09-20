// charts.js — hand-built SVG charts. Pure functions: data in, markup out.
//
// No library, no DOM, no network. Chart.js from a CDN would have put a third-party request on
// every page load and made Privacy Mode something to bolt on afterwards. Building the SVG here
// means every value that reaches the screen passes through one decision: `showValues`.
//
// PRIVACY MODE: when `showValues` is false, no amount appears anywhere in the markup — not in an
// axis label, not in a tooltip (<title>), not in a label for a screen reader. Only shapes remain.
// Callers pass amounts as pre-formatted strings; this module never formats money itself, so it
// cannot leak a figure it was not handed.
//
// Geometry uses floats (pixels, angles). Money never does: values are integers in, and only the
// ratio between them is turned into a length.

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeColor = (c, fallback = '#64748b') => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : fallback);
const fixed = (n) => (Math.round(n * 100) / 100).toString();

/* ------------------------------------------------------------------ */
/* Scale                                                               */
/* ------------------------------------------------------------------ */

/**
 * A "nice" axis for a maximum given in whole minor units: steps of 1, 2 or 5 × a power of ten,
 * chosen with integer arithmetic. → { max, step, ticks: [0, step, 2·step, …] }
 */
export function niceScale(maxMinor, wanted = 4) {
  const top = Math.max(1, Math.ceil(maxMinor));
  for (let power = 1; ; power *= 10) {
    for (const mult of [1, 2, 5]) {
      const step = mult * power;
      if (step * wanted >= top) {
        const count = Math.ceil(top / step);
        return { max: count * step, step, ticks: Array.from({ length: count + 1 }, (_, i) => i * step) };
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Donut                                                               */
/* ------------------------------------------------------------------ */

/**
 * Donut of value shares.
 *   slices: [{ name, value (integer, > 0), color, valueText, sharePct }]  largest first
 *   showValues: false in Privacy Mode — drops every amount, tooltip and the total
 *   totalText: shown in the hole (only when showValues)
 * Slices are decorative: the legend the caller builds beside it is the accessible version.
 */
export function donutChart({ slices, showValues, totalText = '', caption = '', ariaLabel }) {
  const shown = slices.filter((s) => s.value > 0);
  const total = shown.reduce((n, s) => n + s.value, 0);
  if (total <= 0) return '';

  const size = 220;
  const mid = size / 2;
  const radius = 78;
  const thickness = 30;
  const circumference = 2 * Math.PI * radius;
  const gap = shown.length > 1 ? 2 : 0;

  let used = 0;
  const arcs = shown.map((s) => {
    const length = (s.value / total) * circumference;
    const dash = Math.max(0.5, length - gap);
    const arc = `<circle cx="${mid}" cy="${mid}" r="${radius}" fill="none" stroke="${safeColor(s.color)}" stroke-width="${thickness}"
      stroke-dasharray="${fixed(dash)} ${fixed(circumference - dash)}" stroke-dashoffset="${fixed(-used)}" transform="rotate(-90 ${mid} ${mid})">${
  showValues ? `<title>${esc(s.name)}: ${esc(s.valueText)} (${s.sharePct}%)</title>` : ''}</circle>`;
    used += length;
    return arc;
  });

  const centre = showValues && totalText
    ? `<text x="${mid}" y="${mid - 2}" text-anchor="middle" font-size="17" font-weight="700" fill="currentColor">${esc(totalText)}</text>
       <text x="${mid}" y="${mid + 18}" text-anchor="middle" font-size="12" fill="currentColor" opacity="0.7">${esc(caption)}</text>`
    : (caption ? `<text x="${mid}" y="${mid + 5}" text-anchor="middle" font-size="12" fill="currentColor" opacity="0.7">${esc(caption)}</text>` : '');

  return `<svg viewBox="0 0 ${size} ${size}" class="mx-auto block h-auto w-full max-w-[15rem]" role="img" aria-label="${esc(ariaLabel)}">${arcs.join('')}${centre}</svg>`;
}

/* ------------------------------------------------------------------ */
/* Grouped bars                                                        */
/* ------------------------------------------------------------------ */

/**
 * Grouped bar chart.
 *   groups: [{ label, values: [n, n], valueTexts: [str, str] }]   one group per month
 *   series: [{ name, color }]                                     same order as `values`
 *   ticks:  [{ value, label }]  axis marks (label is dropped when !showValues)
 *   max:    the axis maximum, from niceScale()
 */
export function barChart({ groups, series, ticks, max, showValues, ariaLabel }) {
  if (!groups.length || max <= 0) return '';

  const width = 340;
  const height = 210;
  const pad = { left: showValues ? 46 : 10, right: 8, top: 10, bottom: 26 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const y = (v) => pad.top + plotH - (Math.min(v, max) / max) * plotH;

  const grid = ticks.map((t) => {
    const gy = y(t.value);
    const base = t.value === 0;
    return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${fixed(gy)}" y2="${fixed(gy)}" stroke="currentColor" stroke-opacity="${base ? 0.45 : 0.15}" stroke-width="1"/>${
      showValues ? `<text x="${pad.left - 6}" y="${fixed(gy + 4)}" text-anchor="end" font-size="10" fill="currentColor" opacity="0.75">${esc(t.label)}</text>` : ''}`;
  });

  const groupW = plotW / groups.length;
  const barW = Math.min(20, groupW * 0.34);
  const inner = 3;
  const cluster = barW * series.length + inner * (series.length - 1);

  const bars = groups.map((g, gi) => {
    const x0 = pad.left + gi * groupW + (groupW - cluster) / 2;
    const rects = g.values.map((v, si) => {
      const top = y(v);
      const h = Math.max(0, pad.top + plotH - top);
      if (h <= 0) return '';
      const x = x0 + si * (barW + inner);
      return `<rect x="${fixed(x)}" y="${fixed(top)}" width="${fixed(barW)}" height="${fixed(h)}" rx="3" fill="${safeColor(series[si].color)}">${
        showValues ? `<title>${esc(g.label)} · ${esc(series[si].name)}: ${esc(g.valueTexts[si])}</title>` : ''}</rect>`;
    });
    const cx = pad.left + gi * groupW + groupW / 2;
    return `${rects.join('')}<text x="${fixed(cx)}" y="${height - 8}" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.8">${esc(g.label)}</text>`;
  });

  return `<svg viewBox="0 0 ${width} ${height}" class="block h-auto w-full" role="img" aria-label="${esc(ariaLabel)}">${grid.join('')}${bars.join('')}</svg>`;
}
