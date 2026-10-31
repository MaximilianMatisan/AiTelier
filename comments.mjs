// Follow-up comments on a Sokosumi Task: the chat surface of the agent.
//
// A Task is one conversation. The order starts it, the result the worker
// submitted is the first set of looks, and every comment after that is a turn:
// the customer can change the brief and have it restyled, pick one of the
// looks, and confirm the purchase. logic/chat-session.mjs holds the state and
// does the work; this file only moves text in and out of Sokosumi.
//
// A comment is answered once. Each event id is marked before the turn runs and
// is never picked up again, so a crash mid-turn cannot pay twice.
//
// With AITELIER_PIPELINE=false the agent falls back to the plain LLM, and so
// does this: the comment is relayed to the Eve session that answered the Task.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { client } from "./client.mjs";
import { loadSokosumiRuntime } from "./sokosumi-runtime.mjs";
import {
  taskTarget,
  assertTaskTarget,
  verifyRuntimeTask,
} from "./task-target.mjs";
import {
  loadChat,
  saveChat,
  seedFromRun,
  runTurn,
  runPipelineForChat,
} from "./logic/chat-session.mjs";
import { conversationAsker, conversationModel } from "./logic/conversation.mjs";
import { logger } from "./log.mjs";
const log = logger("comments");
const target = taskTarget();
const {
  readRuntimeCredential,
  createCoworkerHttpClient,
  fetchTaskEvents,
  createTaskEvent,
} = await loadSokosumiRuntime();
const runtime = createCoworkerHttpClient({
  apiKey: readRuntimeCredential(target.coworkerId),
});
// Sokosumi renders one comment as one message; a long presentation is cut
// rather than silently refused by the API.
const MAX_COMMENT_CHARS = 12000;
const chatting = process.env.AITELIER_PIPELINE !== "false";
let asker;

/** The model hook, built once: a chat turn should not re-create the provider. */
async function ask() {
  if (asker === undefined) asker = conversationAsker({ model: await conversationModel() });
  return asker;
}

/** The conversation for this Task, seeded from its finished run on first use. */
async function conversationFor(taskId) {
  const state = loadChat(taskId);
  if (state.messages.length || state.outfits.length) return state;
  return saveChat(await seedFromRun(state, { taskId }));
}

/** What the agent answers one comment with, as the comments to post in order. */
async function chatReply(taskId, comment) {
  const state = await conversationFor(taskId);
  const turn = await runTurn(state, comment, {
    ask: await ask(),
    runStyling: (order) => runPipelineForChat(order, { id: taskId }),
  });
  // Saved before anything is posted: what the agent has already done to the
  // order, or paid for, must survive a failure to post the reply.
  saveChat(turn.state);
  log.info("turn", { task: taskId, status: turn.state.status, posts: turn.posts.length });
  return turn.posts;
}

/** The plain-LLM fallback: relay the comment to the session that answered. */
async function sessionReply(taskId, comment) {
  const sessionFile = `.local/${taskId}-session.json`;
  if (!existsSync(sessionFile)) return [];
  const { sessionId } = JSON.parse(readFileSync(sessionFile, "utf8"));
  if (!sessionId) return [];
  const response = await (
    await client.sessions.attach(sessionId).send(comment.slice(0, 16000))
  ).result();
  if (
    response.status === "failed" ||
    response.inputRequests.length ||
    !response.message?.trim()
  ) {
    log.warn("no reply to comment", { task: taskId, status: response.status });
    return [];
  }
  return [response.message];
}

export async function reply(task) {
  assertTaskTarget(task, target);
  const taskId = task.id;
  await verifyRuntimeTask(runtime, taskId, target);
  const p = `.local/${taskId}-comments.json`;
  const state = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  const { events } = await fetchTaskEvents(
    runtime,
    taskId,
    AbortSignal.timeout(30000),
  );
  for (const event of events.filter(
    (e) =>
      e.actor?.type === "user" &&
      typeof e.comment === "string" &&
      e.comment.trim(),
  )) {
    if (state[event.id]) continue;
    log.info("comment received", { task: taskId, chars: event.comment.length });
    // Marked before the turn runs: a turn that starts a payment and then dies
    // is not repeated on the next poll.
    state[event.id] = "model-pending";
    writeFileSync(p, JSON.stringify(state), { mode: 0o600 });
    const posts = chatting
      ? await chatReply(taskId, event.comment)
      : await sessionReply(taskId, event.comment);
    if (!posts.length) continue;
    state[event.id] = "post-pending";
    writeFileSync(p, JSON.stringify(state), { mode: 0o600 });
    for (const post of posts) {
      await verifyRuntimeTask(runtime, taskId, target);
      await createTaskEvent(
        runtime,
        taskId,
        { comment: post.slice(0, MAX_COMMENT_CHARS) },
        AbortSignal.timeout(30000),
      );
      log.info("reply posted", { task: taskId, chars: post.length });
    }
    state[event.id] = "posted";
    writeFileSync(p, JSON.stringify(state), { mode: 0o600 });
  }
}
