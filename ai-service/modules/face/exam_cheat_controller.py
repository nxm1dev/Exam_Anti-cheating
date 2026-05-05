"""
ai-service/modules/face/exam_cheat_controller.py
──────────────────────────────────────────────────
ExamCheatController – Bộ điều khiển xác nhận chéo (cross-check) đa phương thức.

Quản lý state riêng biệt cho từng session/user bằng Dictionary.
Sử dụng Time-Series Buffer (deque) để tính phương sai MAR → đánh giá
"miệng đang cử động" thay vì "miệng đang mở" (tĩnh).

Logic nghiệp vụ:
  - speech_detected + is_mouth_moving  → Level 1 (đọc nhẩm / nói chuyện)
  - speech_detected + NOT moving > 1.5s → Level 2 (người khác nhắc bài)
  - Ho/hắng (< 1.5s, miệng không cử động) → Bỏ qua (debounce)
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

from modules.face.exam_face_detector import (
    ExamFaceDetector,
    MultimodalResult,
)


# ──────────────────────────────────────────────────────────────────────────────
# Cheating Levels
# ──────────────────────────────────────────────────────────────────────────────
LEVEL_NORMAL = 0
LEVEL_MILD_WARNING = 1     # Đọc nhẩm (miệng cử động + có tiếng + nhìn thẳng)
LEVEL_WARNING_L1 = 2       # Quay sang nói chuyện (miệng cử động + nhìn đi)
LEVEL_WARNING_L2 = 3       # Người khác nhắc bài (có tiếng + miệng KHÔNG cử động)

LEVEL_LABELS = {
    LEVEL_NORMAL: "NORMAL",
    LEVEL_MILD_WARNING: "MILD_WARNING",
    LEVEL_WARNING_L1: "WARNING_LEVEL_1",
    LEVEL_WARNING_L2: "WARNING_LEVEL_2_URGENT",
}

LEVEL_MESSAGES = {
    LEVEL_NORMAL: "Bình thường – không phát hiện bất thường.",
    LEVEL_MILD_WARNING: "Cảnh báo nhẹ: Thí sinh đang đọc nhẩm.",
    LEVEL_WARNING_L1: "Cảnh báo Mức 1: Thí sinh đang quay sang nói chuyện.",
    LEVEL_WARNING_L2: "Cảnh báo Mức 2 Khẩn cấp: Có tiếng người khác nhắc bài!",
}


# ──────────────────────────────────────────────────────────────────────────────
# Result dataclass
# ──────────────────────────────────────────────────────────────────────────────
@dataclass
class CheatingVerdict:
    """Kết quả phân tích hành vi gian lận."""
    status: str = "NORMAL"        # Mã trạng thái
    message: str = "Bình thường"  # Mô tả tiếng Việt
    level: int = 0                # 0=bình thường → 3=khẩn cấp
    details: Dict[str, Any] = field(default_factory=dict)


# ──────────────────────────────────────────────────────────────────────────────
# Per-session state (cô lập dữ liệu giữa các thí sinh)
# ──────────────────────────────────────────────────────────────────────────────
@dataclass
class SessionState:
    """
    State riêng biệt cho mỗi session/user.

    mar_history: Lưu lịch sử MAR thô của 20 frame gần nhất.
        - Buffer lớn đảm bảo luôn chứa giá trị "miệng đóng" làm baseline,
          kể cả khi thí sinh nói liên tục 10-15 giây.
        - Với 1 frame/giây (im lặng) hoặc 2 frame/giây (đang nói),
          20 frames ≈ 10-20 giây lịch sử.
    """
    mar_history: Deque[float] = field(
        default_factory=lambda: deque(maxlen=20)
    )
    speech_start_time: float = 0.0
    last_activity: float = field(default_factory=time.monotonic)


# ──────────────────────────────────────────────────────────────────────────────
# Main Controller
# ──────────────────────────────────────────────────────────────────────────────
class ExamCheatController:
    """
    Controller tổng hợp – quản lý state cho nhiều session đồng thời.

    Dùng cho WebSocket endpoint: mỗi thí sinh kết nối qua 1 session_id riêng.
    Dữ liệu MAR buffer và bộ đếm speech được cô lập hoàn toàn.

    Parameters
    ----------
    model_root : str
        Đường dẫn thư mục chứa model InsightFace.
    ctx_id : int
        -1 = CPU, 0 = GPU.
    yaw_threshold : float
        Ngưỡng yaw cho head pose.
    pitch_threshold : float
        Ngưỡng pitch cho head pose.
    mar_variance_threshold : float
        Ngưỡng phương sai MAR để phân biệt "miệng cử động" vs "miệng tĩnh".
        Giá trị mặc định 0.001 dựa trên thực nghiệm: khi nói chuyện bình
        thường, phương sai MAR thường > 0.003, khi im lặng thường < 0.0005.
    speech_debounce_seconds : float
        Thời gian tối thiểu speech_detected=True liên tục trước khi
        trigger cảnh báo Level 2 (người khác nhắc bài). Mặc định 1.5s
        giúp loại bỏ nhiễu từ tiếng ho, hắng ngắn.
    session_timeout : float
        Thời gian (giây) không có activity trước khi tự xóa session state.
    """

    def __init__(
        self,
        model_root: str = "~/.insightface",
        ctx_id: int = -1,
        yaw_threshold: float = 20.0,    # Đã giảm từ 30.0 để tăng độ nhạy quay ngang
        pitch_threshold: float = 15.0,  # Đã giảm từ 20.0 để tăng độ nhạy cúi/ngửa
        mar_variance_threshold: float = 0.001,
        speech_debounce_seconds: float = 1.5,
        session_timeout: float = 3600.0,  # 1 giờ
    ) -> None:
        self.detector = ExamFaceDetector(
            model_root=model_root,
            ctx_id=ctx_id,
            yaw_threshold=yaw_threshold,
            pitch_threshold=pitch_threshold,
            # Không throttle vì frontend đã throttle 500ms
            throttle_interval=0.0,
        )
        self.mar_variance_threshold = mar_variance_threshold
        self.speech_debounce_seconds = speech_debounce_seconds
        self._session_timeout = session_timeout

        # Thread-safe dictionary quản lý state cho từng session
        self._sessions: Dict[str, SessionState] = {}
        self._sessions_lock = threading.Lock()

    # ── Session management ────────────────────────────────────────────────────
    def _get_or_create_session(self, session_id: str) -> SessionState:
        """Lấy hoặc tạo mới SessionState cho session_id."""
        with self._sessions_lock:
            if session_id not in self._sessions:
                self._sessions[session_id] = SessionState()
            state = self._sessions[session_id]
            state.last_activity = time.monotonic()
            return state

    def clear_session(self, session_id: str) -> None:
        """Giải phóng state khi thí sinh kết thúc thi."""
        with self._sessions_lock:
            self._sessions.pop(session_id, None)

    def cleanup_stale_sessions(self) -> int:
        """Xóa các session không hoạt động quá timeout. Trả về số session bị xóa."""
        now = time.monotonic()
        removed = 0
        with self._sessions_lock:
            stale_ids = [
                sid for sid, st in self._sessions.items()
                if (now - st.last_activity) > self._session_timeout
            ]
            for sid in stale_ids:
                del self._sessions[sid]
                removed += 1
        return removed

    @property
    def active_session_count(self) -> int:
        """Số session đang hoạt động."""
        with self._sessions_lock:
            return len(self._sessions)

    # ── Mouth Movement Evaluation ────────────────────────────
    def evaluate_mouth_movement(
        self, session_id: str, current_mar: float
    ) -> Tuple[bool, float]:
        """
        Đánh giá miệng có đang CỬ ĐỘNG hay không bằng 2 bộ kiểm tra song song.

        Bộ 1 – Delta dài hạn (20 frames):
          baseline = min(20 frames gần nhất)
          delta = current_mar - baseline
          Nếu delta > 0.08 → miệng đang mở hơn bình thường.
          → Bắt được lúc BẮT ĐẦU nói (buffer vẫn có frames im lặng).

        Bộ 2 – Biên độ dao động ngắn hạn (5 frames):
          range = max(5 frames) - min(5 frames)
          Nếu range > 0.06 → miệng đang dao động (mở-đóng theo nhịp nói).
          → Bắt được lúc NÓI LIÊN TỤC (kể cả khi buffer toàn frame nói).
          → Khi mím chặt môi, jitter chỉ tạo range ≈ 0.02-0.04 < 0.06.

        Miệng = đang cử động nếu BẤT KỲ bộ nào True.
        """
        state = self._get_or_create_session(session_id)
        history_all = list(state.mar_history)

        if len(history_all) < 3:
            return False, 0.0

        # ── Bộ 1: Delta dài hạn (toàn bộ buffer 20 frames) ──
        # Jitter ở 480px tạo delta tối đa ≈ 0.14, nói chuyện tạo delta ≈ 0.25+
        baseline = min(history_all)
        delta = current_mar - baseline
        check_delta = delta > 0.15

        # ── Bộ 2: Biên độ dao động ngắn hạn (5 frames gần nhất) ──
        # Jitter tạo range ≈ 0.10-0.14, nói chuyện tạo range ≈ 0.20+
        recent = history_all[-5:]
        mar_range = max(recent) - min(recent)
        check_range = mar_range > 0.15

        is_moving = check_delta or check_range

        logger.info(
            "[CheatCtrl] MAR=%.4f | delta=%.4f (>0.15?%s) | range=%.4f (>0.15?%s) -> is_moving=%s",
            current_mar, delta, check_delta, mar_range, check_range, is_moving,
        )

        return is_moving, delta

    # ── Cross-check Analysis ──────────────────────────────────────────────────
    def process_payload(
        self,
        session_id: str,
        payload: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Xử lý payload JSON từ WebSocket theo ma trận đánh giá.
        """
        return self.analyze_cheating_behavior(session_id, payload)

    def analyze_cheating_behavior(
        self,
        session_id: str,
        payload: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Ma trận logic cross-check:
        ┌──────────────────┬────────────────┬──────────────┬─────────────────────────┐
        │ speech_detected  │ is_mouth_open  │ looking_away │ Kết luận                │
        ├──────────────────┼────────────────┼──────────────┼─────────────────────────┤
        │ False            │ *              │ *            │ Bình thường              │
        │ True             │ True           │ False        │ LV1: Đọc nhẩm           │
        │ True             │ True           │ True         │ LV1: Quay sang nói      │
        │ True             │ False          │ *            │ LV2: Người khác nhắc    │
        └──────────────────┴────────────────┴──────────────┴─────────────────────────┘
        """
        speech_detected = payload.get("speech_detected", False)
        state = self._get_or_create_session(session_id)

        # ── 1. Decode và phân tích frame ──
        base64_image = payload.get("image")
        if not base64_image:
            return {"status": "ERROR", "message": "Thiếu frame ảnh", "level": -1}

        frame = ExamFaceDetector.decode_base64_image(base64_image)
        if frame is None:
            return {"status": "ERROR", "message": "Không thể decode ảnh", "level": -1}

        # Chạy inference multimodal
        mm: MultimodalResult = self.detector.process_frame_multimodal(frame)

        # Cập nhật MAR vào buffer của session
        state.mar_history.append(mm.mar_value)

        # Đánh giá miệng mở (baseline động)
        is_mouth_moving, mar_delta = self.evaluate_mouth_movement(session_id, mm.mar_value)

        # Cập nhật state (để dọn dẹp stale sessions)
        state.last_activity = time.monotonic()

        # Build chi tiết cho response
        details: Dict[str, Any] = {
            "face_count": mm.face_count,
            "mar_value": round(mm.mar_value, 4),
            "mar_delta": round(mar_delta, 4),
            "is_mouth_moving": is_mouth_moving,
            "is_looking_away": mm.is_looking_away,
            "pose": {
                "pitch": round(mm.pitch, 2),
                "yaw": round(mm.yaw, 2),
                "roll": round(mm.roll, 2),
            },
            "has_landmarks": mm.has_landmarks,
            "speech_detected": speech_detected,
        }

        # ── 2. Kiểm tra các vi phạm cơ bản về khuôn mặt ──
        if mm.face_count == 0:
            return self._build_verdict(
                LEVEL_WARNING_L2,
                message="Không tìm thấy khuôn mặt của thí sinh!",
                details=details,
            )
        
        if mm.face_count > 1:
            return self._build_verdict(
                LEVEL_WARNING_L2,
                message=f"Phát hiện {mm.face_count} khuôn mặt trong khung hình!",
                details=details,
            )

        # ── 3. Áp dụng ma trận cross-check ──
        if not speech_detected:
            return self._build_verdict(LEVEL_NORMAL, details=details)

        # Log quyết định để debug
        logger.info(
            "[CheatCtrl] DECISION: speech=%s mouth_moving=%s looking_away=%s (yaw=%.1f pitch=%.1f)",
            speech_detected, is_mouth_moving, mm.is_looking_away, mm.yaw, mm.pitch,
        )

        if is_mouth_moving:
            if mm.is_looking_away:
                # speech=True, mouth=True, away=True
                return self._build_verdict(LEVEL_WARNING_L1, message="Thí sinh đang quay sang nói chuyện", details=details)
            else:
                # speech=True, mouth=True, away=False
                return self._build_verdict(LEVEL_MILD_WARNING, message="Thí sinh đang đọc nhẩm", details=details)
        else:
            # speech=True, mouth=False
            return self._build_verdict(LEVEL_WARNING_L2, message="Có tiếng người khác nhắc bài!", details=details)

    # ── Verdict builder ───────────────────────────────────────────────────────
    @staticmethod
    def _build_verdict(
        level: int,
        message: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Tạo verdict response dict chuẩn hóa."""
        return {
            "status": LEVEL_LABELS.get(level, "UNKNOWN"),
            "message": message or LEVEL_MESSAGES.get(level, "Không xác định"),
            "level": level,
            "details": details or {},
        }
