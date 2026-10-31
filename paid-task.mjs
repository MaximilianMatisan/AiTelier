import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { verifySettlement, escrowTransaction, shortTxHash } from "./settlement.mjs";
import { loadSokosumiRuntime } from "./sokosumi-runtime.mjs";
import {
  taskTarget,
  assertTaskTarget,
  verifyRuntimeTask,
  closeTaskWithoutResult,
} from "./task-target.mjs";
import { logger } from "./log.mjs";
const log = logger("paid");
const MINUTE = 60 * 1000;
export const USDM =
  "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d";
export function taskHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Stages where nothing irreversible is in flight, so a Task that stopped in
 * one of them can be closed instead of left RUNNING for ever. `submit-pending`
 * and `complete-pending` are deliberately absent: the operation before them
 * may have landed, and only a person should decide what happened.
 */
export const RECOVERABLE_PENDING = new Set([
  "terms-pending",
  "purchase-pending",
  "model-pending",
]);

/**
 * Stages with nothing left to do. Recognised before the Task is read back, so
 * a worker left running does not spend two API calls every five seconds on
 * Tasks that finished hours ago.
 */
export const TERMINAL_STAGES = new Set(["settled", "refunded", "stalled"]);

/** What the customer reads when the guarantees did not hold. */
export function refundNotice(failed = []) {
  return [
    "AiTelier did not submit a result for this order, so the escrow returns your money.",
    "",
    "Every outfit it could build broke at least one of the five guarantees:",
    ...failed.map((f) => `- ${f}`),
    "",
    "Not submitting a result is what returns the funds to you once the result",
    "deadline passes. You were not charged for the styling.",
  ].join("\n");
}

/** What the customer reads when the run stopped part-way. */
export function stalledNotice(stage) {
  return [
    "AiTelier stopped before it could finish this order, so no result was submitted",
    "and the escrow returns your money once the result deadline passes.",
    "",
    `It stopped at the "${stage}" step. You were not charged for the styling.`,
    "",
    "Starting the order again is safe.",
  ].join("\n");
}
/**
 * How an unpaid run that ends with no result is closed. The paid flow records
 * this itself; the unpaid path used to only write a log line, so the Task sat
 * in RUNNING for ever and the local journal stayed at "model-pending".
 * Returns the terminal phase and what the customer reads, or null when the
 * phase is one where an operation may already have landed.
 */
export function unpaidFailure(state, error) {
  if (error?.refund)
    return { phase: "refunded", text: refundNotice(error.failed) };
  if (RECOVERABLE_PENDING.has(state?.phase))
    return { phase: "stalled", text: stalledNotice(state.phase) };
  return null;
}

/**
 * The receipt line under the result. Only said when the escrow service showed a
 * confirmed deposit: a customer who paid can open the transaction themselves,
 * and a customer who did not is not shown a link to nothing.
 */
