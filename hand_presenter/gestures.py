"""Natural hand-movement gestures for presentation control (pure Python, no dependencies).

Input: the 21 MediaPipe hand landmarks of one hand, as (x, y) in camera-image coordinates
(0..1, not mirrored), plus a timestamp in milliseconds.

Gestures:
  * Swipes: LEFT / RIGHT / UP / DOWN palm movement past a dead zone around a calibrated neutral
    point. The return stroke never fires the opposite command.
  * Finger poses: index pointing left/right (POINT_LEFT / POINT_RIGHT), index pointing up (laser
    pointer), and thumb + index pinch moved up/down (continuous zoom).
  * "One action per appearance": after a page action nothing fires until the hand leaves the
    camera view and comes back.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

PALM = (0, 5, 9, 13, 17)


@dataclass(frozen=True)
class Pose:
    pinch: float            # thumb-tip to index-tip distance / palm size
    index_ext: bool         # index finger stretched out
    index_curled: bool
    others_curled: bool     # middle, ring and little finger folded
    vx: float               # index direction (knuckle -> tip), presenter's point of view
    vy: float
    tip: tuple[float, float]


def analyze_hand(landmarks, aspect: float = 4 / 3):
    """Return (palm_center, palm_size, Pose) in the presenter's (mirrored, "selfie") view."""
    sel = [((1.0 - x) * aspect, y) for x, y in landmarks]   # isotropic selfie space

    def span(i: int, j: int) -> float:
        return math.dist(sel[i], sel[j])

    def curled(tip: int, pip: int) -> bool:
        # A finger is curled when its tip is nearer the wrist than its middle (PIP) joint.
        return span(0, tip) < span(0, pip)

    palm = (
        sum(1.0 - landmarks[i][0] for i in PALM) / len(PALM),
        sum(landmarks[i][1] for i in PALM) / len(PALM),
    )
    size = (span(0, 9) + span(5, 17)) / 2
    pose = Pose(
        pinch=span(4, 8) / max(size, 1e-3),
        index_ext=span(0, 8) > span(0, 6) * 1.08 and span(5, 8) > size * 0.55,
        index_curled=curled(8, 6),
        others_curled=curled(12, 10) and curled(16, 14) and curled(20, 18),
        vx=sel[8][0] - sel[5][0],
        vy=sel[8][1] - sel[5][1],
        tip=(1.0 - landmarks[8][0], landmarks[8][1]),
    )
    return palm, size, pose


