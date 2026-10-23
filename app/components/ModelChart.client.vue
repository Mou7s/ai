<script setup>
import Plotly from 'plotly.js-dist-min';
import fallbackData from '../../src/data.json';
let data = fallbackData;
import { onMounted, onBeforeUnmount, nextTick, ref, computed, watch } from 'vue';


let themeMedia = null;
function palette() {
  const dark = themeMedia?.matches ?? window.matchMedia('(prefers-color-scheme: dark)').matches;
  return dark
    ? { bg: '#101722', text: '#dbe5f2', grid: '#29394e', border: '#40516a', muted: '#a2b1c6', panel: '#182333', ability: '#9db9e5', cost: '#9ac8ae', time: '#c3a7e8' }
    : { bg: '#ffffff', text: '#465366', grid: '#e0e6ee', border: '#cbd5e1', muted: '#64748b', panel: '#ffffff', ability: '#7b9bc9', cost: '#7ba58b', time: '#a18bc5' };
}
async function applySystemTheme() {
  if (!ready || !chart.value) return;
  const p = palette();
  const patch = { paper_bgcolor: p.bg, plot_bgcolor: p.bg, 'font.color': p.text,
    hoverlabel: { bgcolor: p.panel, bordercolor: p.border, font: { color: p.text, size: 12 } } };
  const axes = [['scene.xaxis', p.ability], ['scene.yaxis', p.cost], ['scene.zaxis', p.time]];
  for (const [axis, color] of axes) {
    patch[axis + '.gridcolor'] = p.grid;
    patch[axis + '.linecolor'] = p.border;
    patch[axis + '.tickfont.color'] = color;
    patch[axis + '.title.font.color'] = color;
    patch[axis + '.color'] = color;
  }
  // Update presentation only: retain camera, axis ranges, and hidden models.
  await Plotly.relayout(chart.value, patch);
  await Plotly.restyle(chart.value, { 'marker.line.color': p.bg });
  await Plotly.restyle(chart.value, { 'marker.color': p.muted, 'marker.line.color': p.muted }, [chart.value.data.length - 1]);
  syncSceneState(getLiveCamera(), currentView.value);
}

const STORAGE_KEY = 'ai_model_chart_hidden_ids';

function getStoredHiddenIds() {
  if (typeof window === 'undefined' || !window.sessionStorage) return new Set();
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveStoredHiddenIds(idsSet) {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...idsSet]));
  } catch {}
}

function clearStoredHiddenIds() {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}

