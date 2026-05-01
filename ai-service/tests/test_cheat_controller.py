"""
ai-service/tests/test_cheat_controller.py
──────────────────────────────────────────
Unit tests cho ExamCheatController – logic xác nhận chéo multimodal.

Tests cover:
  1. calculate_mar – Inner Lips indices (96-103)
  2. evaluate_mouth_movement – Variance-based detection
  3. process_payload – Cross-check decision matrix
  4. Session isolation – Multi-user state management
  5. Debounce – 1.5s threshold for Level 2 warnings
"""

from __future__ import annotations

import time
from collections import deque
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from modules.face.exam_face_detector import (
    ExamFaceDetector,
    MultimodalResult,
)
from modules.face.exam_cheat_controller import (
    ExamCheatController,
    SessionState,
    CheatingVerdict,
    LEVEL_NORMAL,
    LEVEL_MILD_WARNING,
    LEVEL_WARNING_L1,
    LEVEL_WARNING_L2,
)


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────
def _make_landmarks_106(
    inner_lip_gap: float = 0.0,
    horizontal_width: float = 60.0,
) -> np.ndarray:
    """
    Tạo mảng 106 landmarks giả với khe miệng trong (inner lip gap) tùy chỉnh.

    inner_lip_gap: Khoảng cách dọc giữa môi trên và môi dưới (inner lips).
        0 = miệng khép, >0 = miệng mở.
    horizontal_width: Khoảng cách ngang giữa 2 khóe miệng trong.
    """
    lmk = np.zeros((106, 2), dtype=np.float32)

    # Inner lip corners (horizontal base)
    cx, cy = 320.0, 240.0
    half_w = horizontal_width / 2.0

    lmk[96] = [cx - half_w, cy]      # Khóe miệng trong trái
    lmk[100] = [cx + half_w, cy]     # Khóe miệng trong phải

    # Inner lip vertical pairs – symmetric gap
    half_gap = inner_lip_gap / 2.0
    # Pair (97, 103) – trái
    lmk[97] = [cx - half_w * 0.6, cy - half_gap]
    lmk[103] = [cx - half_w * 0.6, cy + half_gap]
    # Pair (98, 102) – giữa
    lmk[98] = [cx, cy - half_gap]
    lmk[102] = [cx, cy + half_gap]
    # Pair (99, 101) – phải
    lmk[99] = [cx + half_w * 0.6, cy - half_gap]
    lmk[101] = [cx + half_w * 0.6, cy + half_gap]

    return lmk


# ──────────────────────────────────────────────────────────────────────────────
# Test: calculate_mar (Inner Lips)
# ──────────────────────────────────────────────────────────────────────────────
class TestCalculateMAR:
    """Test MAR calculation using Inner Lips indices."""

    def test_closed_mouth_returns_near_zero(self):
        """Miệng khép hoàn toàn → MAR ≈ 0."""
        lmk = _make_landmarks_106(inner_lip_gap=0.0)
        mar = ExamFaceDetector.calculate_mar(lmk)
        assert mar == pytest.approx(0.0, abs=1e-6)

    def test_open_mouth_returns_positive_mar(self):
        """Miệng mở → MAR > 0."""
        lmk = _make_landmarks_106(inner_lip_gap=20.0, horizontal_width=60.0)
        mar = ExamFaceDetector.calculate_mar(lmk)
        # Expected: vertical_avg/horizontal = 20/60 ≈ 0.333
        assert mar > 0.3
        assert mar < 0.4

    def test_wide_open_mouth_higher_mar(self):
        """Miệng mở rộng → MAR lớn hơn miệng hé."""
        lmk_slight = _make_landmarks_106(inner_lip_gap=5.0)
        lmk_wide = _make_landmarks_106(inner_lip_gap=30.0)
        mar_slight = ExamFaceDetector.calculate_mar(lmk_slight)
        mar_wide = ExamFaceDetector.calculate_mar(lmk_wide)
        assert mar_wide > mar_slight

    def test_none_landmarks_returns_zero(self):
        """Landmarks None → MAR = 0."""
        assert ExamFaceDetector.calculate_mar(None) == 0.0

    def test_insufficient_landmarks_returns_zero(self):
        """Landmarks < 106 điểm → MAR = 0."""
        lmk = np.zeros((50, 2), dtype=np.float32)
        assert ExamFaceDetector.calculate_mar(lmk) == 0.0

    def test_zero_horizontal_returns_zero(self):
        """Horizontal distance ≈ 0 → tránh chia cho 0."""
        lmk = np.zeros((106, 2), dtype=np.float32)
        # Tất cả điểm trùng nhau → horizontal = 0
        assert ExamFaceDetector.calculate_mar(lmk) == 0.0


