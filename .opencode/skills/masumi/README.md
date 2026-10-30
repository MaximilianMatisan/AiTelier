# Masumi skill (vendored, workspace-local)

Official Masumi ecosystem skill from
<https://github.com/masumi-network/masumi-skills>.

- **Pinned commit:** `3eabe4a243dfd3ee326a105736215eeb0d83c787`
- **Pinned on:** 2026-10-29
- **License:** MIT (see `LICENSE`)
- **Skill ID:** `masumi`

This copy is installed under `.opencode/skills/masumi/` so OpenCode discovers it
without a global install. It includes the entry point (`SKILL.md`), all reference
guides under `references/`, and the safe `.env.example` template.

OpenCode loads only `SKILL.md` when the skill is invoked. The assistant then
reads the relevant file from `references/` for the task at hand:

| Task | Reference |
|---|---|
| Payment integration | `references/masumi-payments.md` |
| Agent registration / identity | `references/registry-identity.md` |
| MIP-003 API compliance | `references/agentic-services.md` |
| Sokosumi marketplace listing | `references/sokosumi-marketplace.md` |
| Sokosumi API endpoints | `references/sokosumi-api-reference.md` |
| Masumi Registry API | `references/masumi-registry-api.md` |
| Smart contracts | `references/smart-contracts.md` |
| Cardano basics | `references/cardano-blockchain.md` |
| Kodosumi runtime | `references/kodosumi-runtime.md` |
| Safe API debugging | `references/api-debug-recipes.md` |

## Updating

Re-copy `skill/SKILL.md`, `skill/references/`, `.env.example`, and `LICENSE` from
a newer upstream commit, then update the pinned commit above. Do not edit the
vendored reference files in place unless the change is intentional; keeping the
upstream commit makes updates auditable.

## Secrets

The skill reads API keys only from a local `.env` file. Do not put real keys in
`.env.example`, chat, logs, or Git. The workspace root `.env` is git-ignored.
