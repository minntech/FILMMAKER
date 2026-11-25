---
"openfilm": minor
---

`openfilm guard <folder>` keeps the originals of every project in a folder with no Studio page open, for a machine an agent works on alone. With `--own`, run as a user of its own (deploy/linux sets it up with systemd), it owns each original, so the agent's user cannot change, delete, rename or unlock one, whatever it runs.