# ──────────────────────────────────────────────────────────────────────────────
# Test: evaluate_mouth_movement (Variance-based)
# ──────────────────────────────────────────────────────────────────────────────
class TestEvaluateMouthMovement:
    """Test variance-based mouth movement detection."""

    def setup_method(self):
        """Khởi tạo controller với threshold nhỏ để test dễ hơn."""
        self.controller = ExamCheatController(
            mar_variance_threshold=0.001,
        )

    def test_static_mouth_not_moving(self):
        """
        Miệng tĩnh (MAR không đổi) → variance ≈ 0 → is_moving = False.
        Ví dụ: Thí sinh ngậm miệng im lặng.
        """
        sid = "test-static"
        state = self.controller._get_or_create_session(sid)
        # Đẩy 5 giá trị MAR giống nhau vào buffer
        for _ in range(5):
            state.mar_history.append(0.05)

        is_moving, variance = self.controller.evaluate_mouth_movement(sid)
        assert is_moving is False
        assert variance < 0.001

    def test_moving_mouth_detected(self):
        """
        Miệng cử động (MAR thay đổi liên tục) → variance lớn → is_moving = True.
        Ví dụ: Thí sinh đang nói chuyện.
        """
        sid = "test-moving"
        state = self.controller._get_or_create_session(sid)
        # Mô phỏng MAR dao động khi nói: mở → đóng → mở → đóng → mở
        for mar in [0.05, 0.25, 0.08, 0.30, 0.06]:
            state.mar_history.append(mar)

        is_moving, variance = self.controller.evaluate_mouth_movement(sid)
        assert is_moving is True
        assert variance > 0.001

    def test_insufficient_samples_returns_not_moving(self):
        """
        Ít hơn 3 mẫu → không đủ dữ liệu → mặc định is_moving = False.
        Tránh false positive khi thí sinh vừa kết nối.
        """
        sid = "test-few"
        state = self.controller._get_or_create_session(sid)
        state.mar_history.append(0.1)
        state.mar_history.append(0.3)

        is_moving, variance = self.controller.evaluate_mouth_movement(sid)
        assert is_moving is False
        assert variance == 0.0

    def test_thick_lips_static_not_false_positive(self):
        """
        Người có môi dày → MAR baseline cao hơn (ví dụ 0.15 thay vì 0.05)
        nhưng NẾU miệng tĩnh → variance vẫn ≈ 0 → KHÔNG false positive.

        Đây là lý do cốt lõi dùng variance thay vì threshold tĩnh.
        """
        sid = "test-thick-lips"
        state = self.controller._get_or_create_session(sid)
        # MAR baseline cao nhưng ổn định → tĩnh
        for _ in range(5):
            state.mar_history.append(0.15)

        is_moving, variance = self.controller.evaluate_mouth_movement(sid)
        assert is_moving is False


