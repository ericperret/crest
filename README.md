# CREST
### Copernicus Raster Elevation Simulation Toolkit

> Browser-based DSM viewer and hydrological flow simulator.  
> No server. No build step. No framework. Two HTML files.

![CREST map view](screenshots/map.png)
![CREST DSM view](screenshots/dsm.png)

---

## What it does

**`map.html`** — worldwide satellite map cataloguing your local Copernicus DSM tiles.  
Click a green square to open it in the viewer.

**`dsm.html`** — full DSM viewer with hydrological flow simulation.  
Right-click anywhere on terrain to pour water. Watch it find its own path.

---

## Features

| Feature | Detail |
|---|---|
| DSM rendering | GeoTIFF COG Float32, native DEFLATE decompression |
| Colour palette | Hypsometric LUT, histogram equalisation (10 000 bins) |
| Contour lines | 4-neighbour detection, auto interval, major/minor |
| Flow simulation | Local flood-fill, downhill priority, canyon infiltration |
| Water overlay | Right-click = source, Space = reset, level rises +1m when blocked |
| Mouse overlay | Lon/lat DMS WGS84 + elevation or water depth |
| Altitude legend | Live colour bar, water level indicator |
| Road overlay | Leaflet + Carto labels (optional, on/off) |
| Recording | WebM 5 fps via MediaRecorder, auto-download |
| Tile catalogue | Scans `~/Downloads/copernicus/` — zero upload, filenames only |
| Communication | BroadcastChannel between tabs, works on `file://` |

---

## Dependencies

| Library | Used in | Why |
|---|---|---|
| [Leaflet 1.9.4](https://leafletjs.com) | both files | Satellite basemap + optional road overlay |

Everything else is **vanilla JavaScript** — TIFF parsing, DEFLATE decompression (`DecompressionStream`), Float32 decoding, histogram equalisation, contour detection, flood simulation, WebM recording — all native browser APIs.

---

## Data source

Tiles come from the **Copernicus DEM GLO-30** (30 m resolution), freely available from AWS:

```
https://copernicus-dem-30m.s3.amazonaws.com/
Copernicus_DSM_COG_10_{NS}{LAT}_00_{EW}{LON}_00_DEM/
Copernicus_DSM_COG_10_{NS}{LAT}_00_{EW}{LON}_00_DEM.tif
```

Expected local structure:
```
~/Downloads/copernicus/
  Copernicus_DSM_COG_10_N04_00_W053_00_DEM/
    Copernicus_DSM_COG_10_N04_00_W053_00_DEM.tif
  Copernicus_DSM_COG_10_S20_00_E169_00_DEM/
    Copernicus_DSM_COG_10_S20_00_E169_00_DEM.tif
  ...
```

---

## Usage

```bash
# 1. Clone
git clone https://github.com/yourname/crest.git
cd crest

# 2. Open map.html in Chrome or Firefox — no server needed
# 3. Click "Ouvrir copernicus/" and point to ~/Downloads/copernicus/
# 4. Green squares appear for every tile found locally
# 5. Click a green square — dsm.html opens and loads the tile
```

> **Popup note** — Chrome may block the dsm.html popup on first use.  
> Allow popups for `file://` and click again.

---

## Controls

### map.html
| Action | Result |
|---|---|
| Click green square | Open tile in dsm.html |

### dsm.html
| Action | Result |
|---|---|
| Scroll wheel | Zoom (cursor-centred) |
| Drag | Pan |
| Right-click | Place water source |
| Space | Reset simulation |
| ⇄ button | Toggle hypsometry / contour lines |
| 🗺 button | Toggle road & label overlay |
| ⏺ REC button | Start/stop WebM recording |

---

## Flow simulation

Water follows local terrain at each step:

1. **Downhill flow** — spreads to the lowest accessible border pixel each tick
2. **Flat terrain** — spreads to all pixels at equal minimum elevation
3. **Basin filling** — when blocked, water level rises +1 m per tick
4. **Canyon infiltration** — beyond 10 m of accumulated rise, penetration increases by +2 m/tick to overcome averaging artefacts in 30 m pixels
5. **Ocean stop** — simulation halts when water reaches sea level

Status bar shows: surface elevation · accumulated rise · pixel count · active front size.

---

## Architecture

```
crest/
├── map.html          # Tile catalogue — Leaflet satellite + grid layer
├── dsm.html          # DSM viewer + flow simulator
└── README.md
```

**Inter-tab communication**: `BroadcastChannel('crest_dsm')`  
`map.html` passes the `File` object directly — no re-upload, no copy.

**Decompression pipeline**:
```
.tif → ArrayBuffer → TIFF tags → tile offsets
     → Uint8Array(compressed) → DecompressionStream('deflate-raw')
     → Float32 predictor decode → elevGrid + OffscreenCanvas
```

---

## Browser compatibility

| Browser | Minimum version |
|---|---|
| Chrome / Edge | 80+ |
| Firefox | 113+ |
| Safari | 16.4+ |

Required APIs: `DecompressionStream`, `OffscreenCanvas`, `BroadcastChannel`, `MediaRecorder`.

---

## Changelog

| Version | Change |
|---|---|
| 2.0 | Replaced pako with native `DecompressionStream` — sharper output, zero dependency |
| 1.9 | Reverted to local flood-fill (Manning removed), RAF full speed |
| 1.8 | Altitude legend panel, RAF loop |
| 1.7 | WebM 5 fps recording (MediaRecorder) |
| 1.6 | Canyon infiltration (+2 m/tick beyond 10 m rise) |
| 1.5 | Local flood-fill — water flows from adjacent wet pixel, not global level |
| 1.4 | Water level rises +1 m when blocked, mouse shows water depth |
| 1.3 | Flow simulation — right-click source, Space reset |
| 1.2 | Carto overlay on/off (light_only_labels, transparent container) |
| 1.1 | BroadcastChannel replacing postMessage (file:// compatibility) |
| 1.0 | map.html + dsm.html, tile catalogue, hypsometry, contour lines |

---

## Licence

MIT — see `LICENSE`.

---

*Built with Claude Sonnet 4.6 / Anthropic — May 2026*
