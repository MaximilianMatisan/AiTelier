# TUM Blockchain & AI Hackathon — setup and runbook

This is the working runbook for this workspace. It condenses the official TUM
guide and keeps the commands in one place.

Official sources:

- Setup guide: <https://www.masumi.network/tum-hackathon>
- Full agent brief: <https://www.masumi.network/tum-hackathon/agent>
- Submission checklist: <https://www.masumi.network/tum-hackathon/submission>
- Event page: <https://hackathon.tum-blockchain.com/>
- Devfolio: <https://tum.devfolio.co/>
- Prizes: <https://hackathon.tum-blockchain.com/prizes>
- Upstream quickstart README snapshot: `docs/tum-quickstart-readme.md`

The event runs **30–31 October 2026** in Munich. Use the official event page for
the current schedule and rules.

## 0. Choose a useful job first

Before touching tools, fill in this sentence:

> For **[team]**, turn **[input]** into **[useful result]**, so they can
> **[make a decision or take action]**.

Good first jobs are small, checkable, and use public data, sample data, or data
you have permission to use. Avoid a demo that depends on private data or a
long-running external system.

The template starts as a team-name assistant. Adapt
`hackathon-agent/agent/instructions.md` to your job. Keep a small test input that
another participant can inspect.

## 1. Prerequisites

- Node.js **24** and Git.
- Podman (for the local MCP).
- Your own **Sokosumi Preprod** account: <https://preprod.sokosumi.com/signup>.
- An API connection to the model you want your agent to use.
- Personal Workspace test credits before creating a Task.
- A system credential vault supported by the Sokosumi CLI.

The host currently has Node 20. Use Node 24 for the agent. If you do not want to
install it globally, use a Node 24 container or a version manager, and run the
agent commands inside that environment.

Sokosumi CLI version for this guide: **1.0.4**. The template imports modules from
that version. Do not upgrade it without checking the template.

Optional: Socket Firewall (`sfw`) for package installs. If you use it, prefix
install commands with `sfw`.

## 2. Prepare this workspace

From the workspace root:

```powershell
Copy-Item .env.example .env
```

Set `SOKOSUMI_API_KEY` to a **Preprod** key from
<https://preprod.sokosumi.com/connections> → **API Keys**. Keep
`SOKOSUMI_NETWORK=preprod`.

Build and smoke-test the local MCP:

```powershell
powershell ./scripts/build-sokosumi-mcp.ps1
python ./scripts/mcp_smoke_test.py
```

Open OpenCode and check `/mcps`, or run:

```powershell
opencode mcp list
```

The local server is named `sokosumi`. The hosted mainnet server is
`sokosumi-mainnet` and is disabled by default.

## 3. Sign in and check your account

Install the pinned CLI and sign in to Preprod:

```sh
npm install --global @masumi_network/sokosumi@1.0.4
sokosumi --version
sokosumi --preprod auth login
sokosumi --preprod auth whoami --json
sokosumi skills
```

Check that you signed in to the right account before continuing. Keep OAuth
tokens and API keys out of chat, logs, and screenshots.

Check existing organization membership, Vendors, and Coworkers:

```sh
sokosumi --preprod workspaces list --json
sokosumi --preprod vendors me --json
sokosumi --preprod coworkers list --scope owned --json
```

You must belong to an organization to create a Vendor. Each account can create
one self-service Vendor.

Join the TUM Workspace with the invitation:
<https://preprod.sokosumi.com/join/GTAHB3OQFWgg8rGetMfleiqgeL6_ltdW>

Check membership again. Continue the agent test in your **Personal Workspace**.

Reuse an existing Vendor if you have its `admin` role. Do not create a duplicate.

## 4. Create or reuse a private Coworker

If you do not administer a Vendor, create one with your chosen name and an unused
slug:

```sh
sokosumi --preprod vendors create --name "YOUR_VENDOR_NAME" --slug YOUR_VENDOR_SLUG --json
```

Save the returned **Vendor ID**. Replace `VENDOR_ID` below with that ID, then
choose a Coworker name:

```sh
sokosumi --preprod coworkers register --vendor-id VENDOR_ID --name "YOUR_COWORKER_NAME" --capability tasks --personal --json
```

Save the returned **Coworker ID**. On resume, connect the existing Coworker
instead of creating another:

```sh
sokosumi --preprod coworkers connect COWORKER_ID --vendor-id VENDOR_ID --personal --json
```

Check your Personal Workspace:

```sh
sokosumi --preprod workspaces list --personal --json
```

Select **Personal Workspace** in the website's Workspace switcher. Check that the
Coworker's personal access is `GRANTED`.

### Import the worker credential once

Replace `COWORKER_ID` in both places and run this in your terminal:

