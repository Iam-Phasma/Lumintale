#!/usr/bin/env python3
"""
bake_land.py — Pre-rasterize the Lumintale world land mask.

Downloads world-atlas@2 TopoJSON (the same source the site already uses),
decodes the arc-based topology, rasterizes all land polygons to a 720×360
reference bitmap, and writes land-data.json next to this script.

The frontend loads that file once and uses a single bitwise lookup for every
isOnLand() call, replacing the canvas-based pixel sampling that happens at
runtime today.  The CDN TopoJSON fetch and the topojson-client script tag are
no longer needed for land testing (the outline-canvas cosmetic path is handled
separately in the updated JS).

Requirements:
    pip install Pillow

Usage:
    python bake_land.py

Output:
    land-data.json   ~45 KB  (base64-packed bitfield, 720×360 cells)
"""

import base64
import json
import sys
import urllib.request
from pathlib import Path

# ── Configuration ─────────────────────────────────────────────────────────────

TOPO_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json"

# Reference grid resolution.
# 720×360 → 0.5° per cell.  At the typical LED spacing of 10 px and a 1920-wide
# viewport we only get 192 LED columns, so 720 columns is already 3.75× finer
# than the actual grid — more than enough accuracy.
REF_W = 720
REF_H = 360

OUT_PATH = Path(__file__).parent / "land-data.json"


# ── TopoJSON arc decoder ───────────────────────────────────────────────────────

def _decode_arcs(topo: dict) -> list[list[tuple[float, float]]]:
    """
    Dequantize TopoJSON arcs and return them as lists of (lon, lat) tuples.

    TopoJSON stores arc points as delta-encoded integers.  Each arc[i] = [dx, dy]
    where the true position is the running sum, then scaled + translated:
        lon = accumulated_x * scale[0] + translate[0]
        lat = accumulated_y * scale[1] + translate[1]
    """
    tf        = topo.get("transform", {})
    sx, sy    = tf.get("scale",     [1.0, 1.0])
    tx, ty    = tf.get("translate", [0.0, 0.0])

    decoded = []
    for raw_arc in topo["arcs"]:
        ax = ay = 0
        ring: list[tuple[float, float]] = []
        for dx, dy in raw_arc:
            ax += dx
            ay += dy
            ring.append((ax * sx + tx, ay * sy + ty))
        decoded.append(ring)
    return decoded


def _arc_coords(arcs: list, idx: int) -> list[tuple[float, float]]:
    """Return the coordinate list for an arc index (negative → reversed)."""
    return list(reversed(arcs[~idx])) if idx < 0 else arcs[idx]


def _ring_from_arc_seq(arcs: list, arc_seq: list[int]) -> list[tuple[float, float]]:
    """
    Join a sequence of arc indices into a single coordinate ring.

    Adjacent arcs share an endpoint; we skip the duplicate first point of each
    continuation arc (same rule as topojson-client).
    """
    pts: list[tuple[float, float]] = []
    for idx in arc_seq:
        seg = _arc_coords(arcs, idx)
        pts.extend(seg[1:] if pts else seg)
    return pts


def _iter_polygons(geom: dict, arcs: list):
    """
    Recursively yield (exterior_ring, [hole_ring, ...]) for every polygon
    in a TopoJSON geometry (Polygon / MultiPolygon / GeometryCollection).
    """
    t = geom["type"]
    if t == "Polygon":
        rings = [_ring_from_arc_seq(arcs, r) for r in geom["arcs"]]
        yield rings[0], rings[1:]
    elif t == "MultiPolygon":
        for poly_arcs in geom["arcs"]:
            rings = [_ring_from_arc_seq(arcs, r) for r in poly_arcs]
            yield rings[0], rings[1:]
    elif t == "GeometryCollection":
        for child in geom.get("geometries", []):
            yield from _iter_polygons(child, arcs)


# ── Rasterizer ────────────────────────────────────────────────────────────────

def _project(lon: float, lat: float) -> tuple[float, float]:
    """Map (lon, lat) → floating pixel coords in the REF_W × REF_H grid."""
    x = (lon + 180.0) / 360.0 * REF_W
    y = (90.0 - lat)  / 180.0 * REF_H
    return x, y


def rasterize(polygons) -> bytes:
    """
    Draw land polygons into a REF_W × REF_H bitmap using Pillow.

    Each polygon is drawn exterior-fill then holes-erase, so enclosed water
    bodies (e.g. Caspian Sea) are correctly excluded.

    Returns the bitmap as a packed-bit bytes object (MSB first, row-major).
    """
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        sys.exit(
            "\nPillow is required.  Install it with:\n"
            "    pip install Pillow\n"
        )

    img  = Image.new("1", (REF_W, REF_H), 0)   # black (ocean) background
    draw = ImageDraw.Draw(img)

    for exterior, holes in polygons:
        px_ext = [_project(lon, lat) for lon, lat in exterior]
        if len(px_ext) >= 3:
            draw.polygon(px_ext, fill=1)          # paint land white
        for hole in holes:
            px_hole = [_project(lon, lat) for lon, lat in hole]
            if len(px_hole) >= 3:
                draw.polygon(px_hole, fill=0)     # erase interior water

    # PIL mode "1" packs 8 pixels per byte (MSB first) — exactly what we want.
    return img.tobytes()


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    # 1 · Fetch ---------------------------------------------------------------
    print(f"Fetching  {TOPO_URL} …")
    try:
        with urllib.request.urlopen(TOPO_URL, timeout=30) as resp:
            topo: dict = json.loads(resp.read())
    except Exception as exc:
        sys.exit(f"Download failed: {exc}")
    print("  OK")

    # 2 · Decode topology -----------------------------------------------------
    print("Decoding topology …")
    arcs     = _decode_arcs(topo)
    land_obj = topo["objects"]["land"]
    polygons = list(_iter_polygons(land_obj, arcs))
    print(f"  {len(polygons)} land polygon(s)")

    # 3 · Rasterize -----------------------------------------------------------
    print(f"Rasterizing {REF_W}×{REF_H} grid …")
    raw_bits = rasterize(polygons)

    land_cell_count = sum(bin(b).count("1") for b in raw_bits)
    total_cells     = REF_W * REF_H
    print(f"  {land_cell_count:,} land cells  "
          f"({land_cell_count / total_cells * 100:.1f}% of grid)")

    # 4 · Encode & write ------------------------------------------------------
    encoded = base64.b64encode(raw_bits).decode("ascii")
    out = {
        "w":    REF_W,
        "h":    REF_H,
        "fmt":  "bits-base64-msb",   # MSB-first packed bits, base64-encoded
        "data": encoded,
    }

    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))

    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"\nWritten → {OUT_PATH}  ({size_kb:.1f} KB)")
    print(
        "\nNext step: update submenus/world.js to call loadLandData() instead\n"
        "of loadWorldMap() for land testing.  See the comment block at the top\n"
        "of this script for details."
    )


if __name__ == "__main__":
    main()
