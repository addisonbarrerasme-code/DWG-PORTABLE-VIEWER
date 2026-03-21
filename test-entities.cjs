const { LibreDwg } = require('@mlightcad/libredwg-web');
const path = require('path');
const fs = require('fs');
const wasmDir = path.join(__dirname, 'node_modules', '@mlightcad', 'libredwg-web', 'wasm');
LibreDwg.create(wasmDir).then(lib => {
  const buf = fs.readFileSync('C:/Users/Addison Barreras/Downloads/architectural_-_annotation_scaling_and_multileaders.dwg');
  const dwgData = lib.dwg_read_data(new Uint8Array(buf), 1);
  const db = lib.convert(dwgData);

  console.log('--- DIMENSIONS (first 3) ---');
  db.entities.filter(e => e.type === 'DIMENSION').slice(0, 3).forEach((e, i) => {
    console.log(`DIM[${i}]:`, JSON.stringify(e, null, 2));
  });

  console.log('\n--- INSERTS (first 3) ---');
  db.entities.filter(e => e.type === 'INSERT').slice(0, 3).forEach((e, i) => {
    console.log(`INSERT[${i}]:`, JSON.stringify(e, null, 2));
  });

  console.log('\n--- ATTRIBS (first 3) ---');
  db.entities.filter(e => e.type === 'ATTRIB').slice(0, 3).forEach((e, i) => {
    console.log(`ATTRIB[${i}]:`, JSON.stringify(e, null, 2));
  });

  console.log('\n--- LWPOLYLINES (first 2) ---');
  db.entities.filter(e => e.type === 'LWPOLYLINE').slice(0, 2).forEach((e, i) => {
    console.log(`LWPOLY[${i}]:`, JSON.stringify(e, null, 2));
  });

  // Print bounding box of all LINE entities to see coordinate range
  const lines = db.entities.filter(e => e.type === 'LINE');
  let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
  for (const l of lines) {
    const pts = [l.startPoint, l.endPoint].filter(Boolean);
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  console.log('\n--- LINE coordinate bounds ---');
  console.log(`X: ${minX.toFixed(2)} .. ${maxX.toFixed(2)}`);
  console.log(`Y: ${minY.toFixed(2)} .. ${maxY.toFixed(2)}`);

  // ATTRIB coordinate range
  const attribs = db.entities.filter(e => e.type === 'ATTRIB');
  let aMinX=Infinity, aMaxX=-Infinity, aMinY=Infinity, aMaxY=-Infinity;
  for (const a of attribs) {
    const p = a.startPoint || a.position || a.insert;
    if (p) {
      if (p.x < aMinX) aMinX = p.x;
      if (p.x > aMaxX) aMaxX = p.x;
      if (p.y < aMinY) aMinY = p.y;
      if (p.y > aMaxY) aMaxY = p.y;
    }
  }
  console.log('\n--- ATTRIB coordinate bounds ---');
  console.log(`X: ${aMinX.toFixed(2)} .. ${aMaxX.toFixed(2)}`);
  console.log(`Y: ${aMinY.toFixed(2)} .. ${aMaxY.toFixed(2)}`);

}).catch(console.error);