def _dist(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


class GestureController:
    """Turns a stream of hand observations into presentation actions.

    ``update`` and ``lost`` return an event dict:
      state  - short status text (READY, STILL, LOCKED, POINT, ZOOM, ...)
      action - LEFT/RIGHT/UP/DOWN/POINT_LEFT/POINT_RIGHT/ZOOM_IN/ZOOM_OUT, or None
      zoom   - {"phase": "start"|"move"|"end", "factor": float} during a pinch zoom, or None
      laser  - True while the index finger points up
    """

    def __init__(self) -> None:
        self.threshold = 0.07       # palm travel (fraction of the frame) that counts as a move
        self.smoothing = 0.25
        self.cooldown_ms = 450
        self.stable_frames = 3
        self.settle_ms = 700
        self.zoom_mode = "pinch"    # "pinch" | "depth" | "off"
        self.pointing = True
        self.laser = True
        self.once_per_appearance = True
        self.unlock_ms = 350        # the hand must be away this long to unlock the next action
        self.point_hold_ms = 160
        self.pinch_hold_ms = 120
        self.reset()

    # ------------------------------------------------------------------ state

    def reset(self) -> None:
        """Full reset: recalibrate, pause/resume, camera start."""
        self.locked = False
        self.gone_at = None
        self.last_trigger = -math.inf
        self._reset_tracking()

    def _reset_tracking(self) -> None:
        self.origin = None
        self.point = None
        self.size = None
        self.prev_raw = None
        self.seen = 0
        self.armed = True
        self.zoom_base = None
        self.zoom_armed = True
        self.anchor = None
        self.anchor_time = 0.0
        self.pose = "open"
        self.pose_since = 0.0
        self.pose_fired = False
        self.candidate = None
        self.candidate_count = 0
        self.pinch_zoom = None

    def hud(self) -> dict:
        return {
            "origin": self.origin, "point": self.point, "threshold": self.threshold,
            "armed": self.armed and not self.locked, "pose": self.pose, "locked": self.locked,
        }

    @staticmethod
    def _event(state: str, action: str | None = None, zoom: dict | None = None, laser: bool = False) -> dict:
        return {"state": state, "action": action, "zoom": zoom, "laser": laser}

    def _mark_anchor(self, now: float) -> None:
        self.anchor = self.point
        self.anchor_time = now

    # ------------------------------------------------------------------ input

    def lost(self, now: float) -> dict:
        """The hand left the camera view. The lock is released once it stays away long enough."""
        if self.gone_at is None:
            self.gone_at = now
        zoom = {"phase": "end", "factor": self.pinch_zoom["factor"]} if self.pinch_zoom else None
        self._reset_tracking()
        return self._event("NO HAND", zoom=zoom)

    def update(self, palm, size: float, pose: Pose | None, now: float) -> dict:
        if self.gone_at is not None:
            if now - self.gone_at >= self.unlock_ms:
                self.locked = False
            self.gone_at = None

        jump = _dist(palm, self.prev_raw) if self.prev_raw else 0.0
        self.prev_raw = palm
        a = 1.0 - self.smoothing
        if self.point:
            self.point = (self.point[0] + (palm[0] - self.point[0]) * a, self.point[1] + (palm[1] - self.point[1]) * a)
            self.size += (size - self.size) * a
        else:
            self.point = palm
            self.size = size

        if self.origin is None:
            # Calibrate only once the hand is calm, so a hand entering the frame never fires a swipe.
            self.seen = 0 if jump > self.threshold * 0.35 else self.seen + 1
            if self.seen < self.stable_frames:
                return self._event("LOCKING")
            self.origin = self.point
            self.zoom_base = self.size
            self._mark_anchor(now)
            return self._event("LOCKED" if self.locked else "READY")

        posed = self._poses(pose, now)
        if posed:
            return posed

        if _dist(self.point, self.anchor) > self.threshold * 0.35:
            self._mark_anchor(now)
        settled = now - self.anchor_time > self.settle_ms
        dx = self.point[0] - self.origin[0]
        dy = self.point[1] - self.origin[1]
        offset = max(abs(dx), abs(dy))

        if not self.armed:
            if settled:
                self.origin = self.point
                self.zoom_base = self.size
            if settled or offset < self.threshold * 0.6:
                self.armed = True
                return self._event("LOCKED" if self.locked else "READY")
            return self._event("RE-ARM")

        if self.zoom_mode == "depth" and offset < self.threshold * 0.5:
            zoom = self._depth_zoom(now, settled)
            if zoom:
                return zoom

        if offset < self.threshold:
            if settled:
                self.origin = self.point
            return self._event("LOCKED" if self.locked else "STILL")
        if self.once_per_appearance and self.locked:
            self.origin = self.point   # nothing accumulates while waiting for the hand to leave
            return self._event("LOCKED")
        if now - self.last_trigger < self.cooldown_ms:
            return self._event("COOLDOWN")

        if abs(dx) >= abs(dy):
            action = "RIGHT" if dx > 0 else "LEFT"
        else:
            action = "DOWN" if dy > 0 else "UP"
        self.last_trigger = now
        self.armed = False
        if self.once_per_appearance:
            self.locked = True
        self._mark_anchor(now)
        return self._event(action, action)

    # ------------------------------------------------------------------ finger poses

    def _classify(self, f: Pose | None) -> str:
        if f is None:
            return "open"
        if not f.index_curled and f.pinch < (0.45 if self.pose == "pinch" else 0.3):
            return "pinch"
        if f.index_ext and f.others_curled and f.pinch > 0.4:
            ax, ay = abs(f.vx), abs(f.vy)
            if ax > ay * 1.3:
                return "point-right" if f.vx > 0 else "point-left"
            if -f.vy > ax * 1.3:
                return "laser"
        return "open"

    def _poses(self, f: Pose | None, now: float) -> dict | None:
        name = self._classify(f)
        if name != self.pose:
            # A pose must be seen on two consecutive frames before it counts (filters flicker).
            if name == self.candidate:
                self.candidate_count += 1
            else:
                self.candidate = name
                self.candidate_count = 1
            if self.candidate_count >= 2:
                ended = self._end_pose(now)
                self.pose = name
                self.pose_since = now
                self.pose_fired = False
                self.candidate = None
                if ended:
                    return ended
        else:
            self.candidate = None

        held = now - self.pose_since
        if self.pose == "pinch":
            if self.zoom_mode != "pinch":
                return None
            if not self.pinch_zoom:
                if held < self.pinch_hold_ms:
                    return self._event("PINCH")
                self.pinch_zoom = {"y0": self.point[1], "factor": 1.0}
                return self._event("ZOOM", zoom={"phase": "start", "factor": 1.0})
            # Moving the pinched hand up 15% of the frame height doubles the zoom; down halves it.
            self.pinch_zoom["factor"] = 2 ** ((self.pinch_zoom["y0"] - self.point[1]) / 0.15)
            return self._event("ZOOM", zoom={"phase": "move", "factor": self.pinch_zoom["factor"]})
        if self.pose in ("point-left", "point-right"):
            if not self.pointing:
                return None
            if self.pose_fired:
                return self._event("LOCKED" if self.locked else "POINT")
            if held < self.point_hold_ms:
                return self._event("POINT")
            if self.once_per_appearance and self.locked:
                return self._event("LOCKED")
            if now - self.last_trigger < self.cooldown_ms:
                return self._event("COOLDOWN")
            self.pose_fired = True
            self.last_trigger = now
            if self.once_per_appearance:
                self.locked = True
            action = "POINT_RIGHT" if self.pose == "point-right" else "POINT_LEFT"
            return self._event(action, action)
        if self.pose == "laser":
            return self._event("LASER", laser=True) if self.laser else None
        return None

    def _end_pose(self, now: float) -> dict | None:
        if self.pose == "open":
            return None
        # Re-centre the swipe origin so releasing a pose never counts as a swipe.
        self.origin = self.point
        self.armed = True
        self.zoom_base = self.size
        self._mark_anchor(now)
        if self.pinch_zoom:
            factor = self.pinch_zoom["factor"]
            self.pinch_zoom = None
            return self._event("ZOOM", zoom={"phase": "end", "factor": factor})
        return None

    def _depth_zoom(self, now: float, settled: bool) -> dict | None:
        if not self.zoom_base:
            return None
        delta = math.log(self.size / self.zoom_base)   # > 0 when the hand comes closer
        limit = 0.2
        if not self.zoom_armed:
            if abs(delta) < limit * 0.4 or settled:
                if settled:
                    self.zoom_base = self.size
                self.zoom_armed = True
            return None
        if abs(delta) < limit or now - self.last_trigger < self.cooldown_ms:
            return None
        self.last_trigger = now
        self.zoom_armed = False
        self._mark_anchor(now)
        action = "ZOOM_IN" if delta > 0 else "ZOOM_OUT"
        return self._event(action, action)
