import asyncio
import os
from typing import Awaitable, Callable, Optional

EncoderEvent = dict
OnEvent = Callable[[EncoderEvent], Awaitable[None]]


# BCM pin defaults (per pi-setup-reference.md). Override at boot via
# NTS_ENCODER_A_PIN / NTS_ENCODER_B_PIN / NTS_ENCODER_BUTTON_PIN if the
# wiring changes without needing a code edit.
DEFAULT_A_PIN = 27
DEFAULT_B_PIN = 17
DEFAULT_BUTTON_PIN = 22
DEFAULT_HOLD_TIME = 0.5  # seconds — long-press threshold


class EncoderInput:
    async def start(self, on_event: OnEvent) -> None:
        raise NotImplementedError


class WebSocketEncoder(EncoderInput):
    def __init__(self) -> None:
        self._on_event: OnEvent | None = None

    async def start(self, on_event: OnEvent) -> None:
        self._on_event = on_event

    async def feed(self, event: EncoderEvent) -> None:
        if self._on_event is not None:
            await self._on_event(event)


class GPIOEncoder(EncoderInput):
    """Rotary encoder + push switch via gpiozero.

    gpiozero fires its callbacks on a background thread, so we capture the
    asyncio loop in start() and bounce events back to it via
    run_coroutine_threadsafe — the rest of the backend assumes async."""

    def __init__(
        self,
        a_pin: int = DEFAULT_A_PIN,
        b_pin: int = DEFAULT_B_PIN,
        button_pin: int = DEFAULT_BUTTON_PIN,
        hold_time: float = DEFAULT_HOLD_TIME,
    ) -> None:
        self._a_pin = a_pin
        self._b_pin = b_pin
        self._button_pin = button_pin
        self._hold_time = hold_time
        self._on_event: OnEvent | None = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._encoder = None
        self._button = None
        # Set true when when_held fires; suppresses the click on release.
        self._was_held = False

    async def start(self, on_event: OnEvent) -> None:
        from gpiozero import Button, RotaryEncoder

        self._on_event = on_event
        self._loop = asyncio.get_running_loop()
        # max_steps=0 → unbounded step counter; we only care about deltas.
        self._encoder = RotaryEncoder(a=self._a_pin, b=self._b_pin, max_steps=0)
        self._button = Button(self._button_pin, hold_time=self._hold_time)
        self._encoder.when_rotated_clockwise = self._on_cw
        self._encoder.when_rotated_counter_clockwise = self._on_ccw
        self._button.when_held = self._on_held
        self._button.when_released = self._on_released

    def _on_cw(self) -> None:
        self._dispatch({"event": "rotate", "direction": "cw", "velocity": 1})

    def _on_ccw(self) -> None:
        self._dispatch({"event": "rotate", "direction": "ccw", "velocity": 1})

    def _on_held(self) -> None:
        self._was_held = True
        self._dispatch({"event": "long_press"})

    def _on_released(self) -> None:
        if not self._was_held:
            self._dispatch({"event": "click"})
        self._was_held = False

    def _dispatch(self, event: EncoderEvent) -> None:
        if self._on_event is None or self._loop is None:
            return
        asyncio.run_coroutine_threadsafe(self._on_event(event), self._loop)


def _pin_from_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def make_encoder() -> EncoderInput:
    """Return a real GPIOEncoder when gpiozero is importable (i.e. on the
    Pi), else fall back to keyboard-driven WebSocketEncoder for dev."""
    try:
        import gpiozero  # noqa: F401
    except (ImportError, OSError):
        return WebSocketEncoder()
    return GPIOEncoder(
        a_pin=_pin_from_env("NTS_ENCODER_A_PIN", DEFAULT_A_PIN),
        b_pin=_pin_from_env("NTS_ENCODER_B_PIN", DEFAULT_B_PIN),
        button_pin=_pin_from_env("NTS_ENCODER_BUTTON_PIN", DEFAULT_BUTTON_PIN),
    )