export function paymentLine({ txHash, url }) {
  return `**Payment:** 1 test USDM held in escrow on Cardano Preprod — [transaction ${shortTxHash(txHash)}](${url})`;
}
export function confirmedState(payment, expected) {
  return (
    (payment.CurrentTransaction?.status === "Confirmed" &&
      payment.CurrentTransaction?.newOnChainState === expected) ||
    payment.TransactionHistory?.some(
      (tx) => tx.status === "Confirmed" && tx.newOnChainState === expected,
    ) ||
    false
  );
}
// Running MPS dist/app-DCTS_JYs.js:249079 signs no forceLayer field.
// Source differs from the loaded build. An absent field is valid for that build.
export function purchasePayload(payment, nonce, registration) {
  if (
    payment.sellerReturnAddress !== null ||
    (payment.forceLayer !== undefined && payment.forceLayer !== null)
  )
    throw new Error(
      "Core Task events cannot preserve non-null signed sellerReturnAddress or forceLayer",
    );
  if (
    payment.PaymentSource?.network !== "Preprod" ||
    payment.PaymentSource?.paymentSourceType !== "Web3CardanoV2"
  )
    throw new Error("Payment source is not Preprod Web3CardanoV2");
  if (payment.SmartContractWallet?.id !== registration.walletId)
    throw new Error("Payment wallet differs from dedicated seller wallet");
  if (
    payment.RequestedFunds.length !== 1 ||
    payment.RequestedFunds[0].unit !== USDM ||
    payment.RequestedFunds[0].amount !== "1000000"
  )
    throw new Error("Signed quote differs from 1 test USDM");
  return {
    blockchainIdentifier: payment.blockchainIdentifier,
    agentIdentifier: payment.agentIdentifier,
    sellerVkey: payment.SmartContractWallet.walletVkey,
    submitResultTime: payment.submitResultTime,
    payByTime: payment.payByTime,
    unlockTime: payment.unlockTime,
    externalDisputeUnlockTime: payment.externalDisputeUnlockTime,
    inputHash: payment.inputHash,
    identifierFromPurchaser: nonce,
    paymentSourceType: "Web3CardanoV2",
    supportedPaymentSourceIndex: registration.supportedPaymentSourceIndex,
    Amounts: payment.RequestedFunds.map(({ amount, unit }) => ({
      amount,
      unit,
    })),
    PaymentSource: {
      network: "Preprod",
      smartContractAddress: payment.PaymentSource.smartContractAddress,
      policyId: payment.PaymentSource.policyId,
    },
  };
}
export function isPaidReady() {
  if (
    !existsSync("docs/registration-state.json") ||
    !existsSync(".local/mps-runtime.env")
  )
    return false;
  const r = JSON.parse(readFileSync("docs/registration-state.json", "utf8"));
  return (
    r.status === "RegistrationConfirmed" ||
    r.registrationState === "RegistrationConfirmed" ||
    r.registration?.state === "RegistrationConfirmed"
  );
}
/**
 * Whether the Masumi Payment Service answers at all. Any HTTP answer counts:
 * this asks "is it running", not "is this request valid". A paid Task that
 * starts while it is down fails at its first step and is closed as stalled,
 * so the worker checks once before it lets any Task into the paid flow.
 */
