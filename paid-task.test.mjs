import { test } from "node:test";
import assert from "node:assert/strict";
import {
  taskHash,
  purchasePayload,
  createPaidAdapter,
  confirmedState,
  unpaidFailure,
  USDM,
} from "./paid-task.mjs";
const registration = {
  walletId: "seller-wallet",
  agentIdentifier: "a".repeat(80),
  supportedPaymentSourceIndex: 0,
};
const target = { coworkerId: "coworker", organizationId: null };
const task = { id: "task", coworkerId: "coworker", organizationId: null };
const core = { get: async () => ({ data: task }) };
const payment = {
  sellerReturnAddress: null,
  forceLayer: null,
  PaymentSource: {
    network: "Preprod",
    paymentSourceType: "Web3CardanoV2",
    smartContractAddress: "addr_test1contract",
    policyId: "a".repeat(56),
  },
  SmartContractWallet: { id: "seller-wallet", walletVkey: "b".repeat(56) },
  RequestedFunds: [{ amount: "1000000", unit: USDM }],
  agentIdentifier: registration.agentIdentifier,
  blockchainIdentifier: "signed",
  inputHash: taskHash("abc"),
  payByTime: String(Date.now() + 100000),
  submitResultTime: String(Date.now() + 200000),
  unlockTime: "9999999999999",
  externalDisputeUnlockTime: "9999999999999",
};
test("Task compatibility hashes exact UTF-8 bytes without JSON escapes or nonce", () => {
  assert.equal(
    taskHash("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.notEqual(taskHash("a\nb"), taskHash("a\\nb"));
});
test("signed fields preserved and unsupported signed override rejected", () => {
  const payload = purchasePayload(payment, "01020304050607", registration);
  assert.equal(payload.blockchainIdentifier, payment.blockchainIdentifier);
  assert.equal(payload.unlockTime, payment.unlockTime);
  assert.throws(
    () =>
      purchasePayload({ ...payment, forceLayer: "L1" }, "nonce", registration),
    /cannot preserve/,
  );
  assert.throws(
    () =>
      purchasePayload(
        { ...payment, sellerReturnAddress: "addr_test1seller" },
        "nonce",
        registration,
      ),
    /cannot preserve/,
  );
  assert.throws(
    () =>
      purchasePayload(
        { ...payment, SmartContractWallet: { id: "other" } },
        "nonce",
        registration,
      ),
    /differs/,
  );
});
test("uncertain purchase is never reposted, and the Task is closed instead", async () => {
  // Reposting the payment request could charge twice, so it must never happen.
  // Leaving the Task untouched is not the alternative: it then sat in RUNNING
  // for ever with no result coming, which is what the customer complained of.
  const bodies = [];
  const adapter = await createPaidAdapter({
    target,
    registration,
    save: async () => {},
    answer: async () => {
      throw Error("unexpected model");
    },
    core: {
      ...core,
      post: async (path, body) => {
        bodies.push(body);
        return { data: { id: "event" } };
      },
    },
  });
  const next = await adapter.advance(task, {
    input: "abc",
    paid: { stage: "purchase-pending" },
  });
  assert.equal(
    bodies.filter((b) => b.masumiPayment).length,
    0,
    "the signed payment request must never be posted a second time",
  );
  assert.equal(next.paid.stage, "stalled");
  assert.equal(next.paid.stalledAt, "purchase-pending");
  assert.equal(next.phase, "failed");
  assert.match(bodies.at(-1).comment, /not charged/);
});

test("an uncertain submit is left for a person, not closed by the worker", async () => {
  // Past submit-result the money may already be moving. Nothing here may
  // guess: a person has to read what happened first.
  let posts = 0;
  const adapter = await createPaidAdapter({
    target,
    registration,
    save: async () => {},
    answer: async () => {
      throw Error("unexpected model");
    },
    core: {
      ...core,
      post: async () => {
        posts++;
        return { data: { id: "event" } };
      },
    },
  });
  await assert.rejects(
    () => adapter.advance(task, { input: "abc", paid: { stage: "submit-pending" } }),
    /automatic retry disabled/,
  );
  assert.equal(posts, 0, "nothing is said about a Task whose payment state is unknown");
});
test("unconfirmed escrow does not invoke model", async () => {
  let sends = 0;
  const adapter = await createPaidAdapter({
    target,
    core,
    registration,
    save: async () => {},
    answer: async () => {
      sends++;
    },
    mps: async () => ({
      ...payment,
      onChainState: "FundsLocked",
      CurrentTransaction: { status: "Pending" },
    }),
  });
  const state = await adapter.advance(task, {
    input: "abc",
    paid: { stage: "awaiting-escrow", payment },
  });
  assert.equal(sends, 0);
  assert.equal(state.paid.stage, "awaiting-escrow");
});
test("expired deadline prevents model after confirmed read", async () => {
  let sends = 0;
  const expired = { ...payment, submitResultTime: "1" };
  const adapter = await createPaidAdapter({
    target,
    core,
    registration,
    save: async () => {},
    answer: async () => {
      sends++;
    },
    mps: async () => ({
      ...expired,
      onChainState: "FundsLocked",
      CurrentTransaction: {
        status: "Confirmed",
        newOnChainState: "FundsLocked",
      },
    }),
  });
  await assert.rejects(
    () =>
      adapter.advance(task, {
        input: "abc",
        paid: { stage: "awaiting-escrow", payment: expired },
      }),
    /deadline expired/,
  );
  assert.equal(sends, 0);
});

test("confirmed history proves lock when CurrentTransaction is absent", () => {
  assert.equal(
    confirmedState(
      {
        CurrentTransaction: null,
        TransactionHistory: [
          { status: "Confirmed", newOnChainState: "FundsLocked" },
        ],
      },
      "FundsLocked",
    ),
    true,
  );
  assert.equal(
    confirmedState(
      {
        CurrentTransaction: null,
        TransactionHistory: [
          { status: "Confirmed", newOnChainState: "ResultSubmitted" },
        ],
      },
      "FundsLocked",
    ),
    false,
  );
});
test("successful quote survives later payload rejection", async () => {
  let saved;
  const adapter = await createPaidAdapter({
    target,
    core,
    registration,
    save: async (_, s) => {
      saved = s;
    },
    answer: async () => {},
    mps: async () => ({ ...payment, forceLayer: "L1" }),
  });
  const state = await adapter.advance(task, { input: "abc" });
  assert.equal(saved.paid.payment.blockchainIdentifier, "signed");
  assert.equal(state.paid.stage, "terms-saved");
  await assert.rejects(() => adapter.advance(task, state), /cannot preserve/);
});

test("running MPS legacy response without unsigned forceLayer is supported", () => {
  const older = { ...payment };
  delete older.forceLayer;
  assert.equal(
    purchasePayload(older, "nonce", registration).blockchainIdentifier,
    "signed",
  );
});

test("unrelated confirmed transaction cannot prove escrow", () => {
  assert.equal(
    confirmedState(
      {
        CurrentTransaction: {
          status: "Confirmed",
          newOnChainState: "Withdrawn",
        },
      },
      "FundsLocked",
    ),
    false,
  );
});

test("paid execution rejects another Workspace or Coworker before any saved state or payment write", async () => {
  let writes = 0;
  const target = {
    coworkerId: "event-coworker",
    organizationId: "event-organization",
  };
  const adapter = await createPaidAdapter({
    target,
    registration,
    save: async () => {
      writes++;
    },
    answer: async () => {},
    mps: async () => {
      writes++;
      return payment;
    },
  });
  for (const task of [
    { id: "task", coworkerId: "event-coworker", organizationId: null },
    {
      id: "task",
      coworkerId: "event-coworker",
      organizationId: "other-organization",
    },
    {
      id: "task",
      coworkerId: "other-coworker",
      organizationId: "event-organization",
    },
  ])
    await assert.rejects(
      adapter.advance(task, { input: "abc" }),
      /configured Coworker and Workspace/,
    );
  assert.equal(writes, 0);
});

const lockedEscrow = {
  onChainState: "FundsLocked",
  CurrentTransaction: { status: "Confirmed", newOnChainState: "FundsLocked" },
};

test("a refund closes the Task and submits nothing", async () => {
  // The stage used to stay at "model-pending" after the throw, and every later
  // poll refused to touch it, so the Task ran in Sokosumi for ever. Submitting
  // is also what charges the customer, so the result must stay unsubmitted.
  const bodies = [];
  const adapter = await createPaidAdapter({
    target,
    registration,
    save: async () => {},
    answer: async () => {
      const error = new Error("Guarantees failed");
      error.refund = true;
      error.failed = ["budget: no outfit passed", "fit: no outfit passed"];
      throw error;
    },
    mps: async (path) => {
      if (path.includes("resolve-blockchain-identifier")) return lockedEscrow;
      throw new Error(`the escrow must not be touched: ${path}`);
    },
    core: {
      ...core,
      post: async (path, body) => {
        bodies.push(body);
        return { data: { id: "event" } };
      },
    },
  });
  const next = await adapter.advance(task, {
    input: "abc",
    paid: { stage: "awaiting-escrow", payment },
  });
  assert.equal(next.paid.stage, "refunded", "the stage is terminal, not left pending");
  assert.equal(next.phase, "refunded");
  assert.deepEqual(next.paid.failed, ["budget: no outfit passed", "fit: no outfit passed"]);
  assert.equal(
    bodies.filter((b) => b.status === "COMPLETED").length,
    0,
    "a refund must never complete the Task",
  );
  assert.equal(bodies.at(-1).status, "FAILED");
  assert.match(bodies.at(-1).comment, /returns your money/);
});

test("a Task canceled before the result is submitted is not submitted", async () => {
  let submits = 0;
  const adapter = await createPaidAdapter({
    target,
    registration,
    save: async () => {},
    answer: async () => "unused",
    mps: async (path) => {
      if (path.includes("submit-result")) submits++;
      return {};
    },
    core: { get: async () => ({ data: { ...task, status: "CANCELED" } }), post: async () => ({ data: {} }) },
  });
  await assert.rejects(
    () =>
      adapter.advance(task, {
        input: "abc",
        paid: { stage: "result-saved", payment, result: "r", resultHash: "h" },
      }),
    /CANCELED/,
  );
  assert.equal(submits, 0, "the escrow must not be told a result exists for a canceled Task");
});

test("an unpaid run that ends with no result is closed, not left RUNNING", async () => {
  // Seen on a live unpaid Task: the guarantees failed, the worker logged the
  // refund and wrote nothing else, so the journal stayed at "model-pending" and
  // the Task sat in RUNNING while every poll only warned "stopped mid-step".
  const refund = new Error("Guarantees failed");
  refund.refund = true;
  refund.failed = ["budget: no outfit passed", "fit: no outfit passed"];
  const closed = unpaidFailure({ phase: "model-pending" }, refund);
  assert.equal(closed.phase, "refunded");
  assert.match(closed.text, /budget: no outfit passed/);
  assert.match(closed.text, /returns your money/);

  const crash = unpaidFailure({ phase: "model-pending" }, new Error("Pipeline failed or overran"));
  assert.equal(crash.phase, "stalled", "a pipeline crash is terminal too, so it cannot hang");
  assert.match(crash.text, /starting the order again is safe/i);

  // Where an operation may already have landed, only a person decides.
  assert.equal(unpaidFailure({ phase: "complete-pending" }, new Error("x")), null);
});

test("a Task canceled before completion is not completed", async () => {
  let posts = 0;
  const adapter = await createPaidAdapter({
    target,
    registration,
    save: async () => {},
    answer: async () => "unused",
    core: {
      get: async () => ({ data: { ...task, status: "CANCELED" } }),
      post: async () => {
        posts++;
        return { data: { id: "event" } };
      },
    },
  });
  await assert.rejects(
    () =>
      adapter.advance(task, {
        input: "abc",
        paid: { stage: "complete-ready", payment, result: "r", resultHash: "h" },
      }),
    /CANCELED/,
  );
  assert.equal(posts, 0, "a canceled Task must not be reported COMPLETED");
});

test("a canceled Task is not styled at all", async () => {
  let ran = 0;
  const adapter = await createPaidAdapter({
    target,
    registration,
    save: async () => {},
    answer: async () => {
      ran++;
      return "result";
    },
    mps: async () => lockedEscrow,
    core: { get: async () => ({ data: { ...task, status: "CANCELED" } }), post: async () => ({ data: {} }) },
  });
  await assert.rejects(
    () => adapter.advance(task, { input: "abc", paid: { stage: "awaiting-escrow", payment } }),
    /CANCELED/,
  );
  assert.equal(ran, 0, "styling a withdrawn order wastes the run");
});

test("a finished Task is not read back from the API on every poll", async () => {
  let reads = 0;
  const adapter = await createPaidAdapter({
    target,
    registration,
    save: async () => {},
    answer: async () => "unused",
    core: {
      get: async () => {
        reads++;
        return { data: task };
      },
      post: async () => ({ data: {} }),
    },
  });
  for (const stage of ["settled", "refunded", "stalled"])
    await adapter.advance(task, { input: "abc", paid: { stage, payment } });
  assert.equal(reads, 0, "a worker left running must not poll Tasks that are done");
});
