"""WebSocket API for reading visit rows."""

from __future__ import annotations

from typing import Any

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN, WS_POINTS


@websocket_api.websocket_command(
    {
        websocket_api.const.TYPE: WS_POINTS,
        websocket_api.const.ATTR_ID: websocket_api.const.ID_REGEX,
        websocket_api.vol.Optional("entities", default=[]): [str],
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_points(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return non-expired visit rows for the requested entities."""
    runtime = hass.data.get(DOMAIN)
    rows = runtime.store.query(msg.get("entities")) if runtime else []
    connection.send_result(msg["id"], {"rows": rows})


async def async_register_websocket(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, handle_points)
