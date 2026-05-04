import asyncio
import json
import os
import subprocess
from typing import Any, Awaitable, Callable, Optional

SOCKET_PATH = "/tmp/nts-pi-player-mpv.sock"

# Stable IDs for observed properties — id is echoed back in property-change events.
PROP_IDS = {
    "time-pos": 1,
    "duration": 2,
    "pause": 3,
}

EventCallback = Callable[[dict], Awaitable[None]]


class Player:
    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._reader_task: Optional[asyncio.Task] = None
        self._next_request_id = 100  # property-change ids reserved < 100
        self._pending: dict[int, asyncio.Future] = {}
        self._on_event: Optional[EventCallback] = None

    async def start(self, on_event: EventCallback) -> None:
        self._on_event = on_event
        try:
            os.unlink(SOCKET_PATH)
        except FileNotFoundError:
            pass
        self._proc = subprocess.Popen(
            [
                "mpv",
                "--idle",
                "--no-video",
                "--really-quiet",
                f"--input-ipc-server={SOCKET_PATH}",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # Wait for socket to be ready (mpv creates it asynchronously)
        for _ in range(50):
            if os.path.exists(SOCKET_PATH):
                break
            await asyncio.sleep(0.1)
        else:
            raise RuntimeError("mpv IPC socket did not appear")

        self._reader, self._writer = await asyncio.open_unix_connection(SOCKET_PATH)
        self._reader_task = asyncio.create_task(self._read_loop())

        for name, pid in PROP_IDS.items():
            await self._send("observe_property", pid, name)

    async def shutdown(self) -> None:
        if self._writer is not None:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except Exception:
                pass
        if self._reader_task is not None:
            self._reader_task.cancel()
        if self._proc is not None and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        try:
            os.unlink(SOCKET_PATH)
        except FileNotFoundError:
            pass

    async def play(self, url: str) -> None:
        await self._send("loadfile", url)

    async def pause(self) -> None:
        await self._send("set_property", "pause", True)

    async def resume(self) -> None:
        await self._send("set_property", "pause", False)

    async def stop(self) -> None:
        await self._send("stop")

    async def set_volume(self, value: int) -> None:
        await self._send("set_property", "volume", int(value))

    async def _send(self, *command: Any) -> dict:
        if self._writer is None:
            return {"error": "not_started"}
        rid = self._next_request_id
        self._next_request_id += 1
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        payload = json.dumps({"command": list(command), "request_id": rid}) + "\n"
        try:
            self._writer.write(payload.encode())
            await self._writer.drain()
        except Exception as exc:
            self._pending.pop(rid, None)
            return {"error": f"write_failed: {exc}"}
        try:
            return await asyncio.wait_for(fut, timeout=5)
        except asyncio.TimeoutError:
            self._pending.pop(rid, None)
            return {"error": "timeout"}

    async def _read_loop(self) -> None:
        assert self._reader is not None
        while True:
            try:
                line = await self._reader.readline()
            except Exception:
                return
            if not line:
                return
            try:
                msg = json.loads(line.decode())
            except json.JSONDecodeError:
                continue
            if "request_id" in msg:
                fut = self._pending.pop(msg["request_id"], None)
                if fut is not None and not fut.done():
                    fut.set_result(msg)
            elif "event" in msg and self._on_event is not None:
                try:
                    await self._on_event(msg)
                except Exception:
                    pass
