import subprocess
from typing import Optional

YT_DLP_TIMEOUT = 30


def resolve(soundcloud_url: str) -> Optional[str]:
    try:
        result = subprocess.run(
            ["yt-dlp", "-g", "--no-warnings", "--no-playlist", soundcloud_url],
            capture_output=True,
            text=True,
            timeout=YT_DLP_TIMEOUT,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines():
        line = line.strip()
        if line:
            return line
    return None
