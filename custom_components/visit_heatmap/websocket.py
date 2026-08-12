"""WebSocket API for reading visit rows."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.util.dt import parse_datetime

from .const import DOMAIN, WS_POINTS


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_POINTS,
        vol.Optional("entities", default=[]): [str],
        vol.Optional("since"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_points(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return visit rows for the requested entities, optionally since a time.

    The frontend sends ``since`` (ISO timestamp) so only the rows it will
    actually display (its decay horizon) cross the wire; without it every
    stored row up to the retention window would be serialized and sent.
    """
    runtime = hass.data.get(DOMAIN)
    rows: list[dict[str, Any]] = []
    if runtime:
        since = parse_datetime(msg.get("since")) if msg.get("since") else None
        rows = runtime.store.query(msg.get("entities"), since)
    connection.send_result(msg["id"], {"rows": rows})


async def async_register_websocket(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, handle_points)
