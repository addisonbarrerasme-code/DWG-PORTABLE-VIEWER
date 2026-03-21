// Canvas viewer state
let canvas;
let ctx;
let currentZoom = 1;
let panX = 0;
let panY = 0;
let layerColorMap = {}; // layer name (uppercase) -> color/visibility/linetype metadata
let layerOverrides = {}; // layer name (uppercase) -> user overrides
let isPanning = false;
let isDraggingPan = false;
let panDragStart = null;
let measureMode = false;
let measureStart = null;
let measureCurrent = null;
let entities = [];
let bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
let viewportWidth = 0;
let viewportHeight = 0;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 500;
let selectedEntityIds = [];
let activeSnap = null;
let clickDownWorld = null;
let clickDownScreen = null;
let marqueeZoomMode = false;
let isMarqueeZooming = false;
let marqueeStartScreen = null;
let marqueeCurrentScreen = null;
let hoveredEntity = null;
let nextEntityId = 1;
let drawingUnitLabel = 'drawing units';
let drawingUnitCode = null;
let snapCache = [];
let snapCacheDirty = true;
let backgroundColor = '#ffffff';
let showEntityColors = true;
let showAnnotations = true;
let showHatches = true;
let lastConversionStats = null;
let automationConfig = null;
let ignoredEntityTypes = new Set();
let currentParseSource = 'unknown';
let currentSpaceView = 'model';
let parseCache = null;
let currentReaderProfile = {
  name: 'fidelity',
  readModelSpace: true,
  readPaperSpace: false,
  respectLayerVisibility: true,
  readVisibleAttributesAsText: true,
  readProxyEntityGraphics: true,
  preserveComplexHatches: true,
  readExternalReferences: false
};
let redrawScheduled = false;
let adaptedColorCache = new Map();
let imageAssetCache = new Map();
let resolveAutomationReady = null;
const automationReady = new Promise((resolve) => {
  resolveAutomationReady = resolve;
});

async function waitForAutomationConfig(timeoutMs = 1500) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([automationReady, timeout]);
  if (timer) clearTimeout(timer);
}

function unitsLabel() {
  return drawingUnitLabel || 'drawing units';
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initializeUI();
  setupDragDrop();
  window.electronAPI.getAutomationConfig()
    .then((cfg) => {
      automationConfig = cfg;
      ignoredEntityTypes = new Set((cfg?.ignoreTypes || []).map((t) => String(t).toUpperCase()));
      if (cfg?.enabled) {
        console.log('[automation] enabled:', cfg);
      }
      if (resolveAutomationReady) resolveAutomationReady(true);
    })
    .catch(() => {
      automationConfig = { enabled: false };
      ignoredEntityTypes = new Set();
      if (resolveAutomationReady) resolveAutomationReady(false);
    });
  window.electronAPI.onFileSelected((filePath) => {
    console.log('file selected via menu:', filePath);
    loadFile(filePath);
  });
});

function initializeUI() {
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext('2d');

  const setInteractionMode = (mode) => {
    isPanning = mode === 'pan';
    measureMode = mode === 'measure';
    marqueeZoomMode = mode === 'marquee';
    if (!measureMode) {
      measureStart = null;
      measureCurrent = null;
      activeSnap = null;
    }
    isDraggingPan = false;
    panDragStart = null;
    document.getElementById('panBtn')?.classList.toggle('active', isPanning);
    document.getElementById('measureBtn')?.classList.toggle('active', measureMode);
    document.getElementById('marqueeZoomBtn')?.classList.toggle('active', marqueeZoomMode);
    redraw();
  };

  const cancelMarquee = () => {
    isMarqueeZooming = false;
    marqueeStartScreen = null;
    marqueeCurrentScreen = null;
  };

  // Button handlers
  document.getElementById('openBtn')?.addEventListener('click', async () => {
    console.log('open button clicked, requesting file dialog');
    const res = await window.electronAPI.requestOpenFile();
    console.log('dialog result', res);
  });

  document.getElementById('zoomInBtn')?.addEventListener('click', () => {
    zoomAt(viewportWidth / 2, viewportHeight / 2, 1.2);
  });

  document.getElementById('zoomOutBtn')?.addEventListener('click', () => {
    zoomAt(viewportWidth / 2, viewportHeight / 2, 1 / 1.2);
  });

  document.getElementById('fitBtn')?.addEventListener('click', () => {
    fitToView();
  });

  document.getElementById('panBtn')?.addEventListener('click', (e) => {
    if (isPanning) {
      setInteractionMode('none');
    } else {
      setInteractionMode('pan');
    }
  });

  document.getElementById('marqueeZoomBtn')?.addEventListener('click', () => {
    if (marqueeZoomMode) {
      cancelMarquee();
      setInteractionMode('none');
    } else {
      setInteractionMode('marquee');
    }
  });

  document.getElementById('measureBtn')?.addEventListener('click', () => {
    if (measureMode) {
      setInteractionMode('none');
    } else {
      setInteractionMode('measure');
    }
  });

  const bgInput = document.getElementById('bgColorInput');
  bgInput?.addEventListener('input', (e) => {
    backgroundColor = e.target.value || '#ffffff';
    clearRenderCaches();
    redraw();
  });

  const colorsToggle = document.getElementById('showColorsToggle');
  colorsToggle?.addEventListener('change', (e) => {
    showEntityColors = !!e.target.checked;
    redraw();
  });

  const annoToggle = document.getElementById('showAnnoToggle');
  annoToggle?.addEventListener('change', (e) => {
    showAnnotations = !!e.target.checked;
    redraw();
  });

  const hatchToggle = document.getElementById('showHatchToggle');
  hatchToggle?.addEventListener('change', (e) => {
    showHatches = !!e.target.checked;
    redraw();
  });

  const spaceSelect = document.getElementById('spaceViewSelect');
  spaceSelect?.addEventListener('change', (e) => {
    const next = String(e.target.value || 'model').toLowerCase();
    if (next !== 'model' && next !== 'layout' && next !== 'both') return;
    currentSpaceView = next;
    reprocessCachedDrawing();
  });

  // Canvas mouse handlers
  canvas.addEventListener('mousedown', handleCanvasMouseDown);
  canvas.addEventListener('mousemove', handleCanvasMouseMove);
  canvas.addEventListener('mouseup', handleCanvasMouseUp);
  canvas.addEventListener('mouseleave', (e) => { handleCanvasMouseUp(e); hideTooltip(); });
  canvas.addEventListener('wheel', handleCanvasWheel);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('resize', () => {
    if (canvas.style.display !== 'none') {
      resizeCanvasToContainer();
      redraw();
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '+') {
      zoomAt(viewportWidth / 2, viewportHeight / 2, 1.1);
    } else if (e.ctrlKey && e.key === '-') {
      zoomAt(viewportWidth / 2, viewportHeight / 2, 1 / 1.1);
    } else if (e.key === 'Escape' && (isMarqueeZooming || marqueeZoomMode)) {
      cancelMarquee();
      if (marqueeZoomMode) {
        setInteractionMode('none');
      }
      redraw();
    }
  });
}

function applyMarqueeZoom(startScreen, endScreen) {
  if (!startScreen || !endScreen) return;
  const dx = endScreen.x - startScreen.x;
  const dy = endScreen.y - startScreen.y;
  if (Math.abs(dx) < 8 || Math.abs(dy) < 8) return;

  const minClientX = Math.min(startScreen.x, endScreen.x);
  const maxClientX = Math.max(startScreen.x, endScreen.x);
  const minClientY = Math.min(startScreen.y, endScreen.y);
  const maxClientY = Math.max(startScreen.y, endScreen.y);

  const topLeftWorld = getWorldPointFromCanvas(minClientX, minClientY);
  const bottomRightWorld = getWorldPointFromCanvas(maxClientX, maxClientY);
  const worldMinX = Math.min(topLeftWorld.x, bottomRightWorld.x);
  const worldMaxX = Math.max(topLeftWorld.x, bottomRightWorld.x);
  const worldMinY = Math.min(topLeftWorld.y, bottomRightWorld.y);
  const worldMaxY = Math.max(topLeftWorld.y, bottomRightWorld.y);
  const worldW = worldMaxX - worldMinX;
  const worldH = worldMaxY - worldMinY;
  if (worldW <= 1e-9 || worldH <= 1e-9) return;

  const scaleX = (viewportWidth * 0.94) / worldW;
  const scaleY = (viewportHeight * 0.94) / worldH;
  currentZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(scaleX, scaleY)));

  const cx = (worldMinX + worldMaxX) / 2;
  const cy = (worldMinY + worldMaxY) / 2;
  panX = viewportWidth / 2 - cx * currentZoom;
  panY = viewportHeight / 2 + cy * currentZoom;
  redraw();
}

function zoomAt(screenX, screenY, factor) {
  const oldZoom = currentZoom;
  const nextZoom = Math.max(MIN_ZOOM, Math.min(oldZoom * factor, MAX_ZOOM));
  if (nextZoom === oldZoom) return;

  const worldX = (screenX - panX) / oldZoom;
  const worldY = (panY - screenY) / oldZoom;

  currentZoom = nextZoom;
  panX = screenX - worldX * currentZoom;
  panY = screenY + worldY * currentZoom;
  redraw();
}

function crisp(v) {
  return Math.round(v) + 0.5;
}

function toRadians(angle) {
  if (typeof angle !== 'number' || Number.isNaN(angle)) return 0;
  return angle * Math.PI / 180;
}

function angleToRadians(value, unit = 'rad') {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return unit === 'deg' ? toRadians(n) : n;
}

function normalizeAngleUnit(entity, source, startRaw, endRaw) {
  const explicit = String(entity?.angleUnit ?? entity?.angleUnits ?? entity?.units ?? '').toLowerCase();
  if (explicit.includes('deg')) return 'deg';
  if (explicit.includes('rad')) return 'rad';

  const s = Math.abs(Number(startRaw));
  const e = Math.abs(Number(endRaw));
  const maxAbs = Math.max(s, e);
  if (Number.isFinite(maxAbs) && maxAbs > Math.PI * 2 + 0.01) return 'deg';

  // dxf-parser and libdxfrw-dxf generally return degrees for ARC.
  const src = String(source || '').toLowerCase();
  if (src === 'dxf-parser' || src === 'libdxfrw-dxf') return 'deg';
  return 'rad';
}

function resolveArcDirection(entity) {
  if (typeof entity?.clockwise === 'boolean') return entity.clockwise;
  if (typeof entity?.counterClockwise === 'boolean') return !entity.counterClockwise;
  if (typeof entity?.ccw === 'boolean') return !entity.ccw;
  if (Number.isFinite(Number(entity?.direction))) return Number(entity.direction) < 0;

  // Mirror/reversed extrusion commonly flips winding in OCS space.
  const nz = Number(entity?.extrusion?.z ?? entity?.normal?.z);
  if (Number.isFinite(nz) && nz < 0) return true;

  // DXF ARC default is CCW from start to end when no direction flag is present.
  return false;
}

function normalizeArcSweep(start, end, clockwise = false) {
  const s = normalizeAngle(start);
  const e = normalizeAngle(end);
  if (!clockwise) {
    let span = e - s;
    if (span <= 0) span += Math.PI * 2;
    return { start: s, end: s + span, span, clockwise: false };
  }
  let span = s - e;
  if (span <= 0) span += Math.PI * 2;
  return { start: s, end: s - span, span, clockwise: true };
}

function resolveArcSpec(entity, source, rotationOffset = 0) {
  const rawStart = Number(entity?.startAngle);
  const rawEnd = Number(entity?.endAngle);
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
    return null;
  }

  const unit = normalizeAngleUnit(entity, source, rawStart, rawEnd);
  const start = angleToRadians(rawStart, unit) + rotationOffset;
  const end = angleToRadians(rawEnd, unit) + rotationOffset;
  const clockwise = resolveArcDirection(entity);
  return normalizeArcSweep(start, end, clockwise);
}

// Full AutoCAD 256-color ACI palette
const ACI_PALETTE = [
  null,       '#FF0000','#FFFF00','#00FF00','#00FFFF','#0000FF',
  '#FF00FF',  '#FFFFFF','#414141','#808080','#FF0000','#FF7F7F',
  '#CC0000',  '#CC6666','#990000','#994C4C','#7F0000','#7F3F3F',
  '#4C0000',  '#4C2626','#FF3F00','#FF9F7F','#CC3300','#CC7F66',
  '#992600',  '#995F4C','#7F1F00','#7F4F3F','#4C1300','#4C2F26',
  '#FF7F00',  '#FFBF7F','#CC6600','#CC9966','#994C00','#99724C',
  '#7F3F00',  '#7F5F3F','#4C2600','#4C3926','#FFBF00','#FFDF7F',
  '#CC9900',  '#CCB266','#997200','#998566','#7F5F00','#7F6C3F',
  '#4C3900',  '#4C4126','#FFFF00','#FFFF7F','#CCCC00','#CCCC66',
  '#999900',  '#999966','#7F7F00','#7F7F3F','#4C4C00','#4C4C26',
  '#BFFF00',  '#DFFF7F','#99CC00','#B2CC66','#728F00','#899966', // indices 60..65-- approx
  '#5F7F00',  '#6C7F3F','#394C00','#414C26','#7FFF00','#BFFF7F',
  '#66CC00',  '#99CC66','#4C9900','#72994C','#3F7F00','#5F7F3F',
  '#264C00',  '#394C26','#3FFF00','#9FFF7F','#33CC00','#7FCC66',
  '#269900',  '#5F994C','#1F7F00','#4F7F3F','#134C00','#2F4C26',
  '#00FF00',  '#7FFF7F','#00CC00','#66CC66','#009900','#4C994C',
  '#007F00',  '#3F7F3F','#004C00','#264C26','#00FF3F','#7FFF9F',
  '#00CC33',  '#66CC7F','#00992A','#4C9961','#007F1F','#3F7F4F',
  '#004C13',  '#264C2F','#00FF7F','#7FFFBF','#00CC66','#66CC99',
  '#00994C',  '#4C9972','#007F3F','#3F7F5F','#004C26','#264C39',
  '#00FFBF',  '#7FFFDF','#00CC99','#66CCB2','#009972','#4C9985',
  '#007F5F',  '#3F7F6C','#004C39','#264C41','#00FFFF','#7FFFFF',
  '#00CCCC',  '#66CCCC','#009999','#4C9999','#007F7F','#3F7F7F',
  '#004C4C',  '#264C4C','#00BFFF','#7FDFFF','#0099CC','#66B2CC',
  '#007299',  '#4C8599','#005F7F','#3F6C7F','#00394C','#26414C',
  '#007FFF',  '#7FBFFF','#0066CC','#6699CC','#004C99','#4C7299',
  '#003F7F',  '#3F5F7F','#00264C','#26394C','#003FFF','#7F9FFF',
  '#0033CC',  '#667FCC','#002699','#4C5F99','#001F7F','#3F4F7F',
  '#00134C',  '#262F4C','#0000FF','#7F7FFF','#0000CC','#6666CC',
  '#000099',  '#4C4C99','#00007F','#3F3F7F','#00004C','#26264C',
  '#3F00FF',  '#9F7FFF','#3300CC','#7F66CC','#260099','#5F4C99',
  '#1F007F',  '#4F3F7F','#13004C','#2F264C','#7F00FF','#BF7FFF',
  '#6600CC',  '#9966CC','#4C0099','#724C99','#3F007F','#5F3F7F',
  '#26004C',  '#39264C','#BF00FF','#DF7FFF','#9900CC','#B266CC',
  '#720099',  '#854C99','#5F007F','#6C3F7F','#39004C','#41264C',
  '#FF00FF',  '#FF7FFF','#CC00CC','#CC66CC','#990099','#994C99',
  '#7F007F',  '#7F3F7F','#4C004C','#4C264C','#FF00BF','#FF7FDF',
  '#CC0099',  '#CC66B2','#990072','#994C85','#7F005F','#7F3F6C',
  '#4C0039',  '#4C2641','#FF007F','#FF7FBF','#CC0066','#CC6699',
  '#99004C',  '#994C72','#7F003F','#7F3F5F','#4C0026','#4C2639',
  '#FF003F',  '#FF7F9F','#CC0033','#CC667F','#990026','#994C5F',
  '#7F001F',  '#7F3F4F','#4C0013','#4C262F',
  '#333333','#505050','#696969','#828282','#BEBEBE','#D2D2D2','#E6E6E6','#FFFFFF'
];

function aciToHex(idx) {
  const i = Number(idx);
  if (!Number.isFinite(i) || i <= 0) return null;
  // ACI 7 = white/black; adapt based on background
  if (i === 7) return null; // let adaptColorForBackground handle it
  if (i < ACI_PALETTE.length && ACI_PALETTE[i]) return ACI_PALETTE[i];
  // Greyscale fallback for out-of-range indices
  const g = Math.max(0, Math.min(255, Math.round((i / 255) * 255)));
  const h = g.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}

function layerColor(layerName) {
  if (!layerName) return null;
  const key = layerName.toUpperCase();
  const override = layerOverrides[key] || null;
  if (override?.color) return override.color;
  const entry = layerColorMap[key];
  if (!entry) return null;
  // dxf-parser pre-computes a hex color string in entry.hex
  if (entry.hex) return entry.hex;
  if (entry.color != null) return aciToHex(entry.color);
  return null;
}

function isLayerVisible(layerName) {
  if (!layerName) return true;
  const key = layerName.toUpperCase();
  const override = layerOverrides[key];
  if (override && typeof override.visible === 'boolean') return override.visible;
  const entry = layerColorMap[key];
  if (!entry) return true;
  return entry.visible !== false;
}

function layerLinetype(layerName) {
  if (!layerName) return null;
  const key = layerName.toUpperCase();
  const override = layerOverrides[key];
  if (override?.linetype) return String(override.linetype);
  return layerColorMap[key]?.linetype || null;
}

function linetypeDashPattern(name) {
  const n = String(name || '').toUpperCase();
  if (!n || n === 'CONTINUOUS' || n === 'BYLAYER' || n === 'BYBLOCK') return [];
  if (n.includes('DASH') || n === 'HIDDEN') return [8, 4];
  if (n.includes('DOT')) return [2, 4];
  if (n.includes('CENTER')) return [10, 4, 2, 4];
  if (n.includes('PHANTOM')) return [12, 4, 2, 4, 2, 4];
  return [];
}

function renderLayerPanel() {
  const panel = document.getElementById('layersList');
  if (!panel) return;
  const entries = Object.entries(layerColorMap || {}).sort((a, b) => a[0].localeCompare(b[0]));
  if (!entries.length) {
    panel.innerHTML = '<div class="property-item"><span class="property-value">No layers</span></div>';
    return;
  }

  const rows = entries.map(([key, meta]) => {
    const ov = layerOverrides[key] || {};
    const visible = typeof ov.visible === 'boolean' ? ov.visible : (meta.visible !== false);
    const color = ov.color || meta.hex || aciToHex(meta.color) || '#000000';
    const linetype = String(ov.linetype || meta.linetype || 'CONTINUOUS').toUpperCase();
    return `
      <div class="property-item" style="display:block; border-bottom:1px solid #eef2f5; padding:6px 0;">
        <div style="display:flex; justify-content:space-between; gap:6px; align-items:center;">
          <label style="display:flex; align-items:center; gap:6px; min-width:0;">
            <input type="checkbox" class="property-checkbox" data-layer-visible="${key}" ${visible ? 'checked' : ''}>
            <span class="property-label" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:120px;">${meta.name || key}</span>
          </label>
          <input type="color" class="property-input" data-layer-color="${key}" value="${color}" style="width:42px; padding:0; border:none; background:none;">
        </div>
        <div style="margin-top:6px; display:flex; justify-content:flex-end;">
          <select class="property-input" data-layer-linetype="${key}" style="width:118px;">
            <option value="CONTINUOUS" ${linetype === 'CONTINUOUS' ? 'selected' : ''}>Continuous</option>
            <option value="DASHED" ${linetype === 'DASHED' ? 'selected' : ''}>Dashed</option>
            <option value="DOTTED" ${linetype === 'DOTTED' ? 'selected' : ''}>Dotted</option>
            <option value="CENTER" ${linetype === 'CENTER' ? 'selected' : ''}>Center</option>
          </select>
        </div>
      </div>
    `;
  }).join('');

  panel.innerHTML = rows;

  panel.querySelectorAll('[data-layer-visible]').forEach((el) => {
    el.addEventListener('change', (ev) => {
      const layer = ev.target.getAttribute('data-layer-visible');
      if (!layer) return;
      layerOverrides[layer] = { ...(layerOverrides[layer] || {}), visible: !!ev.target.checked };
      redraw();
    });
  });

  panel.querySelectorAll('[data-layer-color]').forEach((el) => {
    el.addEventListener('input', (ev) => {
      const layer = ev.target.getAttribute('data-layer-color');
      if (!layer) return;
      layerOverrides[layer] = { ...(layerOverrides[layer] || {}), color: ev.target.value || '#000000' };
      redraw();
    });
  });

  panel.querySelectorAll('[data-layer-linetype]').forEach((el) => {
    el.addEventListener('change', (ev) => {
      const layer = ev.target.getAttribute('data-layer-linetype');
      if (!layer) return;
      layerOverrides[layer] = { ...(layerOverrides[layer] || {}), linetype: String(ev.target.value || 'CONTINUOUS').toUpperCase() };
      redraw();
    });
  });
}

