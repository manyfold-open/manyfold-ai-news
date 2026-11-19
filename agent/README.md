# AI in 5 Narra Agent (`ai5-chat`)

Workspace files for the Manyfold agent `ai5-chat` (`agt_agq66pewgf2ovmibamfujrwdqi`).

## Files

- `AGENTS.md`: Guide behavior, trilingual script rules (`zh-Hant` / `zh-Hans` / `en`), voice mode rules, multi-agent group rules, and self-learning instructions.
- `news.py`: Read-only CLI against `https://app.manyfold.ai/ai-news/api/*` plus `updates` check against `~/.cache/ai-news/last-announced.json`.
- `memory.py`: Stdlib SQLite self-learning store (`~/.cache/ai-news/memory.sqlite3`) with DM/group privacy isolation and prompt-injection filtering.
- `test_agent.py`: Offline `unittest` suite (`python3 -m unittest agent/test_agent.py`).

## Live sandbox sync

Upload only agent files (`AGENTS.md`, `news.py`, `memory.py`) with `mf`:

```bash
mf --profile manyfold --agent-id agt_agq66pewgf2ovmibamfujrwdqi files upload agent/AGENTS.md AGENTS.md
mf --profile manyfold --agent-id agt_agq66pewgf2ovmibamfujrwdqi files upload agent/news.py news.py
mf --profile manyfold --agent-id agt_agq66pewgf2ovmibamfujrwdqi files upload agent/memory.py memory.py
```

Do not overwrite `CLAUDE.md` (which includes `@AGENTS.manyfold.md` + `@AGENTS.md`) or `.manyfold-config-delivery`.
