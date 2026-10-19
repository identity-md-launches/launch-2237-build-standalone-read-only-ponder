# Dependency packaging

The generated pnpm content-addressed store was removed because it exceeded the 8 MiB source-upload limit. No application dependencies were removed from package.json or pnpm-lock.yaml. Ordinary installation now requires registry access; fresh offline installation is not supported by this deliverable. See README.md for the explicit limitation and current check evidence.
