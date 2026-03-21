# DWG/DXF Viewer

A portable Windows application for viewing DWG/DXF files using Electron, `@mlightcad/libredwg-web`, `@mlightcad/libdxfrw-web`, and `dxf-parser`.

## Features

- **File Support**: Open and view **DWG** and **DXF** files. The parser path is profile-driven (`fidelity` / `performance`) and uses libredwg first with libdxfrw+DXF fallback.

- **Zoom & Pan**: Zoom in/out and pan across drawings
- **Measurement Tools**: Measure distances and angles
- **No Admin Required**: Single portable .exe - no installation needed
- **Lightweight**: Minimal dependencies, fast startup
- **Open Source**: Uses LibreDWG (GNU open-source library)

## Requirements

- Windows 7 or later
- No installation required
- No administrative privileges needed

## Usage

1. Download the portable .exe file
2. Run it directly - no installation needed
3. Use File → Open or drag-and-drop to load DWG or DXF files. DWG parsing uses libredwg as primary and libdxfrw+DXF parser fallback.
4. Use the toolbar for zoom, pan, and measurement tools

## Entity Support Matrix

### Core geometric entities

- `LINE`, `CIRCLE`, `ARC`, `LWPOLYLINE`, `POLYLINE`, `ELLIPSE`
- `SPLINE`
- `RAY`, `XLINE`
- `TEXT`, `MTEXT`, `ATTDEF`, `ATTRIB`
- `DIMENSION`, `LEADER`, `QLEADER`, `MLEADER`

### Structural/container entities

- `INSERT` (nested blocks, scaling/rotation/arrayed inserts)
- `HATCH` (pattern and concrete-style fallback rendering)
- `VIEWPORT` (viewport frame rendering with model/paper-space policy)
- Layer metadata handling: visibility, color, and linetype; interactive layer overrides in UI

### Advanced/3D and references

- `IMAGE` (bitmap draw with frame fallback)
- `PDFUNDERLAY`, `DGNUNDERLAY`, `DWFUNDERLAY` (frame + label fallback)
- `MESH` (wireframe extraction from faces or grid)
- `SURFACE` family (`SURFACE`, `PLANESURFACE`, `NURBSSURFACE`, `REVOLVEDSURFACE`, `SWEPTSURFACE`, `LOFTEDSURFACE`) as wireframe fallback
- `3DSOLID` / `BODY` / `REGION` placeholder fallback (bounds frame or marker)
- XREF discovery and optional recursive loading when `readExternalReferences` is enabled in the active reader profile

## Reader Profiles

- Default profile: `fidelity`
- Optional profile: `performance`
- CLI: `--reader-profile=fidelity` or `--reader-profile=performance`

## Building from Source

### Prerequisites

- Node.js 16+
- npm
- Python 2.7 or 3.x (for native module compilation)
- Visual Studio Build Tools (for Windows)


### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

### Regression Smoke Test

```bash
npm run test:regression
```

This validates required entity handlers and XREF/profile plumbing checks.

### Build Portable EXE

```bash
npm run dist:win
```

The portable executable will be created in the `dist` folder.

### Build Shareable Portable ZIP

```powershell
.\build-share-zip.ps1
```

This creates a Desktop zip containing the unpacked portable app plus the two reference DWG files used for regression checks.

## Project Structure

```
dwl-viewer/
├── src/
│   └── main.ts           # Electron main process
├── public/
│   ├── index.html        # UI layout
│   └── renderer.js       # Canvas viewer and tools
├── preload.js            # IPC bridge for secure communication
├── package.json          # Dependencies and build config
└── tsconfig.json         # TypeScript configuration
```

## Architecture

### Electron Main Process
- Handles file dialogs and file I/O
- Manages application lifecycle
- Creates native menus

### Renderer Process
- Canvas-based 2D viewer
- Zoom and pan controls
- Measurement tools
- Displays drawing properties

### IPC Communication
- Secure preload bridge
- File reading operations
- Event handling

## Parsing Pipeline

- `DWG` primary: `@mlightcad/libredwg-web`
- `DWG` fallback: `@mlightcad/libdxfrw-web` exported to DXF, then parsed
- `DXF`: `dxf-parser`
- Renderer: Canvas normalization pipeline in `public/renderer.js`

## License

GPL-3.0 (compatible with LibreDWG)

## Future Enhancements

- [ ] Higher-fidelity 3D solid/surface tessellation (beyond wireframe/placeholder fallback)
- [ ] Rich underlay/image clipping support
- [ ] Print and export capabilities
- [ ] Recent files list
