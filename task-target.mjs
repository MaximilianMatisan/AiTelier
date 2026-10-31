export function taskTarget(env = process.env) {
  const coworkerId = env.COWORKER_ID?.trim();
  if (!coworkerId || /\s/u.test(coworkerId))
    throw new Error("COWORKER_ID must identify your Coworker");
  const organizationId = env.SOKOSUMI_ORGANIZATION_ID?.trim() || null;
  const organizationSlug = env.SOKOSUMI_ORGANIZATION_SLUG?.trim() || null;
  if (Boolean(organizationId) !== Boolean(organizationSlug))
    throw new Error(
      "Set both SOKOSUMI_ORGANIZATION_ID and SOKOSUMI_ORGANIZATION_SLUG, or leave both blank",
    );
  if (organizationId && /\s/u.test(organizationId))
    throw new Error("SOKOSUMI_ORGANIZATION_ID must be a single ID");
  if (organizationSlug && !/^[a-zA-Z0-9_-]+$/u.test(organizationSlug))
    throw new Error(
      "SOKOSUMI_ORGANIZATION_SLUG must be a valid Workspace slug",
    );
  return {
    coworkerId,
    organizationId,
    taskArgs: organizationSlug ? ["--organization-slug", organizationSlug] : [],
    runtimeArgs: organizationId
      ? ["--organization-id", organizationId]
      : ["--personal"],
  };
}
export function isTaskForTarget(task, target) {
  return (
    (task?.coworkerId ?? task?.assigneeId) === target.coworkerId &&
    task.organizationId === target.organizationId
  );
}
export function assertTaskTarget(task, target) {
  if (!isTaskForTarget(task, target))
    throw new Error("Task must match the configured Coworker and Workspace");
}
/** Says something on the Task without changing its status. */
export async function postTaskComment(client, taskId, text) {
  await client.post(`/v1/tasks/${encodeURIComponent(taskId)}/events`, { comment: text });
}

/**
 * Closes a Task that is going to get no result and tells the customer why, so
 * it does not sit in RUNNING waiting for something that will never arrive.
 * Returns how far it got: "FAILED" when Core took the terminal status, or
 * "comment" when it only took the text. It never submits a result, because
 * submitting is what charges the customer.
 */
export async function closeTaskWithoutResult(client, taskId, text, { log } = {}) {
  const path = `/v1/tasks/${encodeURIComponent(taskId)}/events`;
  try {
    await client.post(path, { status: "FAILED", comment: text });
    return "FAILED";
  } catch (error) {
    log?.warn?.("could not close the Task; posting the reason as a comment", {
      task: taskId,
      error: error.message,
    });
    await client.post(path, { comment: text });
    return "comment";
  }
}

/** Statuses that mean the customer is no longer waiting for this result. */
export const ABANDONED_STATUS = new Set(["CANCELED", "CANCELLED", "EXPIRED"]);

/**
 * The customer withdrew the Task. Told apart from a crash so the caller can
 * stop without reporting a failure the customer did not cause.
 */
export class TaskAbandoned extends Error {
  constructor(status) {
    super(`Task is ${status}; nothing further was submitted`);
    this.name = "TaskAbandoned";
    this.abandoned = true;
    this.status = status;
  }
}

/**
 * `mustBeLive` re-reads the status and refuses to go on once the Task has been
 * canceled. Checked immediately before anything the customer would be held to
 * - submitting a result, completing the Task - because a cancellation that
 * lands mid-run used to be ignored and the Task was completed anyway.
 * The settlement stages leave it off: the money has already moved there, and
 * the payout still has to be verified and recorded.
 */
export async function verifyRuntimeTask(client, taskId, target, { mustBeLive = false } = {}) {
  const { data: task } = await client.get(
    `/v1/tasks/${encodeURIComponent(taskId)}`,
    AbortSignal.timeout(30000),
  );
  if (task?.id !== taskId) throw new Error("Runtime Task ID does not match");
  assertTaskTarget(task, target);
  if (mustBeLive && ABANDONED_STATUS.has(String(task.status ?? "").toUpperCase()))
    throw new TaskAbandoned(task.status);
  return client;
}
