"""Coverage for the config and options flow wiring.

The config flow must return an OptionsFlow *instance* from
`async_get_options_flow` synchronously — declaring it `async def` returns a
coroutine that Home Assistant's flow manager cannot attach `hass` to,
surfacing as `AttributeError: 'coroutine' object has no attribute 'hass'`
when opening the integration's options.
"""

from visit_heatmap import config_flow as visit_mod

VisitHeatmapConfigFlow = visit_mod.VisitHeatmapConfigFlow
VisitHeatmapOptionsFlow = visit_mod.VisitHeatmapOptionsFlow


def test_async_get_options_flow_returns_instance_not_coroutine():
    flow = VisitHeatmapConfigFlow.async_get_options_flow({"options": {}})
    assert isinstance(flow, VisitHeatmapOptionsFlow)


def test_options_flow_stores_entry():
    flow = VisitHeatmapOptionsFlow({"options": {}})
    assert flow._entry == {"options": {}}
