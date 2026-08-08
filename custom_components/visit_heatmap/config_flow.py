"""Config and options flow for the visit heatmap integration."""

from __future__ import annotations

import homeassistant.helpers.config_validation as cv
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import HomeAssistant

from .const import (
    CONF_BACKFILL_DAYS,
    CONF_DEDUPE_RADIUS,
    CONF_MOVE_SPEED_THRESHOLD,
    CONF_RETENTION_DAYS,
    DEFAULT_BACKFILL_DAYS,
    DEFAULT_DEDUPE_RADIUS,
    DEFAULT_MOVE_SPEED_THRESHOLD,
    DEFAULT_RETENTION_DAYS,
    DOMAIN,
    DOMAIN_NAME,
)


class VisitHeatmapConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Minimal flow: installing just enables recording."""

    VERSION = 1

    @staticmethod
    def async_get_options_flow(config_entry):
        return VisitHeatmapOptionsFlow(config_entry)

    async def async_step_user(self, user_input=None):
        if self._async_current_entries():
            return self.async_abort(reason="already_configured")
        return self.async_create_entry(title=DOMAIN_NAME, data={})


class VisitHeatmapOptionsFlow(config_entries.OptionsFlow):
    """Options for ingestion/storage tuning."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self._entry = config_entry

    async def async_step_init(self, user_input=None):
        options = {**self._entry.options, **(user_input or {})}
        if user_input is not None:
            return self.async_create_entry(title="", data=options)
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_DEDUPE_RADIUS,
                        default=options.get(CONF_DEDUPE_RADIUS, DEFAULT_DEDUPE_RADIUS),
                    ): cv.positive_int,
                    vol.Required(
                        CONF_MOVE_SPEED_THRESHOLD,
                        default=options.get(
                            CONF_MOVE_SPEED_THRESHOLD, DEFAULT_MOVE_SPEED_THRESHOLD
                        ),
                    ): cv.positive_float,
                    vol.Required(
                        CONF_RETENTION_DAYS,
                        default=options.get(
                            CONF_RETENTION_DAYS, DEFAULT_RETENTION_DAYS
                        ),
                    ): cv.positive_int,
                    vol.Required(
                        CONF_BACKFILL_DAYS,
                        default=options.get(CONF_BACKFILL_DAYS, DEFAULT_BACKFILL_DAYS),
                    ): cv.positive_int,
                }
            ),
        )


async def async_setup_entry(hass: HomeAssistant, entry: config_entries.ConfigEntry):
    return True