```sh
sokosumi --preprod coworkers api-key COWORKER_ID --json | sokosumi --preprod runtime key-import --coworker-id COWORKER_ID --api-key-stdin
```

This imports the worker credential into the CLI vault. The template runtime
adapter reads it when the worker starts.

- Do **not** paste the runtime key into `.env`.
- Do **not** replace your account login with it.
- On resume, reuse the imported credential.
- Do not rerun this key creation command after a successful import.
- If the import fails, fix the vault setup before creating another key or
  starting the worker.

Save your Vendor and Coworker IDs. Check personal access and the key import
before continuing.

## 5. Bootstrap the agent template

From the workspace root:

```powershell
powershell ./scripts/bootstrap-tum-agent.ps1
```

This clones <https://github.com/masumi-network/tum-hackathon-quickstart> into
`hackathon-agent/` and creates its `.env` from the template example if needed.

Then:

```powershell
Set-Location hackathon-agent
npm ci
Copy-Item .env.example .env
```

On macOS/Linux, use `cd hackathon-agent`, `npm ci`, `cp .env.example .env`, and
`chmod 600 .env`.

On resume, keep your existing `hackathon-agent/.env`. Do not overwrite it with
the example.

For extra protection, consider Socket Firewall (`sfw`) for package installs. If
installed, prefix the install with `sfw`, for example `sfw npm ci`.

### Configure the model and Coworker

Edit `hackathon-agent/.env` and set:

- `ZAI_API_KEY`, `ZAI_BASE_URL`, `ZAI_MODEL` — your authorized model connection.
- `ZAI_CONTEXT_WINDOW_TOKENS` (optional) — the provider's documented context
  limit if the model is missing from the catalog.
- `COWORKER_ID` — the Coworker ID from step 4.
- `EVE_PORT`, `EVE_URL` — matching local port and URL from the template.
- `PAID_TASKS_ENABLED=false` — keep payments off for the first Task.

Choose a model provider:

- Z.ai: <https://z.ai/> — low-cost GLM models; check
  <https://docs.z.ai/guides/overview/pricing>.
- Vercel AI Gateway: <https://vercel.com/docs/ai-gateway> — one API with provider
  and model fallbacks; compare <https://vercel.com/ai-gateway/models>.

Edit `hackathon-agent/agent/instructions.md` for your agent's job. Keep secret
values in private configuration.

### Start the agent and worker

In the `hackathon-agent/` directory, start the agent:

```sh
npm start
```

After the agent starts, open a **second terminal** in the same directory and
start one worker:

```sh
npm run worker
```

The agent and worker run as separate processes. The worker connects to the local
agent URL from `.env`.

- Keep both processes running.
- Keep your computer awake.
- Do not start a second worker for the same Coworker.
- Wait for `Continuous worker running` in the worker terminal before creating a
  Task.

## 6. Run your first Task

Select **Personal Workspace** and check its Preprod credit balance:
<https://preprod.sokosumi.com/billing?tab=credits>

Use your account login to create the Task. For the unmodified team-name
assistant:

```sh
sokosumi --preprod tasks create --personal --coworker-id COWORKER_ID --name "TUM team names" --description "Suggest five team names for a climate data agent. Use a short technical style." --status READY --json
```

For an adapted agent, replace the description with its small test input.

Save the returned **Task ID**. Open the Task in Sokosumi and check the result.

If a Task fails, inspect the worker terminal and the saved `.local/` journal
before retrying.

Check that the Task is `COMPLETED` and has a saved result. Read the answer to
check that it does the job. Then send a follow-up comment and check the agent's
reply.

### If a Task needs Vendor approval

If the worker reports `grant_required`:

1. Stop the worker. Approve the Vendor grant as the Personal Workspace owner.
2. Confirm the start request failed before execution. Check that the Task remains
   `READY`.
3. Inspect `hackathon-agent/.local/TASK_ID.json`. If it contains only
   `{"phase":"starting"}`, move it to an unused backup name.
4. Keep the backup and restart the worker. Check that the same Task completes.

The worker saves a `starting` journal before it sends the start request. It does
not automatically retry that journal. If you cannot confirm whether execution or
payment started, keep the active journal. Check Task events before retrying.

## 7. Run a Task in the TUM Workspace

After your Personal Workspace test works, join the TUM Workspace:
<https://preprod.sokosumi.com/join/GTAHB3OQFWgg8rGetMfleiqgeL6_ltdW>

List your Workspaces and copy the TUM organization's ID and slug:

```sh
sokosumi --preprod workspaces list --json
```

Connect your existing Coworker. Replace `ORGANIZATION_ID` with the TUM
organization ID:

```sh
sokosumi --preprod coworkers connect COWORKER_ID --vendor-id VENDOR_ID --workspace-id ORGANIZATION_ID --json
sokosumi --preprod workspaces check ORGANIZATION_ID --json
```

