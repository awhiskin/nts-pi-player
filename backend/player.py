import subprocess
from typing import Optional


class Player:
    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None

    def play(self, url: str) -> None:
        self.stop()
        self._proc = subprocess.Popen(
            ["mpv", "--no-video", "--really-quiet", url],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def stop(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        self._proc = None
