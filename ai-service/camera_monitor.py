"""
ai-service/camera_monitor.py
─────────────────────────────
All-in-one Multimodal Exam Monitor.
Gộp: ExamFaceDetector (MAR + Head Pose) + CheatingAnalyzer + Camera Loop.

Chạy:  python camera_monitor.py [--camera 0] [--gpu]
"""
from __future__ import annotations
import argparse, os, sys, threading, time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional
import cv2, numpy as np
from PIL import Image, ImageDraw, ImageFont

# ══════════════════════════════════════════════════════════════════════════════
# Type aliases
# ══════════════════════════════════════════════════════════════════════════════
BBox = List[int]
OnMultipleFacesCB = Callable[[np.ndarray, int], None]
OnNoFaceCB = Callable[[np.ndarray], None]
OnNormalCB = Callable[[np.ndarray, BBox], None]

# ══════════════════════════════════════════════════════════════════════════════
# DetectionResult
# ══════════════════════════════════════════════════════════════════════════════
@dataclass
class DetectionResult:
    face_count: int = 0
    bboxes: List[BBox] = field(default_factory=list)
    timestamp: float = field(default_factory=time.monotonic)
    landmarks_106: Optional[np.ndarray] = None
    mar_value: float = 0.0
    is_mouth_open: bool = False
    head_pose: Optional[Dict[str, float]] = None
    is_looking_away: bool = False

# ══════════════════════════════════════════════════════════════════════════════
# Cheating Levels
# ══════════════════════════════════════════════════════════════════════════════
LEVEL_NORMAL = 0
LEVEL_READING_ALOUD = 1
LEVEL_TALKING = 2
LEVEL_SOMEONE_PROMPTING = 3

LEVEL_NAMES = {0: "normal", 1: "reading_aloud", 2: "talking_to_someone", 3: "someone_prompting"}
LEVEL_MESSAGES = {
    0: "Bình thường",
    1: "Cảnh báo nhẹ: Thí sinh đang đọc nhẩm",
    2: "Cảnh báo Mức 1: Đang quay sang nói chuyện",
    3: "Cảnh báo Mức 2 Khẩn cấp: Có tiếng người khác nhắc bài",
}
LEVEL_SEVERITIES = {0: "none", 1: "low", 2: "medium", 3: "critical"}

@dataclass
class CheatingAnalysisResult:
    level: int = LEVEL_NORMAL
    level_name: str = "normal"
    message: str = "Bình thường"
    severity: str = "none"
    speech_detected: bool = False
    is_mouth_open: bool = False
    is_looking_away: bool = False
    mar_value: float = 0.0
    head_pose: Optional[Dict[str, float]] = None
    face_count: int = 0
    face_detected: bool = False

