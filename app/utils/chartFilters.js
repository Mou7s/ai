const STORAGE_KEY = 'ai_model_chart_hidden_ids';

export function getStoredHiddenIds() {
  if (typeof window === 'undefined') return new Set();
  try {
    let raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      // Carry existing session preferences into persistent storage once.
      try {
        raw = window.sessionStorage.getItem(STORAGE_KEY);
        if (raw !== null) {
          window.localStorage.setItem(STORAGE_KEY, raw);
          window.sessionStorage.removeItem(STORAGE_KEY);
        }
      } catch {}
    }
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

export function saveStoredHiddenIds(idsSet) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...idsSet]));
  } catch {}
}

export function clearStoredHiddenIds() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {}
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export const canPlot = model => [model.intelligence, model.cost, model.timeSeconds]
  .every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);

export const formatMetric = (value, digits = 2, prefix = '', suffix = '') =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `${prefix}${value.toFixed(digits)}${suffix}` : '—';

export const formatReleaseDate = value =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value))
    ? value.slice(0, 10) : '—';

export const missingMetrics = model => [
  ['intelligence', 'intelligence'], ['cost', 'cost'], ['timeSeconds', 'time']
].filter(([key]) => !(typeof model[key] === 'number' && Number.isFinite(model[key]) && model[key] >= 0))
  .map(([, label]) => label).join(', ');

/**
 * Compute the set of Pareto-optimal model IDs among candidate models.
 * View '1': Intelligence (max) vs Time (min)
 * View '2': Cost (min) vs Time (min)
 * View '3': Intelligence (max) vs Cost (min)
 * View '4': Intelligence (max) vs Cost (min) vs Time (min)
 */
export function computeParetoIds(candidates, view = '4') {
  const dominates = (a, b) => {
    if (view === '1') {
      return a.intelligence >= b.intelligence && a.timeSeconds <= b.timeSeconds &&
        (a.intelligence > b.intelligence || a.timeSeconds < b.timeSeconds);
    }
    if (view === '2') {
      return a.cost <= b.cost && a.timeSeconds <= b.timeSeconds &&
        (a.cost < b.cost || a.timeSeconds < b.timeSeconds);
    }
    if (view === '3') {
      return a.intelligence >= b.intelligence && a.cost <= b.cost &&
        (a.intelligence > b.intelligence || a.cost < b.cost);
    }
    return a.intelligence >= b.intelligence && a.cost <= b.cost && a.timeSeconds <= b.timeSeconds &&
      (a.intelligence > b.intelligence || a.cost < b.cost || a.timeSeconds < b.timeSeconds);
  };

  const paretoIds = new Set();
  for (const m of candidates) {
    if (!canPlot(m)) continue;
    let dominated = false;
    for (const other of candidates) {
      if (other.id === m.id || !canPlot(other)) continue;
      if (dominates(other, m)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) paretoIds.add(m.id);
  }
  return paretoIds;
}

/**
 * Parse text and split it into plain text segments and interactive model tokens
 * for models that can be located on the chart.
 */
export function linkifyModelsInText(text, plottableModels) {
  if (!text || typeof text !== 'string' || !Array.isArray(plottableModels) || !plottableModels.length) {
    return [{ type: 'text', text: text || '' }];
  }
  const byName = new Map();
  for (const m of plottableModels) {
    if (m.name && m.name.length >= 3) byName.set(m.name.toLowerCase(), m);
    if (m.shortName && m.shortName.length >= 3 && !byName.has(m.shortName.toLowerCase())) {
      byName.set(m.shortName.toLowerCase(), m);
    }
  }
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  if (!names.length) return [{ type: 'text', text }];

  const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(?<![\\p{L}\\d])(${escaped.join('|')})(?![\\p{L}\\d])`, 'giu');

  const segments = [];
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const idx = match.index;
    const raw = match[0];
    const model = byName.get(raw.toLowerCase());
    if (!model) continue;
    if (idx > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, idx) });
    }
    segments.push({ type: 'model', text: raw, model });
    lastIndex = idx + raw.length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIndex) });
  }
  return segments.length ? segments : [{ type: 'text', text }];
}
