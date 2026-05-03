---
description: Replace default project names in the frontend with the root directory name.
---

This workflow automates the process of fetching the desired project name from the root directory and updating default template names in the frontend codebase.

1. First, identify the current project name by determining the name of the root directory (e.g., if the root path is `/path/to/blueprint-2.0`, the project name is `blueprint-2.0`). Feel free to format this nicely (e.g., "Blueprint 2.0" for display names, and "blueprint-2.0" for package names).
2. Scan the `frontend` directory for default app names to replace. Specifically look for:
   - `"TanStack App"`
   - `"Create TanStack App Sample"`
   - `"TanStack Start Starter"`
3. Replace these values with the newly formatted project name. The files you will most likely need to modify include:
   - `frontend/public/manifest.json` (replacing `"TanStack App"` and `"Create TanStack App Sample"`)
   - `frontend/src/routes/__root.tsx` (replacing `"TanStack Start Starter"`)
   - Any other places where the default names might still linger.
