"""
ai-service/api/routes/monitor.py
─────────────────────────────────
WebSocket endpoint cho giám sát multimodal thời gian thực.

Mỗi thí sinh kết nối qua WebSocket với session_id riêng biệt.
State (MAR buffer, speech timer) được cô lập hoàn toàn giữa các session
nhờ ExamCheatController.active_sessions dictionary.

Protocol:
  Client → Server (JSON):
    {
      "speech_detected": true/false,
      "image": "data:image/jpeg;base64,...",
      "timestamp": 1234567890
    }

  Server → Client (JSON):
    {
      "status": "NORMAL" | "MILD_WARNING" | "WARNING_LEVEL_1" | "WARNING_LEVEL_2_URGENT",
      "message": "Mô tả tiếng Việt",
      "level": 0-3,
      "details": { ... }
    }
"""

from __future__ import annotations

import json
import threading

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from core.config import get_settings
from core.logger import get_logger
from modules.face.exam_cheat_controller import ExamCheatController

log = get_logger(__name__)
router = APIRouter(tags=["monitor"])

# ──────────────────────────────────────────────────────────────────────────────
# Singleton controller – chia sẻ giữa tất cả WebSocket connections.
# State cho từng thí sinh được cô lập bên trong controller.active_sessions.
# ──────────────────────────────────────────────────────────────────────────────
_controller: ExamCheatController | None = None
_controller_lock = threading.Lock()


def _get_controller() -> ExamCheatController:
    """Lazy-init singleton ExamCheatController."""
    global _controller
    if _controller is None:
        with _controller_lock:
            if _controller is None:
                settings = get_settings()
                _controller = ExamCheatController(
                    model_root=settings.model_cache_dir,
                    ctx_id=-1,  # CPU; đặt 0 nếu có GPU
                )
                log.info(
                    "ExamCheatController initialized",
                    model_root=settings.model_cache_dir,
                )
    return _controller


# ──────────────────────────────────────────────────────────────────────────────
# WebSocket endpoint
# ──────────────────────────────────────────────────────────────────────────────
@router.websocket("/ws/monitor/{session_id}")
async def websocket_monitor(websocket: WebSocket, session_id: str):
    """
    WebSocket endpoint cho giám sát multimodal.

    URL: ws://localhost:8001/ws/monitor/{session_id}

    session_id được trích từ URL path để đảm bảo mỗi thí sinh
    có state riêng biệt (MAR buffer, speech timer).
    """
    await websocket.accept()
    controller = _get_controller()

    log.info("WebSocket connected", session_id=session_id)

    try:
        while True:
            # Nhận JSON payload từ client
            raw = await websocket.receive_text()

            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({
                    "status": "ERROR",
                    "message": "Invalid JSON",
                    "level": -1,
                })
                continue

            # Xử lý cross-check thông qua controller
            # Controller tự quản lý state theo session_id
            verdict = controller.process_payload(session_id, payload)

            # Gửi verdict về client
            await websocket.send_json(verdict)

    except WebSocketDisconnect:
        log.info("WebSocket disconnected", session_id=session_id)
    except Exception as e:
        log.error("WebSocket error", session_id=session_id, error=str(e))
    finally:
        # Giải phóng session state khi thí sinh ngắt kết nối
        controller.clear_session(session_id)
        log.info("Session state cleared", session_id=session_id)
