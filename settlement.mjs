// A transaction is worth linking only when the payment service showed it as
// confirmed and named the hash it confirmed. The customer is about to let the
// escrow release, and a hash they can open on an explorer is the difference
// between a receipt and a claim.

/** Where a Cardano transaction can be read, per network. */
const EXPLORERS = {
  Preprod: "https://preprod.cardanoscan.io/transaction/",
  Mainnet: "https://cardanoscan.io/transaction/",
};

/** The explorer address of a transaction, or null when the hash cannot be one. */
export function txExplorerUrl(txHash, network = "Preprod") {
  const base = EXPLORERS[network];
  if (!base || !/^[0-9a-f]{64}$/i.test(txHash ?? "")) return null;
  return base + txHash;
}

/** A hash short enough to sit inside a sentence, still recognisable. */
export function shortTxHash(txHash) {
  return `${txHash.slice(0, 8)}…${txHash.slice(-6)}`;
}

/**
 * The confirmed transaction that locked the buyer's funds in escrow, or null.
 * Only a confirmed FundsLocked transaction is the deposit: the later withdrawal
 * is a different payment, and its hash says something else about the money.
 */
export function escrowTransaction(payment) {
  const txs = [payment?.CurrentTransaction, ...(payment?.TransactionHistory ?? [])];
  const tx = txs.find(
    (t) => t?.status === "Confirmed" && t.newOnChainState === "FundsLocked",
  );
  const network = payment?.PaymentSource?.network ?? "Preprod";
  const url = txExplorerUrl(tx?.txHash, network);
  return url ? { txHash: tx.txHash, network, url } : null;
}

export function sellerTokenNet(utxos, address, unit) {
  const sum = (entries) =>
    entries
      .filter((x) => x.address === address)
      .reduce(
        (total, x) =>
          total +
          x.amount
            .filter((a) => a.unit === unit)
            .reduce((n, a) => n + BigInt(a.quantity), 0n),
        0n,
      );
  return sum(utxos.outputs) - sum(utxos.inputs);
}
export async function verifySettlement({
  core,
  taskId,
  payment,
  sellerAddress,
  unit,
}) {
  const raw = await core.get(`/v1/tasks/${encodeURIComponent(taskId)}/receipt`);
  const receipt = raw.data;
  if (!receipt?.settled || !receipt.txHash) return { verified: false, receipt };
  if (receipt.blockchainIdentifier !== payment.blockchainIdentifier)
    throw new Error("Core receipt payment identifier mismatch");
  const tx = [
    payment.CurrentTransaction,
    ...(payment.TransactionHistory || []),
  ].find(
    (t) =>
      t?.status === "Confirmed" &&
      ["Withdrawn", "DisputedWithdrawn"].includes(t.newOnChainState) &&
      t.txHash === receipt.txHash,
  );
  if (!tx)
    return {
      verified: false,
      receipt,
      reason: "Matching MPS withdrawal transaction not confirmed",
    };
  const response = await fetch(
    `https://cardano-preprod.blockfrost.io/api/v0/txs/${receipt.txHash}/utxos`,
    {
      headers: { project_id: process.env.BLOCKFROST_API_KEY_PREPROD },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok)
    return { verified: false, receipt, blockfrostStatus: response.status };
  const net = sellerTokenNet(await response.json(), sellerAddress, unit);
  return {
    verified: net > 0n,
    receipt,
    txHash: receipt.txHash,
    netAtomicUnits: net.toString(),
    method:
      "Matched Core/MPS withdrawal hash and Blockfrost transaction inputs/outputs at dedicated seller address",
  };
}
