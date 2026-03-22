import { app, BrowserWindow, Menu, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// Force runtime/cache paths to a writable temp location.
// This avoids Chromium cache permission errors on restricted profiles.
const runtimeRoot = path.join(app.getPath('temp'), 'dwl-viewer-runtime');
const runtimeUserData = path.join(runtimeRoot, 'userData');
const runtimeSessionData = path.join(runtimeRoot, 'sessionData');
const settingsPath = path.join(runtimeRoot, 'settings.json');
fs.mkdirSync(runtimeUserData, { recursive: true });
fs.mkdirSync(runtimeSessionData, { recursive: true });

type AppSettings = {
  hardwareAcceleration: boolean;
};

const DEFAULT_SETTINGS: AppSettings = {
  hardwareAcceleration: false
};

function readAppSettings(): AppSettings {
  try {
    if (!fs.existsSync(settingsPath)) return { ...DEFAULT_SETTINGS };
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      hardwareAcceleration: parsed.hardwareAcceleration !== false
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeAppSettings(settings: AppSettings): void {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

let appSettings = readAppSettings();
if (!appSettings.hardwareAcceleration) {
  app.disableHardwareAcceleration();
}

app.setPath('userData', runtimeUserData);
app.setPath('sessionData', runtimeSessionData);
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

let mainWindow: BrowserWindow | null = null;
let libdxfrwInstance: any = null;
let libredwgInstance: any = null;
let pendingOpenPath: string | null = null;

type AutomationConfig = {
  enabled: boolean;
  autoOpenPath: string | null;
  captureDir: string;
  autoExit: boolean;
  ignoreTypes: string[];
};

type ReaderProfile = {
  name: 'fidelity' | 'performance';
  readModelSpace: boolean;
  readPaperSpace: boolean;
  respectLayerVisibility: boolean;
  readVisibleAttributesAsText: boolean;
  readProxyEntityGraphics: boolean;
  preserveComplexHatches: boolean;
  readExternalReferences: boolean;
};

type XrefReference = {
  name: string;
  path: string | null;
  resolvedPath: string | null;
  source: 'block' | 'block-record';
};

function readArgValue(flag: string): string | null {
  const prefix = `${flag}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (!hit) return null;
  const raw = hit.slice(prefix.length).trim();
  if (!raw) return null;
  // Support quoted paths: --auto-open="C:\\path\\file.dwg"
  return raw.replace(/^"|"$/g, '');
}

function resolveOpenPathFromArgv(argv: string[]): string | null {
  for (const arg of argv) {
    if (!arg || arg.startsWith('--')) continue;
    const ext = path.extname(arg).toLowerCase();
    if ((ext === '.dwg' || ext === '.dxf') && fs.existsSync(arg)) {
      return path.resolve(arg);
    }
  }
  return null;
}

const autoOpenArg = readArgValue('--auto-open');
const autoCaptureDirArg = readArgValue('--auto-capture-dir');
const autoExitFlag = process.argv.includes('--auto-exit');
const autoIgnoreArg = readArgValue('--auto-ignore');
const readerProfileArg = (readArgValue('--reader-profile') || 'fidelity').toLowerCase();
const autoIgnoreTypes = (autoIgnoreArg || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const automationConfig: AutomationConfig = {
  enabled: !!autoOpenArg,
  autoOpenPath: autoOpenArg ? path.resolve(autoOpenArg) : null,
  captureDir: autoCaptureDirArg ? path.resolve(autoCaptureDirArg) : path.join(process.cwd(), 'artifacts', 'auto-view'),
  autoExit: autoExitFlag,
  ignoreTypes: autoIgnoreTypes
};

const READER_PROFILES: Record<'fidelity' | 'performance', ReaderProfile> = {
  fidelity: {
    name: 'fidelity',
    readModelSpace: true,
    readPaperSpace: false,
    respectLayerVisibility: true,
    readVisibleAttributesAsText: true,
    readProxyEntityGraphics: true,
    preserveComplexHatches: true,
    readExternalReferences: false
  },
  performance: {
    name: 'performance',
    readModelSpace: true,
    readPaperSpace: false,
    respectLayerVisibility: true,
    readVisibleAttributesAsText: true,
    readProxyEntityGraphics: false,
    preserveComplexHatches: false,
    readExternalReferences: false
  }
};

const readerProfile: ReaderProfile =
  readerProfileArg === 'performance' ? READER_PROFILES.performance : READER_PROFILES.fidelity;

async function getLibdxfrw() {
  if (libdxfrwInstance) return libdxfrwInstance;
  // When packaged, node_modules lives inside the asar but wasm files are
  // unpacked to app.asar.unpacked. Use process.resourcesPath to find both.
  const resourcesPath = process.resourcesPath ?? path.join(__dirname, '..');
  const libdxfrwPath = path.join(resourcesPath, 'app.asar', 'node_modules', '@mlightcad', 'libdxfrw-web', 'dist', 'libdxfrw.js');
  const wasmUnpacked = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@mlightcad', 'libdxfrw-web', 'dist');
  // In dev mode fall back to local node_modules
  const localLibPath = path.join(__dirname, '..', 'node_modules', '@mlightcad', 'libdxfrw-web', 'dist', 'libdxfrw.js');
  const localWasmDir = path.join(__dirname, '..', 'node_modules', '@mlightcad', 'libdxfrw-web', 'dist');
  const isPacked = fs.existsSync(libdxfrwPath);
  const factory = require(isPacked ? libdxfrwPath : localLibPath);
  const MainModuleFactory = factory.default ?? factory;
  libdxfrwInstance = await MainModuleFactory({
    locateFile: (file: string) => path.join(isPacked ? wasmUnpacked : localWasmDir, file)
  });
  return libdxfrwInstance;
}

async function getLibredwg() {
  if (libredwgInstance) return libredwgInstance;
  const resourcesPath = process.resourcesPath ?? path.join(__dirname, '..');
  const localWasmDir = path.join(__dirname, '..', 'node_modules', '@mlightcad', 'libredwg-web', 'wasm');
  const packedWasmDir = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@mlightcad', 'libredwg-web', 'wasm');
  const wasmDir = fs.existsSync(packedWasmDir) ? packedWasmDir : localWasmDir;
  const pkg = require('@mlightcad/libredwg-web');
  libredwgInstance = await pkg.LibreDwg.create(wasmDir);
  return libredwgInstance;
}

function normalizeEntitiesForRenderer(entities: any[]): any[] {
  // Keep renderer contract compatible with dxf-parser entity shape.
  return entities.map((e: any) => {
    if (e?.type === 'LINE' && e.startPoint && e.endPoint && !e.vertices) {
      return {
        ...e,
        vertices: [
          { x: e.startPoint.x, y: e.startPoint.y },
          { x: e.endPoint.x, y: e.endPoint.y }
        ]
      };
    }
    return e;
  });
}

type EntitySpace = 'model' | 'paper' | 'unknown';

function classifyBlockRecordSpace(name: unknown): EntitySpace {
  const upper = String(name ?? '').toUpperCase();
  if (upper.startsWith('*PAPER_SPACE')) return 'paper';
  if (upper.startsWith('*MODEL_SPACE')) return 'model';
  return 'unknown';
}

function buildOwnerSpaceMap(blockRecordEntries: any[]): Map<string, EntitySpace> {
  const map = new Map<string, EntitySpace>();
  for (const br of blockRecordEntries ?? []) {
    const space = classifyBlockRecordSpace(br?.name);
    if (space === 'unknown') continue;
    const handle = br?.handle ?? br?.objectHandle ?? br?.id;
    if (handle === undefined || handle === null) continue;
    map.set(String(handle).toUpperCase(), space);
  }
  return map;
}

function annotateEntitySpace(entity: any, ownerSpaceByHandle: Map<string, EntitySpace>, inheritedSpace: EntitySpace = 'unknown'): void {
  if (!entity || typeof entity !== 'object') return;

  let resolved: EntitySpace = inheritedSpace;

  const explicitBool = entity.paperSpace ?? entity.paperspace ?? entity.inPaperSpace ?? entity.isPaperSpace;
  if (typeof explicitBool === 'boolean') {
    resolved = explicitBool ? 'paper' : 'model';
  }

  if (resolved === 'unknown') {
    const ownerHandle = entity.ownerBlockRecordSoftId ?? entity.ownerBlockRecordHandle ?? entity.ownerHandle;
    if (ownerHandle !== undefined && ownerHandle !== null) {
      const mapped = ownerSpaceByHandle.get(String(ownerHandle).toUpperCase());
      if (mapped) resolved = mapped;
    }
  }

  const explicitText = String(entity.entitySpace ?? '').toLowerCase();
  if (explicitText.includes('paper')) resolved = 'paper';
  if (explicitText.includes('model')) resolved = 'model';

  if (resolved !== 'unknown') {
    entity.entitySpace = resolved;
    entity.isInPaperSpace = resolved === 'paper';
  }

  const nestedGroups = [entity.attribs, entity.attributes];
  for (const group of nestedGroups) {
    if (!Array.isArray(group)) continue;
    for (const child of group) {
      annotateEntitySpace(child, ownerSpaceByHandle, resolved);
    }
  }
}

function annotateEntitiesSpaceByOwner(entities: any[], blockRecordEntries: any[]): any[] {
  const ownerSpaceByHandle = buildOwnerSpaceMap(blockRecordEntries);
  for (const entity of entities ?? []) {
    annotateEntitySpace(entity, ownerSpaceByHandle);
  }
  return entities;
}

function mapInsUnitsToLabel(insUnits: number): string {
  const unitMap: Record<number, string> = {
    0: 'Unitless',
    1: 'Inches',
    2: 'Feet',
    3: 'Miles',
    4: 'Millimeters',
    5: 'Centimeters',
    6: 'Meters',
    7: 'Kilometers',
    8: 'Microinches',
    9: 'Mils',
    10: 'Yards',
    11: 'Angstroms',
    12: 'Nanometers',
    13: 'Microns',
    14: 'Decimeters',
    15: 'Decameters',
    16: 'Hectometers',
    17: 'Gigameters',
    18: 'Astronomical Units',
    19: 'Light Years',
    20: 'Parsecs',
    21: 'US Survey Feet',
    22: 'US Survey Inch',
    23: 'US Survey Yard',
    24: 'US Survey Mile'
  };
  return unitMap[insUnits] ?? `INSUNITS ${insUnits}`;
}

type LayerMeta = {
  color: number | null;
  hex: string | null;
  name: string;
  visible: boolean;
  linetype: string | null;
  linetypePattern?: number[] | null;
  lineweightMm?: number | null;
};

function extractDashElementLength(raw: any): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof raw === 'object') {
    const candidates = [raw.length, raw.value, raw.segmentLength, raw.dashLength, raw.len];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function normalizeDashArray(raw: any): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw
    .map((v) => extractDashElementLength(v))
    .filter((v): v is number => Number.isFinite(v))
    .map((v) => Math.abs(v))
    .filter((n) => n >= 0);
  return out.length ? out : null;
}

function buildDxfLinetypePatternMap(tables: any): Record<string, number[] | null> {
  const out: Record<string, number[] | null> = {};
  const ltRoot = tables?.lineType ?? tables?.linetype ?? tables?.LTYPE ?? null;
  if (!ltRoot) return out;
  const defsObj = ltRoot.lineTypes ?? ltRoot.linetypes ?? ltRoot.entries ?? ltRoot;
  const defs: any[] = Array.isArray(defsObj) ? defsObj : Object.values(defsObj);
  for (const def of defs) {
    const name = String(def?.name || '').trim();
    if (!name) continue;
    const pattern = normalizeDashArray(
      def?.pattern ??
      def?.elements ??
      def?.segments ??
      def?.dashes ??
      def?.dashArray ??
      def?.data
    );
    out[name.toUpperCase()] = pattern;
  }
  return out;
}

function buildDwgLinetypePatternMap(dwgDb: any): Record<string, number[] | null> {
  const out: Record<string, number[] | null> = {};
  const defs: any[] = dwgDb?.tables?.LTYPE?.entries ?? [];
  for (const def of defs) {
    const name = String(def?.name || '').trim();
    if (!name) continue;
    const pattern = normalizeDashArray(
      def?.pattern ??
      def?.dashes ??
      def?.dashLengths ??
      def?.elements ??
      def?.segments ??
      def?.lines ??
      def?.data
    );
    out[name.toUpperCase()] = pattern;
  }
  return out;
}

function normalizeLineweightMm(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  // CAD lineweights are typically stored as hundredths of a millimeter when the
  // raw value is an integer code (for example 7 => 0.07 mm, 35 => 0.35 mm).
  if (Number.isInteger(n) && n <= 211) return n / 100;
  // Some parsers may already normalize to millimeters as floats (for example 0.35).
  if (!Number.isInteger(n) && n < 10) return n;
  return null;
}

function buildDwgLinetypeNameByHandleMap(dwgDb: any): Map<string, string> {
  const map = new Map<string, string>();
  const defs: any[] = dwgDb?.tables?.LTYPE?.entries ?? [];
  for (const def of defs) {
    const name = String(def?.name || '').trim();
    if (!name) continue;
    const candidates = [def?.handle, def?.objectHandle, def?.id];
    for (const c of candidates) {
      if (c === undefined || c === null) continue;
      map.set(String(c).toUpperCase(), name);
    }
  }
  return map;
}

function resolveEntityLinetypeName(entity: any, handleMap?: Map<string, string>): string | null {
  if (!entity || typeof entity !== 'object') return null;
  const rawName = entity.lineTypeName ?? entity.linetypeName ?? entity.linetype ?? entity.lineType ?? entity.ltype ?? null;
  if (typeof rawName === 'string' && rawName.trim()) return rawName.trim();

  const rawHandle = entity.linetypeHandle ?? entity.lineTypeHandle ?? entity.ltypeHandle ?? entity.linetypeId ?? null;
  if (rawHandle !== null && rawHandle !== undefined && handleMap) {
    return handleMap.get(String(rawHandle).toUpperCase()) ?? null;
  }
  return null;
}

function annotateEntityStyle(
  entity: any,
  linetypePatternByName: Record<string, number[] | null>,
  linetypeHandleMap?: Map<string, string>
): void {
  if (!entity || typeof entity !== 'object') return;

  const linetypeName = resolveEntityLinetypeName(entity, linetypeHandleMap);
  if (linetypeName && !entity.lineTypeName) entity.lineTypeName = linetypeName;
  if (linetypeName && !entity.linetypePattern) {
    const pattern = linetypePatternByName[String(linetypeName).toUpperCase()] ?? null;
    if (pattern) entity.linetypePattern = pattern;
  }

  if (!entity.lineweightMm) {
    const lw = normalizeLineweightMm(
      entity.lineweight ??
      entity.lineWeight ??
      entity.lWeight ??
      entity.weight
    );
    if (lw) entity.lineweightMm = lw;
  }

  const nestedGroups = [entity.attribs, entity.attributes];
  for (const group of nestedGroups) {
    if (!Array.isArray(group)) continue;
    for (const child of group) {
      annotateEntityStyle(child, linetypePatternByName, linetypeHandleMap);
    }
  }
}

function annotateEntitiesStyle(
  entities: any[],
  linetypePatternByName: Record<string, number[] | null>,
  linetypeHandleMap?: Map<string, string>
): any[] {
  for (const entity of entities ?? []) {
    annotateEntityStyle(entity, linetypePatternByName, linetypeHandleMap);
  }
  return entities;
}

function annotateBlockMapStyles(
  blocks: Record<string, any>,
  linetypePatternByName: Record<string, number[] | null>,
  linetypeHandleMap?: Map<string, string>
): Record<string, any> {
  for (const block of Object.values(blocks || {})) {
    const entities = Array.isArray((block as any)?.entities)
      ? (block as any).entities
      : (Array.isArray((block as any)?.objects) ? (block as any).objects : null);
    if (!entities) continue;
    annotateEntitiesStyle(entities, linetypePatternByName, linetypeHandleMap);
  }
  return blocks;
}

function extractLayerTable(tables: any): Record<string, LayerMeta> {
  const result: Record<string, LayerMeta> = {};
  if (!tables) return result;
  const linetypePatterns = buildDxfLinetypePatternMap(tables);
  // dxf-parser stores layers at tables.layer.layers keyed by layer name
  const layerTable = tables.layer ?? tables.LAYER ?? null;
  if (!layerTable) return result;
  const layersObj = layerTable.layers ?? layerTable;
  const entries: any[] = Array.isArray(layersObj)
    ? layersObj
    : Object.values(layersObj);
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !entry.name) continue;
    const name = String(entry.name);
    // entry.colorIndex (ACI): negative value means the layer is turned off (AutoCAD convention)
    const rawIdx = entry.colorIndex ?? (typeof entry.color === 'number' ? entry.color : null);
    const colorIdxNum = typeof rawIdx === 'number' ? rawIdx : null;
    const colorIdx = colorIdxNum !== null ? Math.abs(colorIdxNum) : null;
    // Layer is visible unless colorIndex is negative (layer off) or explicitly frozen/off
    const visible = !(colorIdxNum !== null && colorIdxNum < 0) && !entry.frozen && !entry.off;
    // Only use hex for explicit 24-bit true color (group code 420); entry.color in dxf-parser
    // is the ACI index (1-255), NOT a 24-bit RGB value - do NOT treat it as RGB.
    let hex: string | null = null;
    const tcNum = Number(entry.trueColor ?? entry.truecolor ?? null);
    if (Number.isFinite(tcNum) && tcNum > 0) {
      const r = (tcNum >> 16) & 0xff;
      const g = (tcNum >> 8) & 0xff;
      const b = tcNum & 0xff;
      hex = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    } else if (typeof entry.color === 'string' && /^#[0-9a-f]{6}$/i.test(entry.color)) {
      hex = entry.color;
    }
    const linetype = typeof entry.lineTypeName === 'string'
      ? entry.lineTypeName
      : (typeof entry.linetype === 'string' ? entry.linetype : null);
    const linetypePattern = linetype ? (linetypePatterns[String(linetype).toUpperCase()] ?? null) : null;
    const lineweightMm = normalizeLineweightMm(entry.lineweight ?? entry.lineWeight ?? entry.weight);
    result[name.toUpperCase()] = { color: colorIdx, hex, name, visible, linetype, linetypePattern, lineweightMm };
  }
  return result;
}

function extractLayerTableFromDwgDb(dwgDb: any): Record<string, LayerMeta> {
  const result: Record<string, LayerMeta> = {};
  const linetypePatterns = buildDwgLinetypePatternMap(dwgDb);
  const entries: any[] = dwgDb?.tables?.LAYER?.entries ?? [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !entry.name) continue;
    const name = String(entry.name);
    const colorIdxRaw = entry.colorIndex ?? entry.colorNumber ?? entry.aci ?? entry.color?.index ?? null;
    const colorIdxNum = Number.isFinite(Number(colorIdxRaw)) ? Number(colorIdxRaw) : null;
    const colorIdx = colorIdxNum !== null ? Math.abs(colorIdxNum) : null;
    // Negative colorIndex means layer is off; also check freeze/off flags from libredwg
    const visible = !(colorIdxNum !== null && colorIdxNum < 0) && !entry.freeze && !entry.frozen && !entry.off;

    let hex: string | null = null;
    // Only use trueColor/truecolor for 24-bit RGB; colorValue may be ACI (0-256) so skip it.
    // Guard: n must be > 0 (0 = BYBLOCK/unset) and != 256 (BYLAYER).
    const trueColorNum = Number(entry.trueColor ?? entry.truecolor ?? null);
    if (Number.isFinite(trueColorNum) && trueColorNum > 0 && trueColorNum !== 256) {
      const r = (trueColorNum >> 16) & 0xff;
      const g = (trueColorNum >> 8) & 0xff;
      const b = trueColorNum & 0xff;
      hex = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    } else if (entry.color?.rgb != null) {
      // libredwg color object with explicit .rgb integer
      const n = Number(entry.color.rgb);
      if (Number.isFinite(n) && n > 0) {
        const r = (n >> 16) & 0xff;
        const g = (n >> 8) & 0xff;
        const b = n & 0xff;
        hex = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
      }
    } else if (typeof entry.color === 'string' && /^#[0-9a-f]{6}$/i.test(entry.color)) {
      hex = entry.color;
    }

    const linetype = typeof entry.lineTypeName === 'string'
      ? entry.lineTypeName
      : (typeof entry.linetypeName === 'string'
        ? entry.linetypeName
        : (typeof entry.linetype === 'string' ? entry.linetype : null));
    const linetypePattern = linetype ? (linetypePatterns[String(linetype).toUpperCase()] ?? null) : null;
    const lineweightMm = normalizeLineweightMm(entry.lineweight ?? entry.lineWeight ?? entry.weight);
    result[name.toUpperCase()] = { color: colorIdx, hex, name, visible, linetype, linetypePattern, lineweightMm };
  }
  return result;
}

function extractUnitsFromHeader(header: any): { code: number | null; label: string } {
  if (!header || typeof header !== 'object') {
    return { code: null, label: 'Unknown' };
  }

  const raw = header.$INSUNITS ?? header.INSUNITS ?? null;
  if (raw === null || raw === undefined || raw === '') {
    return { code: null, label: 'Unknown' };
  }

  const code = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (Number.isNaN(code)) {
    return { code: null, label: 'Unknown' };
  }

  return { code, label: mapInsUnitsToLabel(code) };
}

function normalizePossiblePath(v: any): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length ? s : null;
}

function resolveReferencePath(baseFilePath: string, refPath: string | null): string | null {
  if (!refPath) return null;
  if (path.isAbsolute(refPath)) return refPath;
  return path.resolve(path.dirname(baseFilePath), refPath);
}

function extractXrefsFromBlocks(blocks: any, baseFilePath: string): XrefReference[] {
  const out: XrefReference[] = [];
  if (!blocks || typeof blocks !== 'object') return out;
  for (const [name, raw] of Object.entries(blocks)) {
    const b: any = raw as any;
    const refPath =
      normalizePossiblePath(b?.xrefPath) ??
      normalizePossiblePath(b?.xRefPath) ??
      normalizePossiblePath(b?.externalReferencePath) ??
      normalizePossiblePath(b?.pathName) ??
      normalizePossiblePath(b?.filename) ??
      normalizePossiblePath(b?.fileName);
    const isXref = !!(b?.isXref || b?.xref || b?.externalReference || refPath || String(name).includes('|'));
    if (!isXref) continue;
    out.push({
      name: String(name),
      path: refPath,
      resolvedPath: resolveReferencePath(baseFilePath, refPath),
      source: 'block'
    });
  }
  return out;
}

function extractXrefsFromBlockRecords(entries: any[], baseFilePath: string): XrefReference[] {
  const out: XrefReference[] = [];
  for (const rec of entries || []) {
    if (!rec || typeof rec !== 'object') continue;
    const name = String(rec.name || '').trim();
    if (!name) continue;
    const refPath =
      normalizePossiblePath(rec?.xrefPath) ??
      normalizePossiblePath(rec?.xRefPath) ??
      normalizePossiblePath(rec?.pathName) ??
      normalizePossiblePath(rec?.filename) ??
      normalizePossiblePath(rec?.fileName) ??
      normalizePossiblePath(rec?.xref?.path);
    const flags = Number(rec?.flags ?? rec?.flag ?? 0);
    const isXref = !!(rec?.isXref || rec?.xref || refPath || String(name).includes('|') || (Number.isFinite(flags) && ((flags & 4) === 4 || (flags & 8) === 8)));
    if (!isXref) continue;
    out.push({
      name,
      path: refPath,
      resolvedPath: resolveReferencePath(baseFilePath, refPath),
      source: 'block-record'
    });
  }
  return out;
}

function dedupeXrefs(items: XrefReference[]): XrefReference[] {
  const map = new Map<string, XrefReference>();
  for (const x of items) {
    const key = `${x.name.toUpperCase()}|${String(x.resolvedPath || x.path || '')}`;
    if (!map.has(key)) map.set(key, x);
  }
  return Array.from(map.values());
}

type ParsePayload = {
  source: string;
  entities: any[];
  blocks: Record<string, any>;
  layers: Record<string, LayerMeta>;
  units: { code: number | null; label: string };
  xrefs: XrefReference[];
};

function ensureBlockMap(blocks: any): Record<string, any> {
  if (!blocks || typeof blocks !== 'object') return {};
  return blocks as Record<string, any>;
}

async function parseCadFileForReference(filePath: string): Promise<ParsePayload | null> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.dxf') {
    const content = fs.readFileSync(filePath, 'utf8');
    const DxfParser = require('dxf-parser');
    const parser = new DxfParser();
    const dxf = parser.parseSync(content);
    const linetypePatternByName = buildDxfLinetypePatternMap(dxf.tables);
    const blocks = annotateBlockMapStyles(ensureBlockMap(dxf.blocks), linetypePatternByName);
    const entities = annotateEntitiesStyle(dxf.entities ?? [], linetypePatternByName);
    return {
      source: 'dxf-parser',
      entities,
      blocks,
      layers: extractLayerTable(dxf.tables),
      units: extractUnitsFromHeader(dxf.header),
      xrefs: dedupeXrefs(extractXrefsFromBlocks(blocks, filePath))
    };
  }

  if (ext !== '.dwg') return null;

  const nodeBuffer = fs.readFileSync(filePath);

  try {
    const libredwg = await getLibredwg();
    const { Dwg_File_Type } = require('@mlightcad/libredwg-web');
    const dwgData = libredwg.dwg_read_data(new Uint8Array(nodeBuffer), Dwg_File_Type.DWG);
    const dwgDb = libredwg.convert(dwgData);
    const linetypePatternByName = buildDwgLinetypePatternMap(dwgDb);
    const linetypeHandleMap = buildDwgLinetypeNameByHandleMap(dwgDb);
    const blockRecordEntries: any[] = dwgDb?.tables?.BLOCK_RECORD?.entries ?? [];
    const entities = annotateEntitiesStyle(
      annotateEntitiesSpaceByOwner(
        normalizeEntitiesForRenderer(dwgDb?.entities ?? []),
        blockRecordEntries
      ),
      linetypePatternByName,
      linetypeHandleMap
    );
    const blocks: Record<string, any> = {};
    for (const br of blockRecordEntries) {
      if (!br?.name) continue;
      const blockSpace = classifyBlockRecordSpace(br.name);
      const blockEntities = annotateEntitiesStyle(
        normalizeEntitiesForRenderer(br.entities ?? []),
        linetypePatternByName,
        linetypeHandleMap
      );
      for (const blockEntity of blockEntities) {
        annotateEntitySpace(blockEntity, new Map<string, EntitySpace>(), blockSpace);
      }
      const blockPayload = {
        entities: blockEntities,
        basePoint: br.basePoint ?? { x: 0, y: 0, z: 0 }
      };
      blocks[br.name] = blockPayload;
      const upper = String(br.name).toUpperCase();
      if (upper !== br.name) blocks[upper] = blockPayload;
    }
    return {
      source: 'libredwg',
      entities,
      blocks,
      layers: extractLayerTableFromDwgDb(dwgDb),
      units: extractUnitsFromHeader(dwgDb?.header),
      xrefs: dedupeXrefs(extractXrefsFromBlockRecords(blockRecordEntries, filePath))
    };
  } catch {
    const arrayBuffer = nodeBuffer.buffer.slice(
      nodeBuffer.byteOffset,
      nodeBuffer.byteOffset + nodeBuffer.byteLength
    );
    const mod = await getLibdxfrw();
    const database = new mod.DRW_Database();
    const fileHandler = new mod.DRW_FileHandler();
    fileHandler.database = database;
    const ok = fileHandler.fileImport(arrayBuffer, database, false, false);
    if (!ok) {
      database.delete();
      fileHandler.delete();
      return null;
    }
    const dxfContent = fileHandler.fileExport(mod.DRW_Version.AC1021, false, database, false);
    database.delete();
    fileHandler.delete();

    const DxfParser = require('dxf-parser');
    const parser = new DxfParser();
    const dxfParsed = parser.parseSync(dxfContent);
    const linetypePatternByName = buildDxfLinetypePatternMap(dxfParsed.tables);
    const blocks = annotateBlockMapStyles(ensureBlockMap(dxfParsed.blocks), linetypePatternByName);
    const entities = annotateEntitiesStyle(dxfParsed.entities ?? [], linetypePatternByName);
    return {
      source: 'libdxfrw-dxf',
      entities,
      blocks,
      layers: extractLayerTable(dxfParsed.tables),
      units: extractUnitsFromHeader(dxfParsed.header),
      xrefs: dedupeXrefs(extractXrefsFromBlocks(blocks, filePath))
    };
  }
}

async function mergeExternalReferences(baseFilePath: string, payload: ParsePayload, maxDepth = 3): Promise<ParsePayload> {
  const visited = new Set<string>([path.resolve(baseFilePath).toLowerCase()]);
  const queue = payload.xrefs.map((x) => ({ xref: x, depth: 1 }));

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    if (item.depth > maxDepth) continue;

    const xrefPath = item.xref.resolvedPath;
    if (!xrefPath) continue;
    const resolved = path.resolve(xrefPath);
    const key = resolved.toLowerCase();
    if (visited.has(key)) continue;
    visited.add(key);
    if (!fs.existsSync(resolved)) continue;

    try {
      const ext = await parseCadFileForReference(resolved);
      if (!ext) continue;

      if (item.xref.name && !payload.blocks[item.xref.name] && Array.isArray(ext.entities) && ext.entities.length > 0) {
        payload.blocks[item.xref.name] = {
          entities: ext.entities,
          basePoint: { x: 0, y: 0, z: 0 }
        };
      }

      for (const [name, blk] of Object.entries(ext.blocks || {})) {
        if (!payload.blocks[name]) {
          payload.blocks[name] = blk;
          continue;
        }
        const prefixed = `${item.xref.name}|${name}`;
        if (!payload.blocks[prefixed]) {
          payload.blocks[prefixed] = blk;
        }
      }

      for (const [layerName, layerValue] of Object.entries(ext.layers || {})) {
        if (!payload.layers[layerName]) {
          payload.layers[layerName] = layerValue as any;
        }
      }

      for (const child of ext.xrefs || []) {
        const childKey = path.resolve(child.resolvedPath || '').toLowerCase();
        if (!child.resolvedPath || visited.has(childKey)) continue;
        queue.push({ xref: child, depth: item.depth + 1 });
      }
    } catch (err) {
      console.warn('[xref] failed to load reference:', resolved, (err as Error).message);
    }
  }

  payload.xrefs = dedupeXrefs(payload.xrefs);
  return payload;
}

async function saveAutomationArtifacts(payload: any): Promise<{ fullPath: string; canvasPath: string; statsPath: string }> {
  if (!mainWindow) {
    throw new Error('Main window is not available for capture.');
  }

  const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T | null> => {
    let timeoutId: NodeJS.Timeout | null = null;
    try {
      const timeoutPromise = new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), timeoutMs);
      });
      const result = await Promise.race([promise, timeoutPromise]);
      if (result === null) {
        console.warn(`[automation] ${label} timed out after ${timeoutMs}ms`);
      }
      return result as T | null;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  fs.mkdirSync(automationConfig.captureDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fullPath = path.join(automationConfig.captureDir, `viewer-full-${stamp}.png`);
  const canvasPath = path.join(automationConfig.captureDir, `viewer-canvas-${stamp}.png`);
  const statsPath = path.join(automationConfig.captureDir, `viewer-stats-${stamp}.json`);

  const image = await withTimeout(mainWindow.webContents.capturePage(), 8000, 'capturePage');
  if (image) {
    fs.writeFileSync(fullPath, image.toPNG());
  } else {
    fs.writeFileSync(fullPath, Buffer.alloc(0));
  }

  try {
    const canvasDataUrl = await withTimeout(mainWindow.webContents.executeJavaScript(`(() => {
      const c = document.getElementById('canvas');
      return c ? c.toDataURL('image/png') : null;
    })()`), 5000, 'canvas data extraction');
    if (typeof canvasDataUrl === 'string' && canvasDataUrl.startsWith('data:image/png;base64,')) {
      const b64 = canvasDataUrl.slice('data:image/png;base64,'.length);
      fs.writeFileSync(canvasPath, Buffer.from(b64, 'base64'));
    } else {
      fs.writeFileSync(canvasPath, Buffer.alloc(0));
    }
  } catch {
    fs.writeFileSync(canvasPath, Buffer.alloc(0));
  }

  const safePayload = {
    capturedAt: new Date().toISOString(),
    automation: automationConfig,
    payload: payload ?? null
  };
  fs.writeFileSync(statsPath, JSON.stringify(safePayload, null, 2), 'utf8');
  return { fullPath, canvasPath, statsPath };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    },
    icon: path.join(__dirname, '../public/icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, '../public/index.html'));

  // Keep DevTools closed by default to avoid noisy console transport errors
  // during automated runs; open manually when needed.

  // Relay renderer console messages to main process stdout (for diagnostics)
  mainWindow.webContents.on('console-message', (_event, _level, message) => {
    if (
      message.includes('=== RENDERING') ||
      message.includes('[automation]') ||
      message.includes('showError:') ||
      message.includes('Error loading file:')
    ) {
      console.log('[renderer]', message);
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('renderer finished loading');
    if (automationConfig.enabled && automationConfig.autoOpenPath) {
      console.log('[automation] auto-opening file:', automationConfig.autoOpenPath);
      mainWindow?.webContents.send('file-selected', automationConfig.autoOpenPath);
    } else if (pendingOpenPath) {
      mainWindow?.webContents.send('file-selected', pendingOpenPath);
      pendingOpenPath = null;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  createMenu();
}

function createMenu() {
  const hwAccelChecked = !!appSettings.hardwareAcceleration;
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            if (mainWindow) {
              dialog.showOpenDialog(mainWindow, {
                filters: [
                  { name: 'CAD Files', extensions: ['dwg', 'dxf'] },
                  { name: 'All Files', extensions: ['*'] }
                ]
              }).then(result => {
                if (!result.canceled && result.filePaths.length > 0) {
                  mainWindow?.webContents.send('file-selected', result.filePaths[0]);
                }
              });
            }
          }
        },
        {
          label: 'Print',
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            if (!mainWindow) return;
            mainWindow.webContents.send('open-print-dialog');
          }
        },
        {
          label: 'Close File',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (!mainWindow) return;
            mainWindow.webContents.send('close-current-file');
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Settings',
      submenu: [
        {
          label: 'Hardware Acceleration',
          type: 'checkbox',
          checked: hwAccelChecked,
          click: (menuItem) => {
            const enabled = !!menuItem.checked;
            if (enabled === appSettings.hardwareAcceleration) return;
            appSettings = { ...appSettings, hardwareAcceleration: enabled };
            writeAppSettings(appSettings);
            dialog.showMessageBox({
              type: 'info',
              title: 'Restart Required',
              message: 'Hardware acceleration change will apply after restart.',
              buttons: ['Restart Now', 'Later'],
              defaultId: 0,
              cancelId: 1
            }).then((result) => {
              if (result.response === 0) {
                app.relaunch();
                app.exit(0);
              }
            }).catch(() => {
              // Ignore prompt failures; setting is already persisted.
            });
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

ipcMain.handle('read-file', async (_event, filePath: string) => {
  try {
    const data = fs.readFileSync(filePath);
    return { success: true, data: data.toString('base64'), path: filePath };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('get-file-info', async (_event, filePath: string) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const stat = fs.statSync(filePath);
    return {
      success: true,
      name: path.basename(filePath),
      extension: ext,
      size: stat.size,
      path: filePath
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('parse-file', async (_event, filePath: string) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.dxf') {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const DxfParser = require('dxf-parser');
      const parser = new DxfParser();
      const dxf = parser.parseSync(content);
      const units = extractUnitsFromHeader(dxf.header);
      const layers = extractLayerTable(dxf.tables);
      const linetypePatternByName = buildDxfLinetypePatternMap(dxf.tables);
      const entities = annotateEntitiesStyle(dxf.entities ?? [], linetypePatternByName);
      const blocks = annotateBlockMapStyles(ensureBlockMap(dxf.blocks), linetypePatternByName);
      let payload: ParsePayload = {
        source: 'dxf-parser',
        entities,
        blocks,
        layers,
        units,
        xrefs: dedupeXrefs(extractXrefsFromBlocks(blocks, filePath))
      };
      if (readerProfile.readExternalReferences) {
        payload = await mergeExternalReferences(filePath, payload);
      }
      return {
        success: true,
        source: payload.source,
        entities: payload.entities,
        blocks: payload.blocks,
        layers: payload.layers,
        units: payload.units,
        xrefs: payload.xrefs,
        readerProfile
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  } else if (ext === '.dwg') {
    try {
      const nodeBuffer = fs.readFileSync(filePath);
      // Primary path: libredwg is more tolerant for problematic DWGs.
      try {
        const libredwg = await getLibredwg();
        const { Dwg_File_Type } = require('@mlightcad/libredwg-web');
        // libredwg emits a non-fatal "Open dwg file with error code" log for
        // some files even when conversion succeeds. Filter only that line.
        const originalLog = console.log;
        console.log = (...args: any[]) => {
          const first = String(args?.[0] ?? '');
          if (first.includes('Open dwg file with error code')) return;
          originalLog(...args);
        };
        let dwgData: any;
        try {
          dwgData = libredwg.dwg_read_data(new Uint8Array(nodeBuffer), Dwg_File_Type.DWG);
        } finally {
          console.log = originalLog;
        }
        const dwgDb = libredwg.convert(dwgData);
        const linetypePatternByName = buildDwgLinetypePatternMap(dwgDb);
        const linetypeHandleMap = buildDwgLinetypeNameByHandleMap(dwgDb);
        const blockRecordEntries: any[] = dwgDb?.tables?.BLOCK_RECORD?.entries ?? [];
        const entities = annotateEntitiesStyle(
          annotateEntitiesSpaceByOwner(
            normalizeEntitiesForRenderer(dwgDb?.entities ?? []),
            blockRecordEntries
          ),
          linetypePatternByName,
          linetypeHandleMap
        );
        if (entities.length) {
          const blocks: Record<string, any> = {};
          for (const br of blockRecordEntries) {
            if (!br?.name) continue;
            const blockSpace = classifyBlockRecordSpace(br.name);
            const blockEntities = annotateEntitiesStyle(
              normalizeEntitiesForRenderer(br.entities ?? []),
              linetypePatternByName,
              linetypeHandleMap
            );
            for (const blockEntity of blockEntities) {
              annotateEntitySpace(blockEntity, new Map<string, EntitySpace>(), blockSpace);
            }
            const blockPayload = {
              entities: blockEntities,
              basePoint: br.basePoint ?? { x: 0, y: 0, z: 0 }
            };
            blocks[br.name] = blockPayload;
            const upper = String(br.name).toUpperCase();
            if (upper !== br.name) blocks[upper] = blockPayload;
          }
          const layers = extractLayerTableFromDwgDb(dwgDb);
          const xrefs = dedupeXrefs(extractXrefsFromBlockRecords(blockRecordEntries, filePath));
          console.log('[parse-file] libredwg primary parse ok, blocks:', Object.keys(blocks).length, 'layers:', Object.keys(layers).length);
          const units = extractUnitsFromHeader(dwgDb?.header);
          let payload: ParsePayload = {
            source: 'libredwg',
            entities,
            blocks,
            layers,
            units,
            xrefs
          };
          if (readerProfile.readExternalReferences) {
            payload = await mergeExternalReferences(filePath, payload);
          }
          return {
            success: true,
            source: payload.source,
            entities: payload.entities,
            blocks: payload.blocks,
            layers: payload.layers,
            units: payload.units,
            xrefs: payload.xrefs,
            readerProfile
          };
        }
      } catch (libredwgErr) {
        console.warn('[parse-file] libredwg primary parse failed, trying libdxfrw fallback:', (libredwgErr as Error).message);
      }

      // Fallback path: libdxfrw -> DXF export -> dxf-parser.
      const arrayBuffer = nodeBuffer.buffer.slice(
        nodeBuffer.byteOffset,
        nodeBuffer.byteOffset + nodeBuffer.byteLength
      );
      const mod = await getLibdxfrw();
      const database = new mod.DRW_Database();
      const fileHandler = new mod.DRW_FileHandler();
      fileHandler.database = database;
      const ok = fileHandler.fileImport(arrayBuffer, database, false, false);
      console.log('[parse-file] libdxfrw fallback import ok:', ok);
      if (!ok) {
        database.delete();
        fileHandler.delete();
        return { success: false, error: 'Both libredwg and libdxfrw failed to parse this DWG file.' };
      }

      const dxfContent = fileHandler.fileExport(mod.DRW_Version.AC1021, false, database, false);
      database.delete();
      fileHandler.delete();
      const DxfParser = require('dxf-parser');
      const parser = new DxfParser();
      const dxfParsed = parser.parseSync(dxfContent);
      const units = extractUnitsFromHeader(dxfParsed.header);
      const layers = extractLayerTable(dxfParsed.tables);
      const linetypePatternByName = buildDxfLinetypePatternMap(dxfParsed.tables);
      const entities = annotateEntitiesStyle(dxfParsed.entities ?? [], linetypePatternByName);
      const blocks = annotateBlockMapStyles(ensureBlockMap(dxfParsed.blocks), linetypePatternByName);
      let payload: ParsePayload = {
        source: 'libdxfrw-dxf',
        entities,
        blocks,
        layers,
        units,
        xrefs: dedupeXrefs(extractXrefsFromBlocks(blocks, filePath))
      };
      if (readerProfile.readExternalReferences) {
        payload = await mergeExternalReferences(filePath, payload);
      }
      return {
        success: true,
        source: payload.source,
        entities: payload.entities,
        blocks: payload.blocks,
        layers: payload.layers,
        units: payload.units,
        xrefs: payload.xrefs,
        readerProfile
      };
    } catch (err) {
      return { success: false, error: `DWG conversion failed: ${(err as Error).message}` };
    }
  } else {
    return { success: false, error: 'Unsupported file format' };
  }
});

ipcMain.handle('request-open-file', async (event) => {
  if (!mainWindow) return { success: false };
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [
      { name: 'CAD Files', extensions: ['dwg', 'dxf'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    mainWindow.webContents.send('file-selected', result.filePaths[0]);
    return { success: true, path: result.filePaths[0] };
  }
  return { success: false };
});

ipcMain.handle('get-hardware-acceleration', async () => {
  return { enabled: !!appSettings.hardwareAcceleration };
});

ipcMain.handle('print-drawing', async (_event, settings: any) => {
  if (!mainWindow) {
    return { success: false, error: 'No active window to print.' };
  }

  const orientation = String(settings?.orientation || 'landscape').toLowerCase();
  const pageSize = String(settings?.pageSize || 'Letter');
  const marginInches = Math.max(0, Math.min(2, Number(settings?.marginInches ?? 0.25) || 0.25));
  const printBackground = !!settings?.printBackground;
  const color = !settings?.monochrome;
  const css = `@page { size: ${pageSize} ${orientation}; margin: ${marginInches}in; }`;

  let insertedCssKey: string | null = null;
  try {
    insertedCssKey = await mainWindow.webContents.insertCSS(css);
    return await new Promise((resolve) => {
      const options: any = {
        printBackground,
        landscape: orientation === 'landscape',
        color,
        pageSize
      };
      mainWindow?.webContents.print(options, (success, failureReason) => {
        if (!success) {
          resolve({ success: false, error: failureReason || 'Print cancelled or failed.' });
          return;
        }
        resolve({ success: true });
      });
    });
  } finally {
    if (insertedCssKey) {
      try {
        await mainWindow.webContents.removeInsertedCSS(insertedCssKey);
      } catch {
        // Ignore CSS cleanup failure; it should not block printing.
      }
    }
  }
});

ipcMain.handle('get-automation-config', async () => {
  return {
    enabled: automationConfig.enabled,
    autoOpenPath: automationConfig.autoOpenPath,
    captureDir: automationConfig.captureDir,
    autoExit: automationConfig.autoExit,
    ignoreTypes: automationConfig.ignoreTypes
  };
});

ipcMain.handle('report-view-ready', async (_event, payload: any) => {
  if (!automationConfig.enabled) {
    return { success: true, enabled: false };
  }

  try {
    const saved = await saveAutomationArtifacts(payload);
    console.log('[automation] artifacts saved:', saved);
    if (automationConfig.autoExit) {
      setTimeout(() => app.quit(), 250);
    }
    return { success: true, enabled: true, ...saved };
  } catch (err) {
    return { success: false, enabled: true, error: (err as Error).message };
  }
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  pendingOpenPath = resolveOpenPathFromArgv(process.argv);

  app.on('second-instance', (_event, argv) => {
    const nextPath = resolveOpenPathFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (nextPath) {
        mainWindow.webContents.send('file-selected', nextPath);
      }
    } else if (nextPath) {
      pendingOpenPath = nextPath;
    }
  });

  app.whenReady().then(() => {
    createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
