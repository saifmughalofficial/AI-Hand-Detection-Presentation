"""Behaviour tests for the gesture engine.  Run:  python -m unittest discover tests"""
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hand_presenter.gestures import GestureController, analyze_hand  # noqa: E402
from tests.synthetic import hand  # noqa: E402

FRAME_MS = 110   # the browser sends about 9 hand updates per second


class Session:
    def __init__(self, **options):
        self.g = GestureController()
        self.g.smoothing = 0.0
        for key, value in options.items():
            setattr(self.g, key, value)
        self.t = 0.0
        self.log = []

    def feed(self, cx, cy, frames=1, kind="open", jitter=0.0):
        for _ in range(frames):
            self.t += FRAME_MS
            x = cx + random.uniform(-jitter, jitter)
            y = cy + random.uniform(-jitter, jitter)
            palm, size, pose = analyze_hand(hand(x, y, kind))
            self._record(self.g.update(palm, size, pose, self.t))

    def gone(self, ms):
        for _ in range(max(1, round(ms / FRAME_MS))):
            self.t += FRAME_MS
            self._record(self.g.lost(self.t))

    def _record(self, event):
        if event["action"]:
            self.log.append(event["action"])
        if event["zoom"] and event["zoom"]["phase"] != "move":
            self.log.append(f"zoom-{event['zoom']['phase']}")
            if event["zoom"]["phase"] == "end":
                self.factor = event["zoom"]["factor"]
        if event["laser"] and "laser" not in self.log:
            self.log.append("laser")


class PoseTests(unittest.TestCase):
    def test_pose_classification(self):
        g = GestureController()
        for kind, expected in [("open", "open"), ("point-right", "point-right"), ("point-left", "point-left"),
                               ("laser", "laser"), ("pinch", "pinch")]:
            _, _, pose = analyze_hand(hand(0.5, 0.5, kind))
            self.assertEqual(g._classify(pose), expected, kind)


class GestureTests(unittest.TestCase):
    def setUp(self):
        random.seed(7)

    def test_still_hand_with_jitter_does_nothing(self):
        s = Session()
        s.feed(0.5, 0.5, 40, jitter=0.01)
        self.assertEqual(s.log, [])

    def test_entering_hand_does_not_fire(self):
        s = Session()
        for i in range(6):
            s.feed(0.2 + i * 0.08, 0.5)
        s.feed(0.68, 0.5, 10, jitter=0.01)
        self.assertEqual(s.log, [])

    def test_swipe_directions(self):
        for dx, dy, expected in [(0.12, 0, "RIGHT"), (-0.12, 0, "LEFT"), (0, -0.12, "UP"), (0, 0.12, "DOWN")]:
            s = Session()
            s.feed(0.5, 0.5, 5)
            s.feed(0.5 + dx, 0.5 + dy, 2)
            self.assertEqual(s.log, [expected])

    def test_one_action_per_appearance(self):
        s = Session()
        s.feed(0.5, 0.5, 5)
        s.feed(0.62, 0.5, 2)                       # RIGHT
        s.feed(0.5, 0.5, 10)
        s.feed(0.38, 0.5, 2)                       # ignored: hand never left
        s.feed(0.38, 0.5, 10)
        s.gone(500)                                # hand leaves the camera view
        s.feed(0.5, 0.5, 5)
        s.feed(0.62, 0.5, 2)                       # RIGHT again
        self.assertEqual(s.log, ["RIGHT", "RIGHT"])

    def test_brief_dropout_keeps_lock(self):
        s = Session()
        s.feed(0.5, 0.5, 5)
        s.feed(0.62, 0.5, 2)
        s.gone(110)                                # one lost frame is not "hand left"
        s.feed(0.62, 0.5, 5)
        s.feed(0.5, 0.5, 2)
        self.assertEqual(s.log, ["RIGHT"])

    def test_return_stroke_is_ignored_when_lock_is_off(self):
        s = Session(once_per_appearance=False)
        s.feed(0.5, 0.5, 5)
        s.feed(0.62, 0.5, 2)
        s.feed(0.5, 0.5, 3)                        # coming back: no LEFT
        self.assertEqual(s.log, ["RIGHT"])

    def test_pointing(self):
        s = Session()
        s.feed(0.5, 0.5, 5)
        s.feed(0.5, 0.5, 6, kind="point-right")
        s.gone(500)
        s.feed(0.5, 0.5, 5)
        s.feed(0.5, 0.5, 6, kind="point-left")
        self.assertEqual(s.log, ["POINT_RIGHT", "POINT_LEFT"])

    def test_pinch_zoom_in_and_out(self):
        s = Session()
        s.feed(0.5, 0.5, 5)
        s.feed(0.5, 0.5, 4, kind="pinch")
        for i in range(1, 11):
            s.feed(0.5, 0.5 - i * 0.015, kind="pinch")
        s.feed(0.5, 0.35, 3)                       # open the fingers: zoom ends
        self.assertEqual(s.log, ["zoom-start", "zoom-end"])
        self.assertAlmostEqual(s.factor, 2.0, places=2)

        s = Session()
        s.feed(0.5, 0.5, 5)
        s.feed(0.5, 0.5, 4, kind="pinch")
        for i in range(1, 11):
            s.feed(0.5, 0.5 + i * 0.015, kind="pinch")
        s.gone(200)                                # hand lost mid-pinch: zoom is kept
        self.assertEqual(s.log, ["zoom-start", "zoom-end"])
        self.assertAlmostEqual(s.factor, 0.5, places=2)

    def test_laser(self):
        s = Session()
        s.feed(0.5, 0.5, 5)
        s.feed(0.5, 0.5, 4, kind="laser")
        self.assertEqual(s.log, ["laser"])

    def test_options_can_be_switched_off(self):
        s = Session(pointing=False, laser=False, zoom_mode="off")
        s.feed(0.5, 0.5, 5)
        s.feed(0.5, 0.5, 6, kind="point-right")
        s.feed(0.5, 0.5, 6, kind="laser")
        s.feed(0.5, 0.5, 6, kind="pinch")
        self.assertEqual(s.log, [])


if __name__ == "__main__":
    unittest.main()