# ══════════════════════════════════════════════════════════════════════════════
# ExamFaceDetector (detection + landmark_2d_106 + MAR + Head Pose)
# ══════════════════════════════════════════════════════════════════════════════
class ExamFaceDetector:
    _PREPROCESS_W = 640
    _PREPROCESS_H = 360

    def __init__(
        self,
        model_root: str = "~/.insightface",
        on_multiple_faces: Optional[OnMultipleFacesCB] = None,
        on_no_face: Optional[OnNoFaceCB] = None,
        on_normal: Optional[OnNormalCB] = None,
        det_size: tuple = (640, 640),
        det_thresh: float = 0.5,
        throttle_interval: float = 0.25,
        mar_threshold: float = 0.2,
        yaw_threshold: float = 30.0,
        ctx_id: int = -1,
    ) -> None:
        self._on_multiple_faces = on_multiple_faces
        self._on_no_face = on_no_face
        self._on_normal = on_normal
        self._det_size = det_size
        self._det_thresh = det_thresh
        self._throttle_interval = throttle_interval
        self._mar_threshold = mar_threshold
        self._yaw_threshold = yaw_threshold
        self._ctx_id = ctx_id
        self._model_root = model_root
        self._last_inference_time: float = 0.0
        self._last_result = DetectionResult()
        self._app = None

    def _load_model(self) -> None:
        if self._app is not None:
            return
        from insightface.app import FaceAnalysis
        self._app = FaceAnalysis(
            name="buffalo_l", root=self._model_root,
            allowed_modules=["detection", "landmark_2d_106"],
        )
        self._app.prepare(ctx_id=self._ctx_id, det_thresh=self._det_thresh, det_size=self._det_size)

    @staticmethod
    def _preprocess(frame: np.ndarray) -> np.ndarray:
        h, w = frame.shape[:2]
        tw, th = ExamFaceDetector._PREPROCESS_W, ExamFaceDetector._PREPROCESS_H
        if w == tw and h == th:
            return frame
        return cv2.resize(frame, (tw, th), interpolation=cv2.INTER_AREA)

    @staticmethod
    def calculate_mar(landmarks: np.ndarray, threshold: float = 0.2) -> tuple:
        """
        Tính MAR từ Inner Lips (InsightFace 106-point landmarks).

        Sử dụng 3 cặp dọc Inner Lips thay vì Outer Lips:
          - (97, 103): cặp trái
          - (98, 102): cặp giữa
          - (99, 101): cặp phải
        Horizontal: dist(96, 100) – khóe miệng trong.

        Trung bình 3 cặp dọc giúp giảm sai lệch khi nhếch mép
        và tránh false positive cho người môi dày.
        """
        if landmarks is None or landmarks.shape[0] < 106:
            return 0.0, False

        # Khoảng cách ngang giữa 2 khóe miệng trong
        horiz = float(np.linalg.norm(landmarks[96] - landmarks[100]))
        if horiz < 1e-6:
            return 0.0, False

        # Trung bình 3 khoảng cách dọc Inner Lips
        vert_pairs = [(97, 103), (98, 102), (99, 101)]
        vert_sum = sum(
            float(np.linalg.norm(landmarks[t] - landmarks[b]))
            for t, b in vert_pairs
        )
        vert_avg = vert_sum / len(vert_pairs)

        mar = vert_avg / horiz
        return mar, mar > threshold

    @staticmethod
    def estimate_head_pose(face, yaw_threshold: float = 30.0) -> tuple:
        pose = getattr(face, "pose", None)
        if pose is None or not hasattr(pose, "__len__") or len(pose) < 3:
            return None, False
        pitch, yaw, roll = float(pose[0]), float(pose[1]), float(pose[2])
        d = {"yaw": round(yaw, 2), "pitch": round(pitch, 2), "roll": round(roll, 2)}
        return d, abs(yaw) > yaw_threshold

    def _run_inference(self, small_frame: np.ndarray) -> DetectionResult:
        self._load_model()
        try:
            faces = self._app.get(small_frame)
        except Exception:
            return DetectionResult()
        bboxes = [face.bbox.astype(int).tolist() for face in faces]
        result = DetectionResult(face_count=len(bboxes), bboxes=bboxes, timestamp=time.monotonic())
        if len(faces) >= 1:
            pf = faces[0]
            lmk = getattr(pf, "landmark_2d_106", None)
            if lmk is not None:
                result.landmarks_106 = lmk
                result.mar_value, result.is_mouth_open = self.calculate_mar(lmk, self._mar_threshold)
            result.head_pose, result.is_looking_away = self.estimate_head_pose(pf, self._yaw_threshold)
        return result

    def _dispatch(self, frame: np.ndarray, result: DetectionResult) -> None:
        c = result.face_count
        if c == 0 and self._on_no_face:
            self._on_no_face(frame)
        elif c == 1 and self._on_normal:
            self._on_normal(frame, result.bboxes[0])
        elif c > 1 and self._on_multiple_faces:
            self._on_multiple_faces(frame, c)

    def process_frame(self, frame: np.ndarray) -> DetectionResult:
        now = time.monotonic()
        if now - self._last_inference_time >= self._throttle_interval:
            small = self._preprocess(frame)
            self._last_result = self._run_inference(small)
            self._last_inference_time = now
        self._dispatch(frame, self._last_result)
        return self._last_result

# ══════════════════════════════════════════════════════════════════════════════
# Drawing & GUI Logic
# ══════════════════════════════════════════════════════════════════════════════
_DET_SIZE = (640, 640)
_PREPROCESS_SIZE = (640, 360)
_overlay_lock = threading.Lock()
_overlay_state: dict = {
    "label": "Initializing…", "color": (200, 200, 200),
    "bbox": None, "face_count": 0, "last_update": 0.0,
    "cheating": None,
}

_COLOR_NORMAL = (0, 220, 80)
_COLOR_NO_FACE = (60, 60, 220)
_COLOR_MULTIPLE = (0, 165, 255)

def _on_multiple_faces(frame: np.ndarray, face_count: int) -> None:
    with _overlay_lock:
        _overlay_state.update(label=f"⚠ CẢNH BÁO: {face_count} khuôn mặt!",
                              color=_COLOR_MULTIPLE, face_count=face_count,
                              bbox=None, last_update=time.monotonic())

def _on_no_face(frame: np.ndarray) -> None:
    with _overlay_lock:
        _overlay_state.update(label="⚠ CẢNH BÁO: Không có thí sinh!",
                              color=_COLOR_NO_FACE, face_count=0,
                              bbox=None, last_update=time.monotonic())

def _on_normal(frame: np.ndarray, bbox: BBox) -> None:
    with _overlay_lock:
        _overlay_state.update(label="✓ Bình thường", color=_COLOR_NORMAL,
                              face_count=1, bbox=bbox, last_update=time.monotonic())

