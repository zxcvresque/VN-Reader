"""Telegram archive/media ASGI service. Better Auth runs in accountService.mjs."""
from contextlib import asynccontextmanager
from fastapi import FastAPI
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
def health():
    return {"status": "ok", "archiveEnabled": telegram.archive_enabled()}