Continue only when `taskSeatEligible` is `true` and Coworker access is `GRANTED`.
Ask an organization owner or admin if either check fails.

Finish active Tasks and pending seller receipt checks before switching Workspaces.

Stop the worker. Set both organization values in `hackathon-agent/.env`:

```text
SOKOSUMI_ORGANIZATION_ID=ORGANIZATION_ID
SOKOSUMI_ORGANIZATION_SLUG=ORGANIZATION_SLUG
```

Restart the worker:

```sh
npm run worker
```

Select the TUM Workspace and check its credits before creating a Task. Replace
the slug below with your saved value:

```sh
sokosumi --preprod tasks create --organization-slug ORGANIZATION_SLUG --coworker-id COWORKER_ID --name "TUM demo" --description "Suggest five team names for a climate data agent. Use a short technical style." --status READY --json
```

Check the completed Task in the TUM Workspace.

Keep both organization values blank when you want Personal Workspace tasks.

## 8. Optional Preprod payment test

Do this **only after** the execution-only Task works and the user explicitly
authorizes the setup.

Follow the template's Preprod payment setup:
<https://github.com/masumi-network/tum-hackathon-quickstart#optional-preprod-payments>

Read its dependency audit notes before exposing the service to other users.

Summary:

1. Prepare a dedicated Masumi Payment Service database, encryption key, and
   selling wallet.
2. Fund that wallet with test ADA. Save only your own source, wallet, and
   registration records.
3. Create a wallet-scoped `ReadAndPay` key. Confirm registration and the signed
   payment terms.
4. Start the agent API, enable `PAID_TASKS_ENABLED`, and restart the worker.
5. Run a paid Task. Match the payment transaction and verify the seller's net
   token receipt.

Set `AGENT_AUTHOR` to your own author name before registration. Keep `ADMIN_KEY`
in `.local/mps.env` and the worker's `BLOCKFROST_API_KEY_PREPROD` in `.env`. Set
the confirmed source index and seller verification key as described in the
template.

The template's payment setup is manual. Check the seller's actual receipt before
you call the payment test complete.

The template's exact registration commands are:

```sh
node --env-file=.env --env-file=.local/mps.env payment-registration.mjs key
node --env-file=.env --env-file=.local/mps.env payment-registration.mjs register
node --env-file=.env --env-file=.local/mps.env payment-registration.mjs
```

Keep `docs/payment-state.json`, `docs/registration-state.json`, `.local/mps.env`,
and `.local/mps-runtime.env` out of Git. Start the API with `npm run api`, set
`PAID_TASKS_ENABLED=true`, and restart the worker only after registration
confirms.

Save the completed Task ID, payment transaction hash, and seller receipt
together.

## 8b. Check your changes

Run the template's local tests:

```sh
npm test
```

These tests check local logic. They do not replace a real model connection,
Coworker Task, or seller receipt check. The upstream README notes current
`npm audit` findings (two high, one moderate) across `eve`, `undici`, and `zod`;
review them before public deployment. Dependency versions stay pinned in
`package-lock.json`.

## 9. Prepare the demo and submission

Prepare a small example that another team can run:

- Explain the team, input, useful result, and limits.
- Share your repository and exact local run commands.
- Show a completed Task and a follow-up reply.
- Include payment evidence if you completed the optional paid test.

Use the official pages for current requirements:

- <https://hackathon.tum-blockchain.com/>
- <https://tum.devfolio.co/>
- <https://hackathon.tum-blockchain.com/prizes>
- <https://www.masumi.network/tum-hackathon/submission>

Join the TUM Workspace and check Coworker access before sharing the demo.

## 10. Troubleshooting

### MCP container will not start

- Check Podman: `podman info`.
- Build the image: `powershell ./scripts/build-sokosumi-mcp.ps1`.
- Check `.env` exists and has `SOKOSUMI_NETWORK=preprod`.
- Run the smoke test: `python ./scripts/mcp_smoke_test.py`.

### MCP connects but API calls fail

- Check `SOKOSUMI_API_KEY` is a **Preprod** key.
- Check `SOKOSUMI_NETWORK=preprod`.
- Run `sokosumi --preprod auth whoami --json` to confirm the account.

### Task stays `READY`

- Check the worker terminal for `grant_required` or errors.
- Confirm the Coworker access is `GRANTED` in the selected Workspace.
- Confirm only one worker is running.
- Inspect `hackathon-agent/.local/TASK_ID.json` before retrying.

### Node version is wrong

The agent requires Node 24. Check:

```sh
node --version
```

If it is not v24 or newer, install Node 24 or run the agent in a Node 24
container/version-manager environment.

### I need to stop and clean up

See `DELET.md/README.md`. Save Task IDs, results, payment hashes, and receipts
outside the workspace before deleting anything.
