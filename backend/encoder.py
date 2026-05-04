from typing import Awaitable, Callable

EncoderEvent = dict
OnEvent = Callable[[EncoderEvent], Awaitable[None]]


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


def make_encoder() -> EncoderInput:
    try:
        import gpiozero  # noqa: F401
    except (ImportError, OSError):
        return WebSocketEncoder()
    return WebSocketEncoder()
