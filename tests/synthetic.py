"""Synthetic MediaPipe-style hand landmarks for tests (21 points, camera-image coordinates)."""
from __future__ import annotations

# Hand shapes in the presenter's (selfie) view, as offsets from the palm centre in palm units.
_OPEN = [
    (0.0, 1.0),                                              # 0 wrist
    (-0.4, 0.7), (-0.7, 0.4), (-0.9, 0.15), (-1.1, -0.05),   # 1-4 thumb
    (-0.35, -0.1), (-0.4, -0.55), (-0.42, -0.85), (-0.44, -1.1),   # 5-8 index
    (0.0, -0.15), (0.0, -0.65), (0.0, -0.95), (0.0, -1.2),         # 9-12 middle
    (0.3, -0.1), (0.32, -0.55), (0.34, -0.85), (0.35, -1.05),      # 13-16 ring
    (0.55, 0.0), (0.6, -0.35), (0.62, -0.55), (0.64, -0.75),       # 17-20 little
]


def _curl(pts, mcp: int) -> None:
    """Fold one finger: its tip comes back towards the palm."""
    x, y = pts[mcp]
    pts[mcp + 1] = (x, y - 0.45)
    pts[mcp + 2] = (x, y - 0.25)
    pts[mcp + 3] = (x, y + 0.05)


def shape(kind: str):
    pts = list(_OPEN)
    if kind in ("point-right", "point-left", "laser"):
        for mcp in (9, 13, 17):
            _curl(pts, mcp)
        pts[4] = (-0.3, 0.2)                                   # thumb tucked
        if kind == "point-right":
            pts[6], pts[7], pts[8] = (0.15, -0.15), (0.45, -0.17), (0.75, -0.18)
        elif kind == "point-left":
            pts[5] = (0.35, -0.1)
            pts[6], pts[7], pts[8] = (-0.15, -0.15), (-0.45, -0.17), (-0.75, -0.18)
        else:
            pts[6], pts[7], pts[8] = (-0.35, -0.6), (-0.35, -0.95), (-0.35, -1.25)
    elif kind == "pinch":
        pts[6], pts[7], pts[8] = (-0.4, -0.55), (-0.5, -0.75), (-0.6, -0.8)
        pts[3], pts[4] = (-0.8, -0.3), (-0.65, -0.75)
    elif kind != "open":
        raise ValueError(kind)
    return pts


def hand(cx: float, cy: float, kind: str = "open", scale: float = 0.1):
    """Landmarks as MediaPipe reports them: x is NOT mirrored (camera image), y grows downwards."""
    return [(1.0 - (cx + dx * scale), cy + dy * scale) for dx, dy in shape(kind)]