# ──────────────────────────────────────────────────────────────────────────────
# Test: Session isolation (Multi-user)
# ──────────────────────────────────────────────────────────────────────────────
class TestSessionIsolation:
    """Test that different sessions don't leak state."""

    def setup_method(self):
        self.controller = ExamCheatController()

    def test_different_sessions_have_separate_buffers(self):
        """2 thí sinh khác nhau phải có MAR buffer riêng."""
        s1 = self.controller._get_or_create_session("student-A")
        s2 = self.controller._get_or_create_session("student-B")

        s1.mar_history.append(0.1)
        s1.mar_history.append(0.2)

        # Student B's buffer phải rỗng
        assert len(s2.mar_history) == 0
        assert len(s1.mar_history) == 2

    def test_clear_session_removes_state(self):
        """clear_session phải xóa state hoàn toàn."""
        self.controller._get_or_create_session("temp")
        assert self.controller.active_session_count == 1

        self.controller.clear_session("temp")
        assert self.controller.active_session_count == 0

    def test_clear_nonexistent_session_no_error(self):
        """Xóa session không tồn tại → không lỗi."""
        self.controller.clear_session("nonexistent")  # Should not raise


# ──────────────────────────────────────────────────────────────────────────────
# Test: Cross-check decision matrix (process_payload)
# ──────────────────────────────────────────────────────────────────────────────
class TestCrossCheckMatrix:
    """Test the cross-check decision logic in process_payload."""

    def setup_method(self):
        self.controller = ExamCheatController(
            mar_variance_threshold=0.001,
            speech_debounce_seconds=1.5,
        )

    def _mock_multimodal(
        self,
        face_count: int = 1,
        mar_value: float = 0.0,
        is_looking_away: bool = False,
        has_landmarks: bool = True,
    ) -> MultimodalResult:
        """Helper to create a MultimodalResult."""
        return MultimodalResult(
            face_count=face_count,
            bboxes=[[0, 0, 100, 100]] * face_count,
            mar_value=mar_value,
            is_looking_away=is_looking_away,
            has_landmarks=has_landmarks,
        )

    @patch.object(ExamFaceDetector, "process_frame_multimodal")
    @patch.object(ExamFaceDetector, "decode_base64_image")
    def test_no_speech_returns_normal(self, mock_decode, mock_process):
        """speech_detected=False → Level 0 (bình thường), bỏ qua decode."""
        result = self.controller.process_payload("s1", {
            "speech_detected": False,
            "image": "fake",
        })
        assert result["level"] == LEVEL_NORMAL
        # Không cần decode ảnh khi không có tiếng nói
        mock_decode.assert_not_called()

    @patch.object(ExamFaceDetector, "process_frame_multimodal")
    @patch.object(ExamFaceDetector, "decode_base64_image")
    def test_speech_with_moving_mouth_returns_mild(self, mock_decode, mock_process):
        """
        speech=True + miệng cử động + nhìn thẳng → Level 1 (đọc nhẩm).
        """
        mock_decode.return_value = np.zeros((480, 640, 3), dtype=np.uint8)
        mock_process.return_value = self._mock_multimodal(
            mar_value=0.2, is_looking_away=False,
        )

        sid = "s-mild"
        state = self.controller._get_or_create_session(sid)
        # Đẩy MAR dao động vào buffer để is_mouth_moving = True
        for mar in [0.05, 0.25, 0.08, 0.30, 0.06]:
            state.mar_history.append(mar)

        result = self.controller.process_payload(sid, {
            "speech_detected": True,
            "image": "data:image/jpeg;base64,/9j/fake",
        })
        assert result["level"] == LEVEL_MILD_WARNING

    @patch.object(ExamFaceDetector, "process_frame_multimodal")
    @patch.object(ExamFaceDetector, "decode_base64_image")
    def test_speech_with_moving_mouth_looking_away_returns_l1(
        self, mock_decode, mock_process
    ):
        """
        speech=True + miệng cử động + nhìn đi → Level 2 (quay sang nói).
        """
        mock_decode.return_value = np.zeros((480, 640, 3), dtype=np.uint8)
        mock_process.return_value = self._mock_multimodal(
            mar_value=0.2, is_looking_away=True,
        )

        sid = "s-l1"
        state = self.controller._get_or_create_session(sid)
        for mar in [0.05, 0.25, 0.08, 0.30, 0.06]:
            state.mar_history.append(mar)

        result = self.controller.process_payload(sid, {
            "speech_detected": True,
            "image": "data:image/jpeg;base64,/9j/fake",
        })
        assert result["level"] == LEVEL_WARNING_L1

    @patch.object(ExamFaceDetector, "process_frame_multimodal")
    @patch.object(ExamFaceDetector, "decode_base64_image")
    def test_speech_no_movement_under_debounce_waits(
        self, mock_decode, mock_process
    ):
        """
        speech=True + miệng tĩnh + thời gian < 1.5s → Level 0 (chờ debounce).
        Kịch bản: tiếng ho ngắn, chưa đủ thời gian kết luận.
        """
        mock_decode.return_value = np.zeros((480, 640, 3), dtype=np.uint8)
        mock_process.return_value = self._mock_multimodal(
            mar_value=0.05, is_looking_away=False,
        )

        sid = "s-debounce"
        state = self.controller._get_or_create_session(sid)
        # Buffer tĩnh (variance ≈ 0)
        for _ in range(5):
            state.mar_history.append(0.05)

        result = self.controller.process_payload(sid, {
            "speech_detected": True,
            "image": "data:image/jpeg;base64,/9j/fake",
        })
        # Lần đầu speech_detected → bắt đầu đếm → chưa đủ 1.5s
        assert result["level"] == LEVEL_NORMAL

    @patch.object(ExamFaceDetector, "process_frame_multimodal")
    @patch.object(ExamFaceDetector, "decode_base64_image")
    def test_speech_no_movement_over_debounce_returns_l2(
        self, mock_decode, mock_process
    ):
        """
        speech=True + miệng tĩnh + thời gian > 1.5s → Level 3 (người khác nhắc bài).
        """
        mock_decode.return_value = np.zeros((480, 640, 3), dtype=np.uint8)
        mock_process.return_value = self._mock_multimodal(
            mar_value=0.05, is_looking_away=False,
        )

        sid = "s-l2"
        state = self.controller._get_or_create_session(sid)
        # Buffer tĩnh
        for _ in range(5):
            state.mar_history.append(0.05)
        # Giả lập speech đã kéo dài > 1.5s
        state.speech_start_time = time.monotonic() - 2.0

        result = self.controller.process_payload(sid, {
            "speech_detected": True,
            "image": "data:image/jpeg;base64,/9j/fake",
        })
        assert result["level"] == LEVEL_WARNING_L2

    @patch.object(ExamFaceDetector, "process_frame_multimodal")
    @patch.object(ExamFaceDetector, "decode_base64_image")
    def test_no_face_with_speech_returns_l2(self, mock_decode, mock_process):
        """
        speech=True + không thấy mặt → Level 3 (người khác nhắc bài).
        """
        mock_decode.return_value = np.zeros((480, 640, 3), dtype=np.uint8)
        mock_process.return_value = self._mock_multimodal(face_count=0)

        result = self.controller.process_payload("s-noface", {
            "speech_detected": True,
            "image": "data:image/jpeg;base64,/9j/fake",
        })
        assert result["level"] == LEVEL_WARNING_L2

    def test_missing_image_returns_error(self):
        """Payload thiếu image → error."""
        result = self.controller.process_payload("s-err", {
            "speech_detected": True,
        })
        assert result["level"] == -1
        assert "Thiếu" in result["message"]

    @patch.object(ExamFaceDetector, "process_frame_multimodal")
    @patch.object(ExamFaceDetector, "decode_base64_image")
    def test_speech_end_resets_timer(self, mock_decode, mock_process):
        """
        speech_detected chuyển từ True → False phải reset speech_start_time.
        """
        sid = "s-reset"
        state = self.controller._get_or_create_session(sid)
        state.speech_start_time = time.monotonic() - 5.0  # Đang đếm

        result = self.controller.process_payload(sid, {
            "speech_detected": False,
        })
        assert result["level"] == LEVEL_NORMAL
        assert state.speech_start_time == 0.0
