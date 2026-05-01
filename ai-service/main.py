"""
ai-service/main.py
───────────────────
FastAPI entry point for the AI analysis service.
Mounts face and audio routers.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import audio, face, monitor
from core.config import get_settings
from core.logger import get_logger, setup_logging

settings = get_settings()
setup_logging(settings.log_level)
log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("SecureExam AI Service starting", port=8001)
    # Pre-warm models in background (optional – avoids cold-start latency)
    # Could trigger get_analyzer()._load_model() here in a thread
    yield
    log.info("SecureExam AI Service stopped")


app = FastAPI(
    title="SecureExam AI Service",
    description="Real-time face and audio analysis for exam proctoring",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(face.router)
app.include_router(audio.router)
app.include_router(monitor.router)


@app.get("/health", tags=["health"])
async def health():
    return {"status": "ok", "service": "ai-service"}
