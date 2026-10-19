Autonomous route tracking and persistent coverage visualization for the Liectroux ZK901.

- Collects incremental LAN route points every 20 seconds during activity, independently of dashboard visibility.
- Preserves route history and acquisition cursors across Home Assistant restarts, with bounded storage and explicit gaps after interruptions.
- Adds activity selection and separate visual layers for routes and estimated coverage, including cleaning, return and unclassified segments.
- Retains accumulated coverage independently of individual route history, with separate map contexts.
- Adds capture status, update timestamps and reconstruction reset with confirmation, preserving the acquisition cursor during active cleaning.