function intColorToHex(v) {
  const n = Number(v);
  // 0 = BYBLOCK/unset; 256 = BYLAYER (should be resolved via layer table); both are not RGB.
  if (!Number.isFinite(n) || n <= 0 || n === 256) return null;
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function normalizeColor(value) {
  if (typeof value !== 'string') return null;
  const c = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) {
    return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  }
  return null;
}

function normalizeLayerName(value) {
  return String(value || '').trim().toUpperCase();
}

function clearRenderCaches() {
  adaptedColorCache.clear();
}

function normalizeImageUri(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const src = rawPath.trim();
  if (!src) return null;

  if (/^(file|https?):\/\//i.test(src)) {
    return src;
  }

  // Windows absolute path: C:\dir\image.png
  if (/^[a-zA-Z]:\\/.test(src)) {
    return `file:///${src.replace(/\\/g, '/')}`;
  }

  // UNC path: \\server\share\image.png
  if (/^\\\\/.test(src)) {
    return `file:${src.replace(/\\/g, '/')}`;
  }

  return src;
}

function getImageAsset(rawPath) {
  const uri = normalizeImageUri(rawPath);
  if (!uri) return null;
  if (imageAssetCache.has(uri)) {
    return imageAssetCache.get(uri);
  }

  const asset = { status: 'loading', img: null, uri };
  const img = new Image();
  img.onload = () => {
    asset.status = 'ready';
    asset.img = img;
    redraw();
  };
  img.onerror = () => {
    asset.status = 'error';
    redraw();
  };
  img.src = uri;
  imageAssetCache.set(uri, asset);
  return asset;
}

function extractEntityColor(raw, entityLayer) {
  if (!raw || typeof raw !== 'object') return null;
  // Explicit 24-bit true color (group codes 420/421). Also check libredwg's color.rgb field
  // which stores 24-bit RGB directly when color.method === 0xC2.
  const colorObjRgb = (raw.color && typeof raw.color === 'object') ? Number(raw.color.rgb ?? 0) : 0;
  const trueColor = intColorToHex(raw.trueColor ?? raw.truecolor ?? (colorObjRgb > 0 ? colorObjRgb : null));
  if (trueColor) return trueColor;
  // colorValue: use only if clearly a 24-bit value (> 255) to avoid treating ACI as RGB.
  const colValN = Number(raw.colorValue);
  if (Number.isFinite(colValN) && colValN > 255) {
    const tc = intColorToHex(colValN);
    if (tc) return tc;
  }
  // ACI direct color (group code 62). Also check libredwg's nested color.index and plain
  // numeric raw.color (some parsers store the ACI integer directly in entity.color).
  const aciIdx = raw.colorNumber ?? raw.colorIndex ?? raw.aci
    ?? (raw.color && typeof raw.color === 'object' ? raw.color.index : null)
    ?? (typeof raw.color === 'number' ? raw.color : undefined);
  if (aciIdx != null) {
    const n = Number(aciIdx);
    // 0 = BYBLOCK, 256 = BYLAYER — both resolve from layer
    if (n === 256 || n === 0) {
      return layerColor(entityLayer || raw.layer) || null;
    }
    return aciToHex(n);
  }
  // Direct hex string color
  const direct = normalizeColor(raw.color || raw.colour || raw.rgb || raw.hexColor);
  if (direct) return direct;
  // Fallback: resolve from layer
  return layerColor(entityLayer || raw.layer) || null;
}