export async function paymentServiceReachable({ env = process.env, fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  if (!env.MPS_URL?.trim()) return false;
  try {
    await fetchImpl(env.MPS_URL, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/**
 * "on", or why the paid flow is not used: "off", "on-but-no-key" or
 * "on-but-unreachable". Anything but "on" sends new Tasks down the unpaid path.
 */
export async function paidMode({ env = process.env, ready = isPaidReady, reachable = paymentServiceReachable } = {}) {
  if (env.PAID_TASKS_ENABLED !== "true") return "off";
  if (!ready()) return "on-but-no-key";
  if (!(await reachable({ env }))) return "on-but-unreachable";
  return "on";
}

export async function createPaidAdapter({
  save,
  answer,
  core: providedCore,
  mps: providedMps,
  registration: providedRegistration,
  target = taskTarget(),
}) {
  const registration = () =>
    providedRegistration ??
    JSON.parse(readFileSync("docs/registration-state.json", "utf8"));
  let core = providedCore;
  async function getCore() {
    if (!core) {
      const { readRuntimeCredential, createCoworkerHttpClient } =
        await loadSokosumiRuntime();
      core = createCoworkerHttpClient({
        apiKey: readRuntimeCredential(target.coworkerId),
      });
    }
    return core;
  }
  async function mps(path, body) {
    if (providedMps) return providedMps(path, body);
    const env = parseEnv(readFileSync(".local/mps-runtime.env", "utf8"));
    const response = await fetch(`${process.env.MPS_URL}${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        "Content-Type": "application/json",
        token: env.MPS_RUNTIME_TOKEN,
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok || data.status !== "success") {
      log.error("payment service call failed", { path, status: response.status });
      throw new Error(
        `MPS ${path} failed HTTP ${response.status}. Inspect saved state before retry.`,
      );
    }
    return data.data;
  }
  async function persist(task, state, paid) {
    const next = { ...state, paid };
    await save(task.id, next);
    // One line per step of the payment, and per change in what the chain shows.
    const before = state.paid ?? {};
    const chain = paid?.observed?.onChainState;
    if (paid?.stage !== before.stage || chain !== before.observed?.onChainState)
      log.info(paid?.stage === before.stage ? "chain" : "stage", {
        task: task.id,
        from: paid?.stage === before.stage ? undefined : before.stage ?? "new",
        to: paid?.stage,
        onChain: chain,
      });
    return next;
  }
  /**
   * Tells the customer the Task ended without a result and closes it, so it
   * does not sit in RUNNING for ever waiting for something that will never
   * come. It never submits a result: submitting is what moves the escrow
   * towards paying us, and there is nothing here worth paying for.
   */
  async function reportNoResult(task, text) {
    const client = await verifyRuntimeTask(await getCore(), task.id, target);
    return closeTaskWithoutResult(client, task.id, text, { log });
  }
  return {
    async advance(task, state) {
      assertTaskTarget(task, target);
      if (TERMINAL_STAGES.has(state.paid?.stage)) return state;
      await verifyRuntimeTask(await getCore(), task.id, target);
      let p = state.paid ?? {};
      const r = registration();
      if (!p.stage) {
        if (!state.input?.trim())
          throw new Error("Paid Task requires authoritative started input");
        const nonce = randomBytes(10).toString("hex");
        const now = Date.now();
        const body = {
          network: "Preprod",
          agentIdentifier: r.agentIdentifier,
          paymentSourceType: "Web3CardanoV2",
          supportedPaymentSourceIndex: r.supportedPaymentSourceIndex,
          inputHash: taskHash(state.input),
          identifierFromPurchaser: nonce,
          RequestedFunds: [{ amount: "1000000", unit: USDM }],
          payByTime: new Date(now + 5 * MINUTE).toISOString(),
          submitResultTime: new Date(now + 20 * MINUTE).toISOString(),
          unlockTime: new Date(now + 36 * MINUTE).toISOString(),
          externalDisputeUnlockTime: new Date(now + 52 * MINUTE).toISOString(),
          metadata: JSON.stringify({ taskId: task.id }),
        };
        if (
          !body.agentIdentifier ||
          !Number.isInteger(body.supportedPaymentSourceIndex)
        )
          throw new Error(
            "Registration identifier and source index are required",
          );
        state = await persist(task, state, {
          stage: "terms-pending",
          nonce,
          request: body,
        });
        const payment = await mps("/api/v1/payment", body);
        return persist(task, state, {
          ...state.paid,
          stage: "terms-saved",
          payment,
        });
      }
      if (p.stage === "terms-saved") {
        const payload = purchasePayload(p.payment, p.nonce, r);
        if (Date.now() >= Number(p.payment.payByTime))
          throw new Error("Signed payment deadline expired");
        state = await persist(task, state, {
          ...p,
          payload,
          stage: "purchase-pending",
        });
        const response = await (
          await verifyRuntimeTask(await getCore(), task.id, target)
        ).post(`/v1/tasks/${encodeURIComponent(task.id)}/events`, {
          comment: "Payment requested: 1 test USDM.",
          masumiPayment: payload,
        });
        return persist(task, state, {
          ...p,
          stage: "awaiting-escrow",
          eventId: response.data.id,
        });
      }
      if (
        ["awaiting-escrow", "awaiting-result", "awaiting-withdrawal"].includes(
          p.stage,
        )
      ) {
        const observed = await mps(
          "/api/v1/payment/resolve-blockchain-identifier",
          {
            network: "Preprod",
            blockchainIdentifier: p.payment.blockchainIdentifier,
            includeHistory: "true",
          },
        );
        p = { ...p, observed };
        state = await persist(task, state, p);
        if (p.stage === "awaiting-escrow") {
          if (
            observed.onChainState !== "FundsLocked" ||
            !confirmedState(observed, "FundsLocked")
          )
            return state;
          if (Date.now() >= Number(p.payment.submitResultTime))
            throw new Error("Result deadline expired before model");
          // A cancellation that landed while the escrow was being watched used
          // to be ignored; styling a withdrawn order wastes the run and the
          // result would be submitted against a Task nobody is waiting for.
          await verifyRuntimeTask(await getCore(), task.id, target, { mustBeLive: true });
          state = await persist(task, state, { ...p, stage: "model-pending" });
          if (Date.now() >= Number(p.payment.submitResultTime))
            throw new Error("Result deadline expired before model send");
          // The deposit exists by now: the escrow was just read as FundsLocked.
          // It travels with the answer so the result page can link the same
          // transaction that the result text names.
          const escrow = escrowTransaction(observed);
          let result;
          try {
            result = await answer(
              state.input,
              `.local/${task.id}-session.json`,
              Number(p.payment.submitResultTime),
              { payment: escrow },
            );
          } catch (error) {
            if (!error?.refund) throw error;
            // The guarantees were checked and did not hold. Saying so closes
            // the Task; submitting nothing is what returns the money. Left
            // unsaid, the stage stayed "model-pending" and every later poll
            // refused to touch it, so the Task ran for ever.
            const reported = await reportNoResult(task, refundNotice(error.failed));
            log.warn("refund reported, no result submitted", {
              task: task.id,
              reported,
              failed: error.failed ?? error.message,
            });
            return persist(
              task,
              { ...state, phase: "refunded" },
              { ...p, stage: "refunded", failed: error.failed ?? [], reported },
            );
          }
          if (typeof result !== "string" || !result.trim())
            throw new Error("Model did not return a result");
          // Under the result, not at the top: the outfits are what was bought,
          // the deposit is the receipt. Hashed with the rest, so what the
          // escrow is told matches what the customer read.
          if (escrow) result = `${result}\n\n${paymentLine(escrow)}`;
          writeFileSync(`.local/${task.id}.txt`, result, { mode: 0o600 });
          return persist(task, state, {
            ...p,
            stage: "result-saved",
            result,
            resultHash: taskHash(result),
          });
        }
        if (
          p.stage === "awaiting-result" &&
          observed.resultHash === p.resultHash &&
          confirmedState(observed, "ResultSubmitted") &&
          observed.onChainState === "ResultSubmitted"
        )
          return persist(task, state, { ...p, stage: "complete-ready" });
        if (
          p.stage === "awaiting-withdrawal" &&
          ["Withdrawn", "DisputedWithdrawn"].includes(observed.onChainState)
        ) {
          const evidence = await verifySettlement({
            core: await verifyRuntimeTask(await getCore(), task.id, target),
            taskId: task.id,
            payment: observed,
            sellerAddress:
              registration().registration?.SmartContractWallet?.walletAddress,
            unit: USDM,
          });
          return persist(task, state, {
            ...p,
            stage: evidence.verified ? "settled" : "awaiting-withdrawal",
            settlement: evidence,
          });
        }
        return state;
      }
      if (p.stage === "result-saved") {
        if (Date.now() >= Number(p.payment.submitResultTime))
          throw new Error("Result deadline expired before submit");
        // Submitting the hash is the step that moves the escrow towards paying
        // us. A Task canceled while the result was being written must not be
        // charged for it.
        await verifyRuntimeTask(await getCore(), task.id, target, { mustBeLive: true });
        state = await persist(task, state, { ...p, stage: "submit-pending" });
        await mps("/api/v1/payment/submit-result", {
          network: "Preprod",
          blockchainIdentifier: p.payment.blockchainIdentifier,
          submitResultHash: p.resultHash,
        });
        return persist(task, state, { ...p, stage: "awaiting-result" });
      }
      if (p.stage === "complete-ready") {
        // Read the status once more before claiming the Task is done. A
        // cancellation that arrived while the result was being confirmed on
        // chain used to be ignored and the Task was completed anyway. Checked
        // before the stage advances, so stopping here leaves nothing wedged.
        const live = await verifyRuntimeTask(await getCore(), task.id, target, {
          mustBeLive: true,
        });
        state = await persist(task, state, { ...p, stage: "complete-pending" });
        const response = await live.post(`/v1/tasks/${encodeURIComponent(task.id)}/events`, {
          status: "COMPLETED",
          comment: p.result,
        });
        return persist(
          task,
          { ...state, phase: "completed" },
          {
            ...p,
            stage: "awaiting-withdrawal",
            completionEventId: response.data.id,
          },
        );
      }
      if (p.stage.endsWith("-pending")) {
        // A step that stopped half-way is never retried, because it could then
        // run twice. Before the escrow and before a submit there is nothing in
        // flight to double, so the Task is closed and the customer told,
        // instead of being left in RUNNING with no result coming.
        if (RECOVERABLE_PENDING.has(p.stage)) {
          const reported = await reportNoResult(task, stalledNotice(p.stage));
          log.warn("stalled step closed, no result submitted", {
            task: task.id,
            stage: p.stage,
            reported,
          });
          return persist(
            task,
            { ...state, phase: "failed" },
            { ...p, stage: "stalled", stalledAt: p.stage, reported },
          );
        }
        throw new Error(
          `Uncertain ${p.stage}. Inspect prior operation before recovery; automatic retry disabled.`,
        );
      }
      return state;
    },
  };
}
