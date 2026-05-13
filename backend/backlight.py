import asyncio
import os
from pathlib import Path
from typing import Awaitable, Callable, Optional

OnIdle = Callable[[], Awaitable[None]]

# Raspberry Pi Touch Display 2 exposes 0..31 brightness via sysfs. The path
# and max are hardware-specific to this build; auto-detection isn't worth it.
BACKLIGHT_PATH = Path("/sys/class/backlight/10-0045/brightness")
MAX_BRIGHTNESS = 31
MIN_BRIGHTNESS = MAX_BRIGHTNESS // 4  # intermediate dim level
IDLE_DIM_TIMEOUT = 60.0   # seconds → fade to MIN_BRIGHTNESS
IDLE_OFF_TIMEOUT = 120.0   # seconds → fade to 0
FADE_IN_DURATION = 0.2
FADE_DIM_DURATION = 0.2
FADE_OFF_DURATION = 0.2
FADE_BOOT_DURATION = 1.0  # one-shot fade up when the kiosk first signals ready


class BacklightDimmer:
    """Dim the Touch Display 2 backlight after a period of no encoder
    activity. Any encoder source (physical GPIO, browser keyboard, LAN
    client) counts as activity. No-ops when the sysfs entry isn't writable
    (macOS dev, Pi without the display attached)."""

    def __init__(self, on_idle: Optional[OnIdle] = None) -> None:
        self._enabled = BACKLIGHT_PATH.exists() and os.access(BACKLIGHT_PATH, os.W_OK)
        self._brightness = MAX_BRIGHTNESS
        self._fade_task: Optional[asyncio.Task] = None
        self._idle_task: Optional[asyncio.Task] = None
        # Fired when a fade-out completes (brightness reaches 0) — the UI
        # uses this to also retreat to Now Playing at the same moment.
        self._on_idle = on_idle
        # Gates that suppress the idle countdown. _kiosk_ready flips True
        # the first time the frontend signals it's rendered; _loading is
        # mirrored from now_playing state to avoid dimming while the user
        # is waiting on an episode to resolve/buffer.
        self._kiosk_ready = False
        self._loading = False

    async def start(self) -> None:
        if not self._enabled:
            return
        # Stay dark until the kiosk signals it has rendered. Avoids the
        # white-Chromium-loading flash that's visible at full brightness
        # while X/Chromium are coming up.
        self._write(0)

    def on_kiosk_ready(self) -> None:
        """Called when the frontend sends `{"type": "ready"}` on its WS
        open. Fires once per fresh kiosk session: at boot (backlight dark
        from udev) and at every `restart-kiosk` (backlight dark from the
        openbox autostart). Already-bright path is a no-op fade so an
        extra LAN client connecting mid-session doesn't flicker."""
        if not self._enabled:
            return
        self._kiosk_ready = True
        # The openbox autostart writes 0 to sysfs on every kiosk restart
        # — re-read so the fade interpolates from the real current value
        # rather than what the dimmer last set.
        try:
            self._brightness = int(BACKLIGHT_PATH.read_text().strip())
        except (OSError, ValueError):
            pass
        self._cancel_fade()
        if self._brightness != MAX_BRIGHTNESS:
            self._fade_task = asyncio.create_task(
                self._fade_to(MAX_BRIGHTNESS, FADE_BOOT_DURATION)
            )
        self._schedule_idle()

    def set_loading(self, loading: bool) -> None:
        """Mirror now_playing's loading state. While loading, the idle
        timer is suspended and the screen stays lit — the user is actively
        waiting on the system."""
        if not self._enabled or loading == self._loading:
            return
        self._loading = loading
        if loading:
            self._cancel_fade()
            if self._idle_task and not self._idle_task.done():
                self._idle_task.cancel()
            self._fade_task = asyncio.create_task(
                self._fade_to(MAX_BRIGHTNESS, FADE_IN_DURATION)
            )
        elif self._kiosk_ready:
            self._schedule_idle()

    async def shutdown(self) -> None:
        if not self._enabled:
            return
        self._cancel_fade()
        if self._idle_task and not self._idle_task.done():
            self._idle_task.cancel()
        # Restore full brightness so a restarted service never leaves the
        # screen black.
        self._write(MAX_BRIGHTNESS)

    def on_activity(self) -> None:
        if not self._enabled:
            return
        self._cancel_fade()
        self._fade_task = asyncio.create_task(
            self._fade_to(MAX_BRIGHTNESS, FADE_IN_DURATION)
        )
        if self._kiosk_ready and not self._loading:
            self._schedule_idle()

    def _schedule_idle(self) -> None:
        if self._idle_task and not self._idle_task.done():
            self._idle_task.cancel()
        self._idle_task = asyncio.create_task(self._idle_then_fade_out())

    async def _idle_then_fade_out(self) -> None:
        try:
            await asyncio.sleep(IDLE_DIM_TIMEOUT)
            self._cancel_fade()
            self._fade_task = asyncio.create_task(
                self._fade_to(MIN_BRIGHTNESS, FADE_DIM_DURATION)
            )
            # The fade-to-MIN animates concurrently with this sleep; the gap
            # is measured from the original last-activity moment, not from
            # the end of the first fade.
            await asyncio.sleep(IDLE_OFF_TIMEOUT - IDLE_DIM_TIMEOUT)
        except asyncio.CancelledError:
            return
        self._cancel_fade()
        self._fade_task = asyncio.create_task(self._fade_to(0, FADE_OFF_DURATION))

    def _cancel_fade(self) -> None:
        if self._fade_task and not self._fade_task.done():
            self._fade_task.cancel()

    async def _fade_to(self, target: int, duration: float) -> None:
        try:
            start = self._brightness
            delta = target - start
            if delta != 0 and duration > 0:
                steps = abs(delta)
                step_interval = duration / steps
                sign = 1 if delta > 0 else -1
                for i in range(1, steps + 1):
                    self._write(start + sign * i)
                    if i < steps:
                        await asyncio.sleep(step_interval)
            else:
                self._write(target)
        except asyncio.CancelledError:
            return
        # Fire on completion of the first dim stage (fade-to-MIN). The UI
        # uses this to retreat to Now Playing while the screen is still
        # partially visible, so the snap is over by the time fade-to-0
        # finishes. Cancelled fades (user moved the encoder mid-dim) do
        # not fire — they bail out of the try block above.
        if target == MIN_BRIGHTNESS and self._on_idle is not None:
            try:
                await self._on_idle()
            except Exception:
                pass

    def _write(self, value: int) -> None:
        value = max(0, min(MAX_BRIGHTNESS, int(value)))
        self._brightness = value
        try:
            BACKLIGHT_PATH.write_text(str(value))
        except OSError:
            pass
