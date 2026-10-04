import asyncio
import json
import logging

from fastapi import WebSocket

from core.engine import FlexEngine

logger = logging.getLogger("NeighbourhoodFlex")


class Runtime:
    """Owns the engine, advances it on a timer and pushes snapshots to dashboards."""

    def __init__(self):
        self.engine = FlexEngine()
        self.connections: list[WebSocket] = []

    async def run(self):
        while True:
            if self.engine.running:
                self.engine.tick()
                await self.broadcast()
            await asyncio.sleep(self.engine.seconds_per_interval if self.engine.running else 0.25)

    def reset(self):
        running = self.engine.running
        speed = self.engine.seconds_per_interval
        self.engine = FlexEngine()
        self.engine.running = running
        self.engine.seconds_per_interval = speed

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.connections.append(websocket)
        await websocket.send_text(json.dumps({"type": "SNAPSHOT", "payload": self.engine.snapshot()}))

    def disconnect(self, websocket: WebSocket):
        if websocket in self.connections:
            self.connections.remove(websocket)

    async def broadcast(self):
        if not self.connections:
            return
        message = json.dumps({"type": "SNAPSHOT", "payload": self.engine.snapshot()})
        dead = []
        for connection in self.connections:
            try:
                await connection.send_text(message)
            except Exception:
                dead.append(connection)
        for connection in dead:
            self.disconnect(connection)


runtime = Runtime()