def _load_unicode_font(size: int = 22) -> ImageFont.FreeTypeFont:
    for fp in ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf",
               "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        if os.path.isfile(fp):
            try: return ImageFont.truetype(fp, size)
            except: continue
    return ImageFont.load_default()

_FONT_BANNER = _load_unicode_font(24)
_FONT_LABEL = _load_unicode_font(18)
_FONT_SMALL = _load_unicode_font(14)

def _put_text_unicode(img, text, pos, font, color_bgr) -> np.ndarray:
    pil_img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(pil_img)
    draw.text(pos, text, font=font, fill=(color_bgr[2], color_bgr[1], color_bgr[0]))
    res = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    np.copyto(img, res)
    return img

def _normalize_bbox_to_frame(bbox, frame_w, frame_h):
    x1, y1, x2, y2 = map(int, bbox)
    lb_scale = min(_DET_SIZE[0] / 640.0, _DET_SIZE[1] / 360.0)
    pad_x = (_DET_SIZE[0] - 640.0 * lb_scale) / 2.0
    pad_y = (_DET_SIZE[1] - 360.0 * lb_scale) / 2.0
    pp_x1 = (x1 - pad_x) / lb_scale
    pp_y1 = (y1 - pad_y) / lb_scale
    pp_x2 = (x2 - pad_x) / lb_scale
    pp_y2 = (y2 - pad_y) / lb_scale
    sx, sy = frame_w / 640.0, frame_h / 360.0
    return (int(pp_x1*sx), int(pp_y1*sy), int(pp_x2*sx), int(pp_y2*sy))

def _draw_overlay(frame: np.ndarray) -> np.ndarray:
    display = frame.copy()
    h, w = display.shape[:2]
    with _overlay_lock:
        label, color, bbox = _overlay_state["label"], _overlay_state["color"], _overlay_state["bbox"]
        cheating = _overlay_state["cheating"]

    # Top banner
    overlay = display.copy()
    cv2.rectangle(overlay, (0, 0), (w, 50), (20, 20, 20), -1)
    cv2.addWeighted(overlay, 0.6, display, 0.4, 0, display)
    _put_text_unicode(display, label, (16, 12), _FONT_BANNER, color)

    if bbox:
        x1, y1, x2, y2 = _normalize_bbox_to_frame(bbox, w, h)
        cv2.rectangle(display, (x1, y1), (x2, y2), color, 2)
        _put_text_unicode(display, "Thí sinh", (x1, max(y1-24, 2)), _FONT_LABEL, color)

    if cheating and cheating.speech_detected:
        panel_y = h - 100
        cv2.rectangle(display, (0, panel_y), (400, h), (20, 20, 20), -1)
        _put_text_unicode(display, f"🛡 {cheating.message}", (10, panel_y+10), _FONT_LABEL, (0, 255, 255))
        detail = f"MAR: {cheating.mar_value:.2f} | Mouth: {'Open' if cheating.is_mouth_open else 'Closed'}"
        _put_text_unicode(display, detail, (10, panel_y+40), _FONT_SMALL, (200, 200, 200))
    
    return display

def run_monitor(camera_index=0, model_root="~/.insightface", ctx_id=-1, simulate_speech=False):
    detector = ExamFaceDetector(model_root=model_root, ctx_id=ctx_id,
                                on_multiple_faces=_on_multiple_faces, on_no_face=_on_no_face, on_normal=_on_normal)
    cap = cv2.VideoCapture(camera_index)
    speech_on = simulate_speech
    
    while cap.isOpened():
        ret, frame = cap.read()
        if not ret: break
        
        det = detector.process_frame(frame)
        
        # Cross-check logic
        cheating = CheatingAnalysisResult(speech_detected=speech_on, face_count=det.face_count, 
                                          mar_value=det.mar_value, is_mouth_open=det.is_mouth_open, 
                                          is_looking_away=det.is_looking_away)
        if speech_on:
            if not det.face_count: cheating.level, cheating.message = 3, "Có tiếng nhưng không thấy mặt"
            elif det.is_mouth_open:
                if det.is_looking_away: cheating.level, cheating.message = 2, "Đang nói chuyện (quay đi)"
                else: cheating.level, cheating.message = 1, "Đang đọc nhẩm"
            else: cheating.level, cheating.message = 3, "Có người khác nhắc bài"
        
        with _overlay_lock: _overlay_state["cheating"] = cheating
        
        cv2.imshow("SecureExam Monitor", _draw_overlay(frame))
        key = cv2.waitKey(1) & 0xFF
        if key == ord('q'): break
        if key == ord('s'): speech_on = not speech_on
    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--gpu", action="store_true")
    parser.add_argument("--simulate-speech", action="store_true")
    args = parser.parse_args()
    run_monitor(camera_index=args.camera, ctx_id=0 if args.gpu else -1, simulate_speech=args.simulate_speech)
