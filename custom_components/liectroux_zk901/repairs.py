"""Restart confirmation for Home Assistant versions without a native prompt."""

from homeassistant.components.repairs import ConfirmRepairFlow
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir

from .const import DOMAIN
from .update import async_get_update_manager


class RestartRequiredFlow(ConfirmRepairFlow):
    """Restart only after the user submits the confirmation form."""

    async def async_step_confirm(self, user_input=None):
        manager = await async_get_update_manager(self.hass)
        if not manager.restart_pending:
            ir.async_delete_issue(self.hass, DOMAIN, "restart_required")
            return self.async_abort(reason="restart_not_required")
        if user_input is not None:
            await self.hass.services.async_call("homeassistant", "restart", blocking=True)
            return self.async_create_entry(data={})
        return await super().async_step_confirm(user_input)


async def async_create_fix_flow(hass: HomeAssistant, issue_id: str, data):
    """Create the fix flow for the restart request."""
    if issue_id == "restart_required":
        return RestartRequiredFlow()
    return ConfirmRepairFlow()
