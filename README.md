# Lumintale

Lumintale is a browser-based ambient LED grid visualizer. It renders a full-screen LED matrix and can drive the pattern from animated effects, world data feeds, and live device input.

Open: https://iam-phasma.github.io/Lumintale/

## Highlights

- Full-screen LED matrix canvas with configurable:
  - LED density
  - active light coverage
  - flicker speed
  - brightness
  - color
- Matrix effects:
  - Classic
  - Pulse
  - Wave
  - Rainbow
  - Twinkle
  - Ripple
- World modes:
  - Seismic (USGS 24h earthquakes)
  - Solar day/night map
  - ISS live position + projected path
- Other modes:
  - Microphone-reactive visualization
  - Flip-style digital clock
  - Webcam brightness mapping
- Optional map outline overlay for world modes
- Light and dark visual modes (auto-locked for some world modes)
- Wake Lock support to keep the screen on while active

## Tech Stack

- Plain HTML, CSS, and JavaScript
- Canvas 2D rendering
- No build step required
- Static hosting friendly (for example GitHub Pages)

## Getting Started

### 1. Clone

```bash
git clone https://github.com/Iam-Phasma/Lumintale.git
cd Lumintale
```

### 2. Run locally

Use a local web server (recommended instead of opening the file directly):

```bash
python -m http.server 8000
```

Then open:

- http://localhost:8000

## Why a local server?

- `fetch()` for local JSON and remote APIs behaves more reliably from `http://localhost` than `file://`.
- Browser permissions for microphone/webcam work better on secure contexts (`https`) or localhost.

## Usage

- Open the Settings panel to change LED and source settings.
- Pick a source category:
  - Matrix
  - World
  - Others
- Use Reset to return all settings to defaults.

## Data Sources

- USGS Earthquake feed: https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson
- World map TopoJSON: https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json
- ISS API: https://api.wheretheiss.at/v1/satellites/25544

## Project Structure

```text
.
|- index.html              # App shell and settings UI
|- style.css               # Visual styling and panel components
|- script.js               # Core grid renderer, controls, and source orchestration
|- land-data.json          # Pre-baked land mask bitmap used for O(1) land lookup
|- bake_land.py            # Utility script to regenerate land-data.json
|- robots.txt
|- sitemap.xml
|- google6819f8bbedb401e6.html
`- submenus/
   |- matrix.js            # Matrix sub-effects
   |- world.js             # Seismic, Solar, ISS logic and map helpers
   |- others.js            # Microphone, Clock, Webcam modes
   `- submenus.js          # Category/submenu interaction logic
```

## Regenerating the Land Mask (optional)

`land-data.json` is already included. Regenerate it only if you want to refresh or modify the pre-baked world land raster.

### Requirements

- Python 3.9+
- Pillow

Install dependency:

```bash
pip install Pillow
```

Run generator:

```bash
python bake_land.py
```

This downloads world topology data, rasterizes land to a 720x360 bitfield, and writes `land-data.json`.

## Notes

- Some features require internet access (seismic, world map outline, ISS).
- Microphone and webcam modes require permission prompts from the browser.
- If browser APIs are blocked, the app falls back to safer defaults where possible.

## License

No license file is currently included in this repository.