const chart = ref(null);
const failed = ref(false);
const updatedAt = ref(data.retrievedAt);
const updatedAtLabel = computed(() => {
  const date = new Date(updatedAt.value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
    : 'Unknown';
});
const searchQuery = ref('');
const searchOpen = ref(false);
const searchInput = ref(null);
let searchReturnFocus = null;
function closeSearch() {
  searchOpen.value = false;
  searchQuery.value = '';
  searchReturnFocus?.focus();
}
function trapSearchFocus(event) {
  const controls = [...event.currentTarget.querySelectorAll('input, button:not(:disabled)')];
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
async function handleSearchKey(event) {
  if (event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'Escape' && searchOpen.value) {
    event.preventDefault();
    closeSearch();
    return;
  }
  if (event.key !== '/' || event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  event.preventDefault();
  searchReturnFocus = document.activeElement;
  searchOpen.value = true;
  await nextTick();
  searchInput.value?.focus();
}
const searchData = ref(data.models);
const searchResults = computed(() => {
  // Split names at letter/number boundaries too: deep4.1 -> deep + 4.1.
  const words = searchQuery.value.normalize('NFKC').toLowerCase().match(/\p{L}+|\d+(?:\.\d+)*/gu) || [];
  if (!words.length) return [];
  return searchData.value.filter(model => words.every(word =>
    `${model.name} ${model.creator}`.normalize('NFKC').toLowerCase().includes(word)
  ));
});
const activeResult = ref(-1);
watch(searchResults, results => {
  activeResult.value = results.findIndex(canPlot);
});
async function handleResultKey(event) {
  if (event.isComposing || !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
  // Native Enter already activates focused result buttons.
  if (event.key === 'Enter' && event.target instanceof HTMLButtonElement) return;
  event.preventDefault();
  const available = searchResults.value.map((model, index) => canPlot(model) ? index : -1).filter(index => index >= 0);
  if (!available.length || !ready) return;
  if (event.key === 'Enter') {
    const model = searchResults.value[activeResult.value];
    if (model && canPlot(model)) await locateModel(model);
    return;
  }
  const current = available.indexOf(activeResult.value);
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  activeResult.value = available[(current + direction + available.length) % available.length];
  await nextTick();
  document.getElementById(`model-result-${activeResult.value}`)?.scrollIntoView({ block: 'nearest' });
}
const canPlot = model => [model.intelligence, model.cost, model.timeSeconds]
  .every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
const formatMetric = (value, digits = 2, prefix = '', suffix = '') =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `${prefix}${value.toFixed(digits)}${suffix}` : '—';
const formatReleaseDate = value =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value))
    ? value.slice(0, 10) : '—';
const missingMetrics = model => [
  ['intelligence', 'intelligence'], ['cost', 'cost'], ['timeSeconds', 'time']
].filter(([key]) => !(typeof model[key] === 'number' && Number.isFinite(model[key]) && model[key] >= 0))
  .map(([, label]) => label).join(', ');

async function locateModel(model) {
  if (!ready || !canPlot(model)) return;
  if (hiddenIds.value.has(model.id)) {
    const savedCamera = getLiveCamera();
    hiddenIds.value = new Set([...hiddenIds.value].filter(id => id !== model.id));
    saveStoredHiddenIds(hiddenIds.value);
    const layout = getLayout(false);
    layout.scene.camera = savedCamera;
    await Plotly.react(chart.value, createTraces(), layout, config);
    syncSceneState(savedCamera, currentView.value);
  }
  centerOnPoint({ x: model.intelligence, y: model.cost, z: model.timeSeconds / 60 });
  closeSearch();
}

const initialCamera = () => ({
  eye: { x: 1.65, y: 1.65, z: 1.1 },
  up: { x: 0, y: 0, z: 1 },
  center: { x: 0, y: 0, z: 0 },
  projection: { type: 'perspective' }
});
const currentView = ref('4');
const planeViews = {
  '1': { eye: { x: 0, y: 1.95, z: 0 }, up: { x: 0, y: 0, z: 1 }, hidden: 'yaxis', hiddenIdx: 1 },
  '2': { eye: { x: 1.95, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 }, hidden: 'xaxis', hiddenIdx: 0 },
  '3': { eye: { x: 0, y: 0, z: 1.95 }, up: { x: 0, y: -1, z: 0 }, hidden: 'zaxis', hiddenIdx: 2 }
};
const viewCamera = (view = currentView.value) => view === '4' ? initialCamera() : {
  eye: { ...planeViews[view].eye },
  up: { ...planeViews[view].up },
  center: { x: 0, y: 0, z: 0 },
  projection: { type: 'perspective' }
};

let orthoBlend = 0;
let animFrameId = null;

function installProjectionHook() {
  const sceneObj = chart.value?._fullLayout?.scene?._scene;
  const glplot = sceneObj?.glplot;
  if (!glplot?.cameraParams) return;
  if (sceneObj.camera) {
    sceneObj.camera.enableWheel = false;
  }
  if (!glplot.cameraParams._orthoHooked) {
    const rawProjection = glplot.cameraParams.projection;
    Object.defineProperty(glplot.cameraParams, '_orthoHooked', { value: true });
    Object.defineProperty(glplot.cameraParams, 'projection', {
      enumerable: true,
      configurable: true,
      get() {
        if (orthoBlend > 1e-4 && rawProjection[11] === -1 && rawProjection[15] === 0) {
          const cam = glplot.camera;
          const d = cam?.distance || Math.hypot(
            (cam?.eye?.[0] ?? 1.65) - (cam?.center?.[0] ?? 0),
            (cam?.eye?.[1] ?? 1.65) - (cam?.center?.[1] ?? 0),
            (cam?.eye?.[2] ?? 1.1) - (cam?.center?.[2] ?? 0)
          ) || 1.95;
          const a = orthoBlend;
          rawProjection[10] = (1 - a) * rawProjection[10] - 0.1 * a;
          rawProjection[11] = -(1 - a);
          rawProjection[14] = (1 - a) * rawProjection[14] - 0.1 * a * d;
          rawProjection[15] = a * d;
        }
        return rawProjection;
      }
    });
  }
  const axes = glplot.axes;
  if (axes && !axes._planeDrawHooked) {
    Object.defineProperty(axes, '_planeDrawHooked', { value: true });
    const origAxesDraw = axes.draw.bind(axes);
    axes.draw = function (cameraParams) {
      if (axes._lines && !axes._lines._planeHooked) {
        const linesObj = axes._lines;
        const origDrawAxisTicks = linesObj.drawAxisTicks.bind(linesObj);
        Object.defineProperty(linesObj, '_planeHooked', { value: true });
        linesObj.drawAxisTicks = function (axisIdx, offset, tickVec, color, width) {
          const hIdx = planeViews[currentView.value]?.hiddenIdx;
          if (orthoBlend > 0.7 && hIdx !== undefined && axisIdx !== hIdx) {
            const pIdx = 3 - axisIdx - hIdx;
            const b0 = axes.bounds[0][pIdx];
            const b1 = axes.bounds[1][pIdx];
            const useHigh = currentView.value === '3' || (currentView.value === '1' && pIdx === 0);
            const adjOffset = [offset[0], offset[1], offset[2]];
            adjOffset[pIdx] = useHigh ? b1 : b0;
            const len = Math.hypot(tickVec[0], tickVec[1], tickVec[2]);
            const adjTick = [0, 0, 0];
            adjTick[pIdx] = (useHigh ? 1 : -1) * len;
            return origDrawAxisTicks(axisIdx, adjOffset, adjTick, color, width);
          }
          return origDrawAxisTicks(axisIdx, offset, tickVec, color, width);
        };
      }
      return origAxesDraw(cameraParams);
    };
  }
  if (axes?._text && !axes._text._planeHooked) {
    const textObj = axes._text;
    const origDrawTicks = textObj.drawTicks.bind(textObj);
    const origDrawLabel = textObj.drawLabel.bind(textObj);
    Object.defineProperty(textObj, '_planeHooked', { value: true });

    const getDistanceRatio = () => {
      const cam = glplot.camera;
      const d = cam?.distance || Math.hypot(
        (cam?.eye?.[0] ?? 1.65) - (cam?.center?.[0] ?? 0),
        (cam?.eye?.[1] ?? 1.65) - (cam?.center?.[1] ?? 0),
        (cam?.eye?.[2] ?? 1.1) - (cam?.center?.[2] ?? 0)
      ) || 1.95;
      return d / 1.95;
    };

    const getPlaneEdge = (axisIdx, hIdx, axesBounds) => {
      const pIdx = 3 - axisIdx - hIdx;
      const b0 = axesBounds[0][pIdx];
      const b1 = axesBounds[1][pIdx];
      const span = (b1 - b0) || 1;
      // Place horizontal axis on bottom edge and vertical axis on left edge for all 3 faces.
      const useHigh = currentView.value === '3' || (currentView.value === '1' && pIdx === 0);
      const edge = useHigh ? b1 : b0;
      const sign = useHigh ? 1 : -1;
      return { pIdx, edge, sign, span };
    };

    textObj.drawTicks = function (axisIdx, scale, angle, offset, color, axisVec, alignDir, alignOpt) {
      const hIdx = planeViews[currentView.value]?.hiddenIdx;
      if (orthoBlend > 0.7 && hIdx !== undefined && axisIdx !== hIdx) {
        const { pIdx, edge, sign, span } = getPlaneEdge(axisIdx, hIdx, axes.bounds);
        const adjOffset = [offset[0], offset[1], offset[2]];
        adjOffset[pIdx] = edge + sign * span * 0.042 * getDistanceRatio();
        return origDrawTicks(axisIdx, scale, angle, adjOffset, color, axisVec, [0, 0, 0], [0, 0.5, 1]);
      }
      return origDrawTicks(axisIdx, scale, angle, offset, color, axisVec, alignDir, alignOpt);
    };

    textObj.drawLabel = function (axisIdx, scale, angle, offset, color, axisVec, alignDir, alignOpt) {
      const hIdx = planeViews[currentView.value]?.hiddenIdx;
      if (orthoBlend > 0.7 && hIdx !== undefined && axisIdx !== hIdx) {
        const { pIdx, edge, sign, span } = getPlaneEdge(axisIdx, hIdx, axes.bounds);
        const adjOffset = [offset[0], offset[1], offset[2]];
        adjOffset[pIdx] = edge + sign * span * 0.115 * getDistanceRatio();
        const dir = [0, 0, 0];
        dir[axisIdx] = 1;
        return origDrawLabel(axisIdx, scale, angle, adjOffset, color, axisVec, dir, [0, 0.5, 1]);
      }
      return origDrawLabel(axisIdx, scale, angle, offset, color, axisVec, alignDir, alignOpt);
    };
  }
}

function getLiveCamera() {
  const sceneObj = chart.value?._fullLayout?.scene?._scene;
  if (sceneObj?.getCamera) {
    const cam = sceneObj.getCamera();
    return {
      eye: { ...cam.eye },
      center: { ...(cam.center || { x: 0, y: 0, z: 0 }) },
      up: { ...cam.up },
      projection: { type: 'perspective' }
    };
  }
  const fallback = chart.value?._fullLayout?.scene?.camera ?? viewCamera();
  return {
    eye: { ...fallback.eye },
    center: { ...(fallback.center || { x: 0, y: 0, z: 0 }) },
    up: { ...fallback.up },
    projection: { type: 'perspective' }
  };
}

function cancelCameraAnimation() {
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

const vecSub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const vecDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vecCross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const vecNorm = v => {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-8 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1];
};
function orthoUp(upVec, dirVec) {
  const dot = vecDot(upVec, dirVec);
  const proj = [upVec[0] - dot * dirVec[0], upVec[1] - dot * dirVec[1], upVec[2] - dot * dirVec[2]];
  const len = Math.hypot(proj[0], proj[1], proj[2]);
  if (len > 1e-6) return [proj[0] / len, proj[1] / len, proj[2] / len];
  const fallback = Math.abs(dirVec[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  return orthoUp(fallback, dirVec);
}
function rotateAroundAxis(v, axis, angle) {
  if (Math.abs(angle) < 1e-8) return v;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kDotV = vecDot(axis, v);
  const kCrossV = vecCross(axis, v);
  return [
    v[0] * c + kCrossV[0] * s + axis[0] * kDotV * (1 - c),
    v[1] * c + kCrossV[1] * s + axis[1] * kDotV * (1 - c),
    v[2] * c + kCrossV[2] * s + axis[2] * kDotV * (1 - c)
  ];
}

function interpolateCamera(from, to, t) {
  const center = {
    x: from.center.x + (to.center.x - from.center.x) * t,
    y: from.center.y + (to.center.y - from.center.y) * t,
    z: from.center.z + (to.center.z - from.center.z) * t
  };
  const v0 = vecSub(from.eye, from.center);
  const v1 = vecSub(to.eye, to.center);
  const r0 = Math.hypot(...v0) || 1.9;
  const r1 = Math.hypot(...v1) || 1.9;
  const radius = r0 + (r1 - r0) * t;

  const d0 = [v0[0] / r0, v0[1] / r0, v0[2] / r0];
  const d1 = [v1[0] / r1, v1[1] / r1, v1[2] / r1];
  const cosOmega = Math.max(-1, Math.min(1, vecDot(d0, d1)));
  let omega = Math.acos(cosOmega);
  let rotAxis = vecCross(d0, d1);
  const axisLen = Math.hypot(...rotAxis);
  if (axisLen > 1e-6) {
    rotAxis = [rotAxis[0] / axisLen, rotAxis[1] / axisLen, rotAxis[2] / axisLen];
  } else if (cosOmega < 0) {
    rotAxis = orthoUp([0, 0, 1], d0);
    omega = Math.PI;
  } else {
    rotAxis = [0, 0, 1];
    omega = 0;
  }

  const dir = rotateAroundAxis(d0, rotAxis, omega * t);
  const u0 = orthoUp([from.up.x, from.up.y, from.up.z], d0);
  const u1 = orthoUp([to.up.x, to.up.y, to.up.z], d1);
  // Parallel-transport u0 along the sightline arc to d1, then measure twist angle to u1.
  const u0AtEnd = orthoUp(rotateAroundAxis(u0, rotAxis, omega), d1);
  const twistCos = Math.max(-1, Math.min(1, vecDot(u0AtEnd, u1)));
  const twistSin = vecDot(d1, vecCross(u0AtEnd, u1));
  const twistAngle = Math.atan2(twistSin, twistCos);
  const uCarried = rotateAroundAxis(u0, rotAxis, omega * t);
  const upArr = vecNorm(rotateAroundAxis(uCarried, dir, twistAngle * t));

  return {
    center,
    eye: {
      x: center.x + dir[0] * radius,
      y: center.y + dir[1] * radius,
      z: center.z + dir[2] * radius
    },
    up: { x: upArr[0], y: upArr[1], z: upArr[2] },
    projection: { type: 'perspective' }
  };
}

function applyLiveCamera(cam, blend) {
  orthoBlend = blend;
  const sceneObj = chart.value?._fullLayout?.scene?._scene;
  if (!sceneObj?.camera || !sceneObj?.glplot) return;
  installProjectionHook();
  sceneObj.camera.lookAt(
    [cam.eye.x, cam.eye.y, cam.eye.z],
    [cam.center.x, cam.center.y, cam.center.z],
    [cam.up.x, cam.up.y, cam.up.z]
  );
  sceneObj.glplot.redraw();
}

function setHiddenAxis(hiddenIdx = null) {
  const sceneObj = chart.value?._fullLayout?.scene?._scene;
  if (!sceneObj?.axesOptions) return;
  for (let i = 0; i < 3; i++) {
    const show = i !== hiddenIdx;
    sceneObj.axesOptions.tickEnable[i] = show;
    sceneObj.axesOptions.labelEnable[i] = show;
    sceneObj.axesOptions.gridEnable[i] = show;
  }
}

function setDragMode(view = currentView.value) {
  const isOrbit = view === '4';
  const fullScene = chart.value?._fullLayout?.scene;
  if (fullScene) {
    fullScene.dragmode = isOrbit ? 'orbit' : 'pan';
    if (fullScene._scene?.camera) {
      fullScene._scene.camera.keyBindingMode = isOrbit ? 'rotate' : 'pan';
    }
  }
  if (chart.value?.layout?.scene) {
    chart.value.layout.scene.dragmode = isOrbit ? 'orbit' : 'pan';
  }
}

function syncSceneState(cam, view = currentView.value) {
  if (!chart.value) return;
  const hiddenIdx = planeViews[view]?.hiddenIdx ?? null;
  setHiddenAxis(hiddenIdx);
  setDragMode(view);
  if (chart.value.layout?.scene) {
    chart.value.layout.scene.camera = structuredClone(cam);
  }
  if (chart.value._fullLayout?.scene) {
    chart.value._fullLayout.scene.camera = structuredClone(cam);
  }
  installProjectionHook();
  sceneRedraw();
}

function sceneRedraw() {
  chart.value?._fullLayout?.scene?._scene?.glplot?.redraw();
}

function animateCamera(targetCam, { targetOrtho = orthoBlend, duration = 420, dipOrtho = false, onComplete } = {}) {
  cancelCameraAnimation();
  const startCam = getLiveCamera();
  const startOrtho = orthoBlend;
  const startTime = performance.now();

  const step = (now) => {
    const raw = Math.min(1, (now - startTime) / duration);
    // Smooth easeInOutCubic
    const t = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
    const frameCam = interpolateCamera(startCam, targetCam, t);
    let frameOrtho = startOrtho + (targetOrtho - startOrtho) * t;
    if (dipOrtho && startOrtho > 0.5 && targetOrtho > 0.5) {
      frameOrtho = 1 - 0.35 * Math.sin(Math.PI * t);
    }
    applyLiveCamera(frameCam, frameOrtho);

    if (raw < 1) {
      animFrameId = requestAnimationFrame(step);
    } else {
      animFrameId = null;
      applyLiveCamera(targetCam, targetOrtho);
      onComplete?.(targetCam);
    }
  };

  animFrameId = requestAnimationFrame(step);
}

async function switchToView(targetView) {
  if (!ready || !chart.value) return;
  clearHover();
  const previousView = currentView.value;
  currentView.value = targetView;
  const targetCam = viewCamera(targetView);
  const targetOrtho = targetView === '4' ? 0 : 1;

  // Show all 3 axes during rotation so the 3D cube frame is visible while turning.
  setHiddenAxis(null);
  setDragMode(targetView);

  animateCamera(targetCam, {
    targetOrtho,
    duration: 420,
    dipOrtho: previousView !== '4' && targetView !== '4' && previousView !== targetView,
    onComplete: (finalCam) => {
      syncSceneState(finalCam, targetView);
      clearHover();
    }
  });
}

async function handleViewKey(event) {
  if (!['1', '2', '3', '4'].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing || searchOpen.value) return;
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  if (!ready || !chart.value) return;
  event.preventDefault();
  await switchToView(event.key);
}
let ready = false;
let hoveredModelId = null;
let hoveredPoint = null;

function clearHover() {
  // Clear Plotly's rendered tooltip.
  if (chart.value) {
    Plotly.Fx.unhover(chart.value);
    // Fx.unhover handles Cartesian plots; gl3d owns a separate SVG layer.
    chart.value.querySelectorAll('.hovertext').forEach(label => label.remove());
  }
  hoveredModelId = null;
  hoveredPoint = null;
}

const hiddenIds = ref(getStoredHiddenIds());
const hiddenCount = computed(() => hiddenIds.value.size);

let models = data.models.filter(m => [m.intelligence, m.cost, m.timeSeconds].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0));
let providers = [...new Set(models.map(m => m.creator))].sort();
const colors = {
  OpenAI: '#25805c',
  Anthropic: '#c16e47',
  Meta: '#1877d2',
  Google: '#9366ce',
  NVIDIA: '#659626',
  SpaceXAI: '#6d5abe',
  'Institute of Foundation Models': '#405cc5'
};
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function modelRange(key, scale = 1) {
  const maximum = Math.max(0, ...models.filter(model => !hiddenIds.value.has(model.id)).map(model => model[key] / scale));
  if (!maximum) return [0, 1];
  const roughStep = maximum / 8;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const step = [1, 2, 5, 10].find(value => value * magnitude >= roughStep) * magnitude;
  return [0, Math.ceil(maximum / step) * step];
}

const axis = (title, range, color, hideZero = false, prefix = '') => {
  const rough = range[1] / 8;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find(value => value * magnitude >= rough) * magnitude;
  const ticks = Array.from({ length: Math.round(range[1] / step) + 1 }, (_, index) => index * step);
  return ({
    title: { text: title, font: { size: 13, color } },
    gridcolor: palette().grid,
    zeroline: false,
    linecolor: palette().border,
    showbackground: false,
    tickfont: { size: 11, color },
    color,
    showline: false,
    linewidth: 1,
    showspikes: false,
    tickmode: 'array',
    tickvals: ticks,
    ticktext: ticks.map(value => hideZero && value === 0 ? '' : `${prefix}${value}`),
    autorange: false,
    range
  });
};

function createTraces() {
  const currentHidden = hiddenIds.value;
  const traces = providers.map(provider => {
    const group = models.filter(m => m.creator === provider && !currentHidden.has(m.id));
    return {
      type: 'scatter3d',
      mode: 'markers',
      name: provider,
      x: group.map(m => m.intelligence),
      y: group.map(m => m.cost),
      z: group.map(m => m.timeSeconds / 60),
      text: group.map(m => escape(m.name)),
      hovertext: group.map(m => formatReleaseDate(m.releaseDate)),
      customdata: group.map(m => m.id),
      marker: {
        size: group.map(() => 5),
        color: colors[provider] || (group[0] && group[0].color),
        opacity: 0.9,
        line: { color: palette().bg, width: 0.6 }
      },
      hovertemplate:
        '<b>%{text}</b><br>Provider: ' + escape(provider) +
        '<br>Intelligence Index: %{x:.2f}<br>Cost per Task: $%{y:.4f}<br>Time per Task: %{z:.2f} min<br>Release date: %{hovertext}<br><span style="color:#94a3b8;font-size:11px;">Double-click to center · Right-click to hide</span><extra></extra>'
    };
  });
  traces.push({
    type: 'scatter3d',
    mode: 'markers',
    x: [modelRange('intelligence')[1], modelRange('intelligence')[1]],
    y: [0, 0],
    z: [0, 0],
    marker: {
      symbol: ['circle-open', 'circle'],
      size: [4, 1.2],
      color: palette().muted,
      line: { color: palette().muted, width: 1 }
    },
    hoverinfo: 'skip',
    showlegend: false
  });
  return traces;
}

const config = { responsive: true, displayModeBar: false, scrollZoom: false, doubleClick: false };

const getLayout = (resetCamera = false) => ({
  paper_bgcolor: palette().bg,
  plot_bgcolor: palette().bg,
  font: { family: 'Segoe UI, Microsoft YaHei, sans-serif', color: palette().text },
  margin: { l: 20, r: 20, t: 20, b: 20 },
  showlegend: false,
  uirevision: resetCamera ? Date.now() : (chart.value?.layout?.uirevision ?? 'model-chart-camera'),
  scene: {
    xaxis: axis('X · Intelligence Index', modelRange('intelligence'), palette().ability),
    yaxis: axis('Y · Cost per Task (USD)', modelRange('cost'), palette().cost, true, '$'),
    zaxis: axis('Z · Time per Task (min)', modelRange('timeSeconds', 60), palette().time, true),
    aspectmode: 'cube',
    camera: resetCamera ? viewCamera() : getLiveCamera(),
    dragmode: currentView.value === '4' ? 'orbit' : 'pan'
  },
  hoverlabel: { bgcolor: palette().panel, bordercolor: palette().border, font: { color: palette().text, size: 12 } }
});

async function hideModel(id) {
  if (!id || !ready || !chart.value) return;
  cancelCameraAnimation();
  const savedCamera = getLiveCamera();
  hiddenIds.value = new Set([...hiddenIds.value, id]);
  saveStoredHiddenIds(hiddenIds.value);
  clearHover();
  const layout = getLayout(false);
  layout.scene.camera = savedCamera;
  await Plotly.react(chart.value, createTraces(), layout, config).catch(console.error);
  syncSceneState(savedCamera, currentView.value);
  clearHover();
}

function pointToScene(pt) {
  const scene = chart.value?._fullLayout?.scene;
  const xr = modelRange('intelligence');
  const yr = modelRange('cost');
  const zr = modelRange('timeSeconds', 60);
  // Plotly maps each axis into a centered scene cube before applying the camera.
  const toScene = (range, value, aspect = 1) =>
    ((value - range[0]) / (range[1] - range[0]) - 0.5) * aspect;
  return {
    x: toScene(xr, pt.x, scene?.aspectratio?.x),
    y: toScene(yr, pt.y, scene?.aspectratio?.y),
    z: toScene(zr, pt.z, scene?.aspectratio?.z)
  };
}

function centerOnPoint(pt) {
  if (!pt || !ready || !chart.value) return;
  const center = pointToScene(pt);
  if (!Object.values(center).every(Number.isFinite)) return;

  const camera = getLiveCamera();
  const previousCenter = camera.center || { x: 0, y: 0, z: 0 };
  const eye = Object.fromEntries(['x', 'y', 'z'].map(key => [
    key, camera.eye[key] + center[key] - previousCenter[key]
  ]));
  const targetCam = { up: { ...camera.up }, projection: { type: 'perspective' }, center, eye };

  animateCamera(targetCam, {
    targetOrtho: currentView.value === '4' ? 0 : 1,
    duration: 360,
    onComplete: (finalCam) => {
      syncSceneState(finalCam, currentView.value);
    }
  });
}

function handleWheel(event) {
  if (!ready || !chart.value || searchOpen.value) return;
  const sceneObj = chart.value._fullLayout?.scene?._scene;
  const glplot = sceneObj?.glplot;
  const canvas = glplot?.canvas || chart.value;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  event.preventDefault();
  cancelCameraAnimation();

  const xNdc = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const yNdc = 1 - ((event.clientY - rect.top) / rect.height) * 2;
  const delta = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaMode === 2 ? event.deltaY * 300 : event.deltaY;
  const zoomFactor = Math.exp(Math.max(-0.5, Math.min(0.5, delta * 0.0012)));

  const cam = getLiveCamera();
  const v = vecSub(cam.eye, cam.center);
  const d = Math.hypot(...v) || 1.95;
  const dNew = Math.max(0.15, Math.min(12, d * zoomFactor));
  const s = dNew / d;

  const b = [v[0] / d, v[1] / d, v[2] / d];
  const u = orthoUp([cam.up.x, cam.up.y, cam.up.z], b);
  const r = vecCross(u, b);

  const fovy = glplot?.fovy || Math.PI / 4;
  const halfTan = Math.tan(fovy / 2);
  const aspect = rect.width / rect.height;

  let refDepth = d;
  if (orthoBlend < 0.5 && hoveredPoint) {
    const ptScene = pointToScene(hoveredPoint);
    const toEye = vecSub(cam.eye, ptScene);
    const ptDepth = vecDot(toEye, b);
    if (Number.isFinite(ptDepth) && ptDepth > 0.05) {
      refDepth = Math.max(0.2 * d, Math.min(2.5 * d, ptDepth));
    }
  }

  const xCam = xNdc * refDepth * aspect * halfTan;
  const yCam = yNdc * refDepth * halfTan;
  const move = 1 - s;

  const nextCenter = {
    x: cam.center.x + move * (xCam * r[0] + yCam * u[0]),
    y: cam.center.y + move * (xCam * r[1] + yCam * u[1]),
    z: cam.center.z + move * (xCam * r[2] + yCam * u[2])
  };
  const nextEye = {
    x: nextCenter.x + b[0] * dNew,
    y: nextCenter.y + b[1] * dNew,
    z: nextCenter.z + b[2] * dNew
  };
  const nextCam = {
    center: nextCenter,
    eye: nextEye,
    up: cam.up,
    projection: { type: 'perspective' }
  };

  applyLiveCamera(nextCam, orthoBlend);
  if (chart.value.layout?.scene) chart.value.layout.scene.camera = structuredClone(nextCam);
  if (chart.value._fullLayout?.scene) chart.value._fullLayout.scene.camera = structuredClone(nextCam);
}

async function resetView(event) {
  if (event) {
    if (event.key.toLowerCase() !== 'r' || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing || searchOpen.value) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  }
  if (!ready || !chart.value) return;

  clearHover();
  await switchToView(currentView.value);
}

async function resetAll() {
  if (!ready || !chart.value) return;
  cancelCameraAnimation();
  const currentCam = getLiveCamera();
  hiddenIds.value = new Set();
  clearStoredHiddenIds();
  clearHover();
  const layout = getLayout(false);
  layout.scene.camera = currentCam;
  await Plotly.react(chart.value, createTraces(), layout, config).catch(console.error);
  installProjectionHook();
  await switchToView(currentView.value);
}

function handleContextMenu(event) {
  event.preventDefault();
  if (hoveredModelId) {
    hideModel(hoveredModelId);
  }
}

function handleDblClick(event) {
  if (event) event.preventDefault();
  if (hoveredPoint) {
    centerOnPoint(hoveredPoint);
  }
}

onMounted(async () => {
  await nextTick();
  themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  themeMedia.addEventListener('change', handleThemeChange);
  try {
    try {
      const response = await fetch('/api/data', { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Data HTTP ${response.status}`);
      const latest = await response.json();
      if (!Array.isArray(latest.models) || latest.models.length < 100) throw new Error('Invalid model data');
      const knownDates = new Map(fallbackData.models.map(model => [model.id, model.releaseDate]));
      data = { ...latest, models: latest.models.map(model => ({ ...model, releaseDate: model.releaseDate ?? knownDates.get(model.id) ?? null })) };
      searchData.value = data.models;
      updatedAt.value = data.retrievedAt;
      models = data.models.filter(m => [m.intelligence, m.cost, m.timeSeconds].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0));
      providers = [...new Set(models.map(m => m.creator))].sort();
    } catch (error) {
      console.warn('Using bundled model snapshot', error);
    }
    await Plotly.newPlot(chart.value, createTraces(), { ...getLayout(true), camera: initialCamera() }, config);
    installProjectionHook();
    ready = true;

    chart.value.on('plotly_hover', (eventData) => {
      if (eventData?.points?.length) {
        const p = eventData.points[0];
        hoveredModelId = p.customdata;
        const model = models.find(model => model.id === p.customdata);
        hoveredPoint = model ? { x: model.intelligence, y: model.cost, z: model.timeSeconds / 60 } : null;
      }
    });

    chart.value.on('plotly_unhover', () => {
      hoveredModelId = null;
      hoveredPoint = null;
    });

    chart.value.on('plotly_click', (eventData) => {
      if (eventData?.points?.length) {
        const p = eventData.points[0];
        hoveredModelId = p.customdata;
        const model = models.find(model => model.id === p.customdata);
        hoveredPoint = model ? { x: model.intelligence, y: model.cost, z: model.timeSeconds / 60 } : null;
      }
    });

    chart.value.on('plotly_doubleclick', () => false);

    chart.value.addEventListener('dblclick', handleDblClick);
    chart.value.addEventListener('contextmenu', handleContextMenu);
    chart.value.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('keydown', resetView);
    window.addEventListener('keydown', handleSearchKey);
    window.addEventListener('keydown', handleViewKey);
  } catch (error) {
    failed.value = true;
    console.error(error);
  }
});

function handleThemeChange() {
  applySystemTheme().catch(console.error);
}

onBeforeUnmount(() => {
  cancelCameraAnimation();
  themeMedia?.removeEventListener('change', handleThemeChange);
  ready = false;
  window.removeEventListener('keydown', resetView);
  window.removeEventListener('keydown', handleSearchKey);
  window.removeEventListener('keydown', handleViewKey);
  if (chart.value) {
    chart.value.removeEventListener('dblclick', handleDblClick);
    chart.value.removeEventListener('contextmenu', handleContextMenu);
    chart.value.removeEventListener('wheel', handleWheel);
    Plotly.purge(chart.value);
  }
});
</script>

<template>
  <main aria-label="AI Model 3D Chart">
    <div v-if="searchOpen" class="search-overlay" @click.self="closeSearch">
    <section class="model-search" role="dialog" aria-modal="true" aria-label="Model search" @keydown.tab="trapSearchFocus" @keydown="handleResultKey">
      <input ref="searchInput" v-model="searchQuery" type="search" aria-label="Search models" placeholder="Search models, e.g. 6.1 sol high" autocomplete="off" aria-controls="model-search-results" :aria-activedescendant="activeResult >= 0 ? `model-result-${activeResult}` : undefined" />
      <p class="search-help">↑↓ Select · Enter Locate · Esc Close</p>
      <div v-if="searchQuery.trim()" class="search-results" aria-live="polite">
        <p class="search-summary">{{ searchResults.length ? `${searchResults.length} models found` : 'No matching models' }}</p>
        <ul id="model-search-results">
          <li v-for="(model, index) in searchResults" :key="model.id">
            <button :id="`model-result-${index}`" type="button" :class="{ 'active-result': activeResult === index }" @focus="activeResult = index" @mouseenter="canPlot(model) && (activeResult = index)" :disabled="!ready || !canPlot(model)" @click="locateModel(model)">
              <strong>{{ model.name }}</strong>
              <small>Release date: {{ formatReleaseDate(model.releaseDate) }}</small>
              <span class="result-metrics">
                <span>Intelligence <b>{{ formatMetric(model.intelligence) }}</b></span>
                <span>Cost <b>{{ formatMetric(model.cost, 4, '$') }}</b></span>
                <span>Time <b>{{ formatMetric(typeof model.timeSeconds === 'number' ? model.timeSeconds / 60 : null, 2, '', ' min') }}</b></span>
              </span>
              <small>{{ model.creator }} · {{ canPlot(model) ? (hiddenIds.has(model.id) ? 'Show and locate' : 'Locate in chart') : `Missing ${missingMetrics(model)}; cannot locate` }}</small>
            </button>
          </li>
        </ul>
      </div>
    </section>
    </div>
    <p class="usage-help"><span>/ Search · Double-click Center · Right-click Hide · R Reset view</span><span>1, 2, 3, 4 Switch views</span></p>
    <p class="update-time">Last updated: <time :datetime="updatedAt">{{ updatedAtLabel }}</time> (UTC+8)</p>
    <div id="chart" :ref="el => chart = el" aria-label="X: Intelligence Index; Y: Cost per Task (USD); Z: Time per Task (min)" />
    <div v-if="hiddenCount > 0" id="reset-tip" @click="resetAll()">
      {{ hiddenCount }} models hidden · <span class="action">Click to show all and reset view</span>
    </div>
    <p v-if="failed" id="error" role="alert">Chart failed to load. Check that WebGL is enabled and refresh.</p>
  </main>
</template>

<style scoped>
.search-overlay { position: fixed; inset: 0; z-index: 20; background: #ffffff66; display: flex; justify-content: center; align-items: flex-start; padding-top: min(18vh, 120px); }
.model-search { width: min(420px, calc(100vw - 36px)); font-size: 13px; padding: 12px; border: 1px solid #e2e8f0; border-radius: 12px; background: #fff; box-shadow: 0 16px 48px #0f172a14; }
.search-help { margin: 10px 2px 0; font-size: 11px; color: #64748b; }
.usage-help { position: absolute; left: 18px; bottom: 14px; z-index: 10; margin: 0; max-width: calc(100vw - 36px); display: flex; flex-wrap: wrap; gap: 4px 16px; color: #7b8797; font-size: 11px; line-height: 1.7; pointer-events: none; }
.update-time { position: absolute; right: 18px; bottom: 14px; z-index: 10; margin: 0; color: #7b8797; font-size: 11px; line-height: 1.7; pointer-events: none; }
@media (max-width: 1000px) { .usage-help { bottom: 36px; } }
.model-search input { box-sizing: border-box; width: 100%; padding: 10px 12px; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; color: #334155; font: inherit; box-shadow: 0 2px 8px #0000000a; }
.model-search input:focus { outline: 2px solid #93c5fd; outline-offset: 1px; }
.search-results { margin-top: 6px; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; box-shadow: 0 8px 24px #00000014; max-height: min(420px, 65vh); overflow: auto; }
.search-summary { margin: 0; padding: 10px 12px; color: #64748b; }
.search-results ul { list-style: none; margin: 0; padding: 0; }
.search-results button { display: block; width: 100%; padding: 10px 12px; border: 0; border-top: 1px solid #f1f5f9; background: white; text-align: left; cursor: pointer; color: #334155; font: inherit; }
.search-results button.active-result, .search-results button:hover, .search-results button:focus-visible { background: #eff6ff; }
.search-results button:disabled { color: #94a3b8; cursor: default; }
.search-results strong, .search-results small { display: block; }
.result-metrics { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 7px; color: #64748b; font-size: 11px; font-variant-numeric: tabular-nums; }
.result-metrics b { font-weight: 500; color: #475569; }
.search-results button:disabled .result-metrics, .search-results button:disabled .result-metrics b { color: #94a3b8; }
.search-results small { margin-top: 4px; font-size: 11px; }

#reset-tip {
  position: absolute;
  top: 16px;
  right: 18px;
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 12px;
  color: #64748b;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  cursor: pointer;
  user-select: none;
  backdrop-filter: blur(4px);
  transition: all 0.2s ease;
  z-index: 10;
}
#reset-tip:hover {
  background: #ffffff;
  border-color: #cbd5e1;
  color: #334155;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
}
#reset-tip .action {
  color: #2563eb;
  font-weight: 500;
}
@media (prefers-color-scheme: dark) {
  .search-overlay { background: #00000066; }
  .model-search, .search-results, .model-search input, .search-results button, #reset-tip {
    background: #182333; color: #dbe5f2; border-color: #40516a;
  }
  .search-help, .search-summary, .usage-help, .update-time, .result-metrics { color: #a2b1c6; }
  .result-metrics b { color: #dbe5f2; }
  .search-results button.active-result, .search-results button:hover, .search-results button:focus-visible, #reset-tip:hover { background: #24374e; color: #dbe5f2; }
  .search-results button:disabled, .search-results button:disabled .result-metrics, .search-results button:disabled .result-metrics b { color: #8595aa; }
  #reset-tip .action { color: #93c5fd; }
}
</style>
