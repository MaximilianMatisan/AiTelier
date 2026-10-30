# Demo and submission checklist

Use this before submitting. Check the official event pages for current rules and
track details:

- <https://hackathon.tum-blockchain.com/>
- <https://tum.devfolio.co/>
- <https://hackathon.tum-blockchain.com/prizes>
- <https://www.masumi.network/tum-hackathon/submission>

## 1. The job

- [ ] I can state the job in one sentence: **For [team], turn [input] into
      [useful result], so they can [decision/action].**
- [ ] The input is small, legal to use, and another participant can inspect it.
- [ ] The result is checkable and does not depend on private data.
- [ ] I documented the limits and missing-information behavior.

## 2. The agent

- [ ] `hackathon-agent/agent/instructions.md` describes the real job, not the
      template team-name assistant.
- [ ] The model connection works with the configured provider.
- [ ] The agent starts with `npm start`.
- [ ] The worker starts with `npm run worker`.
- [ ] The worker prints `Continuous worker running`.
- [ ] Only one worker runs for the Coworker.
- [ ] `PAID_TASKS_ENABLED=false` for the execution-only test.

## 3. The first Task

- [ ] Task created in the **Personal Workspace**.
- [ ] Task ID saved.
- [ ] Task status is `COMPLETED`.
- [ ] The result is saved and readable.
- [ ] The result actually does the job.
- [ ] A follow-up comment was sent and answered.
- [ ] If `grant_required` occurred, the recovery steps were followed and the
      same Task completed.

## 4. TUM Workspace

- [ ] Joined the TUM Workspace.
- [ ] Coworker connected to the TUM organization.
- [ ] `taskSeatEligible` is `true`.
- [ ] Coworker access is `GRANTED`.
- [ ] Both `SOKOSUMI_ORGANIZATION_ID` and `SOKOSUMI_ORGANIZATION_SLUG` are set.
- [ ] Worker restarted after the organization change.
- [ ] TUM Workspace Task completed.

## 5. Optional payment evidence

Only if the execution-only Task works and the payment setup was authorized.

- [ ] Dedicated payment database, encryption key, and selling wallet.
- [ ] Selling wallet funded with test ADA.
- [ ] Wallet-scoped `ReadAndPay` key created.
- [ ] Registration confirmed.
- [ ] Signed payment terms confirmed.
- [ ] `PAID_TASKS_ENABLED=true` and worker restarted.
- [ ] Paid Task completed.
- [ ] Payment transaction hash saved.
- [ ] Seller's net token receipt verified.
- [ ] Task ID, tx hash, and receipt saved together.

A completed Task alone is **not** proof of payment.

## 6. Demo package

- [ ] Repository shared.
- [ ] Exact local run commands included.
- [ ] Completed Task shown.
- [ ] Follow-up reply shown.
- [ ] Payment evidence included if applicable.
- [ ] Architecture diagram or short explanation included.
- [ ] Known limitations stated.
- [ ] No secrets, `.env`, `.local/`, OAuth tokens, wallet seeds, or private logs
      in the repository or demo.
- [ ] Submission uploaded before the deadline.

## 7. Before you leave

- [ ] Evidence archived outside this workspace.
- [ ] Preprod API key revoked or rotated.
- [ ] OAuth sessions removed if no longer needed.
- [ ] Podman container/image cleaned up.
- [ ] `DELET.md/README.md` reviewed.

## Evidence template

Copy this into a private note outside the repository:

```text
Team:
Agent name:
Job sentence:

Vendor ID:
Coworker ID:
Personal Workspace Task ID:
Personal Workspace Task status:
Personal Workspace result summary:

TUM organization ID:
TUM organization slug:
TUM Workspace Task ID:
TUM Workspace Task status:
TUM Workspace result summary:

Follow-up comment:
Follow-up reply summary:

Payment task ID:
Payment tx hash:
Seller receipt:
Network: preprod

Repo:
Demo video:
Submission confirmation:
```
