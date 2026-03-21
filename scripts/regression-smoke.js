const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(`[regression] FAIL: ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`[regression] PASS: ${message}`);
}

const root = path.resolve(__dirname, '..');
const rendererPath = path.join(root, 'public', 'renderer.js');
const mainPath = path.join(root, 'src', 'main.ts');

if (!fs.existsSync(rendererPath)) fail('Missing public/renderer.js');
if (!fs.existsSync(mainPath)) fail('Missing src/main.ts');

const renderer = fs.readFileSync(rendererPath, 'utf8');
const mainTs = fs.readFileSync(mainPath, 'utf8');

const caseRegex = /case\s+'([A-Z0-9_]+)'/g;
const handled = new Set();
let m;
while ((m = caseRegex.exec(renderer))) {
  handled.add(m[1]);
}

const requiredCases = [
  'LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'ELLIPSE',
  'SPLINE', 'RAY', 'XLINE',
  'TEXT', 'MTEXT', 'DIMENSION', 'LEADER',
  'INSERT', 'HATCH', 'VIEWPORT',
  'IMAGE', 'PDFUNDERLAY', 'DGNUNDERLAY', 'DWFUNDERLAY',
  'MESH', 'SURFACE', '3DSOLID'
];

const missing = requiredCases.filter((k) => !handled.has(k));
if (missing.length) {
  fail(`Missing entity handlers: ${missing.join(', ')}`);
}
pass(`Entity handler coverage includes ${requiredCases.length} required cases.`);

const profileChecks = [
  'readExternalReferences',
  'mergeExternalReferences',
  'xrefs:'
];
for (const token of profileChecks) {
  if (!mainTs.includes(token)) {
    fail(`Expected token not found in main.ts: ${token}`);
  }
}
pass('Reader profile and XREF merge plumbing detected in main process.');

console.log('[regression] Smoke checks completed.');
