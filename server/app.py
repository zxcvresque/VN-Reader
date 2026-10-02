"""Telegram archive/media ASGI service. Better Auth runs in accountService.mjs."""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from starlette.responses import JSONResponse
from . import telegram

@asynccontextmanager
async def lifespan(app):
    await telegram.start_telegram()
    try:
        yield
    finally:
        await telegram.stop_telegram()

app = FastAPI(title="VN Reader archive", lifespan=lifespan, docs_url=None, redoc_url=None)
app.include_router(telegram.router)

@app.get("/api/archive-health")
async def health():
    status = telegram.archive_status()
    return JSONResponse(status, status_code=200 if status["status"] == "ok" else 503)
