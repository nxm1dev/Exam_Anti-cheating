"""
ai-service/modules/face/exam_face_detector.py
─────────────────────────────────────────────
ExamFaceDetector – giám sát khuôn mặt theo thời gian thực trong phòng thi.

Thiết kế:
  - Sử dụng InsightFace FaceAnalysis (buffalo_l) với detection + landmark_2d_106.
  - Throttle inference: thực sự chạy model mỗi ~0.25s (4 FPS) dù caller
    gọi process_frame() liên tục ở 30 FPS.
  - Các frame ở giữa trả về kết quả cache của lần inference gần nhất.
  - Callback-based: không print ra màn hình, toàn bộ logic phản ứng nằm
    ở phía ứng dụng gọi.

Nâng cấp Multimodal:
  - calculate_mar(): Tính MAR từ 3 cặp điểm INNER LIPS (InsightFace 106).
  - analyze_pose(): Phân tích góc quay đầu (yaw/pitch/roll).
  - process_frame_multimodal(): Trả về MultimodalResult đầy đủ.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

# ──────────────────────────────────────────────────────────────────────────────
# Type aliases cho callback signatures
# ──────────────────────────────────────────────────────────────────────────────
# BBox: [x1, y1, x2, y2] dạng int (pixel coordinates)
BBox = List[int]

OnMultipleFacesCB = Callable[[np.ndarray, int], None]
OnNoFaceCB = Callable[[np.ndarray], None]
OnNormalCB = Callable[[np.ndarray, BBox], None]


# ──────────────────────────────────────────────────────────────────────────────
# Internal result dataclasses
# ──────────────────────────────────────────────────────────────────────────────
@dataclass
class DetectionResult:
    """Kết quả detect của một lần inference (backward-compatible)."""
    face_count: int = 0
    bboxes: List[BBox] = field(default_factory=list)
    timestamp: float = field(default_factory=time.monotonic)


@dataclass
class MultimodalResult:
    """Kết quả phân tích đa phương thức (hình ảnh: MAR + Head Pose)."""
    face_count: int = 0
    bboxes: List[BBox] = field(default_factory=list)
    # MAR (Mouth Aspect Ratio) – giá trị thô, KHÔNG ép boolean
    mar_value: float = 0.0
    is_mouth_open: bool = False
    # Head Pose
    is_looking_away: bool = False
    pitch: float = 0.0
    yaw: float = 0.0
    roll: float = 0.0
    # Flags
    has_landmarks: bool = False


# ──────────────────────────────────────────────────────────────────────────────
# InsightFace 106-Point Inner Lips Index Map
# ──────────────────────────────────────────────────────────────────────────────
# Trong chuẩn landmark 106 điểm của InsightFace (2d106det):
#
#   Inner Lips contour (8 điểm):
#     96  = Khóe miệng trong bên trái (inner left corner)
#     97  = Đỉnh môi trên trong – trái
#     98  = Đỉnh môi trên trong – giữa trái
#     99  = Đỉnh môi trên trong – giữa phải
#     100 = Khóe miệng trong bên phải (inner right corner)
#     101 = Đáy môi dưới trong – phải
#     102 = Đáy môi dưới trong – giữa
#     103 = Đáy môi dưới trong – trái
#
#   Công thức MAR (Inner Lip):
#     vertical = mean(dist(97,103), dist(98,102), dist(99,101))
#     horizontal = dist(96, 100)
#     MAR = vertical / horizontal
#
#   Lý do dùng Inner Lips thay vì Outer Lips:
#     - Outer lips (điểm 84, 87, 90, 93) bao gồm cả bề dày môi.
#       Người môi dày sẽ luôn có MAR cao → False Positive.
#     - Inner lips chỉ đo khe hở miệng thực tế.
#     - 3 cặp dọc trung bình hóa giúp giảm sai lệch khi nhếch mép.
# ──────────────────────────────────────────────────────────────────────────────

# Index constants – dễ audit và thay đổi nếu model version khác
_INNER_LIP_LEFT_CORNER = 96
_INNER_LIP_RIGHT_CORNER = 100
_INNER_LIP_VERT_PAIRS = [
    (97, 103),  # Cặp trái:  môi trên trong trái ↔ môi dưới trong trái
    (98, 102),  # Cặp giữa:  môi trên trong giữa ↔ môi dưới trong giữa
    (99, 101),  # Cặp phải:  môi trên trong phải ↔ môi dưới trong phải
]


# ──────────────────────────────────────────────────────────────────────────────
# Main class
# ──────────────────────────────────────────────────────────────────────────────
class ExamFaceDetector:
    """
    Giám sát khuôn mặt + phân tích MAR & Head Pose cho hệ thống chống gian lận.

    Parameters
    ----------
    model_root : str
        Thư mục root chứa (hoặc sẽ tải về) model buffalo_l.
        Cấu trúc mong đợi: ``<model_root>/models/buffalo_l/``.
    on_multiple_faces : OnMultipleFacesCB | None
        Callback khi phát hiện > 1 khuôn mặt (nghi ngờ có người nhắc bài).
        Signature: ``(frame: np.ndarray, face_count: int) -> None``
    on_no_face : OnNoFaceCB | None
        Callback khi không phát hiện khuôn mặt nào (nghi ngờ rời vị trí).
        Signature: ``(frame: np.ndarray) -> None``
    on_normal : OnNormalCB | None
        Callback khi chỉ có đúng 1 khuôn mặt (trạng thái bình thường).
        Signature: ``(frame: np.ndarray, bbox: BBox) -> None``
        với ``bbox = [x1, y1, x2, y2]``.
    det_size : tuple[int, int]
        Kích thước ảnh đầu vào cho model detection. Mặc định (640, 640).
    det_thresh : float
        Ngưỡng confidence tối thiểu để chấp nhận một khuôn mặt.
    throttle_interval : float
        Thời gian tối thiểu (giây) giữa hai lần inference thực sự.
        Mặc định 0.25s → ~4 FPS inference.
    yaw_threshold : float
        Ngưỡng góc yaw (quay ngang). |yaw| > threshold → looking away.
    pitch_threshold : float
        Ngưỡng góc pitch (cúi/ngửa). |pitch| > threshold → looking away.
    ctx_id : int
        0 = GPU (CUDA), -1 = CPU.
    """

    # ── Preprocessing target resolution ───────────────────────────────────────
    _PREPROCESS_W: int = 480
    _PREPROCESS_H: int = 270  # 16:9 ratio

    def __init__(
        self,
        model_root: str = "~/.insightface",
        on_multiple_faces: Optional[OnMultipleFacesCB] = None,
        on_no_face: Optional[OnNoFaceCB] = None,
        on_normal: Optional[OnNormalCB] = None,
        det_size: tuple[int, int] = (480, 480),
        det_thresh: float = 0.5,
        throttle_interval: float = 0.25,
        yaw_threshold: float = 30.0,
        pitch_threshold: float = 20.0,
        ctx_id: int = -1,  # -1 = CPU; 0 = GPU
    ) -> None:
        self._on_multiple_faces = on_multiple_faces
        self._on_no_face = on_no_face
        self._on_normal = on_normal

        self._det_size = det_size
        self._det_thresh = det_thresh
        self._throttle_interval = throttle_interval
        self._ctx_id = ctx_id
        self._model_root = model_root

        # Ngưỡng head pose
        self.yaw_threshold: float = yaw_threshold
        self.pitch_threshold: float = pitch_threshold

        # Throttle state
        self._last_inference_time: float = 0.0
        self._last_result: DetectionResult = DetectionResult()
        self._last_multimodal: MultimodalResult = MultimodalResult()

        # Lazy-load flag
        self._app = None  # insightface.app.FaceAnalysis

    # ── Model loading ──────────────────────────────────────────────────────────
    def _load_model(self) -> None:
        """Lazy-load InsightFace detection + landmark model."""
        if self._app is not None:
            return

        import insightface
        from insightface.app import FaceAnalysis

        self._app = FaceAnalysis(
            name="buffalo_l",
            root=self._model_root,
            # QUAN TRỌNG: Thêm 'landmark_2d_106' để có 106 điểm landmark
            # cho tính MAR và head pose estimation
            allowed_modules=["detection", "landmark_2d_106"],
        )
        self._app.prepare(
            ctx_id=self._ctx_id,
            det_thresh=self._det_thresh,
            det_size=self._det_size,
        )

    # ── Preprocessing ──────────────────────────────────────────────────────────
    @staticmethod
    def _preprocess(frame: np.ndarray) -> np.ndarray:
        """
        Resize frame xuống 640×360 (hoặc giữ tỉ lệ nếu frame không phải 16:9).
        Dùng cv2.INTER_AREA vì đây là downscale – chất lượng tốt nhất.
        """
        h, w = frame.shape[:2]
        target_w = ExamFaceDetector._PREPROCESS_W
        target_h = ExamFaceDetector._PREPROCESS_H

        if w == target_w and h == target_h:
            return frame  # Không cần resize

        return cv2.resize(frame, (target_w, target_h), interpolation=cv2.INTER_AREA)

    # ── MAR Calculation (Inner Lips) ──────────────────────────────────────────
    @staticmethod
    def calculate_mar(landmarks: Optional[np.ndarray]) -> float:
        """
        Tính Mouth Aspect Ratio (MAR) từ InsightFace 106-point landmarks.

        Sử dụng INNER LIPS thay vì Outer Lips để tránh false positive
        với người có môi dày.

        Công thức:
            vertical = mean(
                dist(landmarks[97], landmarks[103]),  # Cặp trái
                dist(landmarks[98], landmarks[102]),  # Cặp giữa
                dist(landmarks[99], landmarks[101]),  # Cặp phải
            )
            horizontal = dist(landmarks[96], landmarks[100])
            MAR = vertical / horizontal

        Trả về giá trị MAR thô (float). Việc quyết định "miệng đang cử động"
        được giao cho ExamCheatController dựa trên phương sai chuỗi thời gian.

        Parameters
        ----------
        landmarks : np.ndarray | None
            Mảng (106, 2) chứa tọa độ 106 điểm landmark.

        Returns
        -------
        float
            Giá trị MAR. Trả về 0.0 nếu không có landmark.
        """
        if landmarks is None or len(landmarks) < 106:
            return 0.0

        # ── Tính khoảng cách ngang (horizontal) giữa 2 khóe miệng trong ──
        left_corner = landmarks[_INNER_LIP_LEFT_CORNER]   # Index 96
        right_corner = landmarks[_INNER_LIP_RIGHT_CORNER]  # Index 100
        horizontal = float(np.linalg.norm(left_corner - right_corner))

        if horizontal < 1e-6:
            return 0.0  # Tránh chia cho 0

        # ── Tính trung bình 3 khoảng cách dọc (vertical) ──
        # Lấy 3 cặp điểm dọc ở Inner Lips: (97,103), (98,102), (99,101)
        # Trung bình hóa giúp giảm sai lệch khi thí sinh nhếch mép
        # (1 bên cao hơn bên kia → vẫn ra giá trị hợp lý)
        vertical_sum = 0.0
        for top_idx, bottom_idx in _INNER_LIP_VERT_PAIRS:
            dist = float(np.linalg.norm(landmarks[top_idx] - landmarks[bottom_idx]))
            vertical_sum += dist
        vertical_avg = vertical_sum / len(_INNER_LIP_VERT_PAIRS)

        mar = vertical_avg / horizontal
        return mar

    # ── Head Pose Analysis ────────────────────────────────────────────────────
    def analyze_pose(
        self, pose: Optional[np.ndarray]
    ) -> Tuple[bool, Tuple[float, float, float]]:
        """
        Phân tích góc quay đầu từ InsightFace.

        InsightFace trả về pose = [pitch, yaw, roll] (đơn vị: độ).
          - pitch: cúi (âm) / ngửa (dương)
          - yaw:   quay trái (âm) / quay phải (dương)
          - roll:  nghiêng đầu

        Returns
        -------
        (is_looking_away, (pitch, yaw, roll))
        """
        if pose is None or not hasattr(pose, "__len__") or len(pose) < 3:
            return False, (0.0, 0.0, 0.0)

        pitch, yaw, roll = float(pose[0]), float(pose[1]), float(pose[2])

        # Thí sinh "nhìn đi chỗ khác" khi yaw hoặc pitch vượt ngưỡng
        is_looking_away = (
            abs(yaw) > self.yaw_threshold or abs(pitch) > self.pitch_threshold
        )

        return is_looking_away, (pitch, yaw, roll)

    # ── Inference ─────────────────────────────────────────────────────────────
    def _run_inference(
        self, small_frame: np.ndarray
    ) -> Tuple[DetectionResult, MultimodalResult]:
        """Chạy InsightFace và trích xuất BBox + MAR + Pose."""
        self._load_model()

        try:
            faces = self._app.get(small_frame)
        except Exception:
            return DetectionResult(), MultimodalResult()

        bboxes: List[BBox] = []
        for face in faces:
            bboxes.append(face.bbox.astype(int).tolist())

        det = DetectionResult(
            face_count=len(bboxes), bboxes=bboxes, timestamp=time.monotonic()
        )

        # Phân tích MAR và Pose cho khuôn mặt LỚN NHẤT (thí sinh chính)
        mm = MultimodalResult(face_count=len(bboxes), bboxes=bboxes)

        if faces:
            # Chọn face có bounding box lớn nhất (closest to camera = thí sinh)
            face = max(
                faces,
                key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]),
            )

            # MAR từ landmark_2d_106
            lmk = getattr(face, "landmark_2d_106", None)
            if lmk is not None:
                mm.has_landmarks = True
                mm.mar_value = self.calculate_mar(lmk)
                mm.is_mouth_open = mm.mar_value > 0.10

            # Head Pose
            pose = getattr(face, "pose", None)
            if pose is not None:
                mm.is_looking_away, (mm.pitch, mm.yaw, mm.roll) = (
                    self.analyze_pose(pose)
                )

        return det, mm

    # ── Callback dispatcher ────────────────────────────────────────────────────
    def _dispatch(self, frame: np.ndarray, result: DetectionResult) -> None:
        """Gọi callback phù hợp dựa theo face_count."""
        count = result.face_count

        if count == 0:
            if self._on_no_face is not None:
                self._on_no_face(frame)

        elif count == 1:
            bbox: BBox = result.bboxes[0]
            if self._on_normal is not None:
                self._on_normal(frame, bbox)

        else:  # count > 1
            if self._on_multiple_faces is not None:
                self._on_multiple_faces(frame, count)

    # ── Public API ─────────────────────────────────────────────────────────────
    def process_frame(self, frame: np.ndarray) -> DetectionResult:
        """
        Xử lý một frame từ OpenCV (BGR numpy array).
        Backward-compatible API – chỉ trả về DetectionResult.

        Nếu chưa đến ``throttle_interval`` kể từ lần inference trước, hàm
        trả về kết quả cache và vẫn gọi callback với ``frame`` hiện tại.

        Parameters
        ----------
        frame : np.ndarray
            Frame BGR từ ``cv2.VideoCapture.read()``.

        Returns
        -------
        DetectionResult
            Kết quả detect (có thể là cache từ lần trước).
        """
        now = time.monotonic()
        elapsed = now - self._last_inference_time

        if elapsed >= self._throttle_interval:
            # Thực sự chạy inference
            small = self._preprocess(frame)
            self._last_result, self._last_multimodal = self._run_inference(small)
            self._last_inference_time = now

        # Luôn dispatch với frame gốc (full resolution) để callback có ảnh đẹp
        self._dispatch(frame, self._last_result)
        return self._last_result

    def process_frame_multimodal(self, frame: np.ndarray) -> MultimodalResult:
        """
        Xử lý frame và trả về kết quả đa phương thức (MAR + Pose).
        Có throttle giống process_frame.
        """
        now = time.monotonic()
        if now - self._last_inference_time >= self._throttle_interval:
            small = self._preprocess(frame)
            self._last_result, self._last_multimodal = self._run_inference(small)
            self._last_inference_time = now

        self._dispatch(frame, self._last_result)
        return self._last_multimodal

    def reset(self) -> None:
        """Xóa state throttle (dùng khi bắt đầu phiên thi mới)."""
        self._last_inference_time = 0.0
        self._last_result = DetectionResult()
        self._last_multimodal = MultimodalResult()

    @property
    def last_result(self) -> DetectionResult:
        """Kết quả inference gần nhất (có thể là giá trị khởi tạo nếu chưa detect)."""
        return self._last_result

    @property
    def last_multimodal(self) -> MultimodalResult:
        """Kết quả multimodal gần nhất."""
        return self._last_multimodal

    @staticmethod
    def decode_base64_image(base64_str: str) -> Optional[np.ndarray]:
        """
        Decode ảnh base64 (từ frontend) thành numpy array BGR.
        Hỗ trợ cả format 'data:image/jpeg;base64,...' và raw base64.
        """
        import base64 as b64mod

        # Tách header 'data:image/jpeg;base64,' nếu có
        if "," in base64_str:
            base64_str = base64_str.split(",", 1)[1]
        img_data = b64mod.b64decode(base64_str)
        np_arr = np.frombuffer(img_data, np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        return frame