function sanitizeText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    // Common AutoCAD inline symbols and %% control codes
    .replace(/%%c/gi, ' DIA ')
    .replace(/%%d/gi, ' deg ')
    .replace(/%%p/gi, ' +/- ')
    .replace(/\\U\+2205/gi, ' DIA ')
    .replace(/\\U\+00B0/gi, ' deg ')
    .replace(/\\U\+00B1/gi, ' +/- ')
    .replace(/\\U\+2264/gi, ' <= ')
    .replace(/\\U\+2265/gi, ' >= ')
    .replace(/\\P/gi, '\n')
    .replace(/\\X/gi, '\n')
    .replace(/\\~+/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\A\d+;/gi, '')
    .replace(/\\H[^;]*;/gi, '')
    .replace(/\\S([^;#^]+)#([^;]+);/gi, '$1/$2')
    .replace(/\\S([^;#^]+)\^([^;]+);/gi, '$1/$2')
    .replace(/\\S([^;]+);/gi, '$1')
    .replace(/\\[QWTFCL][^;]*;/gi, '')
    .replace(/\\[A-Z]+;/gi, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/[{}]/g, '')
    .trim();
}

function adaptColorForBackground(color) {
  const bg = normalizeColor(backgroundColor) || '#ffffff';
  const c = normalizeColor(color) || '#000000';
  const cacheKey = `${bg}|${c}`;
  const cached = adaptedColorCache.get(cacheKey);
  if (cached) return cached;
  // Preserve explicit CAD colors exactly. Only adapt pure black/white, which are
  // ambiguous display colors on same-tone backgrounds.
  if (c !== '#000000' && c !== '#ffffff') {
    if (adaptedColorCache.size > 2048) adaptedColorCache.clear();
    adaptedColorCache.set(cacheKey, c);
    return c;
  }
  const toRgb = (hex) => ({
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16)
  });
  const fg = toRgb(c);
  const b = toRgb(bg);
  const lumFg = 0.2126 * fg.r + 0.7152 * fg.g + 0.0722 * fg.b;
  const lumBg = 0.2126 * b.r + 0.7152 * b.g + 0.0722 * b.b;
  const contrast = Math.abs(lumFg - lumBg);
  const out = contrast >= 42 ? c : (lumBg > 128 ? '#111111' : '#f2f2f2');
  if (adaptedColorCache.size > 2048) adaptedColorCache.clear();
  adaptedColorCache.set(cacheKey, out);
  return out;
}

function getEffectiveEntityColor(entity, fallbackColor) {
  if (!showEntityColors) return fallbackColor;
  const override = layerOverrides[normalizeLayerName(entity?.layer)] || null;
  const rawColor = override?.color || entity?.color || layerColor(entity?.layer) || fallbackColor;
  return adaptColorForBackground(rawColor);
}

function sameSnap(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.entityId === b.entityId &&
    Math.abs((a.x || 0) - (b.x || 0)) < 1e-9 &&
    Math.abs((a.y || 0) - (b.y || 0)) < 1e-9
  );
}

function drawHatchPattern(entity, color) {
  if (!entity?.loops?.length) return;
  const minX = Number(entity.minX);
  const minY = Number(entity.minY);
  const maxX = Number(entity.maxX);
  const maxY = Number(entity.maxY);
  const hasWorldBounds = Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY);
  const corners = hasWorldBounds
    ? [
      { x: minX, y: minY },
      { x: minX, y: maxY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY }
    ]
    : null;

  ctx.save();
  ctx.beginPath();
  for (const loop of entity.loops) {
    if (!Array.isArray(loop) || loop.length < 3) continue;
    const p0 = getScreenPoint(loop[0].x, loop[0].y);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < loop.length; i++) {
      const p = getScreenPoint(loop[i].x, loop[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  }

  const fill = `${color}22`;
  ctx.fillStyle = fill;
  ctx.fill();

  const patternName = String(entity.patternName || '').toUpperCase();
  const isConcretePattern = patternName.includes('CONC') || patternName.includes('CONCRETE');
  if (isConcretePattern) {
    // Concrete-like stipple pattern (pebble feel) for AR-CONC style hatches.
    ctx.clip();
    ctx.fillStyle = color;
    const spacingWorld = Math.max(0.25, Math.abs(Number(entity.spacing) || 10));
    if (hasWorldBounds) {
      const spanX = Math.max(0.001, maxX - minX);
      const spanY = Math.max(0.001, maxY - minY);
      const approxCount = (spanX / spacingWorld) * (spanY / spacingWorld);
      const densityScale = approxCount > 12000 ? Math.sqrt(approxCount / 12000) : 1;
      const stepWorld = spacingWorld * densityScale;
      const xStart = Math.floor(minX / stepWorld) * stepWorld;
      const yStart = Math.floor(minY / stepWorld) * stepWorld;
      for (let wy = yStart; wy <= maxY + stepWorld; wy += stepWorld) {
        for (let wx = xStart; wx <= maxX + stepWorld; wx += stepWorld) {
          const ix = Math.round(wx / stepWorld);
          const iy = Math.round(wy / stepWorld);
          const jx = (((ix * 13 + iy * 7) % 5) - 2) * stepWorld * 0.12;
          const jy = (((ix * 5 + iy * 11) % 5) - 2) * stepWorld * 0.12;
          const p = getScreenPoint(wx + jx, wy + jy);
          const r = Math.max(0.6, stepWorld * currentZoom * 0.08);
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
    return;
  }

  if (!showHatches) {
    ctx.restore();
    return;
  }

  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const spacingWorld = Math.max(1e-4, Math.abs(Number(entity.spacing) || 8));
  const angle = toRadians(entity.angle || 45);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const px = -dy;
  const py = dx;
  if (hasWorldBounds && corners) {
    let minN = Infinity;
    let maxN = -Infinity;
    let minU = Infinity;
    let maxU = -Infinity;
    for (const c of corners) {
      const n = c.x * px + c.y * py;
      const u = c.x * dx + c.y * dy;
      minN = Math.min(minN, n);
      maxN = Math.max(maxN, n);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
    }
    const lineStart = Math.floor(minN / spacingWorld) - 1;
    const lineEnd = Math.ceil(maxN / spacingWorld) + 1;
    const maxLineCount = 3000;
    const step = Math.max(1, Math.ceil((lineEnd - lineStart + 1) / maxLineCount));
    const margin = (maxU - minU) * 0.08 + spacingWorld * 2;

    for (let i = lineStart; i <= lineEnd; i += step) {
      const n = i * spacingWorld;
      const bx = px * n;
      const by = py * n;
      const p1w = { x: bx + dx * (minU - margin), y: by + dy * (minU - margin) };
      const p2w = { x: bx + dx * (maxU + margin), y: by + dy * (maxU + margin) };
      const p1 = getScreenPoint(p1w.x, p1w.y);
      const p2 = getScreenPoint(p2w.x, p2w.y);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function worldTolFromPx(px = 8) {
  return px / Math.max(currentZoom, 1e-9);
}

function dist2(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return dx * dx + dy * dy;
}

function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
  const l2 = dist2(x1, y1, x2, y2);
  if (l2 === 0) return Math.sqrt(dist2(px, py, x1, y1));
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + t * (x2 - x1);
  const qy = y1 + t * (y2 - y1);
  return Math.sqrt(dist2(px, py, qx, qy));
}

function pointToSegmentDistanceSq(px, py, x1, y1, x2, y2) {
  const l2 = dist2(x1, y1, x2, y2);
  if (l2 === 0) return dist2(px, py, x1, y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + t * (x2 - x1);
  const qy = y1 + t * (y2 - y1);
  return dist2(px, py, qx, qy);
}

function projectPointToSegment(px, py, x1, y1, x2, y2) {
  const l2 = dist2(x1, y1, x2, y2);
  if (l2 === 0) return { x: x1, y: y1, t: 0 };
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return {
    x: x1 + t * (x2 - x1),
    y: y1 + t * (y2 - y1),
    t
  };
}

function normalizeAngle(a) {
  let v = a % (Math.PI * 2);
  if (v < 0) v += Math.PI * 2;
  return v;
}

function angleIsInArc(test, start, end, clockwise = false) {
  const t = normalizeAngle(test);
  const n = normalizeArcSweep(start, end, clockwise);
  const ccwDelta = normalizeAngle(t - n.start);
  if (!n.clockwise) {
    return ccwDelta <= n.span + 1e-9;
  }
  const cwDelta = normalizeAngle(n.start - t);
  return cwDelta <= n.span + 1e-9;
}

function normalizeArcForCanvas(start, end, clockwise = false, angleUnit = 'rad') {
  const s = angleToRadians(start, angleUnit);
  const e = angleToRadians(end, angleUnit);
  return normalizeArcSweep(s, e, clockwise);
}

function arcSpanRadians(entity) {
  const n = normalizeArcForCanvas(entity.startAngle, entity.endAngle, !!entity.clockwise, entity.angleUnit || 'rad');
  return Math.abs(n.end - n.start);
}

function bulgeToArc(p1, p2, bulge) {
  if (!bulge || !Number.isFinite(bulge)) return null;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const chord = Math.sqrt(dx * dx + dy * dy);
  if (chord <= 1e-12) return null;

  const theta = 4 * Math.atan(bulge);
  const radius = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
  const halfChord = chord / 2;
  const h = Math.sqrt(Math.max(0, radius * radius - halfChord * halfChord));

  const ux = dx / chord;
  const uy = dy / chord;
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;

  // Positive bulge => center on left side of segment (CCW from p1 to p2)
  const sign = bulge >= 0 ? 1 : -1;
  const cx = mx + (-uy) * h * sign;
  const cy = my + (ux) * h * sign;

  const start = Math.atan2(p1.y - cy, p1.x - cx);
  const end = Math.atan2(p2.y - cy, p2.x - cx);
  return {
    x: cx,
    y: cy,
    r: radius,
    startAngle: start,
    endAngle: end,
    clockwise: bulge < 0,
    sweepRadians: Math.abs(theta)
  };
}

function getEntityLineLength(entity) {
  return Math.sqrt(dist2(entity.x1, entity.y1, entity.x2, entity.y2));
}

function getLineAngleDeg(entity) {
  return Math.atan2(entity.y2 - entity.y1, entity.x2 - entity.x1) * 180 / Math.PI;
}

function getEntityInfoHtml(entity) {
  if (!entity) return '<div class="property-item"><span class="property-value">No selection</span></div>';
  if (entity.type === 'line') {
    return [
      `<div class="property-item"><span class="property-label">Type:</span><span class="property-value">LINE</span></div>`,
      `<div class="property-item"><span class="property-label">Length:</span><span class="property-value">${getEntityLineLength(entity).toFixed(4)} ${unitsLabel()}</span></div>`,
      `<div class="property-item"><span class="property-label">Angle:</span><span class="property-value">${getLineAngleDeg(entity).toFixed(2)}°</span></div>`
    ].join('');
  }
  if (entity.type === 'circle') {
    return [
      `<div class="property-item"><span class="property-label">Type:</span><span class="property-value">CIRCLE</span></div>`,
      `<div class="property-item"><span class="property-label">Radius:</span><span class="property-value">${entity.r.toFixed(4)} ${unitsLabel()}</span></div>`,
      `<div class="property-item"><span class="property-label">Diameter:</span><span class="property-value">${(entity.r * 2).toFixed(4)} ${unitsLabel()}</span></div>`,
      `<div class="property-item"><span class="property-label">Circumference:</span><span class="property-value">${(2 * Math.PI * entity.r).toFixed(4)} ${unitsLabel()}</span></div>`
    ].join('');
  }
  if (entity.type === 'arc') {
    const span = arcSpanRadians(entity);
    return [
      `<div class="property-item"><span class="property-label">Type:</span><span class="property-value">ARC</span></div>`,
      `<div class="property-item"><span class="property-label">Radius:</span><span class="property-value">${entity.r.toFixed(4)} ${unitsLabel()}</span></div>`,
      `<div class="property-item"><span class="property-label">Arc Length:</span><span class="property-value">${(entity.r * span).toFixed(4)} ${unitsLabel()}</span></div>`,
      `<div class="property-item"><span class="property-label">Sweep:</span><span class="property-value">${(span * 180 / Math.PI).toFixed(2)}°</span></div>`
    ].join('');
  }
  return `<div class="property-item"><span class="property-label">Type:</span><span class="property-value">${entity.type}</span></div>`;
}

function updateSelectionPanel() {
  const panel = document.getElementById('selectionList');
  if (!panel) return;
  if (selectedEntityIds.length === 0) {
    panel.innerHTML = '<div class="property-item"><span class="property-value">No selection</span></div>';
    return;
  }

  const selected = entities.filter((ent) => selectedEntityIds.includes(ent.id));
  let html = `<div class="property-item"><span class="property-label">Selected:</span><span class="property-value">${selected.length}</span></div>`;
  if (selected.length === 1) {
    html += getEntityInfoHtml(selected[0]);
  }
  if (selected.length === 2 && selected.every((e) => e.type === 'line')) {
    const a1 = Math.atan2(selected[0].y2 - selected[0].y1, selected[0].x2 - selected[0].x1);
    const a2 = Math.atan2(selected[1].y2 - selected[1].y1, selected[1].x2 - selected[1].x1);
    let ang = Math.abs((a2 - a1) * 180 / Math.PI);
    if (ang > 180) ang = 360 - ang;
    html += `<div class="property-item"><span class="property-label">Line-Line Angle:</span><span class="property-value">${ang.toFixed(2)}°</span></div>`;
    const aElem = document.getElementById('angle');
    if (aElem) aElem.textContent = `${ang.toFixed(2)}°`;
  }
  panel.innerHTML = html;
}

function _tooltipFmt(label, value) {
  return `<span class="tt-row"><span class="tt-label">${label}</span> ${value}</span>`;
}

function buildTooltipHTML(entity) {
  if (!entity) return '';
  const ul = unitsLabel();
  const lyr = entity.layer ? `<span class="tt-row"><span class="tt-label">Layer</span> ${entity.layer}</span>` : '';
  const lines = [];

  switch (entity.type) {
    case 'line':
    case 'dimension-line': {
      const len = getEntityLineLength(entity);
      const ang = getLineAngleDeg(entity);
      lines.push(`<span class="tt-type">${entity.type === 'dimension-line' ? 'DIM LINE' : 'LINE'}</span>`);
      lines.push(_tooltipFmt('Length', `${len.toFixed(4)} ${ul}`));
      lines.push(_tooltipFmt('Angle', `${ang.toFixed(2)}°`));
      break;
    }
    case 'circle':
      lines.push(`<span class="tt-type">CIRCLE</span>`);
      lines.push(_tooltipFmt('Radius', `${entity.r.toFixed(4)} ${ul}`));
      lines.push(_tooltipFmt('Diameter', `${(entity.r * 2).toFixed(4)} ${ul}`));
      break;
    case 'arc': {
      const span = arcSpanRadians(entity);
      lines.push(`<span class="tt-type">ARC</span>`);
      lines.push(_tooltipFmt('Radius', `${entity.r.toFixed(4)} ${ul}`));
      lines.push(_tooltipFmt('Sweep', `${(span * 180 / Math.PI).toFixed(2)}°`));
      lines.push(_tooltipFmt('Arc Length', `${(entity.r * span).toFixed(4)} ${ul}`));
      break;
    }
    case 'text':
      lines.push(`<span class="tt-type">TEXT</span>`);
      if (entity.text) lines.push(_tooltipFmt('', `"${entity.text.slice(0, 60)}${entity.text.length > 60 ? '…' : ''}"`));
      if (entity.height) lines.push(_tooltipFmt('Height', `${Number(entity.height).toFixed(4)} ${ul}`));
      if (entity.rotation) lines.push(_tooltipFmt('Rotation', `${(Number(entity.rotation) * 180 / Math.PI).toFixed(2)}°`));
      break;
    case 'dimension':
      lines.push(`<span class="tt-type">DIMENSION</span>`);
      if (entity.text) lines.push(_tooltipFmt('Value', `"${entity.text.slice(0, 60)}${entity.text.length > 60 ? '…' : ''}"`));
      if (entity.height) lines.push(_tooltipFmt('Height', `${Number(entity.height).toFixed(4)} ${ul}`));
      break;
    case 'hatch': {
      lines.push(`<span class="tt-type">HATCH</span>`);
      if (entity.patternName) lines.push(_tooltipFmt('Pattern', entity.patternName));
      if (Number.isFinite(entity.minX)) {
        const bba = ((entity.maxX - entity.minX) * (entity.maxY - entity.minY)).toFixed(2);
        lines.push(_tooltipFmt('BBox Area', `~${bba} ${ul}²`));
      }
      if (Array.isArray(entity.loops) && entity.loops.length > 0)
        lines.push(_tooltipFmt('Loops', String(entity.loops.length)));
      break;
    }
    case 'image':
      lines.push(`<span class="tt-type">IMAGE</span>`);
      if (entity.sourcePath) lines.push(_tooltipFmt('File', entity.sourcePath.split(/[\\/]/).pop()));
      if (entity.imageWidth && entity.imageHeight)
        lines.push(_tooltipFmt('Pixels', `${entity.imageWidth} × ${entity.imageHeight}`));
      if (Number.isFinite(entity.minX)) {
        const iw = (entity.maxX - entity.minX).toFixed(4);
        const ih = (entity.maxY - entity.minY).toFixed(4);
        lines.push(_tooltipFmt('Size', `${iw} × ${ih} ${ul}`));
      }
      break;
    case 'underlay':
      lines.push(`<span class="tt-type">${String(entity.kind || 'UNDERLAY').toUpperCase()}</span>`);
      if (entity.sourcePath) lines.push(_tooltipFmt('File', entity.sourcePath.split(/[\\/]/).pop()));
      if (Number.isFinite(entity.minX)) {
        const uw = (entity.maxX - entity.minX).toFixed(4);
        const uh = (entity.maxY - entity.minY).toFixed(4);
        lines.push(_tooltipFmt('Size', `${uw} × ${uh} ${ul}`));
      }
      break;
    default:
      lines.push(`<span class="tt-type">${String(entity.type || 'ENTITY').toUpperCase()}</span>`);
  }

  if (lyr) lines.push(lyr);
  return lines.join('');
}

function showTooltip(entity, clientX, clientY) {
  const el = document.getElementById('hoverTooltip');
  if (!el) return;
  const html = buildTooltipHTML(entity);
  if (!html) { hideTooltip(); return; }
  el.innerHTML = html;
  el.style.display = 'block';
  _positionTooltip(el, clientX, clientY);
}

function _positionTooltip(el, clientX, clientY) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const tw = el.offsetWidth || 220;
  const th = el.offsetHeight || 56;
  let left = clientX + 16;
  let top = clientY + 16;
  if (left + tw > W - 8) left = clientX - tw - 12;
  if (top + th > H - 8) top = clientY - th - 12;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function updateTooltipPosition(clientX, clientY) {
  const el = document.getElementById('hoverTooltip');
  if (el && el.style.display !== 'none') _positionTooltip(el, clientX, clientY);
}

function hideTooltip() {
  const el = document.getElementById('hoverTooltip');
  if (el) el.style.display = 'none';
  hoveredEntity = null;
}

function getSnapCandidates() {
  if (!snapCacheDirty) return snapCache;
  const pts = [];
  for (const ent of entities) {
    if (ent.type === 'line' || ent.type === 'dimension-line') {
      pts.push({ x: ent.x1, y: ent.y1, kind: 'endpoint', entityId: ent.id });
      pts.push({ x: ent.x2, y: ent.y2, kind: 'endpoint', entityId: ent.id });
      const mid = { x: (ent.x1 + ent.x2) / 2, y: (ent.y1 + ent.y2) / 2, kind: 'midpoint', entityId: ent.id };
      pts.push(mid);
    } else if (ent.type === 'circle') {
      pts.push({ x: ent.x + ent.r, y: ent.y, kind: 'quadrant', entityId: ent.id });
      pts.push({ x: ent.x - ent.r, y: ent.y, kind: 'quadrant', entityId: ent.id });
      pts.push({ x: ent.x, y: ent.y + ent.r, kind: 'quadrant', entityId: ent.id });
      pts.push({ x: ent.x, y: ent.y - ent.r, kind: 'quadrant', entityId: ent.id });
      pts.push({ x: ent.x, y: ent.y, kind: 'center', entityId: ent.id });
    } else if (ent.type === 'arc') {
      const s = angleToRadians(ent.startAngle, ent.angleUnit || 'rad');
      const e = angleToRadians(ent.endAngle, ent.angleUnit || 'rad');
      pts.push({ x: ent.x + Math.cos(s) * ent.r, y: ent.y + Math.sin(s) * ent.r, kind: 'endpoint', entityId: ent.id });
      pts.push({ x: ent.x + Math.cos(e) * ent.r, y: ent.y + Math.sin(e) * ent.r, kind: 'endpoint', entityId: ent.id });
      pts.push({ x: ent.x, y: ent.y, kind: 'center', entityId: ent.id });
    }
  }
  snapCache = pts;
  snapCacheDirty = false;
  return snapCache;
}

function pickEntityAt(world) {
  const tol = worldTolFromPx(8);
  const tol2 = tol * tol;
  let best = null;
  let bestDist = Infinity;
  const view = getWorldViewportBounds(24);
  for (const ent of entities) {
    if (!isEntityVisible(ent, view)) continue;
    let d = Infinity;
    if (ent.type === 'line' || ent.type === 'dimension-line') {
      d = pointToSegmentDistanceSq(world.x, world.y, ent.x1, ent.y1, ent.x2, ent.y2);
      if (d < bestDist && d <= tol2) {
        bestDist = d;
        best = ent;
      }
      continue;
    } else if (ent.type === 'circle') {
      const dc = Math.sqrt(dist2(world.x, world.y, ent.x, ent.y));
      d = Math.abs(dc - ent.r);
    } else if (ent.type === 'arc') {
      const a = Math.atan2(world.y - ent.y, world.x - ent.x);
      const s = angleToRadians(ent.startAngle, ent.angleUnit || 'rad');
      const e = angleToRadians(ent.endAngle, ent.angleUnit || 'rad');
      if (!angleIsInArc(a, s, e, !!ent.clockwise)) continue;
      const dc = Math.sqrt(dist2(world.x, world.y, ent.x, ent.y));
      d = Math.abs(dc - ent.r);
    }
    if (d < bestDist && d <= tol) {
      bestDist = d;
      best = ent;
    }
  }

  // Second pass: area-based entities (text, dimension, image, underlay, hatch).
  // Only picked when no stroke geometry was close enough in the first pass.
  if (!best) {
    // Priority: text/dimension > image > underlay > hatch (prefer smaller bbox when tied)
    const AREA_PRIO = { text: 0, dimension: 0, image: 1, underlay: 2, hatch: 3 };
    let areaPri = 9999;
    let areaSmallest = Infinity;
    for (const ent of entities) {
      if (!isEntityVisible(ent, view)) continue;
      const pri = AREA_PRIO[ent.type];
      if (pri === undefined) continue;
      if (!Number.isFinite(ent.minX)) continue;
      if (world.x < ent.minX || world.x > ent.maxX || world.y < ent.minY || world.y > ent.maxY) continue;
      const area = (ent.maxX - ent.minX) * (ent.maxY - ent.minY);
      if (pri < areaPri || (pri === areaPri && area < areaSmallest)) {
        best = ent;
        areaPri = pri;
        areaSmallest = area;
      }
    }
  }

  return best;
}

function findSnapPoint(world) {
  const tol = worldTolFromPx(10);
  const tol2 = tol * tol;
  let best = null;
  let bestDist = Infinity;
  const pts = getSnapCandidates();
  for (const p of pts) {
    const d2 = dist2(world.x, world.y, p.x, p.y);
    if (d2 < bestDist && d2 <= tol2) {
      bestDist = d2;
      best = p;
    }
  }

  if (!best) {
    const ent = pickEntityAt(world);
    if (ent?.type === 'line') {
      const proj = projectPointToSegment(world.x, world.y, ent.x1, ent.y1, ent.x2, ent.y2);
      best = { x: proj.x, y: proj.y, kind: 'edge', entityId: ent.id };
    } else if (ent?.type === 'arc') {
      const a = Math.atan2(world.y - ent.y, world.x - ent.x);
      const s = angleToRadians(ent.startAngle, ent.angleUnit || 'rad');
      const e = angleToRadians(ent.endAngle, ent.angleUnit || 'rad');
      if (angleIsInArc(a, s, e, !!ent.clockwise)) {
        best = { x: ent.x + Math.cos(a) * ent.r, y: ent.y + Math.sin(a) * ent.r, kind: 'edge', entityId: ent.id };
      }
    } else if (ent?.type === 'circle') {
      const a = Math.atan2(world.y - ent.y, world.x - ent.x);
      best = { x: ent.x + Math.cos(a) * ent.r, y: ent.y + Math.sin(a) * ent.r, kind: 'edge', entityId: ent.id };
    }
  }

  return best;
}

function resizeCanvasToContainer() {
  const container = document.getElementById('canvasContainer');
  if (!container || !canvas || !ctx) return;

  const rect = container.getBoundingClientRect();
  viewportWidth = Math.max(1, Math.floor(rect.width));
  viewportHeight = Math.max(1, Math.floor(rect.height));

  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${viewportWidth}px`;
  canvas.style.height = `${viewportHeight}px`;
  canvas.width = Math.max(1, Math.floor(viewportWidth * dpr));
  canvas.height = Math.max(1, Math.floor(viewportHeight * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function getCanvasPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top
  };
}

function getWorldPointFromCanvas(canvasX, canvasY) {
  return {
    x: (canvasX - panX) / currentZoom,
    y: (panY - canvasY) / currentZoom
  };
}

function getWorldPoint(clientX, clientY) {
  const p = getCanvasPoint(clientX, clientY);
  return getWorldPointFromCanvas(p.x, p.y);
}

function getScreenPoint(worldX, worldY) {
  return {
    x: worldX * currentZoom + panX,
    y: panY - worldY * currentZoom
  };
}

function setBBox(entity, minX, minY, maxX, maxY) {
  entity.minX = Math.min(minX, maxX);
  entity.minY = Math.min(minY, maxY);
  entity.maxX = Math.max(minX, maxX);
  entity.maxY = Math.max(minY, maxY);
  return entity;
}

function getWorldViewportBounds(padPx = 0) {
  const pad = padPx / Math.max(currentZoom, 1e-9);
  const minX = (-panX) / currentZoom - pad;
  const maxX = (viewportWidth - panX) / currentZoom + pad;
  const minY = (panY - viewportHeight) / currentZoom - pad;
  const maxY = (panY) / currentZoom + pad;
  return { minX, minY, maxX, maxY };
}

function isEntityVisible(entity, view) {
  const minX = entity.minX ?? Number.NEGATIVE_INFINITY;
  const minY = entity.minY ?? Number.NEGATIVE_INFINITY;
  const maxX = entity.maxX ?? Number.POSITIVE_INFINITY;
  const maxY = entity.maxY ?? Number.POSITIVE_INFINITY;
  return !(maxX < view.minX || maxY < view.minY || minX > view.maxX || minY > view.maxY);
}

function setupDragDrop() {
  const dropZone = document.getElementById('dropZone');
  const canvasContainer = document.getElementById('canvasContainer');

  if (!canvasContainer) return;

  canvasContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone?.classList.add('active');
  });

  canvasContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone?.classList.remove('active');
  });

  canvasContainer.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone?.classList.remove('active');

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0];
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (ext === 'dwg' || ext === 'dxf') {
        // Get file path from file name (limited in browser, use file API)
        // For now, we'll need the user to use File -> Open dialog
      }
    }
  });
}

async function loadFile(filePath) {
  console.log('loading file', filePath);
  try {
    await waitForAutomationConfig();
    document.getElementById('errorDisplay').style.display = 'none';

    const fileInfo = await window.electronAPI.getFileInfo(filePath);
    if (!fileInfo.success) {
      showError(`Failed to read file: ${fileInfo.error}`);
      return;
    }

    const ext = fileInfo.extension?.toLowerCase();
    updateFileInfo(fileInfo);

    // try parsing via backend
    const parseResp = await window.electronAPI.parseFile(filePath);
    console.log('parse response', parseResp);
    if (!parseResp.success) {
      showError(`Unable to parse file: ${parseResp.error}`);
      return;
    }

    nextEntityId = 1;
    selectedEntityIds = [];
    activeSnap = null;
    measureStart = null;
    measureCurrent = null;
    layerColorMap = parseResp.layers || {};
    layerOverrides = {};
    clearRenderCaches();
    console.log('Layer map loaded:', Object.keys(layerColorMap).length, 'layers', Object.entries(layerColorMap).slice(0,5).map(([k,v]) => `${k}:${v.hex||v.color}`));
    currentParseSource = String(parseResp.source || 'unknown');

      drawingUnitCode = Number.isFinite(Number(parseResp?.units?.code)) ? Number(parseResp.units.code) : null;
      currentReaderProfile = {
        ...currentReaderProfile,
        ...(parseResp?.readerProfile || {})
      };
      parseCache = {
        entities: parseResp.entities,
        blocks: parseResp.blocks,
        source: currentParseSource,
        unitsCode: drawingUnitCode
      };

      const spaceSelect = document.getElementById('spaceViewSelect');
      if (spaceSelect) {
        spaceSelect.value = currentSpaceView;
      }

      entities = convertDXFEntities(
        parseResp.entities,
        parseResp.blocks,
        currentParseSource,
        drawingUnitCode,
        currentReaderProfile,
        currentSpaceView
      );
    snapCacheDirty = true;
    drawingUnitLabel = parseResp?.units?.label || 'drawing units';
    const unitsElem = document.getElementById('units');
    if (unitsElem) unitsElem.textContent = drawingUnitLabel;
    bounds = calculateBounds(entities);
    const dElem = document.getElementById('distance');
    if (dElem) dElem.textContent = '—';
    const aElem = document.getElementById('angle');
    if (aElem) aElem.textContent = '—';
    updateSelectionPanel();
    renderLayerPanel();

    showCanvas();
    fitToView();
    redraw();

    const autoEnabled = !!(automationConfig && automationConfig.enabled);
    if (autoEnabled && window.electronAPI.reportViewReady) {
      const payload = {
        filePath,
        units: drawingUnitLabel,
        layerCount: Object.keys(layerColorMap || {}).length,
        view: { zoom: currentZoom, panX, panY, viewportWidth, viewportHeight },
        bounds,
        conversion: lastConversionStats,
        timestamp: new Date().toISOString()
      };
      const report = await window.electronAPI.reportViewReady(payload);
      console.log('[automation] report-view-ready:', report);
    }
  } catch (error) {
    showError(`Error loading file: ${error.message}`);
  }
}

function reprocessCachedDrawing() {
  if (!parseCache) return;
  entities = convertDXFEntities(
    parseCache.entities,
    parseCache.blocks,
    parseCache.source,
    parseCache.unitsCode,
    currentReaderProfile,
    currentSpaceView
  );
  snapCacheDirty = true;
  bounds = calculateBounds(entities);
  updateSelectionPanel();
  fitToView();
  redraw();
}

function updateFileInfo(info) {
  document.getElementById('fileInfo').textContent = `${info.name} (${info.extension?.toUpperCase()})`;
  document.getElementById('format').textContent = info.extension?.toUpperCase() || '—';
  document.getElementById('version').textContent = '—';
  document.getElementById('size').textContent = formatFileSize(info.size);
  const unitsElem = document.getElementById('units');
  if (unitsElem) unitsElem.textContent = 'Detecting...';
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function showCanvas() {
  const dz = document.getElementById('dropZone');
  if (dz) dz.style.display = 'none';
  canvas.style.display = 'block';
  resizeCanvasToContainer();
}

function fitToView() {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (viewportWidth <= 0 || viewportHeight <= 0 || width <= 0 || height <= 0) return;

  const scaleX = (viewportWidth * 0.9) / width;
  const scaleY = (viewportHeight * 0.9) / height;

  currentZoom = Math.min(scaleX, scaleY);
  panX = (viewportWidth - width * currentZoom) / 2 - bounds.minX * currentZoom;
  panY = (viewportHeight + height * currentZoom) / 2 + bounds.minY * currentZoom;

  redraw();
}

function renderFrame() {
  if (!ctx) return;

  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, viewportWidth, viewportHeight);

  ctx.strokeStyle = backgroundColor.toLowerCase() === '#ffffff' ? '#e8e8e8' : 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;

  // Draw grid
  const gridSize = 10;
  const gridStepPx = gridSize * currentZoom;
  // Draw grid only when useful; dense grids make drawings look fuzzy.
  if (gridStepPx >= 18) {
    for (let i = 0; i <= viewportWidth; i += gridStepPx) {
      ctx.beginPath();
      ctx.moveTo(crisp(i + panX), 0);
      ctx.lineTo(crisp(i + panX), viewportHeight);
      ctx.stroke();
    }

    for (let i = 0; i <= viewportHeight; i += gridStepPx) {
      ctx.beginPath();
      ctx.moveTo(0, crisp(i + panY));
      ctx.lineTo(viewportWidth, crisp(i + panY));
      ctx.stroke();
    }
  }

  // Draw entities (hatches first so linework remains legible)
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  ctx.fillStyle = 'rgba(52, 152, 219, 0.1)';
  const view = getWorldViewportBounds(12);

  for (const entity of entities) {
    if (!isEntityVisible(entity, view)) continue;
    if (!isLayerVisible(entity.layer)) continue;
    if (entity.type !== 'hatch') continue;
    if (!showHatches) continue;
    const clip = entity.viewportClip;
    if (clip && Number.isFinite(clip.minX) && Number.isFinite(clip.minY) && Number.isFinite(clip.maxX) && Number.isFinite(clip.maxY)) {
      const pA = getScreenPoint(clip.minX, clip.maxY);
      const pB = getScreenPoint(clip.maxX, clip.minY);
      const xClip = Math.min(pA.x, pB.x);
      const yClip = Math.min(pA.y, pB.y);
      const wClip = Math.abs(pB.x - pA.x);
      const hClip = Math.abs(pB.y - pA.y);
      ctx.save();
      ctx.beginPath();
      ctx.rect(xClip, yClip, wClip, hClip);
      ctx.clip();
    }
    const base = getEffectiveEntityColor(entity, '#7f8c8d');
    drawHatchPattern(entity, base);
    if (clip) {
      ctx.restore();
    }
  }

  for (const entity of entities) {
    if (!isEntityVisible(entity, view)) continue;
    if (!isLayerVisible(entity.layer)) continue;
    if (entity.type === 'hatch') continue;
    if (!showAnnotations && (entity.type === 'text' || entity.type === 'dimension')) continue;

    const isSelected = selectedEntityIds.includes(entity.id);
    const baseColor = getEffectiveEntityColor(entity, '#000000');
    ctx.strokeStyle = isSelected ? '#e67e22' : baseColor;
    ctx.fillStyle = isSelected ? '#e67e22' : baseColor;
    ctx.lineWidth = isSelected ? 2 : 1;
    const dash = linetypeDashPattern(layerLinetype(entity.layer));
    ctx.setLineDash(dash);
    const clip = entity.viewportClip;
    if (clip && Number.isFinite(clip.minX) && Number.isFinite(clip.minY) && Number.isFinite(clip.maxX) && Number.isFinite(clip.maxY)) {
      const pA = getScreenPoint(clip.minX, clip.maxY);
      const pB = getScreenPoint(clip.maxX, clip.minY);
      const xClip = Math.min(pA.x, pB.x);
      const yClip = Math.min(pA.y, pB.y);
      const wClip = Math.abs(pB.x - pA.x);
      const hClip = Math.abs(pB.y - pA.y);
      ctx.save();
      ctx.beginPath();
      ctx.rect(xClip, yClip, wClip, hClip);
      ctx.clip();
    }
    const center = getScreenPoint(entity.x || 0, entity.y || 0);
    const x = center.x;
    const y = center.y;

    switch (entity.type) {
      case 'line':
      case 'dimension-line': {
        const p1 = getScreenPoint(entity.x1, entity.y1);
        const p2 = getScreenPoint(entity.x2, entity.y2);
        ctx.beginPath();
        ctx.moveTo(crisp(p1.x), crisp(p1.y));
        ctx.lineTo(crisp(p2.x), crisp(p2.y));
        ctx.stroke();
        break;
      }

      case 'circle':
        ctx.beginPath();
        ctx.arc(x, y, entity.r * currentZoom, 0, Math.PI * 2);
        ctx.stroke();
        break;

      case 'arc': {
        const norm = normalizeArcForCanvas(entity.startAngle, entity.endAngle, !!entity.clockwise, entity.angleUnit || 'rad');
        const screenStart = -norm.start;
        const screenEnd = -norm.end;
        ctx.beginPath();
        ctx.arc(x, y, entity.r * currentZoom, screenStart, screenEnd, !norm.clockwise);
        ctx.stroke();
        break;
      }

      case 'filled-triangle': {
        if (!Array.isArray(entity.points) || entity.points.length < 3) break;
        const p0 = getScreenPoint(entity.points[0].x, entity.points[0].y);
        const p1 = getScreenPoint(entity.points[1].x, entity.points[1].y);
        const p2 = getScreenPoint(entity.points[2].x, entity.points[2].y);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      }

      case 'text':
      case 'dimension': {
        const p = getScreenPoint(entity.x, entity.y);
        const nominalSize = (entity.height || 2.5) * currentZoom * 0.9;
        const size = entity.viewportClip ? Math.max(1, nominalSize) : Math.max(6, nominalSize);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(entity.rotation || 0);
        ctx.font = `${size}px "Segoe UI", sans-serif`;
        ctx.textBaseline = 'middle';
        const lines = String(entity.text || '').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i]) continue;
          const yOffset = (i - (lines.length - 1) / 2) * size * 1.2;
          ctx.fillText(lines[i], 0, yOffset);
        }
        ctx.restore();
        break;
      }

      case 'rect':
        ctx.fillRect(x, y, entity.w * currentZoom, entity.h * currentZoom);
        ctx.strokeRect(x, y, entity.w * currentZoom, entity.h * currentZoom);
        break;

      case 'image': {
        const p0 = getScreenPoint(entity.p0.x, entity.p0.y);
        const p1 = getScreenPoint(entity.p1.x, entity.p1.y);
        const p3 = getScreenPoint(entity.p3.x, entity.p3.y);

        const vx = { x: p1.x - p0.x, y: p1.y - p0.y };
        const vy = { x: p3.x - p0.x, y: p3.y - p0.y };
        const imgW = Math.max(1, Number(entity.imageWidth) || 1);
        const imgH = Math.max(1, Number(entity.imageHeight) || 1);

        const asset = getImageAsset(entity.sourcePath);
        if (asset?.status === 'ready' && asset.img) {
          ctx.save();
          ctx.setTransform(vx.x / imgW, vx.y / imgW, vy.x / imgH, vy.y / imgH, p0.x, p0.y);
          ctx.drawImage(asset.img, 0, 0, imgW, imgH);
          ctx.restore();
        }

        // Always draw frame to preserve CAD reference intent when image fails to load.
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.lineTo(p1.x + vy.x, p1.y + vy.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.closePath();
        ctx.stroke();
        break;
      }

      case 'underlay': {
        const p0 = getScreenPoint(entity.p0.x, entity.p0.y);
        const p1 = getScreenPoint(entity.p1.x, entity.p1.y);
        const p2 = getScreenPoint(entity.p2.x, entity.p2.y);
        const p3 = getScreenPoint(entity.p3.x, entity.p3.y);

        ctx.save();
        ctx.setLineDash([6, 3]);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);

        const label = `${String(entity.kind || 'UNDERLAY').toUpperCase()}${entity.sourcePath ? `: ${entity.sourcePath}` : ''}`;
        const size = Math.max(10, 10 * Math.min(2, currentZoom));
        ctx.font = `${size}px "Segoe UI", sans-serif`;
        ctx.fillText(label, p0.x + 4, p0.y - 4);
        ctx.restore();
        break;
      }
    }
    if (clip) {
      ctx.restore();
    }
  }

  if (activeSnap) {
    const p = getScreenPoint(activeSnap.x, activeSnap.y);
    ctx.save();
    ctx.fillStyle = '#27ae60';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (measureMode && measureStart && measureCurrent) {
    const p1 = getScreenPoint(measureStart.x, measureStart.y);
    const p2 = getScreenPoint(measureCurrent.x, measureCurrent.y);
    const dx = measureCurrent.x - measureStart.x;
    const dy = measureCurrent.y - measureStart.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    ctx.save();
    ctx.strokeStyle = '#e74c3c';
    ctx.fillStyle = '#e74c3c';
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(p1.x, p1.y, 3, 0, Math.PI * 2);
    ctx.arc(p2.x, p2.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '12px Segoe UI, sans-serif';
    ctx.fillText(`${dist.toFixed(4)} ${unitsLabel()}`, (p1.x + p2.x) / 2 + 8, (p1.y + p2.y) / 2 - 8);
    ctx.restore();
  }

  if (isMarqueeZooming && marqueeStartScreen && marqueeCurrentScreen) {
    const x1 = marqueeStartScreen.x;
    const y1 = marqueeStartScreen.y;
    const x2 = marqueeCurrentScreen.x;
    const y2 = marqueeCurrentScreen.y;
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#1f8ef1';
    ctx.fillStyle = 'rgba(31, 142, 241, 0.12)';
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }
}

function redraw() {
  if (redrawScheduled) return;
  redrawScheduled = true;
  window.requestAnimationFrame(() => {
    redrawScheduled = false;
    renderFrame();
  });
}

function handleCanvasMouseDown(e) {
  hideTooltip();
  clickDownScreen = { x: e.clientX, y: e.clientY, button: e.button };
  clickDownWorld = getWorldPoint(e.clientX, e.clientY);

  const shouldStartMarquee = (!measureMode && !isPanning && e.button === 0 && e.altKey) || (marqueeZoomMode && e.button === 0);
  if (shouldStartMarquee) {
    e.preventDefault();
    const p = getCanvasPoint(e.clientX, e.clientY);
    isMarqueeZooming = true;
    marqueeStartScreen = { x: p.x, y: p.y };
    marqueeCurrentScreen = { x: p.x, y: p.y };
    redraw();
    return;
  }

  if (e.button === 1) {
    e.preventDefault();
    isDraggingPan = true;
    panDragStart = { x: e.clientX, y: e.clientY };
    return;
  }

  if (isPanning && e.button === 0) {
    isDraggingPan = true;
    panDragStart = { x: e.clientX, y: e.clientY };
    return;
  }

  if (measureMode && e.button === 0) {
    const world = getWorldPoint(e.clientX, e.clientY);
    const snap = findSnapPoint(world);
    const p = snap ?? world;

    if (!measureStart) {
      measureStart = { x: p.x, y: p.y };
      measureCurrent = { x: p.x, y: p.y };
      activeSnap = snap;
    } else {
      const end = { x: p.x, y: p.y };
      const dx = end.x - measureStart.x;
      const dy = end.y - measureStart.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);

      const dElem = document.getElementById('distance');
      if (dElem) dElem.textContent = `${distance.toFixed(4)} ${unitsLabel()}`;
      const aElem = document.getElementById('angle');
      if (aElem) aElem.textContent = `${angle.toFixed(2)}°`;

      measureStart = null;
      measureCurrent = null;
      activeSnap = null;
    }
    redraw();
  }
}

function handleCanvasMouseMove(e) {
  if (isMarqueeZooming) {
    const p = getCanvasPoint(e.clientX, e.clientY);
    marqueeCurrentScreen = { x: p.x, y: p.y };
    redraw();
  } else if (isDraggingPan && panDragStart) {
    const dx = e.clientX - panDragStart.x;
    const dy = e.clientY - panDragStart.y;
    panX += dx;
    panY += dy;
    panDragStart = { x: e.clientX, y: e.clientY };
    redraw();
  } else if (measureMode && measureStart) {
    const world = getWorldPoint(e.clientX, e.clientY);
    const snap = findSnapPoint(world);
    const nextMeasure = snap ? { x: snap.x, y: snap.y } : world;
    const changed = !sameSnap(activeSnap, snap) ||
      Math.abs((measureCurrent?.x || 0) - nextMeasure.x) > 1e-9 ||
      Math.abs((measureCurrent?.y || 0) - nextMeasure.y) > 1e-9;
    activeSnap = snap;
    measureCurrent = nextMeasure;
    if (changed) redraw();
  } else {
    const world = getWorldPoint(e.clientX, e.clientY);
    const nextSnap = findSnapPoint(world);
    if (!sameSnap(activeSnap, nextSnap)) {
      activeSnap = nextSnap;
      redraw();
    }
    // Hover tooltip: pick nearest entity and show/update
    const hit = pickEntityAt(world);
    if (hit !== hoveredEntity) {
      hoveredEntity = hit;
      if (hit) {
        showTooltip(hit, e.clientX, e.clientY);
      } else {
        hideTooltip();
      }
    } else if (hit) {
      updateTooltipPosition(e.clientX, e.clientY);
    }
  }
}

function handleCanvasMouseUp(e) {
  if (isMarqueeZooming) {
    const p = getCanvasPoint(e.clientX, e.clientY);
    applyMarqueeZoom(marqueeStartScreen, p);
    isMarqueeZooming = false;
    marqueeStartScreen = null;
    marqueeCurrentScreen = null;
    clickDownScreen = null;
    clickDownWorld = null;
    return;
  }

  if (isDraggingPan) {
    isDraggingPan = false;
    panDragStart = null;
  }

  if (measureMode) {
    return;
  }

  if (clickDownScreen && clickDownScreen.button === 0) {
    const dx = e.clientX - clickDownScreen.x;
    const dy = e.clientY - clickDownScreen.y;
    const clickDistance = Math.sqrt(dx * dx + dy * dy);
    if (clickDistance <= 4) {
      const world = getWorldPoint(e.clientX, e.clientY);
      const picked = pickEntityAt(world);
      if (!e.shiftKey) {
        selectedEntityIds = [];
      }
      if (picked) {
        if (selectedEntityIds.includes(picked.id)) {
          if (e.shiftKey) selectedEntityIds = selectedEntityIds.filter((id) => id !== picked.id);
        } else {
          selectedEntityIds.push(picked.id);
        }
      }
      updateSelectionPanel();
      redraw();
    }
  }

  clickDownScreen = null;
  clickDownWorld = null;
}

function handleCanvasWheel(e) {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const direction = e.deltaY < 0 ? 1 : -1;
  const zoomFactor = direction > 0 ? 1.12 : 1 / 1.12;
  zoomAt(mouseX, mouseY, zoomFactor);
}

function showError(message) {
  console.error('showError:', message);
  const errorDiv = document.getElementById('errorDisplay');
  if (!errorDiv) return;
  errorDiv.textContent = message;
  errorDiv.style.display = 'block';
  const dz2 = document.getElementById('dropZone');
  if(dz2) dz2.style.display = 'block';
  if (canvas) canvas.style.display = 'none';
}

function convertDXFEntities(dxfEntities, dxfBlocks = null, parseSource = 'unknown', unitsCode = null, readerProfile = null, spaceView = 'model') {
  const out = [];
  const blockMap = (dxfBlocks && typeof dxfBlocks === 'object') ? dxfBlocks : {};
  const profile = {
    name: 'fidelity',
    readModelSpace: true,
    readPaperSpace: false,
    respectLayerVisibility: true,
    readVisibleAttributesAsText: true,
    readProxyEntityGraphics: true,
    preserveComplexHatches: true,
    readExternalReferences: false,
    ...(readerProfile || {})
  };
  const automationDiag = {
    dimTypeCounts: {},
    insertCount: 0,
    insertResolved: 0,
    insertMissing: 0,
    blockCount: 0,
    blockWithBase: 0,
    blockWithNonZeroBase: 0,
    arcCount: 0,
    arcSamples: [],
    mtextByLayer: {},
    mtextSamples: []
  };

  const MAX_INSERT_DEPTH = 4;

  // Debug: log all entity types found in the DWG file
  let loggedMleaderSample = false;

  if (dxfEntities && dxfEntities.length > 0) {
    const entityTypeCounts = {};
    for (const e of dxfEntities) {
      const type = e.type || 'UNKNOWN';
      entityTypeCounts[type] = (entityTypeCounts[type] || 0) + 1;
    }
    console.log('=== DWG ENTITY ANALYSIS ===');
    console.log('Entity types:', JSON.stringify(entityTypeCounts, null, 2));
    console.log('Total:', dxfEntities.length);

    if (automationConfig?.enabled) {
      const dimCounts = {};
      let insertCount = 0;
      let insertResolved = 0;
      let insertMissing = 0;
      for (const e of dxfEntities) {
        if (e?.type === 'DIMENSION') {
          const raw = Number(e.dimensionType ?? e.dimType ?? -1);
          const base = Number.isFinite(raw) ? (raw & 0x0f) : -1;
          dimCounts[String(base)] = (dimCounts[String(base)] || 0) + 1;
        }
        if (e?.type === 'INSERT') {
          insertCount++;
          const n = e.name || e.block || e.blockName;
          const has = !!(blockMap?.[n] || blockMap?.[String(n || '').toUpperCase()]);
          if (has) insertResolved++; else insertMissing++;
        }
        if (e?.type === 'MTEXT') {
          const lyr = String(e.layer || '0').toUpperCase();
          automationDiag.mtextByLayer[lyr] = (automationDiag.mtextByLayer[lyr] || 0) + 1;
          if (automationDiag.mtextSamples.length < 6) {
            const txt = sanitizeText(e.plainText || e.text || e.string || e.rawText || '');
            automationDiag.mtextSamples.push({
              layer: lyr,
              text: txt.slice(0, 140),
              hasPlainText: !!e.plainText
            });
          }
        }
        if (e?.type === 'ARC') {
          automationDiag.arcCount += 1;
          if (automationDiag.arcSamples.length < 8) {
            automationDiag.arcSamples.push({
              layer: e.layer || '0',
              startAngle: e.startAngle,
              endAngle: e.endAngle,
              clockwise: e.clockwise,
              counterClockwise: e.counterClockwise,
              ccw: e.ccw,
              direction: e.direction,
              angleUnit: e.angleUnit ?? e.angleUnits ?? null,
              extrusionZ: e.extrusion?.z ?? e.normal?.z ?? null
            });
          }
        }
      }
      const blockEntries = Object.values(blockMap || {});
      const blockWithBase = blockEntries.filter((b) => Number.isFinite(b?.basePoint?.x) && Number.isFinite(b?.basePoint?.y)).length;
      const blockWithNonZeroBase = blockEntries.filter((b) => (Math.abs(Number(b?.basePoint?.x || 0)) > 1e-9 || Math.abs(Number(b?.basePoint?.y || 0)) > 1e-9)).length;
      automationDiag.dimTypeCounts = dimCounts;
      automationDiag.insertCount = insertCount;
      automationDiag.insertResolved = insertResolved;
      automationDiag.insertMissing = insertMissing;
      automationDiag.blockCount = blockEntries.length;
      automationDiag.blockWithBase = blockWithBase;
      automationDiag.blockWithNonZeroBase = blockWithNonZeroBase;
      console.log('[automation] DIMENSION type counts:', JSON.stringify(dimCounts));
      console.log('[automation] INSERT resolution:', { insertCount, insertResolved, insertMissing });
      console.log('[automation] BLOCK base points:', { blockCount: blockEntries.length, blockWithBase, blockWithNonZeroBase });
      console.log('[automation] ARC samples:', automationDiag.arcSamples);
    }

    if (!loggedMleaderSample) {
      const sample = dxfEntities.find((ent) => {
        const t = String(ent?.type || '').toUpperCase();
        return t === 'MLEADER' || t === 'MULTILEADER';
      });
      if (sample) {
        loggedMleaderSample = true;
        const topKeys = Object.keys(sample).slice(0, 60);
        const contextKeys = sample?.contextData && typeof sample.contextData === 'object'
          ? Object.keys(sample.contextData).slice(0, 60)
          : [];
        console.log('[automation] MLEADER sample keys:', topKeys);
        if (contextKeys.length) {
          console.log('[automation] MLEADER contextData keys:', contextKeys);
        }
      }
    }
  }

  const renderStats = { processed: 0, skipped: 0, skippedTypes: {}, diagnostics: automationDiag };
  const clipStack = [];

  function activeClip() {
    return clipStack.length ? clipStack[clipStack.length - 1] : null;
  }

  function degToRad(deg) {
    return (deg || 0) * Math.PI / 180;
  }

  function mapHorizontalAlign(code) {
    const n = Number(code ?? 0);
    if (n === 1 || n === 4) return 'center';
    if (n === 2) return 'right';
    return 'left';
  }

  function mapVerticalAlign(code) {
    const n = Number(code ?? 0);
    if (n === 3) return 'top';
    if (n === 2) return 'middle';
    if (n === 1) return 'bottom';
    return 'baseline';
  }

  function mapMTextAttachment(code) {
    // MTEXT attachmentPoint: 1..9 = TL,TC,TR,ML,MC,MR,BL,BC,BR
    const n = Number(code ?? 7);
    const col = ((n - 1) % 3 + 3) % 3;
    const row = Math.floor((n - 1) / 3);
    const alignX = col === 0 ? 'left' : (col === 1 ? 'center' : 'right');
    const alignY = row === 0 ? 'top' : (row === 1 ? 'middle' : 'bottom');
    return { alignX, alignY };
  }

  function midpoint(a, b) {
    return {
      x: ((a?.x || 0) + (b?.x || 0)) / 2,
      y: ((a?.y || 0) + (b?.y || 0)) / 2
    };
  }

  function formatArchitecturalInches(valueInInches) {
    const sign = valueInInches < 0 ? '-' : '';
    const abs = Math.abs(valueInInches);
    let feet = Math.floor(abs / 12);
    const rem = abs - feet * 12;
    const denom = 16;
    let num = Math.round(rem * denom);
    let wholeInches = Math.floor(num / denom);
    num = num % denom;

    if (wholeInches >= 12) {
      feet += 1;
      wholeInches -= 12;
    }

    let frac = '';
    if (num > 0) {
      let a = num;
      let b = denom;
      while (b !== 0) {
        const t = a % b;
        a = b;
        b = t;
      }
      frac = `${num / a}/${denom / a}`;
    }

    const inchPart = [wholeInches > 0 ? String(wholeInches) : '', frac].filter(Boolean).join(' ');
    if (feet > 0) return `${sign}${feet}'-${inchPart || '0'}\"`;
    return `${sign}${inchPart || '0'}\"`;
  }

  function formatDimensionMeasurement(value, code) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    // INSUNITS: 1 inches, 2 feet, 21 US survey feet, 22 US survey inch.
    if (code === 1 || code === 22) return formatArchitecturalInches(n);
    if (code === 2 || code === 21) return `${n.toFixed(3).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')}'`;
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  }

  function distance(a, b) {
    const dx = (b?.x || 0) - (a?.x || 0);
    const dy = (b?.y || 0) - (a?.y || 0);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function normalizeVec(x, y) {
    const len = Math.sqrt(x * x + y * y);
    if (len < 1e-9) return { x: 1, y: 0, len: 0 };
    return { x: x / len, y: y / len, len };
  }

  function arrowStyleForEntity(entity, fallback = 'closed-filled') {
    const styleName = String(entity?.styleName || entity?.dimStyleName || entity?.dimstyle || '').toUpperCase();
    const blk1 = String(entity?.dimblk1 || entity?.arrowBlock1 || entity?.arrowBlock || '').toUpperCase();
    const blk2 = String(entity?.dimblk2 || entity?.arrowBlock2 || '').toUpperCase();
    const merged = `${styleName} ${blk1} ${blk2}`;
    if (merged.includes('OBLIQUE') || merged.includes('ARCHTICK') || merged.includes('TICK')) return 'tick';
    if (merged.includes('DOT') || merged.includes('ORIGIN')) return 'dot';
    return fallback;
  }

  function addFilledTriangle(a, b, c, style) {
    const ent = {
      id: nextEntityId++,
      type: 'filled-triangle',
      points: [a, b, c],
      layer: style?.layer,
      color: style?.color,
      viewportClip: activeClip()
    };
    out.push(setBBox(
      ent,
      Math.min(a.x, b.x, c.x),
      Math.min(a.y, b.y, c.y),
      Math.max(a.x, b.x, c.x),
      Math.max(a.y, b.y, c.y)
    ));
  }

  function addArrowHead(tip, dir, size, style, arrowStyle = 'closed-filled') {
    const d = normalizeVec(dir.x, dir.y);
    const wing = Math.max(0.0001, size);
    const back = { x: tip.x - d.x * wing, y: tip.y - d.y * wing };
    const perp = { x: -d.y, y: d.x };
    const left = { x: back.x + perp.x * wing * 0.42, y: back.y + perp.y * wing * 0.42 };
    const right = { x: back.x - perp.x * wing * 0.42, y: back.y - perp.y * wing * 0.42 };
    const mode = String(arrowStyle || 'closed-filled').toLowerCase();
    if (mode === 'tick') {
      const tickA = { x: tip.x - d.x * wing * 0.55 + perp.x * wing * 0.55, y: tip.y - d.y * wing * 0.55 + perp.y * wing * 0.55 };
      const tickB = { x: tip.x - d.x * wing * 0.55 - perp.x * wing * 0.55, y: tip.y - d.y * wing * 0.55 - perp.y * wing * 0.55 };
      addLine(tickA.x, tickA.y, tickB.x, tickB.y, style);
      return;
    }
    if (mode === 'dot') {
      addCircle(tip.x - d.x * wing * 0.25, tip.y - d.y * wing * 0.25, wing * 0.24, style);
      return;
    }
    if (mode === 'open') {
      addLine(tip.x, tip.y, left.x, left.y, style);
      addLine(tip.x, tip.y, right.x, right.y, style);
      return;
    }
    addFilledTriangle(tip, left, right, style);
    addLine(left.x, left.y, right.x, right.y, style);
  }

  function axisAlignedDirection(p1, p2) {
    const dx = (p2?.x || 0) - (p1?.x || 0);
    const dy = (p2?.y || 0) - (p1?.y || 0);
    // For rotated/linear dimensions with missing angle, prefer orthogonal orientation.
    return Math.abs(dx) >= Math.abs(dy) ? { x: 1, y: 0 } : { x: 0, y: 1 };
  }

  function drawWeldSymbol(base, dir, size, style, kind = 'FILLET') {
    const d = normalizeVec(dir.x, dir.y);
    const perp = { x: -d.y, y: d.x };
    const s = Math.max(1.0, size);
    const k = String(kind || 'FILLET').toUpperCase();
    // Baseline of reference line segment at the annotation end.
    const a = { x: base.x - d.x * s * 1.2, y: base.y - d.y * s * 1.2 };
    const b = { x: base.x + d.x * s * 1.2, y: base.y + d.y * s * 1.2 };
    addLine(a.x, a.y, b.x, b.y, style);
    if (k.includes('GROOVE') || k.includes('V')) {
      const m = midpoint(a, b);
      addLine(m.x - d.x * s * 0.6, m.y - d.y * s * 0.6, m.x + perp.x * s * 0.8, m.y + perp.y * s * 0.8, style);
      addLine(m.x + d.x * s * 0.6, m.y + d.y * s * 0.6, m.x + perp.x * s * 0.8, m.y + perp.y * s * 0.8, style);
      return;
    }
    // Default fillet triangle.
    addLine(a.x, a.y, a.x + perp.x * s * 0.9, a.y + perp.y * s * 0.9, style);
    addLine(a.x + perp.x * s * 0.9, a.y + perp.y * s * 0.9, b.x, b.y, style);
  }

  function drawFinishSymbol(base, dir, size, style, withBar = false, withCircle = false) {
    const d = normalizeVec(dir.x, dir.y);
    const perp = { x: -d.y, y: d.x };
    const s = Math.max(1.0, size);
    const p0 = { x: base.x - d.x * s * 0.8, y: base.y - d.y * s * 0.8 };
    const p1 = { x: base.x + perp.x * s * 1.1, y: base.y + perp.y * s * 1.1 };
    const p2 = { x: p1.x + d.x * s * 0.8, y: p1.y + d.y * s * 0.8 };
    // ISO-style surface finish check mark.
    addLine(p0.x, p0.y, p1.x, p1.y, style);
    addLine(p1.x, p1.y, p2.x, p2.y, style);
    if (withBar) {
      const b1 = { x: p1.x - d.x * s * 0.65, y: p1.y - d.y * s * 0.65 };
      const b2 = { x: p2.x + d.x * s * 0.45, y: p2.y + d.y * s * 0.45 };
      addLine(b1.x, b1.y, b2.x, b2.y, style);
    }
    if (withCircle) {
      const c = { x: p0.x - d.x * s * 0.45, y: p0.y - d.y * s * 0.45 };
      addCircle(c.x, c.y, s * 0.25, style);
    }
  }

  function attachLeaderSymbols(entity, head, next, style, textValue = '') {
    const dir = { x: next.x - head.x, y: next.y - head.y };
    const symSize = arrowSizeFromSegment(head, next, 2.0) * 1.2;
    const upper = String(textValue || '').toUpperCase();
    const weldKind = entity?.weldSymbol || entity?.weldType || entity?.weld;
    const finishKind = entity?.surfaceFinish || entity?.finishSymbol || entity?.finish;
    if (weldKind || upper.includes('WELD')) {
      drawWeldSymbol(next, dir, symSize, style, weldKind || 'FILLET');
    }
    if (finishKind || upper.includes('SURFACE FINISH') || upper.includes('FINISH SYMBOL')) {
      const hasBar = /MACHIN|REMOVE|BAR/.test(upper) || String(finishKind || '').toUpperCase().includes('BAR');
      const hasCircle = /NO\s+MACHIN|CIRCLE/.test(upper) || String(finishKind || '').toUpperCase().includes('CIRCLE');
      drawFinishSymbol(next, dir, symSize, style, hasBar, hasCircle);
    }
  }

  function transformedTextHeight(height, t) {
    const base = Number.isFinite(height) && height > 0 ? height : 2.5;
    const s = (Math.abs(t?.sx ?? 1) + Math.abs(t?.sy ?? 1)) / 2;
    return base * (Number.isFinite(s) && s > 1e-9 ? s : 1);
  }

  function transformedUnitScale(t) {
    const s = (Math.abs(t?.sx ?? 1) + Math.abs(t?.sy ?? 1)) / 2;
    return Number.isFinite(s) && s > 1e-9 ? s : 1;
  }

  function arrowSizeFromSegment(a, b, fallback = 2.0) {
    const len = distance(a, b);
    if (!Number.isFinite(len) || len <= 1e-6) return fallback;
    return Math.max(0.8, Math.min(6.0, len * 0.12));
  }

  function resolveCurvePoints(rawPoints) {
    if (!Array.isArray(rawPoints)) return [];
    return rawPoints.filter((pt) => isFinitePoint(pt));
  }

  function getSplineWeights(entity, count) {
    if (!entity || count <= 0) return null;
    const weights = Array.isArray(entity.weights)
      ? entity.weights
      : (Array.isArray(entity.weight) ? entity.weight : null);
    if (Array.isArray(weights) && weights.length >= count) {
      return weights.slice(0, count).map((w) => {
        const n = Number(w);
        return Number.isFinite(n) && n > 1e-9 ? n : 1;
      });
    }
    const cpWeights = Array.isArray(entity.controlPoints)
      ? entity.controlPoints.map((pt) => Number(pt?.weight ?? pt?.w ?? 1))
      : [];
    if (cpWeights.length >= count) {
      return cpWeights.slice(0, count).map((w) => Number.isFinite(w) && w > 1e-9 ? w : 1);
    }
    return null;
  }

  function splineSpanCount(knots, degree, controlCount) {
    if (!Array.isArray(knots) || controlCount < 2) return 0;
    const p = Math.max(1, Math.min(Number(degree) || 3, controlCount - 1));
    const start = Number(knots[p]);
    const end = Number(knots[controlCount]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
    let spans = 0;
    for (let i = p; i < controlCount; i++) {
      const a = Number(knots[i]);
      const b = Number(knots[i + 1]);
      if (Number.isFinite(a) && Number.isFinite(b) && b - a > 1e-9) spans += 1;
    }
    return spans;
  }

  function findSplineSpan(knots, degree, controlCount, u) {
    const n = controlCount - 1;
    const p = Math.max(1, Math.min(Number(degree) || 3, n));
    const lowKnot = Number(knots[p]);
    const highKnot = Number(knots[n + 1]);
    if (u <= lowKnot) return p;
    if (u >= highKnot) return n;
    let low = p;
    let high = n + 1;
    let mid = Math.floor((low + high) / 2);
    while (u < Number(knots[mid]) || u >= Number(knots[mid + 1])) {
      if (u < Number(knots[mid])) high = mid;
      else low = mid;
      mid = Math.floor((low + high) / 2);
    }
    return mid;
  }

  function evaluateSplinePoint(controlPoints, knots, degree, u, weights = null) {
    const controlCount = Array.isArray(controlPoints) ? controlPoints.length : 0;
    if (controlCount === 0) return null;
    const p = Math.max(1, Math.min(Number(degree) || 3, controlCount - 1));
    if (!Array.isArray(knots) || knots.length < controlCount + p + 1) return null;
    const span = findSplineSpan(knots, p, controlCount, u);
    const d = [];
    for (let j = 0; j <= p; j++) {
      const src = controlPoints[span - p + j];
      const w = weights ? (Number(weights[span - p + j]) || 1) : 1;
      d[j] = {
        x: (src?.x || 0) * w,
        y: (src?.y || 0) * w,
        z: (src?.z || 0) * w,
        w
      };
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = span - p + j;
        const left = Number(knots[i]);
        const right = Number(knots[i + p - r + 1]);
        const denom = right - left;
        const alpha = Math.abs(denom) > 1e-12 ? (u - left) / denom : 0;
        d[j] = {
          x: (1 - alpha) * d[j - 1].x + alpha * d[j].x,
          y: (1 - alpha) * d[j - 1].y + alpha * d[j].y,
          z: (1 - alpha) * d[j - 1].z + alpha * d[j].z,
          w: (1 - alpha) * d[j - 1].w + alpha * d[j].w
        };
      }
    }
    const out = d[p];
    if (weights && Math.abs(out.w) > 1e-12) {
      return { x: out.x / out.w, y: out.y / out.w, z: out.z / out.w };
    }
    return { x: out.x, y: out.y, z: out.z };
  }

  function sampleFitSplinePoints(points, closed = false) {
    const pts = resolveCurvePoints(points);
    if (pts.length < 2) return pts;
    if (pts.length === 2) return pts;
    const out = [];
    const getPt = (idx) => {
      if (closed) return pts[(idx + pts.length) % pts.length];
      return pts[Math.max(0, Math.min(pts.length - 1, idx))];
    };
    const segCount = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < segCount; i++) {
      const p0 = getPt(i - 1);
      const p1 = getPt(i);
      const p2 = getPt(i + 1);
      const p3 = getPt(i + 2);
      const steps = 12;
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const t2 = t * t;
        const t3 = t2 * t;
        const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
        const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
        out.push({ x, y });
      }
    }
    out.push(pts[closed ? 0 : pts.length - 1]);
    return out;
  }

  function sampleSplinePoints(entity) {
    const fitPoints = resolveCurvePoints(entity?.fitPoints);
    if (fitPoints.length > 1) {
      const closed = !!(entity?.closed || entity?.periodic || ((Number(entity?.flag) || 0) & 1) === 1);
      return sampleFitSplinePoints(fitPoints, closed);
    }

    const controlPoints = resolveCurvePoints(entity?.controlPoints || entity?.vertices);
    const knots = Array.isArray(entity?.knots) ? entity.knots.map((v) => Number(v)) : null;
    if (controlPoints.length > 1 && Array.isArray(knots)) {
      const degree = Math.max(1, Math.min(Number(entity?.degree) || 3, controlPoints.length - 1));
      const start = Number(knots[degree]);
      const end = Number(knots[controlPoints.length]);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        const spans = splineSpanCount(knots, degree, controlPoints.length);
        const segments = Math.max(16, Math.min(192, spans * 16));
        const weights = getSplineWeights(entity, controlPoints.length);
        const out = [];
        for (let i = 0; i <= segments; i++) {
          const u = i === segments ? end : start + ((end - start) * i / segments);
          const pt = evaluateSplinePoint(controlPoints, knots, degree, u, weights);
          if (isFinitePoint(pt)) out.push(pt);
        }
        if (out.length > 1) return out;
      }
    }

    return controlPoints;
  }

  function sampleHelixPoints(entity) {
    const splineLike = sampleSplinePoints(entity);
    if (splineLike.length > 1) return splineLike;

    const center = resolvePoint(entity?.axisBasePoint, entity?.basePoint, entity?.center, entity?.position, entity?.origin);
    const startPoint = resolvePoint(entity?.startPoint, entity?.startVertex, entity?.point, entity?.referencePoint);
    if (!center) return [];

    const startRadius = Number(entity?.startRadius ?? entity?.baseRadius ?? entity?.radius ?? null);
    const endRadius = Number(entity?.endRadius ?? entity?.topRadius ?? entity?.radius2 ?? entity?.radius ?? null);
    const turns = Math.abs(Number(entity?.turns ?? entity?.turnCount ?? entity?.numberOfTurns ?? entity?.totalTurns ?? 1)) || 1;
    const clockwise = !!(entity?.clockwise || Number(entity?.handedness) < 0 || Number(entity?.twist) < 0);
    const dir = clockwise ? -1 : 1;
    const r0 = Number.isFinite(startRadius) ? startRadius : (startPoint ? distance(center, startPoint) : 0);
    const r1 = Number.isFinite(endRadius) ? endRadius : r0;
    if (!(r0 > 1e-9 || r1 > 1e-9)) return [];
    const startAngle = Number.isFinite(Number(entity?.startAngle))
      ? toRadians(Number(entity.startAngle))
      : (startPoint ? Math.atan2(startPoint.y - center.y, startPoint.x - center.x) : 0);
    const endAngle = startAngle + dir * turns * Math.PI * 2;
    const segments = Math.max(48, Math.min(512, Math.ceil(turns * 48)));
    const out = [];
    for (let i = 0; i <= segments; i++) {
      const f = i / segments;
      const angle = startAngle + (endAngle - startAngle) * f;
      const radius = r0 + (r1 - r0) * f;
      out.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
    }
    return out;
  }

  function combineTransform(base, local) {
    const rot = (base.rot || 0) + (local.rot || 0);
    const sx = (base.sx ?? 1) * (local.sx ?? 1);
    const sy = (base.sy ?? 1) * (local.sy ?? 1);
    const p = transformPoint({ x: local.tx || 0, y: local.ty || 0 }, base);
    return { tx: p.x, ty: p.y, sx, sy, rot };
  }

  function getBlockDefinition(name) {
    if (!name) return null;
    const key = String(name);
    return blockMap?.[key] || blockMap?.[key.toUpperCase()] || null;
  }

  function transformPoint(pt, t) {
    const sx = t?.sx ?? 1;
    const sy = t?.sy ?? 1;
    const rot = t?.rot ?? 0;
    const tx = t?.tx ?? 0;
    const ty = t?.ty ?? 0;
    const lx = (pt.x || 0) * sx;
    const ly = (pt.y || 0) * sy;
    const x = lx * Math.cos(rot) - ly * Math.sin(rot) + tx;
    const y = lx * Math.sin(rot) + ly * Math.cos(rot) + ty;
    return { x, y };
  }

  function isFinitePoint(pt) {
    return !!pt && Number.isFinite(pt.x) && Number.isFinite(pt.y);
  }

  function normalizePointLike(raw) {
    if (isFinitePoint(raw)) return { x: Number(raw.x), y: Number(raw.y) };
    if (Array.isArray(raw) && raw.length >= 2 && Number.isFinite(Number(raw[0])) && Number.isFinite(Number(raw[1]))) {
      return { x: Number(raw[0]), y: Number(raw[1]) };
    }
    if (!raw || typeof raw !== 'object') return null;
    return resolvePoint(
      raw.position,
      raw.point,
      raw.vertex,
      raw.location,
      raw.startPoint,
      raw.endPoint,
      raw.anchorPoint,
      raw.insert,
      raw.insertionPoint,
      pointFromXY(raw)
    );
  }

  function normalizePointArray(rawList) {
    if (!Array.isArray(rawList)) return [];
    const pts = [];
    for (const raw of rawList) {
      const pt = normalizePointLike(raw);
      if (pt) pts.push(pt);
    }
    return pts;
  }

  function resolvePoint(...candidates) {
    for (const p of candidates) {
      if (isFinitePoint(p)) return p;
    }
    return null;
  }

  function pointFromXY(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const x = Number(obj.x);
    const y = Number(obj.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function pointFromXYIfMeaningful(obj) {
    const p = pointFromXY(obj);
    if (!p) return null;
    const hasExplicitXY = Object.prototype.hasOwnProperty.call(obj, 'x') && Object.prototype.hasOwnProperty.call(obj, 'y');
    if (!hasExplicitXY) return null;
    // Some parsers materialize missing anchors as x=0,y=0 defaults for ATTRIB-like records.
    if (Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9) return null;
    return p;
  }

  function classifyEntitySpace(entity) {
    const boolFlag = entity?.paperSpace ?? entity?.paperspace ?? entity?.inPaperSpace ?? entity?.isPaperSpace;
    if (typeof boolFlag === 'boolean') return boolFlag ? 'paper' : 'model';

    const numericFlag = Number(entity?.space ?? entity?.ownerSpace ?? entity?.blockSpace);
    if (Number.isFinite(numericFlag)) {
      if (numericFlag === 1) return 'paper';
      if (numericFlag === 0) return 'model';
    }

    const textFlag = String(entity?.space ?? entity?.ownerSpace ?? entity?.layout ?? entity?.layoutName ?? '').toLowerCase();
    if (textFlag.includes('paper')) return 'paper';
    if (textFlag.includes('model')) return 'model';
    return 'unknown';
  }

  function shouldRenderEntitySpace(entitySpace) {
    const mode = String(spaceView || 'model').toLowerCase();
    const isPaper = entitySpace === 'paper';
    const isModel = entitySpace === 'model' || entitySpace === 'unknown';
    if (mode === 'both') return true;
    if (mode === 'layout') return isPaper;
    return isModel;
  }

  function getViewportProjection(def) {
    const w = Number(def?.width);
    const h = Number(def?.height);
    const vh = Number(def?.viewHeight);
    const vc = def?.viewportCenter;
    const dc = def?.displayCenter;
    if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(vh) || !vc || !dc) return null;
    if (w <= 1e-9 || h <= 1e-9 || vh <= 1e-9) return null;
    const s = h / vh;
    const r = -Number(def?.viewTwistAngle || 0);
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const dx = Number(dc.x || 0);
    const dy = Number(dc.y || 0);
    const cx = Number(vc.x || 0);
    const cy = Number(vc.y || 0);
    return {
      tx: cx - s * (dx * cos - dy * sin),
      ty: cy - s * (dx * sin + dy * cos),
      sx: s,
      sy: s,
      rot: r,
      clip: {
        minX: cx - w / 2,
        maxX: cx + w / 2,
        minY: cy - h / 2,
        maxY: cy + h / 2
      }
    };
  }

  function collectLayoutViewports(rawEntities) {
    const vps = [];
    for (const e of rawEntities || []) {
      if (String(e?.type || '').toUpperCase() !== 'VIEWPORT') continue;
      const layer = normalizeLayerName(e?.layer);
      const sameCenter = Math.abs(Number(e?.displayCenter?.x || 0) - Number(e?.viewportCenter?.x || 0)) < 1e-8
        && Math.abs(Number(e?.displayCenter?.y || 0) - Number(e?.viewportCenter?.y || 0)) < 1e-8;
      const sameHeight = Math.abs(Number(e?.viewHeight || 0) - Number(e?.height || 0)) < 1e-8;
      // Skip default full-sheet viewport shell record.
      if (layer === '0' && sameCenter && sameHeight) continue;
      const p = getViewportProjection(e);
      if (!p) continue;
      vps.push({ raw: e, projection: p });
    }
    return vps;
  }

  function getStyle(e, layer) {
    return {
      layer,
      color: extractEntityColor(e, layer) || layerColor(layer) || null
    };
  }

  function addLine(x1, y1, x2, y2, style) {
    const ent = {
      id: nextEntityId++,
      type: 'line',
      x1,
      y1,
      x2,
      y2,
      layer: style?.layer,
      color: style?.color,
      viewportClip: activeClip()
    };
    out.push(setBBox(ent, x1, y1, x2, y2));
  }

  function resolveVector(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const len = Math.sqrt(x * x + y * y);
    if (len < 1e-9) return null;
    return { x: x / len, y: y / len };
  }

  function resolveRayDirection(entity, startPoint) {
    const direct = resolveVector(
      entity?.unitVector ||
      entity?.directionVector ||
      entity?.direction ||
      entity?.dir ||
      entity?.vector
    );
    if (direct) return direct;

    const secondPoint = resolvePoint(
      entity?.secondPoint,
      entity?.throughPoint,
      entity?.targetPoint,
      entity?.endPoint,
      entity?.point2
    );
    if (secondPoint && startPoint) {
      return resolveVector({ x: secondPoint.x - startPoint.x, y: secondPoint.y - startPoint.y });
    }
    return null;
  }

  function addArc(x, y, r, startAngle, endAngle, style, clockwise = false, angleUnit = 'rad') {
    const norm = normalizeArcForCanvas(startAngle, endAngle, clockwise, angleUnit);
    const ent = {
      id: nextEntityId++,
      type: 'arc',
      x,
      y,
      r,
      startAngle: norm.start,
      endAngle: norm.end,
      angleUnit: 'rad',
      clockwise: !!norm.clockwise,
      layer: style?.layer,
      color: style?.color,
      viewportClip: activeClip()
    };
    out.push(setBBox(ent, x - r, y - r, x + r, y + r));
  }

  function addCircle(x, y, r, style) {
    const ent = { id: nextEntityId++, type: 'circle', x, y, r, layer: style?.layer, color: style?.color, viewportClip: activeClip() };
    out.push(setBBox(ent, x - r, y - r, x + r, y + r));
  }

  function addText(x, y, text, height, rotation, style, kind = 'text', options = null) {
    const clean = sanitizeText(text || '');
    if (!clean) return;
    const h = Number.isFinite(height) && height > 0 ? height : 2.5;
    const lines = clean.split('\n');
    const maxLen = Math.max(...lines.map((ln) => ln.length), 1);
    const approxW = Math.max(h * 0.55 * maxLen, h * 2);
    const approxH = h * Math.max(lines.length, 1);
    const ent = {
      id: nextEntityId++,
      type: kind,
      x,
      y,
      text: clean,
      height: h,
      rotation: rotation || 0,
      alignX: options?.alignX || 'left',
      alignY: options?.alignY || 'baseline',
      lineHeight: options?.lineHeight || 1.2,
      layer: style?.layer,
      color: style?.color,
      viewportClip: activeClip()
    };
    out.push(setBBox(ent, x, y - approxH, x + approxW, y + h));
  }

  function addHatch(loops, angle, spacing, style, patternName = null) {
    if (!Array.isArray(loops) || loops.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let validPointCount = 0;

    for (const loop of loops) {
      for (const p of loop) {
        if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
        validPointCount++;
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    if (validPointCount < 3) return;

    const ent = {
      id: nextEntityId++,
      type: 'hatch',
      loops,
      angle,
      spacing,
      patternName,
      layer: style?.layer,
      color: style?.color || '#7f8c8d',
      viewportClip: activeClip()
    };
    out.push(setBBox(ent, minX, minY, maxX, maxY));
  }

  function addImageFrame(p0, p1, p3, style, sourcePath = null, imageWidth = 1, imageHeight = 1) {
    if (!isFinitePoint(p0) || !isFinitePoint(p1) || !isFinitePoint(p3)) return;
    const p2 = { x: p1.x + (p3.x - p0.x), y: p1.y + (p3.y - p0.y) };
    const ent = {
      id: nextEntityId++,
      type: 'image',
      p0,
      p1,
      p2,
      p3,
      sourcePath,
      imageWidth,
      imageHeight,
      layer: style?.layer,
      color: style?.color,
      viewportClip: activeClip()
    };
    out.push(setBBox(
      ent,
      Math.min(p0.x, p1.x, p2.x, p3.x),
      Math.min(p0.y, p1.y, p2.y, p3.y),
      Math.max(p0.x, p1.x, p2.x, p3.x),
      Math.max(p0.y, p1.y, p2.y, p3.y)
    ));
  }

  function addUnderlayFrame(p0, p1, p3, style, kind = 'UNDERLAY', sourcePath = null) {
    if (!isFinitePoint(p0) || !isFinitePoint(p1) || !isFinitePoint(p3)) return;
    const p2 = { x: p1.x + (p3.x - p0.x), y: p1.y + (p3.y - p0.y) };
    const ent = {
      id: nextEntityId++,
      type: 'underlay',
      kind,
      sourcePath,
      p0,
      p1,
      p2,
      p3,
      layer: style?.layer,
      color: style?.color,
      viewportClip: activeClip()
    };
    out.push(setBBox(
      ent,
      Math.min(p0.x, p1.x, p2.x, p3.x),
      Math.min(p0.y, p1.y, p2.y, p3.y),
      Math.max(p0.x, p1.x, p2.x, p3.x),
      Math.max(p0.y, p1.y, p2.y, p3.y)
    ));
  }

  function meshPoint(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function meshFaceIndices(face) {
    if (Array.isArray(face)) {
      return face.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 0);
    }
    if (!face || typeof face !== 'object') return [];
    const arr = face.vertices || face.indices || face.vertexIndices || face.verts || null;
    if (Array.isArray(arr)) {
      return arr.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 0);
    }
    const named = [face.i0, face.i1, face.i2, face.i3]
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v >= 0);
    return named;
  }

  function addFaceLike(vertices, style) {
    if (!Array.isArray(vertices) || vertices.length < 3) return;
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i];
      const b = vertices[(i + 1) % vertices.length];
      if (!a || !b) continue;
      addLine(a.x, a.y, b.x, b.y, style);
    }
  }

  function processEntity(e, t = { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 }, depth = 0, parentLayer = null, opts = null) {
    if (!e || depth > MAX_INSERT_DEPTH) {
      renderStats.skipped++;
      return;
    }
    renderStats.processed++;

    const forceSpace = !!opts?.forceSpace;
    const entitySpace = classifyEntitySpace(e);
    if (!forceSpace && !shouldRenderEntitySpace(entitySpace)) {
      renderStats.skipped++;
      return;
    }

    const rawType = String(e.type || '').toUpperCase();
    if (!profile.readProxyEntityGraphics && (rawType.includes('PROXY') || rawType === 'ACAD_PROXY_ENTITY')) {
      renderStats.skipped++;
      return;
    }

    const layer = e.layer || parentLayer || '0';
    // Respect layer visibility set by the document author when profile enables it.
    const layerEntry = layerColorMap[layer?.toUpperCase()];
    if (profile.respectLayerVisibility && layerEntry?.visible === false) {
      renderStats.skipped++;
      return;
    }
    const style = getStyle(e, layer);
    const clipRect = opts?.clipRect || null;
    clipStack.push(clipRect);

    switch (e.type) {
      case 'LINE':
        if (e.vertices && e.vertices.length >= 2) {
          const p1 = transformPoint(e.vertices[0], t);
          const p2 = transformPoint(e.vertices[1], t);
          addLine(p1.x, p1.y, p2.x, p2.y, style);
        }
        break;
      case 'CIRCLE':
        if (e.center && Number.isFinite(e.radius)) {
          const c = transformPoint(e.center, t);
          const s = (Math.abs(t.sx ?? 1) + Math.abs(t.sy ?? 1)) / 2;
          addCircle(c.x, c.y, e.radius * s, style);
        }
        break;
      case 'ARC':
        if (e.center && Number.isFinite(e.radius)) {
          const c = transformPoint(e.center, t);
          const s = (Math.abs(t.sx ?? 1) + Math.abs(t.sy ?? 1)) / 2;
          const spec = resolveArcSpec(e, parseSource, t.rot || 0);
          if (!spec) break;
          addArc(c.x, c.y, e.radius * s, spec.start, spec.end, style, spec.clockwise, 'rad');
        }
        break;
      case 'RAY':
      case 'XLINE': {
        const startRaw = resolvePoint(
          e.startPoint,
          e.point,
          e.position,
          e.origin,
          e.basePoint,
          e.insert,
          e.insertionPoint,
          pointFromXY(e)
        );
        if (!startRaw) break;
        const dirRaw = resolveRayDirection(e, startRaw);
        if (!dirRaw) break;

        const start = transformPoint(startRaw, t);
        const dirTip = transformPoint({ x: startRaw.x + dirRaw.x, y: startRaw.y + dirRaw.y }, t);
        const dir = normalizeVec(dirTip.x - start.x, dirTip.y - start.y);
        if (!Number.isFinite(dir.x) || !Number.isFinite(dir.y) || dir.len < 1e-9) break;

        const span = 1e5;
        const upperType = String(e.type || '').toUpperCase();
        if (upperType === 'RAY') {
          addLine(start.x, start.y, start.x + dir.x * span, start.y + dir.y * span, style);
        } else {
          addLine(start.x - dir.x * span, start.y - dir.y * span, start.x + dir.x * span, start.y + dir.y * span, style);
        }
        break;
      }
      case 'LWPOLYLINE':
      case 'POLYLINE':
        if (e.vertices && e.vertices.length > 1) {
          for (let i = 0; i < e.vertices.length - 1; i++) {
            const v1 = e.vertices[i];
            const v2 = e.vertices[i + 1];
            const p1 = transformPoint(v1, t);
            const p2 = transformPoint(v2, t);
            const bulge = typeof v1.bulge === 'number' ? v1.bulge : 0;
            if (Math.abs(bulge) > 1e-12 && Math.abs((t.sx ?? 1) - (t.sy ?? 1)) < 1e-9) {
              const arc = bulgeToArc(p1, p2, bulge);
              if (arc) {
                addArc(arc.x, arc.y, arc.r, arc.startAngle, arc.endAngle, style, arc.clockwise);
              } else {
                addLine(p1.x, p1.y, p2.x, p2.y, style);
              }
            } else {
              addLine(p1.x, p1.y, p2.x, p2.y, style);
            }
          }

          // Closed polyline: last->first segment, including bulge on last vertex.
          const closed = !!(e.shape || e.closed || (typeof e.flag === 'number' && (e.flag & 1) === 1));
          if (closed) {
            const vLast = e.vertices[e.vertices.length - 1];
            const vFirst = e.vertices[0];
            const pLast = transformPoint(vLast, t);
            const pFirst = transformPoint(vFirst, t);
            const bulge = typeof vLast.bulge === 'number' ? vLast.bulge : 0;
            if (Math.abs(bulge) > 1e-12 && Math.abs((t.sx ?? 1) - (t.sy ?? 1)) < 1e-9) {
              const arc = bulgeToArc(pLast, pFirst, bulge);
              if (arc) {
                addArc(arc.x, arc.y, arc.r, arc.startAngle, arc.endAngle, style, arc.clockwise);
              } else {
                addLine(pLast.x, pLast.y, pFirst.x, pFirst.y, style);
              }
            } else {
              addLine(pLast.x, pLast.y, pFirst.x, pFirst.y, style);
            }
          }
        }
        break;
      case 'SPLINE':
      case 'HELIX': {
        const pts = String(e.type || '').toUpperCase() === 'HELIX'
          ? sampleHelixPoints(e)
          : sampleSplinePoints(e);
        if (Array.isArray(pts) && pts.length > 1) {
          for (let i = 0; i < pts.length - 1; i++) {
            const p1 = transformPoint(pts[i], t);
            const p2 = transformPoint(pts[i + 1], t);
            addLine(p1.x, p1.y, p2.x, p2.y, style);
          }
          const closed = !!(e.closed || e.periodic || ((Number(e.flag) || 0) & 1) === 1);
          if (closed && distance(pts[0], pts[pts.length - 1]) > 1e-6) {
            const p1 = transformPoint(pts[pts.length - 1], t);
            const p2 = transformPoint(pts[0], t);
            addLine(p1.x, p1.y, p2.x, p2.y, style);
          }
        }
        break;
      }
      case 'ELLIPSE': {
        const c = e.center;
        const major = e.majorAxisEndPoint;
        const axisRatio = e.axisRatio;
        if (!c || !major || typeof axisRatio !== 'number') break;
        const rx = Math.sqrt((major.x || 0) ** 2 + (major.y || 0) ** 2);
        const ry = Math.abs(rx * axisRatio);
        if (rx === 0 || ry === 0) break;
        const rot = Math.atan2(major.y || 0, major.x || 1);
        const start = toRadians(e.startAngle ?? 0);
        let end = toRadians(e.endAngle ?? Math.PI * 2);
        if (end <= start) end += Math.PI * 2;
        const segCount = Math.max(16, Math.min(192, Math.floor((end - start) * 24)));
        let prev = null;
        for (let i = 0; i <= segCount; i++) {
          const param = start + ((end - start) * i / segCount);
          const ex = rx * Math.cos(param);
          const ey = ry * Math.sin(param);
          const x = c.x + ex * Math.cos(rot) - ey * Math.sin(rot);
          const y = c.y + ex * Math.sin(rot) + ey * Math.cos(rot);
          const p = transformPoint({ x, y }, t);
          if (prev) addLine(prev.x, prev.y, p.x, p.y, style);
          prev = p;
        }
        break;
      }
      case '3DFACE': {
        const verts = [e.firstVertex, e.secondVertex, e.thirdVertex, e.fourthVertex]
          .filter((v) => v && Number.isFinite(v.x) && Number.isFinite(v.y));
        if (verts.length >= 3) {
          // fourth vertex can duplicate third for triangles
          const unique = [];
          for (const v of verts) {
            if (!unique.some((u) => Math.abs(u.x - v.x) < 1e-9 && Math.abs(u.y - v.y) < 1e-9)) {
              unique.push(v);
            }
          }
          addFaceLike(unique.map((v) => transformPoint(v, t)), style);
        }
        break;
      }
      case 'SOLID':
      case 'TRACE': {
        const verts = [e.points?.[0], e.points?.[1], e.points?.[2], e.points?.[3]]
          .filter((v) => v && Number.isFinite(v.x) && Number.isFinite(v.y));
        if (verts.length >= 3) addFaceLike(verts.map((v) => transformPoint(v, t)), style);
        break;
      }
      case 'TEXT': {
        const hJust = e.horizontalJustification ?? e.hAlign ?? e.textHalign;
        const vJust = e.verticalJustification ?? e.vAlign ?? e.textValign;
        const hasAlignment = Number(hJust ?? 0) !== 0 || Number(vJust ?? 0) !== 0;
        const rawPos = resolvePoint(
          hasAlignment ? (e.alignPoint || e.position) : null,
          e.startPoint,
          e.position,
          e.alignPoint,
          e.insert,
          e.insertionPoint,
          e.anchorPoint,
          e.definitionPoint,
          e.textPoint
        );
        if (!rawPos) {
          renderStats.diagnostics.missingTextAnchor = (renderStats.diagnostics.missingTextAnchor || 0) + 1;
          break;
        }
        const p = transformPoint(rawPos, t);
        const text = e.text || e.value || e.string || e.plainText;
        addText(
          p.x,
          p.y,
          text,
          transformedTextHeight(e.textHeight || e.height || e.nominalTextHeight, t),
          toRadians(e.rotation || 0) + (t.rot || 0),
          style,
          'text',
          {
            alignX: mapHorizontalAlign(hJust),
            alignY: mapVerticalAlign(vJust)
          }
        );
        break;
      }
      case 'MTEXT': {
        const rawPos = resolvePoint(
          e.position,
          e.startPoint,
          e.insert,
          e.insertionPoint,
          e.location,
          e.textPoint,
          e.anchorPoint
        );
        if (!rawPos) {
          renderStats.diagnostics.missingMTextAnchor = (renderStats.diagnostics.missingMTextAnchor || 0) + 1;
          break;
        }
        const p = transformPoint(rawPos, t);
        const text = e.plainText || e.text || e.string || e.rawText;
        const mtAlign = mapMTextAttachment(e.attachmentPoint ?? e.attach);
        addText(
          p.x,
          p.y,
          text,
          transformedTextHeight(e.height || e.textHeight || e.nominalTextHeight, t),
          toRadians(e.rotation || 0) + (t.rot || 0),
          style,
          'text',
          {
            alignX: mtAlign.alignX,
            alignY: mtAlign.alignY,
            lineHeight: Number(e.lineSpacingFactor) || 1.2
          }
        );
        break;
      }
      case 'ATTDEF':
      case 'ATTRIB': {
        const rawFlags = Number(e.flags ?? e.flag ?? 0);
        const isInvisible = !!(e.invisible || e.isInvisible || ((rawFlags & 1) === 1));
        if (isInvisible) break;
        const rawPos = resolvePoint(
          e.startPoint,
          e.position,
          e.insert,
          e.insertionPoint,
          e.alignPoint,
          e.alignmentPoint,
          e.textPoint,
          e.anchorPoint,
          e.definitionPoint,
          e.mtext?.position,
          e.mtext?.location,
          e.mtext?.insert
        );
        if (!rawPos) {
          renderStats.diagnostics.missingAttribAnchor = (renderStats.diagnostics.missingAttribAnchor || 0) + 1;
          if (!renderStats.diagnostics.missingAttribSample) {
            renderStats.diagnostics.missingAttribSample = {
              type: e.type || null,
              layer: e.layer || null,
              tag: e.tag || e.name || null,
              keys: Object.keys(e || {}).slice(0, 40)
            };
          }
          break;
        }
        const p = transformPoint(rawPos, t);
        const text = e.text || e.value || e.tag || e.prompt || e.mtext?.text || e.mtext?.plainText || e.mtext?.contents;
        addText(
          p.x,
          p.y,
          text,
          transformedTextHeight(e.height || e.textHeight || 2.5, t),
          toRadians(e.rotation || 0) + (t.rot || 0),
          style,
          'text'
        );
        break;
      }
      case 'POINT': {
        const p = transformPoint(e.position || e.point || { x: e.x || 0, y: e.y || 0 }, t);
        // Draw as a small cross (two short crossing lines in world units)
        const half = worldTolFromPx(3);
        addLine(p.x - half, p.y, p.x + half, p.y, style);
        addLine(p.x, p.y - half, p.x, p.y + half, style);
        break;
      }
      case 'LEADER': {
        const verts = normalizePointArray(e.vertices || e.points || e.leaderVertices || e.leaderLinePoints || []);
        if (verts.length > 1) {
          for (let i = 0; i < verts.length - 1; i++) {
            const p1 = transformPoint(verts[i], t);
            const p2 = transformPoint(verts[i + 1], t);
            addLine(p1.x, p1.y, p2.x, p2.y, style);
          }
          const head = transformPoint(verts[0], t);
          const next = transformPoint(verts[1], t);
          addArrowHead(head, { x: next.x - head.x, y: next.y - head.y }, arrowSizeFromSegment(head, next, 2.0), style, arrowStyleForEntity(e, 'closed-filled'));
          attachLeaderSymbols(e, head, next, style, e.text || e.plainText || e.annotationText || '');
        }
        break;
      }
      case 'QLEADER': {
        const verts = normalizePointArray(e.vertices || e.points || e.leaderVertices || e.leaderLinePoints || []);
        if (verts.length > 1) {
          for (let i = 0; i < verts.length - 1; i++) {
            const p1 = transformPoint(verts[i], t);
            const p2 = transformPoint(verts[i + 1], t);
            addLine(p1.x, p1.y, p2.x, p2.y, style);
          }
          const head = transformPoint(verts[0], t);
          const next = transformPoint(verts[1], t);
          addArrowHead(head, { x: next.x - head.x, y: next.y - head.y }, arrowSizeFromSegment(head, next, 2.0), style, arrowStyleForEntity(e, 'closed-filled'));
          attachLeaderSymbols(e, head, next, style, e.text || e.plainText || e.annotationText || '');
        }
        break;
      }
      case 'MLEADER':
      case 'MULTILEADER': {
        const textValue =
          e.text ||
          e.plainText ||
          e.mtext?.text ||
          e.mtext?.plainText ||
          e.contextData?.text ||
          e.contextData?.mtext?.text ||
          e.contextData?.mtext?.plainText ||
          e.contextData?.mtext?.contents ||
          e.content ||
          e.annotationText ||
          '';

        const textPosRaw = resolvePoint(
          e.textPoint,
          e.landingPoint,
          e.textLocation,
          e.mtext?.position,
          e.mtext?.location,
          e.contextData?.textLocation,
          e.contextData?.landingPoint,
          e.contextData?.mtext?.position,
          e.contextData?.mtext?.location,
          e.contextData?.mtext?.insert,
          e.insert,
          e.position
        );

        const rawLeaderSets = [
          e.leaders,
          e.leaderLines,
          e.leaderLinePoints,
          e.lines,
          e.contextData?.leaders,
          e.contextData?.leaderLines,
          e.contextData?.leaderLinePoints
        ];
        const leaderPointSets = [];

        function pushLeaderPoints(candidate) {
          if (!candidate) return;
          if (Array.isArray(candidate)) {
            const pts = normalizePointArray(candidate);
            if (pts.length >= 2) {
              leaderPointSets.push(pts);
              return;
            }
          }
          if (Array.isArray(candidate?.vertices)) {
            const pts = normalizePointArray(candidate.vertices);
            if (pts.length >= 2) leaderPointSets.push(pts);
          }
          if (Array.isArray(candidate?.points)) {
            const pts = normalizePointArray(candidate.points);
            if (pts.length >= 2) leaderPointSets.push(pts);
          }
          if (Array.isArray(candidate?.leaderLinePoints)) {
            const pts = normalizePointArray(candidate.leaderLinePoints);
            if (pts.length >= 2) leaderPointSets.push(pts);
          }
          if (Array.isArray(candidate?.leaderLines)) {
            for (const ll of candidate.leaderLines) pushLeaderPoints(ll);
          }
          if (Array.isArray(candidate?.lines)) {
            for (const ll of candidate.lines) pushLeaderPoints(ll);
          }
        }

        for (const ls of rawLeaderSets) {
          if (!Array.isArray(ls)) continue;
          for (const seg of ls) pushLeaderPoints(seg);
        }

        let inferredTextPosWorld = null;
        if (!textPosRaw && leaderPointSets.length > 0) {
          // Fallback: place callout text slightly beyond the longest leader tail.
          const longest = leaderPointSets.reduce((best, cur) => (cur.length > (best?.length || 0) ? cur : best), null);
          if (longest && longest.length >= 2) {
            const tail = transformPoint(longest[longest.length - 1], t);
            const prev = transformPoint(longest[longest.length - 2], t);
            const d = normalizeVec(tail.x - prev.x, tail.y - prev.y);
            const off = transformedTextHeight(e.textHeight || e.mtext?.textHeight || e.contextData?.mtext?.textHeight || 2.5, t) * 2.0;
            inferredTextPosWorld = { x: tail.x + d.x * off, y: tail.y + d.y * off };
          }
        }

        const textPosWorld = textPosRaw
          ? transformPoint(textPosRaw, t)
          : inferredTextPosWorld;

        const blockNameCandidates = [
          e.blockName,
          e.contentBlockName,
          e.contextData?.blockName,
          e.contextData?.contentBlockName,
          e.block?.name,
          e.contextData?.block?.name,
          e.blockContent?.name
        ].filter((v) => typeof v === 'string' && v.trim().length > 0);

        for (const pts of leaderPointSets) {
          for (let i = 0; i < pts.length - 1; i++) {
            const p1 = transformPoint(pts[i], t);
            const p2 = transformPoint(pts[i + 1], t);
            addLine(p1.x, p1.y, p2.x, p2.y, style);
          }
          const head = transformPoint(pts[0], t);
          const next = transformPoint(pts[1], t);
          addArrowHead(head, { x: next.x - head.x, y: next.y - head.y }, arrowSizeFromSegment(head, next, 2.0), style, arrowStyleForEntity(e, 'closed-filled'));
          attachLeaderSymbols(e, head, next, style, textValue || '');

          // Draw landing segment to text anchor when available.
          if (textPosWorld && pts.length >= 2) {
            const tail = transformPoint(pts[pts.length - 1], t);
            const legDirRaw = normalizeVec(textPosWorld.x - tail.x, textPosWorld.y - tail.y);
            const doglegLen = Number(e?.doglegLength ?? e?.landingDistance ?? e?.contextData?.doglegLength);
            const defaultLeg = transformedTextHeight(e.textHeight || e.mtext?.textHeight || e.contextData?.mtext?.textHeight || 2.5, t) * 1.6;
            const legLen = Number.isFinite(doglegLen) && doglegLen > 0.01 ? doglegLen * transformedUnitScale(t) : defaultLeg;
            const legEnd = { x: tail.x + legDirRaw.x * legLen, y: tail.y + legDirRaw.y * legLen };
            addLine(tail.x, tail.y, legEnd.x, legEnd.y, style);
            addLine(legEnd.x, legEnd.y, textPosWorld.x, textPosWorld.y, style);
          }
        }

        if (textValue && textPosWorld) {
          const mtAlign = mapMTextAttachment(
            e.attachmentPoint ?? e.mtext?.attachmentPoint ?? e.contextData?.mtext?.attachmentPoint ?? 7
          );
          addText(
            textPosWorld.x,
            textPosWorld.y,
            textValue,
            transformedTextHeight(e.textHeight || e.mtext?.textHeight || e.contextData?.mtext?.textHeight || 2.5, t),
            toRadians(e.textRotation || e.rotation || e.contextData?.mtext?.rotation || 0) + (t.rot || 0),
            style,
            'text',
            {
              alignX: mtAlign.alignX,
              alignY: mtAlign.alignY,
              lineHeight: Number(e.lineSpacingFactor ?? e.mtext?.lineSpacingFactor ?? e.contextData?.mtext?.lineSpacingFactor) || 1.2
            }
          );
        }

        // Some multileaders store visible callout content as a referenced block,
        // not plain mtext. Render that block when text extraction is empty.
        if ((!textValue || !textPosWorld) && blockNameCandidates.length > 0) {
          const anchorRaw = resolvePoint(
            textPosRaw,
            e.blockPosition,
            e.contextData?.blockPosition,
            e.contextData?.block?.position,
            e.position,
            e.insert,
            e.insertionPoint,
            e.landingPoint
          );

          let anchorWorld = anchorRaw ? transformPoint(anchorRaw, t) : null;
          if (!anchorWorld && leaderPointSets.length > 0) {
            const longest = leaderPointSets.reduce((best, cur) => (cur.length > (best?.length || 0) ? cur : best), null);
            if (longest && longest.length > 0) {
              anchorWorld = transformPoint(longest[longest.length - 1], t);
            }
          }

          if (anchorWorld) {
            const scaleObj = e.blockScale || e.contextData?.blockScale || e.block?.scale || null;
            const sxRaw = e.blockScaleX ?? e.contextData?.blockScaleX ?? scaleObj?.x ?? scaleObj;
            const syRaw = e.blockScaleY ?? e.contextData?.blockScaleY ?? scaleObj?.y ?? scaleObj;
            const sx = Number.isFinite(Number(sxRaw)) ? Number(sxRaw) : 1;
            const sy = Number.isFinite(Number(syRaw)) ? Number(syRaw) : sx;
            const blockRot = toRadians(e.blockRotation ?? e.contextData?.blockRotation ?? e.rotation ?? 0);

            for (const bName of blockNameCandidates) {
              const blk = getBlockDefinition(bName);
              const child = blk?.entities || blk?.objects || null;
              if (!blk || !Array.isArray(child) || child.length === 0) continue;

              const tBlock = combineTransform(t, {
                tx: anchorWorld.x,
                ty: anchorWorld.y,
                sx,
                sy,
                rot: blockRot
              });
              const base = blk.basePoint || blk.base || blk.position || blk.origin || null;
              const hasBase = !!(base && Number.isFinite(base.x) && Number.isFinite(base.y));
              const tChild = hasBase
                ? combineTransform(tBlock, { tx: -base.x, ty: -base.y, sx: 1, sy: 1, rot: 0 })
                : tBlock;

              for (const sub of child) {
                processEntity(sub, tChild, depth + 1, layer, opts);
              }

              renderStats.diagnostics.mleaderBlockRendered = (renderStats.diagnostics.mleaderBlockRendered || 0) + 1;
              break;
            }
          }
        }
        break;
      }
      case 'TOLERANCE': {
        const rawPos = resolvePoint(
          e.insertionPoint,
          e.position,
          e.insert,
          e.startPoint,
          e.location,
          e.textPoint,
          e.anchorPoint
        );
        if (!rawPos || !Number.isFinite(rawPos.x) || !Number.isFinite(rawPos.y)) break;
        const p = transformPoint(rawPos, t);
        const text = e.text || e.string || e.content || e.plainText || e.value || e.toleranceText;
        const clean = sanitizeText(String(text || ''));
        if (!clean) break;
        const h = transformedTextHeight(e.height || e.textHeight || e.nominalTextHeight || 2.5, t);
        const rotation = toRadians(e.rotation || e.textRotation || 0) + (t.rot || 0);
        // Draw a simple feature-control frame and its text.
        const approxW = Math.max(h * 0.55 * clean.length + h * 1.2, h * 3);
        const approxH = h * 1.25;
        const x1 = p.x;
        const y1 = p.y - approxH * 0.5;
        const x2 = p.x + approxW;
        const y2 = p.y + approxH * 0.5;
        addLine(x1, y1, x2, y1, style);
        addLine(x2, y1, x2, y2, style);
        addLine(x2, y2, x1, y2, style);
        addLine(x1, y2, x1, y1, style);
        addText(p.x + h * 0.4, p.y, clean, h, rotation, style, 'dimension', { alignX: 'left', alignY: 'middle' });
        break;
      }
      case 'TABLE':
      case 'ACAD_TABLE': {
        const insRaw = resolvePoint(
          e.insertionPoint,
          e.position,
          e.insert,
          e.startPoint,
          e.location,
          e.anchorPoint
        );
        if (!insRaw || !Number.isFinite(insRaw.x) || !Number.isFinite(insRaw.y)) {
          renderStats.diagnostics.missingTableAnchor = (renderStats.diagnostics.missingTableAnchor || 0) + 1;
          break;
        }

        const rowHeights = Array.isArray(e.rowHeights)
          ? e.rowHeights.map((v) => Number(v) || 5)
          : (Array.isArray(e.rows) ? e.rows.map((r) => Number(r?.height) || 5) : []);
        const colWidths = Array.isArray(e.columnWidths)
          ? e.columnWidths.map((v) => Number(v) || 15)
          : (Array.isArray(e.columns) ? e.columns.map((c) => Number(c?.width) || 15) : []);
        const nRows = Math.max(1, Number(e.numRows ?? rowHeights.length ?? 1) || 1);
        const nCols = Math.max(1, Number(e.numColumns ?? e.numCols ?? colWidths.length ?? 1) || 1);
        while (rowHeights.length < nRows) rowHeights.push(rowHeights[rowHeights.length - 1] || 5);
        while (colWidths.length < nCols) colWidths.push(colWidths[colWidths.length - 1] || 15);

        const xCuts = [0];
        const yCuts = [0];
        for (let c = 0; c < nCols; c++) xCuts.push(xCuts[c] + colWidths[c]);
        for (let r = 0; r < nRows; r++) yCuts.push(yCuts[r] + rowHeights[r]);

        for (let c = 0; c <= nCols; c++) {
          const p1 = transformPoint({ x: insRaw.x + xCuts[c], y: insRaw.y }, t);
          const p2 = transformPoint({ x: insRaw.x + xCuts[c], y: insRaw.y - yCuts[nRows] }, t);
          addLine(p1.x, p1.y, p2.x, p2.y, style);
        }
        for (let r = 0; r <= nRows; r++) {
          const p1 = transformPoint({ x: insRaw.x, y: insRaw.y - yCuts[r] }, t);
          const p2 = transformPoint({ x: insRaw.x + xCuts[nCols], y: insRaw.y - yCuts[r] }, t);
          addLine(p1.x, p1.y, p2.x, p2.y, style);
        }

        const cells = Array.isArray(e.cells) ? e.cells : [];
        for (const cell of cells) {
          const rr = Number(cell?.row ?? cell?.r);
          const cc = Number(cell?.column ?? cell?.col ?? cell?.c);
          if (!Number.isFinite(rr) || !Number.isFinite(cc)) continue;
          if (rr < 0 || rr >= nRows || cc < 0 || cc >= nCols) continue;
          const txRaw = insRaw.x + xCuts[cc] + 1.0;
          const tyRaw = insRaw.y - yCuts[rr] - rowHeights[rr] * 0.5;
          const tp = transformPoint({ x: txRaw, y: tyRaw }, t);
          const txt = cell?.text || cell?.plainText || cell?.value || cell?.content;
          if (!txt) continue;
          const th = transformedTextHeight(cell?.textHeight || e.textHeight || 2.5, t);
          addText(tp.x, tp.y, txt, th, t.rot || 0, style, 'text', { alignX: 'left', alignY: 'middle' });
        }
        break;
      }
      case 'DIMENSION': {
        // Use entity/layer color as-is — no hardcoded overrides.
        const dimStyle = style;
        const dimTypeRaw = Number(e.dimensionType ?? e.dimType ?? -1);
        const dimType = Number.isFinite(dimTypeRaw) ? (dimTypeRaw & 0x0f) : -1;
        const isRotatedLinear = dimType === 0;
        const isAlignedLinear = dimType === 1;
        const isLinear = isRotatedLinear || isAlignedLinear;
        const isAngular = dimType === 2 || dimType === 5;
        const isDiameter = dimType === 3;
        const isRadius = dimType === 4;
        const isOrdinate = dimType === 6;
        const pt1 = e.subDefinitionPoint1 || e.firstPoint || e.extLine1Point;
        const pt2 = e.subDefinitionPoint2 || e.secondPoint || e.extLine2Point;
        const defPt = e.definitionPoint || e.anchorPoint;
        const textH = transformedTextHeight(e.textHeight || e.nominalTextHeight || 2.5, t);
        const unitScale = transformedUnitScale(t);

        // Resolve text position early so the linear dim line can break around it.
        const txtPosRaw = e.textPoint || e.middleOfText || e.textMidPoint || e.textPosition;

        if (isLinear && pt1 && pt2 && defPt) {
          const p1 = transformPoint(pt1, t);
          const p2 = transformPoint(pt2, t);
          const pd = transformPoint(defPt, t);
          const dirSrc = normalizeVec(p2.x - p1.x, p2.y - p1.y);
          const angle = Number(e.angle ?? e.rotation ?? e.dimensionLineAngle);
          // DIMENSION type 0 (rotated/linear) should be orthogonal if angle is absent.
          // Type 1 (aligned) follows the measured segment direction.
          const axisDir = axisAlignedDirection(p1, p2);
          const dir = Number.isFinite(angle)
            ? { x: Math.cos(toRadians(angle) + (t.rot || 0)), y: Math.sin(toRadians(angle) + (t.rot || 0)) }
            : (isAlignedLinear ? { x: dirSrc.x, y: dirSrc.y } : axisDir);
          const nd = normalizeVec(dir.x, dir.y);
          const normal = { x: -nd.y, y: nd.x };
          const off1 = (pd.x - p1.x) * normal.x + (pd.y - p1.y) * normal.y;
          const off2 = (pd.x - p2.x) * normal.x + (pd.y - p2.y) * normal.y;
          const d1 = { x: p1.x + normal.x * off1, y: p1.y + normal.y * off1 };
          const d2 = { x: p2.x + normal.x * off2, y: p2.y + normal.y * off2 };
          // Extension lines: small gap at reference points, overshoot past dimension line.
          // Direction sign ensures the gap and overshoot go the right way when the reference
          // point is on either side of the dimension line.
          const sign1 = off1 >= 0 ? 1 : -1;
          const sign2 = off2 >= 0 ? 1 : -1;
          const extGap  = Math.max(textH * 0.12, 0.4 * unitScale);  // gap from reference point
          const extOver = Math.max(textH * 0.35, 1.2 * unitScale);  // overshoot past dimension line
          addLine(
            p1.x + sign1 * normal.x * extGap, p1.y + sign1 * normal.y * extGap,
            d1.x + sign1 * normal.x * extOver, d1.y + sign1 * normal.y * extOver,
            dimStyle
          );
          addLine(
            p2.x + sign2 * normal.x * extGap, p2.y + sign2 * normal.y * extGap,
            d2.x + sign2 * normal.x * extOver, d2.y + sign2 * normal.y * extOver,
            dimStyle
          );
          const arr = Math.max(textH * 0.9, 1.6 * unitScale);
          const dimLen = distance(d1, d2);
          const lineDir = normalizeVec(d2.x - d1.x, d2.y - d1.y);
          // Break the dimension line around the text position (standard CAD presentation).
          const txtForGap = txtPosRaw
            ? transformPoint(txtPosRaw, t)
            : { x: (d1.x + d2.x) / 2, y: (d1.y + d2.y) / 2 };
          const projTxt = (txtForGap.x - d1.x) * lineDir.x + (txtForGap.y - d1.y) * lineDir.y;
          const textGap = Math.max(textH * 1.4, 2.0 * unitScale);
          const gapL = projTxt - textGap;
          const gapR = projTxt + textGap;
          if (dimLen > 2 * arr + textH && gapL > arr * 0.5 && gapR < dimLen - arr * 0.5) {
            addLine(d1.x, d1.y, d1.x + lineDir.x * gapL, d1.y + lineDir.y * gapL, dimStyle);
            addLine(d1.x + lineDir.x * gapR, d1.y + lineDir.y * gapR, d2.x, d2.y, dimStyle);
          } else {
            addLine(d1.x, d1.y, d2.x, d2.y, dimStyle);
          }
          const dimArrowStyle = arrowStyleForEntity(e, 'closed-filled');
          addArrowHead(d1, { x: d2.x - d1.x, y: d2.y - d1.y }, arr, dimStyle, dimArrowStyle);
          addArrowHead(d2, { x: d1.x - d2.x, y: d1.y - d2.y }, arr, dimStyle, dimArrowStyle);
        } else if (isRadius || isDiameter) {
          const cp = e.centerPoint || e.center;
          const rp = e.definitionPoint || e.anchorPoint || e.chordPoint || e.firstPoint;
          if (cp && rp) {
            const c = transformPoint(cp, t);
            const r = transformPoint(rp, t);
            if (isDiameter) {
              const opp = { x: c.x - (r.x - c.x), y: c.y - (r.y - c.y) };
              addLine(opp.x, opp.y, r.x, r.y, dimStyle);
              const arr = Math.max(textH * 0.9, 1.6 * unitScale);
              const dimArrowStyle = arrowStyleForEntity(e, 'closed-filled');
              addArrowHead(r, { x: c.x - r.x, y: c.y - r.y }, arr, dimStyle, dimArrowStyle);
              addArrowHead(opp, { x: c.x - opp.x, y: c.y - opp.y }, arr, dimStyle, dimArrowStyle);
            } else {
              addLine(c.x, c.y, r.x, r.y, dimStyle);
              addArrowHead(r, { x: c.x - r.x, y: c.y - r.y }, Math.max(textH * 0.9, 1.6 * unitScale), dimStyle, arrowStyleForEntity(e, 'closed-filled'));
            }
          }
        } else if (isAngular) {
          const cp = e.centerPoint || e.center;
          const ap1 = e.firstPoint || e.extLine1Point || e.subDefinitionPoint1;
          const ap2 = e.secondPoint || e.extLine2Point || e.subDefinitionPoint2;
          const mp = defPt || e.textPoint || e.middleOfText;
          if (cp && ap1 && ap2) {
            const c = transformPoint(cp, t);
            const p1 = transformPoint(ap1, t);
            const p2 = transformPoint(ap2, t);
            const a1 = Math.atan2(p1.y - c.y, p1.x - c.x);
            const a2 = Math.atan2(p2.y - c.y, p2.x - c.x);
            const rr = mp ? distance(c, transformPoint(mp, t)) : Math.min(distance(c, p1), distance(c, p2)) * 0.65;
            if (rr > 1e-4) {
              let span = a2 - a1;
              while (span <= -Math.PI) span += Math.PI * 2;
              while (span > Math.PI) span -= Math.PI * 2;
              const end = a1 + span;
              addArc(c.x, c.y, rr, a1, end, dimStyle, span < 0);
              const e1 = { x: c.x + Math.cos(a1) * rr, y: c.y + Math.sin(a1) * rr };
              const e2 = { x: c.x + Math.cos(end) * rr, y: c.y + Math.sin(end) * rr };
              // Extension lines from arm endpoints to the arc radius
              const r1 = distance(c, p1);
              const r2 = distance(c, p2);
              if (r1 > rr * 0.1) addLine(p1.x, p1.y, c.x + (p1.x - c.x) * (rr / r1), c.y + (p1.y - c.y) * (rr / r1), dimStyle);
              if (r2 > rr * 0.1) addLine(p2.x, p2.y, c.x + (p2.x - c.x) * (rr / r2), c.y + (p2.y - c.y) * (rr / r2), dimStyle);
              const arr = Math.max(textH * 0.8, 1.4 * unitScale);
              const dimArrowStyle = arrowStyleForEntity(e, 'closed-filled');
              addArrowHead(e1, { x: -Math.sin(a1), y: Math.cos(a1) }, arr, dimStyle, dimArrowStyle);
              addArrowHead(e2, { x: Math.sin(end), y: -Math.cos(end) }, arr, dimStyle, dimArrowStyle);
            }
          }
        } else if (isOrdinate) {
          // Ordinate dimension: leader from feature point to annotation endpoint.
          // DXF grp 10 = def point (annotation end), grp 13 = feature point, grp 14 = leader end.
          const featPt = pt1 || defPt;
          const ledPt = pt2 || e.leaderEndPoint || defPt;
          if (featPt && ledPt) {
            const fp = transformPoint(featPt, t);
            const lp = transformPoint(ledPt, t);
            // Small cross at the feature point to mark the measured location
            const tick = Math.max(textH * 0.25, 0.5 * unitScale);
            addLine(fp.x - tick, fp.y, fp.x + tick, fp.y, dimStyle);
            addLine(fp.x, fp.y - tick, fp.x, fp.y + tick, dimStyle);
            if (distance(fp, lp) > tick * 2) {
              addLine(fp.x, fp.y, lp.x, lp.y, dimStyle);
            }
          }
        } else if (defPt) {
          // Generic fallback for unsupported dim subtypes.
          const cp = e.centerPoint || e.center;
          if (cp) {
            const c = transformPoint(cp, t);
            const d = transformPoint(defPt, t);
            addLine(c.x, c.y, d.x, d.y, dimStyle);
          }
        }
        // Dimension text
        const fallbackTextRaw = (!txtPosRaw && isLinear && pt1 && pt2)
          ? midpoint(pt1, pt2)
          : (!txtPosRaw && (isRadius || isDiameter) ? (e.definitionPoint || e.anchorPoint || pt1 || defPt) : null)
          || (!txtPosRaw && isAngular ? (defPt || midpoint(pt1 || {}, pt2 || {})) : null)
          || (!txtPosRaw && isOrdinate ? (pt2 || defPt) : null)
          || (!txtPosRaw ? defPt : null);
        const finalTextRaw = txtPosRaw || fallbackTextRaw;
        if (finalTextRaw) {
          const txtPos = transformPoint(finalTextRaw, t);
          const rawValue = (parseSource === 'libredwg')
            ? (e.text ?? '')
            : (e.text ?? e.measurement ?? e.actualMeasurement ?? '');
          const rawStr = String(rawValue).trim();
          let val = sanitizeText(rawStr);
          // In many CAD files, '<>' means "show measured value".
          if ((val === '' || val === '<>') && Number.isFinite(Number(e.measurement ?? e.actualMeasurement))) {
            const n = Number(e.measurement ?? e.actualMeasurement);
            val = formatDimensionMeasurement(n, unitsCode);
          }
          const rotation = e.textRotation ?? e.ocsRotation ?? e.rotation ?? e.dimensionLineAngle ?? 0;
          if (val && val !== '[]') {
            addText(
              txtPos.x,
              txtPos.y,
              val,
              transformedTextHeight(e.textHeight || e.nominalTextHeight || 2.5, t),
              toRadians(rotation) + (t.rot || 0),
              dimStyle,
              'dimension',
              { alignX: 'center', alignY: 'middle' }
            );
          }
        }
        break;
      }
      case 'HATCH': {
        const loops = [];
        const boundaries = e.boundaryLoops || e.boundaryPaths || e.loops || [];
        let pointCount = 0;
        for (const b of boundaries) {
          const verts = b?.vertices || b?.polyline?.vertices || b?.edges || [];
          const pts = [];
          for (const v of verts) {
            const raw = v?.start || v?.position || v;
            if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) continue;
            pts.push(transformPoint(raw, t));
            pointCount++;
          }
          if (pts.length >= 3) loops.push(pts);
        }
        if (!profile.preserveComplexHatches && (loops.length > 40 || pointCount > 2500)) {
          renderStats.skipped++;
          renderStats.skippedTypes.HATCH_COMPLEX = (renderStats.skippedTypes.HATCH_COMPLEX || 0) + 1;
          break;
        }
        const hatchScale = (Math.abs(t.sx ?? 1) + Math.abs(t.sy ?? 1)) / 2;
        const angleDeg = Number(e.patternAngle ?? 45) + ((t.rot || 0) * 180 / Math.PI);
        const spacing = Number(e.patternScale ?? 8) * (Number.isFinite(hatchScale) && hatchScale > 1e-9 ? hatchScale : 1);
        addHatch(loops, angleDeg, spacing, style, e.patternName || e.pattern || e.name || null);
        break;
      }
      case 'INSERT': {
        const blockName = e.name || e.block || e.blockName;
        const blk = blockMap?.[blockName] || blockMap?.[String(blockName || '').toUpperCase()];
        const child = blk?.entities || blk?.objects || null;
        const isTitleBlockInsert = /TITLE|SHEET|BORDER|TBLK|TITLEBLOCK|REV/i.test(String(blockName || ''));
        const ins = resolvePoint(
          e.insertionPoint,
          e.position,
          e.insert,
          pointFromXYIfMeaningful(e)
        );
        if (!ins) {
          renderStats.diagnostics.missingInsertAnchor = (renderStats.diagnostics.missingInsertAnchor || 0) + 1;
          break;
        }
        const baseRot = degToRad(e.rotation ?? 0);
        const sx = e.xScale ?? e.scaleX ?? 1;
        const sy = e.yScale ?? e.scaleY ?? 1;
        const colCount = Math.max(1, Number(e.columnCount ?? 1) || 1);
        const rowCount = Math.max(1, Number(e.rowCount ?? 1) || 1);
        const colSpacing = Number(e.columnSpacing ?? 0) || 0;
        const rowSpacing = Number(e.rowSpacing ?? 0) || 0;

        function applyInsertAt(offsetX, offsetY) {
          // INSERT array offsets are in insert local axes; rotate them to world.
          const ox = offsetX * Math.cos(baseRot) - offsetY * Math.sin(baseRot);
          const oy = offsetX * Math.sin(baseRot) + offsetY * Math.cos(baseRot);
          const local = {
            tx: (ins?.x ?? 0) + ox,
            ty: (ins?.y ?? 0) + oy,
            sx,
            sy,
            rot: baseRot
          };
          const t2 = combineTransform(t, local);
          const base = blk?.basePoint || blk?.base || blk?.position || blk?.origin || null;
          const hasBase = !!(base && Number.isFinite(base.x) && Number.isFinite(base.y));
          const tChild = hasBase
            ? combineTransform(t2, { tx: -base.x, ty: -base.y, sx: 1, sy: 1, rot: 0 })
            : t2;
          if (child && Array.isArray(child)) {
            for (const sub of child) {
              // ATTRIBs are rendered from INSERT.attribs/top-level list; avoid duplicates.
              if (sub?.type === 'ATTRIB' || sub?.type === 'ATTDEF') continue;
              processEntity(sub, tChild, depth + 1, layer, opts);
            }
          }

          // Build ATTDEF anchor map so orphan ATTRIB values can inherit placement.
          const attdefAnchorByTag = {};
          const attdefAnchorList = [];
          const normalizeTagKey = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (child && Array.isArray(child)) {
            for (const sub of child) {
              if (String(sub?.type || '').toUpperCase() !== 'ATTDEF') continue;
              const rawTag = String(sub?.tag || sub?.name || '').toUpperCase();
              const tag = normalizeTagKey(rawTag);
              const p = resolvePoint(
                sub.startPoint,
                sub.position,
                sub.insert,
                sub.insertionPoint,
                sub.alignPoint,
                sub.alignmentPoint,
                sub.textPoint,
                sub.anchorPoint,
                sub.definitionPoint,
                sub.location,
                sub.point,
                sub.mtext?.position,
                sub.mtext?.location,
                sub.mtext?.insert
              );
              if (!p) continue;
              const anchorInfo = {
                point: p,
                rotation: sub.rotation,
                height: sub.height ?? sub.textHeight,
                tagRaw: rawTag,
                fallbackText: sub.text || sub.value || sub.prompt || rawTag
              };
              attdefAnchorList.push(anchorInfo);
              if (tag) attdefAnchorByTag[tag] = anchorInfo;
            }
          }
          let attdefFallbackIndex = 0;

          // Explicit INSERT attributes (title block/revision values).
          const attrsRaw = Array.isArray(e.attribs)
            ? e.attribs
            : (Array.isArray(e.attributes) ? e.attributes : []);
          const childAttribs = (child && Array.isArray(child))
            ? child.filter((sub) => String(sub?.type || '').toUpperCase() === 'ATTRIB')
            : [];
          const attrs = [...attrsRaw, ...childAttribs];
          const consumedTags = new Set();
          for (const at of attrs) {
            const atPos = resolvePoint(
              at?.startPoint,
              at?.position,
              at?.insert,
              at?.insertionPoint,
              at?.alignPoint,
              at?.alignmentPoint,
              at?.textPoint,
              at?.anchorPoint,
              at?.definitionPoint,
              at?.location,
              at?.point,
              at?.mtext?.position,
              at?.mtext?.location,
              at?.mtext?.insert,
              at?.contextData?.textLocation
            );
            if (atPos) {
              processEntity(at, tChild, depth + 1, layer, opts);
              const tagKey = normalizeTagKey(at?.tag || at?.name);
              if (tagKey) consumedTags.add(tagKey);
              continue;
            }
            const tag = normalizeTagKey(at?.tag || at?.name);
            const anchor = (tag ? attdefAnchorByTag[tag] : null) || attdefAnchorList[attdefFallbackIndex++] || null;
            if (anchor?.point) {
              const patched = {
                ...at,
                startPoint: anchor.point,
                position: anchor.point,
                insert: anchor.point,
                insertionPoint: anchor.point,
                rotation: at?.rotation ?? anchor.rotation,
                textHeight: at?.textHeight ?? at?.height ?? anchor.height
              };
              processEntity(patched, tChild, depth + 1, layer, opts);
              if (tag) consumedTags.add(tag);
            } else {
              // Keep diagnostics so we can continue tightening anchor recovery.
              renderStats.diagnostics.missingAttribAnchor = (renderStats.diagnostics.missingAttribAnchor || 0) + 1;
            }
          }

          // For title blocks, emit ATTDEF placeholders when ATTRIB values are absent.
          if (isTitleBlockInsert && attdefAnchorList.length > 0) {
            for (const anchor of attdefAnchorList) {
              const key = normalizeTagKey(anchor.tagRaw);
              if (key && consumedTags.has(key)) continue;
              const placeholder = {
                type: 'ATTRIB',
                tag: anchor.tagRaw,
                text: anchor.fallbackText,
                startPoint: anchor.point,
                position: anchor.point,
                insert: anchor.point,
                insertionPoint: anchor.point,
                rotation: anchor.rotation,
                textHeight: anchor.height
              };
              processEntity(placeholder, tChild, depth + 1, layer, opts);
            }
          }
        }

        for (let r = 0; r < rowCount; r++) {
          for (let c = 0; c < colCount; c++) {
            applyInsertAt(c * colSpacing, r * rowSpacing);
          }
        }
        break;
      }
      case 'IMAGE': {
        const baseRaw = resolvePoint(
          e.insert,
          e.insertionPoint,
          e.position,
          e.origin,
          e.anchorPoint,
          pointFromXY(e)
        );
        if (!baseRaw) break;

        const widthWorld = Number(e.width ?? e.imageWidth ?? e.size?.x ?? 1) || 1;
        const heightWorld = Number(e.height ?? e.imageHeight ?? e.size?.y ?? 1) || 1;

        const uRaw = e.uVector || e.u || e.horizontalVector || e.orientationU || { x: widthWorld, y: 0 };
        const vRaw = e.vVector || e.v || e.verticalVector || e.orientationV || { x: 0, y: heightWorld };

        const u = {
          x: Number.isFinite(Number(uRaw?.x)) ? Number(uRaw.x) : widthWorld,
          y: Number.isFinite(Number(uRaw?.y)) ? Number(uRaw.y) : 0
        };
        const v = {
          x: Number.isFinite(Number(vRaw?.x)) ? Number(vRaw.x) : 0,
          y: Number.isFinite(Number(vRaw?.y)) ? Number(vRaw.y) : heightWorld
        };

        const p0 = transformPoint(baseRaw, t);
        const p1 = transformPoint({ x: baseRaw.x + u.x, y: baseRaw.y + u.y }, t);
        const p3 = transformPoint({ x: baseRaw.x + v.x, y: baseRaw.y + v.y }, t);

        const pxW = Number(e.pixelWidth ?? e.imageDef?.width ?? e.widthPixels ?? 1) || 1;
        const pxH = Number(e.pixelHeight ?? e.imageDef?.height ?? e.heightPixels ?? 1) || 1;
        const sourcePath =
          e.fileName ||
          e.filename ||
          e.path ||
          e.imagePath ||
          e.imageDef?.fileName ||
          e.imageDef?.path ||
          null;

        addImageFrame(p0, p1, p3, style, sourcePath, pxW, pxH);
        break;
      }
      case 'PDFUNDERLAY':
      case 'DGNUNDERLAY':
      case 'DWFUNDERLAY':
      case 'UNDERLAY': {
        const baseRaw = resolvePoint(
          e.insert,
          e.insertionPoint,
          e.position,
          e.origin,
          e.anchorPoint,
          pointFromXY(e)
        );
        if (!baseRaw) break;

        const widthWorld = Number(e.width ?? e.size?.x ?? 1) || 1;
        const heightWorld = Number(e.height ?? e.size?.y ?? 1) || 1;
        const uRaw = e.uVector || e.u || e.horizontalVector || e.orientationU || { x: widthWorld, y: 0 };
        const vRaw = e.vVector || e.v || e.verticalVector || e.orientationV || { x: 0, y: heightWorld };

        const u = {
          x: Number.isFinite(Number(uRaw?.x)) ? Number(uRaw.x) : widthWorld,
          y: Number.isFinite(Number(uRaw?.y)) ? Number(uRaw.y) : 0
        };
        const v = {
          x: Number.isFinite(Number(vRaw?.x)) ? Number(vRaw.x) : 0,
          y: Number.isFinite(Number(vRaw?.y)) ? Number(vRaw.y) : heightWorld
        };

        const p0 = transformPoint(baseRaw, t);
        const p1 = transformPoint({ x: baseRaw.x + u.x, y: baseRaw.y + u.y }, t);
        const p3 = transformPoint({ x: baseRaw.x + v.x, y: baseRaw.y + v.y }, t);

        const sourcePath =
          e.fileName ||
          e.filename ||
          e.path ||
          e.sourcePath ||
          e.underlayDef?.fileName ||
          e.underlayDef?.path ||
          null;

        addUnderlayFrame(p0, p1, p3, style, e.type || 'UNDERLAY', sourcePath);
        break;
      }
      case 'MESH': {
        const rawVertices =
          (Array.isArray(e.vertices) ? e.vertices : null) ||
          (Array.isArray(e.vertexList) ? e.vertexList : null) ||
          (Array.isArray(e.points) ? e.points : null) ||
          [];
        const vertices = rawVertices
          .map((v) => meshPoint(v))
          .filter((v) => isFinitePoint(v))
          .map((v) => transformPoint(v, t));
        if (vertices.length < 2) break;

        const edges = new Set();
        const addEdge = (ia, ib) => {
          const a = Number(ia);
          const b = Number(ib);
          if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return;
          if (a >= vertices.length || b >= vertices.length || a === b) return;
          const key = a < b ? `${a}:${b}` : `${b}:${a}`;
          if (edges.has(key)) return;
          edges.add(key);
          const p1 = vertices[a];
          const p2 = vertices[b];
          addLine(p1.x, p1.y, p2.x, p2.y, style);
        };

        const rawFaces =
          (Array.isArray(e.faces) ? e.faces : null) ||
          (Array.isArray(e.faceList) ? e.faceList : null) ||
          (Array.isArray(e.polygons) ? e.polygons : null) ||
          [];

        let anyFace = false;
        for (const rf of rawFaces) {
          const idx = meshFaceIndices(rf);
          if (idx.length < 2) continue;
          anyFace = true;
          for (let i = 0; i < idx.length - 1; i++) addEdge(idx[i], idx[i + 1]);
          if (idx.length > 2) addEdge(idx[idx.length - 1], idx[0]);
        }

        if (!anyFace) {
          const mCount = Number(e.mVertexCount ?? e.mCount ?? e.rows ?? 0);
          const nCount = Number(e.nVertexCount ?? e.nCount ?? e.columns ?? 0);
          if (Number.isInteger(mCount) && Number.isInteger(nCount) && mCount > 1 && nCount > 1 && mCount * nCount <= vertices.length) {
            const idx = (r, c) => r * nCount + c;
            for (let r = 0; r < mCount; r++) {
              for (let c = 0; c < nCount; c++) {
                if (c + 1 < nCount) addEdge(idx(r, c), idx(r, c + 1));
                if (r + 1 < mCount) addEdge(idx(r, c), idx(r + 1, c));
              }
            }
          } else {
            for (let i = 0; i < vertices.length - 1; i++) {
              addLine(vertices[i].x, vertices[i].y, vertices[i + 1].x, vertices[i + 1].y, style);
            }
          }
        }
        break;
      }
      case 'SURFACE':
      case 'PLANESURFACE':
      case 'NURBSSURFACE':
      case 'REVOLVEDSURFACE':
      case 'SWEPTSURFACE':
      case 'LOFTEDSURFACE': {
        const linePairs = [];

        const connectPolyline = (pts, closed = false) => {
          if (!Array.isArray(pts) || pts.length < 2) return;
          for (let i = 0; i < pts.length - 1; i++) {
            linePairs.push([pts[i], pts[i + 1]]);
          }
          if (closed && pts.length > 2) {
            linePairs.push([pts[pts.length - 1], pts[0]]);
          }
        };

        const edgeBuckets = [
          e.boundary,
          e.boundaries,
          e.boundaryLoops,
          e.edges,
          e.edgeLoops,
          e.isolines,
          e.uIsolines,
          e.vIsolines,
          e.profileCurves,
          e.guideCurves
        ];

        for (const bucket of edgeBuckets) {
          if (!Array.isArray(bucket)) continue;
          for (const item of bucket) {
            if (Array.isArray(item)) {
              const pts = item.map((p) => meshPoint(p)).filter((p) => isFinitePoint(p)).map((p) => transformPoint(p, t));
              connectPolyline(pts, false);
              continue;
            }
            const verts = (Array.isArray(item?.vertices) ? item.vertices : null) || (Array.isArray(item?.points) ? item.points : null);
            if (Array.isArray(verts)) {
              const pts = verts.map((p) => meshPoint(p)).filter((p) => isFinitePoint(p)).map((p) => transformPoint(p, t));
              connectPolyline(pts, !!item?.closed);
            }
          }
        }

        const rawCtrl = (Array.isArray(e.controlPoints) ? e.controlPoints : null) || (Array.isArray(e.vertices) ? e.vertices : null) || [];
        const ctrl = rawCtrl.map((p) => meshPoint(p)).filter((p) => isFinitePoint(p)).map((p) => transformPoint(p, t));
        const uCount = Number(e.uCount ?? e.uDegreeCount ?? e.mCount ?? e.rows ?? 0);
        const vCount = Number(e.vCount ?? e.vDegreeCount ?? e.nCount ?? e.columns ?? 0);
        if (ctrl.length >= 4 && Number.isInteger(uCount) && Number.isInteger(vCount) && uCount > 1 && vCount > 1 && uCount * vCount <= ctrl.length) {
          const at = (u, v) => ctrl[u * vCount + v];
          for (let u = 0; u < uCount; u++) {
            for (let v = 0; v < vCount; v++) {
              if (u + 1 < uCount) linePairs.push([at(u, v), at(u + 1, v)]);
              if (v + 1 < vCount) linePairs.push([at(u, v), at(u, v + 1)]);
            }
          }
        }

        if (linePairs.length === 0 && ctrl.length > 1) {
          connectPolyline(ctrl, false);
        }

        for (const [a, b] of linePairs) {
          if (!isFinitePoint(a) || !isFinitePoint(b)) continue;
          addLine(a.x, a.y, b.x, b.y, style);
        }
        break;
      }
      case '3DSOLID':
      case 'BODY':
      case 'REGION': {
        const ext = e.extents || e.bounds || e.boundingBox || null;
        const minPt = resolvePoint(
          ext?.min,
          ext?.minPoint,
          e.minPoint,
          e.min,
          (Number.isFinite(e.minX) && Number.isFinite(e.minY)) ? { x: e.minX, y: e.minY } : null
        );
        const maxPt = resolvePoint(
          ext?.max,
          ext?.maxPoint,
          e.maxPoint,
          e.max,
          (Number.isFinite(e.maxX) && Number.isFinite(e.maxY)) ? { x: e.maxX, y: e.maxY } : null
        );

        if (minPt && maxPt) {
          const p1 = transformPoint({ x: minPt.x, y: minPt.y }, t);
          const p2 = transformPoint({ x: maxPt.x, y: minPt.y }, t);
          const p3 = transformPoint({ x: maxPt.x, y: maxPt.y }, t);
          const p4 = transformPoint({ x: minPt.x, y: maxPt.y }, t);
          addLine(p1.x, p1.y, p2.x, p2.y, style);
          addLine(p2.x, p2.y, p3.x, p3.y, style);
          addLine(p3.x, p3.y, p4.x, p4.y, style);
          addLine(p4.x, p4.y, p1.x, p1.y, style);
          addText(p1.x, p3.y, String(e.type || '3DSOLID'), transformedTextHeight(2.0, t), 0, style, 'text');
          break;
        }

        const anchorRaw = resolvePoint(
          e.position,
          e.insert,
          e.insertionPoint,
          e.center,
          e.basePoint,
          pointFromXY(e)
        ) || { x: 0, y: 0 };
        const c = transformPoint(anchorRaw, t);
        const s = transformedTextHeight(2.5, t) * 0.8;
        addLine(c.x - s, c.y - s, c.x + s, c.y + s, style);
        addLine(c.x - s, c.y + s, c.x + s, c.y - s, style);
        addText(c.x + s * 0.8, c.y + s * 0.8, String(e.type || '3DSOLID'), transformedTextHeight(2.0, t), 0, style, 'text');
        break;
      }
      case 'VIEWPORT': {
        // Render only active/on viewport borders; inactive viewport records are often
        // bookkeeping objects that stack near layout origin.
        const vpStatus = Number(e.status ?? e.viewportStatus ?? e.flags ?? 0);
        if (Number.isFinite(vpStatus) && vpStatus <= 0) break;
        const vc = e.center || e.position || { x: e.x || 0, y: e.y || 0 };
        const vw = Number(e.width ?? e.viewportWidth ?? 0);
        const vh = Number(e.height ?? e.viewportHeight ?? 0);
        if (vw > 0 && vh > 0) {
          const cp = transformPoint(vc, t);
          const hw = vw / 2;
          const hh = vh / 2;
          addLine(cp.x - hw, cp.y - hh, cp.x + hw, cp.y - hh, style);
          addLine(cp.x + hw, cp.y - hh, cp.x + hw, cp.y + hh, style);
          addLine(cp.x + hw, cp.y + hh, cp.x - hw, cp.y + hh, style);
          addLine(cp.x - hw, cp.y + hh, cp.x - hw, cp.y - hh, style);
        }
        break;
      }
      default: {
        // Track unhandled entity types
        renderStats.skippedTypes[e.type || 'UNKNOWN'] = (renderStats.skippedTypes[e.type || 'UNKNOWN'] || 0) + 1;
      }
      // handle other entity types as needed
    }
    clipStack.pop();
  }

  for (const e of dxfEntities) {
    processEntity(e);
  }

  if (String(spaceView || '').toLowerCase() === 'layout') {
    const viewports = collectLayoutViewports(dxfEntities);
    if (viewports.length > 0) {
      const modelCandidates = (dxfEntities || []).filter((e) => {
        const sp = classifyEntitySpace(e);
        const type = String(e?.type || '').toUpperCase();
        if (type === 'VIEWPORT') return false;
        return sp === 'model' || sp === 'unknown';
      });
      for (const vp of viewports) {
        for (const me of modelCandidates) {
          processEntity(me, vp.projection, 0, null, { forceSpace: true, clipRect: vp.projection.clip });
        }
      }
      renderStats.diagnostics.layoutViewportCount = viewports.length;
      renderStats.diagnostics.layoutProjectedModelEntityCount = modelCandidates.length;
    }
  }

  console.log('=== RENDERING STATISTICS ===');
  console.log(`Entities processed: ${renderStats.processed}`);
  console.log(`Entities skipped: ${renderStats.skipped}`);
  if (Object.keys(renderStats.skippedTypes).length > 0) {
    console.log('Skipped types:', JSON.stringify(renderStats.skippedTypes, null, 2));
  }
  console.log(`Output entities: ${out.length}`);

  if (out.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const ent of out) {
      minX = Math.min(minX, ent.minX ?? ent.x ?? ent.x1 ?? 0);
      minY = Math.min(minY, ent.minY ?? ent.y ?? ent.y1 ?? 0);
      maxX = Math.max(maxX, ent.maxX ?? ent.x ?? ent.x1 ?? 0);
      maxY = Math.max(maxY, ent.maxY ?? ent.y ?? ent.y1 ?? 0);
    }
    const spanX = Math.max(1e-6, maxX - minX);
    const spanY = Math.max(1e-6, maxY - minY);
    const leftCut = minX + spanX * 0.12;
    const bottomCut = minY + spanY * 0.12;
    const bl = out
      .filter((ent) => {
        const ex = ent.minX ?? ent.x ?? ent.x1 ?? 0;
        const ey = ent.minY ?? ent.y ?? ent.y1 ?? 0;
        return ex <= leftCut && ey <= bottomCut;
      })
      .slice(0, 20)
      .map((ent) => ({
        type: ent.type,
        layer: ent.layer || null,
        x: Number((ent.x ?? ent.x1 ?? ent.minX ?? 0).toFixed?.(3) ?? 0),
        y: Number((ent.y ?? ent.y1 ?? ent.minY ?? 0).toFixed?.(3) ?? 0),
        text: typeof ent.text === 'string' ? ent.text.slice(0, 80) : null
      }));
    renderStats.diagnostics.bottomLeftSample = bl;
  }

  lastConversionStats = {
    inputEntities: Array.isArray(dxfEntities) ? dxfEntities.length : 0,
    processed: renderStats.processed,
    skipped: renderStats.skipped,
    skippedTypes: renderStats.skippedTypes,
    outputEntities: out.length,
    diagnostics: renderStats.diagnostics
  };

  return out;
}

function calculateBounds(ents) {
  if (ents.length === 0) {
    return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  }
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  for (const ent of ents) {
    if (
      Number.isFinite(ent.minX) && Number.isFinite(ent.minY) &&
      Number.isFinite(ent.maxX) && Number.isFinite(ent.maxY)
    ) {
      minX = Math.min(minX, ent.minX);
      minY = Math.min(minY, ent.minY);
      maxX = Math.max(maxX, ent.maxX);
      maxY = Math.max(maxY, ent.maxY);
      continue;
    }
    switch (ent.type) {
      case 'line':
        minX = Math.min(minX, ent.x1, ent.x2);
        minY = Math.min(minY, ent.y1, ent.y2);
        maxX = Math.max(maxX, ent.x1, ent.x2);
        maxY = Math.max(maxY, ent.y1, ent.y2);
        break;
      case 'circle':
        minX = Math.min(minX, ent.x - ent.r);
        minY = Math.min(minY, ent.y - ent.r);
        maxX = Math.max(maxX, ent.x + ent.r);
        maxY = Math.max(maxY, ent.y + ent.r);
        break;
      case 'arc':
        minX = Math.min(minX, ent.x - ent.r);
        minY = Math.min(minY, ent.y - ent.r);
        maxX = Math.max(maxX, ent.x + ent.r);
        maxY = Math.max(maxY, ent.y + ent.r);
        break;
    }
  }

  return { minX, minY, maxX, maxY };
}
