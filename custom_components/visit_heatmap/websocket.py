"""WebSocket API for reading visit rows and debug state."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.util.dt import parse_datetime

from .const import DOMAIN, WS_DEBUG, WS_POINTS


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


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_DEBUG,
        vol.Optional("entities", default=[]): [str],
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def handle_debug(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return diagnostics to answer 'why is nothing showing?'.

    Reports whether the runtime is registered, what its options are, how many
    rows it holds (and per requested entity), plus the frontend registration
    state so a missing card can be distinguished from an empty store.
    """
    runtime = hass.data.get(DOMAIN)
    if runtime is None:
        connection.send_result(
            msg["id"],
            {
                "registered": False,
                "note": "The integration is not loaded. Reload it from Settings -> Devices & Services.",
            },
        )
        return

    entities = msg.get("entities") or []
    rows = runtime.store.query()
    per_entity = {}
    for row in rows:
        if not entities or row["device"] in entities:
            per_entity[row["device"]] = per_entity.get(row["device"], 0) + 1

    connection.send_result(
        msg["id"],
        {
            "registered": True,
            "row_count": len(rows),
            "per_entity": per_entity,
            "entities_requested": entities,
            "options": {
                "dedupe_radius": runtime.dedupe_radius,
                "move_speed_threshold": runtime.speed_threshold,
                "retention_days": runtime.retention_days,
                "backfill_days": runtime.backfill_days,
            },
            "frontend": _frontend_status(hass),
        },
    )


def _frontend_status(hass: HomeAssistant) -> dict[str, Any]:
    """Describe how the card bundle is (or isn't) wired into the frontend."""
    from .const import CARD_URL

    status: dict[str, Any] = {"card_url": CARD_URL}
    lovelace = hass.data.get("lovelace")
    resources = getattr(lovelace, "resources", None)
    if resources is None or not hasattr(resources, "async_items"):
        status["lovelace_resources"] = None
        return status
    try:
        status["lovelace_resources"] = [
            {"id": item["id"], "url": item.get("url")}
            for item in resources.async_items()
            if str(item.get("url", "")).split("?")[0] == CARD_URL
        ]
    except Exception:
        status["lovelace_resources"] = None
    return status


async def async_register_websocket(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, handle_points)
    websocket_api.async_register_command(hass, handle_debug)
