Improves the Home Assistant update and restart workflow.

- Reports the newly installed version immediately and disables further installations while a restart is pending.
- Requests Home Assistant's native restart prompt when supported, with a confirmation flow in Repairs on earlier versions.
- Applies the same restart handling to restoring a previous release and clears obsolete restart notices.
- Keeps installation separate from restart: Home Assistant restarts only after user confirmation.
