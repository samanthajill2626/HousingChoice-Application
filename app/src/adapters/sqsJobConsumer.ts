// SQS jobs consumer — the worker-side intake for job envelopes (M1.2).
//
// EventBridge Scheduler one-off schedules (created by jobs.enqueue() through
// the EventBridgeSchedulerAdapter) deliver each JSON JobEnvelope as an SQS
// message BODY; this long-polls the jobs queue and hands every body to
// dispatchJob() — the consumer gate, which validates the envelope, mints a
// fresh jobRunId, and rehydrates AsyncLocalStorage before any handler runs.
//
// Delete semantics (SQS is at-least-once — handlers must tolerate the rare
// duplicate delivery, e.g. a job overrunning the 120s visibility timeout):
//   - handler success           -> DeleteMessage
//   - handler/unknown-job throw -> NO delete: the visibility timeout
//                                  redelivers; after maxReceiveCount (5) SQS
//                                  dead-letters the message and the
//                                  hc-<env>-jobs-dlq-depth alarm pages
//   - unparseable body or       -> ERROR + DeleteMessage: a poison message
//     malformed envelope           can never succeed on redelivery. Per doc
//                                  §9, envelope-less payloads get a
//                                  synthesized context plus a warning —
//                                  never blind, never crashed.
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type DeleteMessageCommandOutput,
  type Message,
  type ReceiveMessageCommandOutput,
} from '@aws-sdk/client-sqs';
import { MalformedJobEnvelopeError } from '../jobs/jobs.js';
import { newBootId, runWithContext, type CorrelationContext } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';

/** Minimal client surface so tests can inject a fake (no AWS calls). */
export interface SqsClientLike {
  send(
    command: ReceiveMessageCommand | DeleteMessageCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ReceiveMessageCommandOutput | DeleteMessageCommandOutput>;
}

export interface SqsJobConsumerDeps {
  /** Injected so unit tests can use a fake; real SQSClient in the worker. */
  client: SqsClientLike;
  /** The jobs queue URL (config.jobsQueueUrl / JOBS_QUEUE_URL). */
  queueUrl: string;
  /** The consumer gate — dispatchJob in production; injectable for tests. */
  dispatch: (rawEvent: unknown) => Promise<void>;
  /**
   * Correlation context for CONSUMER-level log lines (the worker passes its
   * bootContext): transport errors, poison-message deletions. Handler-side
   * logs never use it — dispatchJob rehydrates the envelope's own context
   * with a fresh jobRunId. Default: a synthesized bootId context (doc §9 —
   * these lines must never be orphans). Falls back per-line, so it cannot
   * trip the orphan-log alarm.
   */
  baseContext?: CorrelationContext;
  logger?: Logger;
  /** Long-poll wait in seconds (default 20 — the SQS maximum). */
  waitTimeSeconds?: number;
  /** Messages per receive, 1..10 (default 10). */
  maxMessagesPerPoll?: number;
  /** Backoff after a failed ReceiveMessage call, ms (default 5000). */
  receiveErrorBackoffMs?: number;
}

export class SqsJobConsumer {
  private readonly log: Logger;
  private readonly baseContext: CorrelationContext;
  private running = false;
  private loop: Promise<void> | undefined;
  private abort: AbortController | undefined;

  constructor(private readonly deps: SqsJobConsumerDeps) {
    this.log = deps.logger ?? defaultLogger;
    this.baseContext = deps.baseContext ?? { bootId: newBootId() };
  }

  /** Begin long-polling. Idempotent — a running consumer is left alone. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.pollLoop();
  }

  /**
   * Graceful shutdown (SIGTERM): abort the in-flight long poll, stop
   * polling, and resolve only after every in-flight handler has finished
   * (success deletes included) — a job is never killed mid-run by stop().
   */
  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loop;
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      let received: ReceiveMessageCommandOutput;
      try {
        received = (await this.deps.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.deps.queueUrl,
            WaitTimeSeconds: this.deps.waitTimeSeconds ?? 20,
            MaxNumberOfMessages: this.deps.maxMessagesPerPoll ?? 10,
          }),
          { abortSignal: this.abort?.signal },
        )) as ReceiveMessageCommandOutput;
      } catch (err) {
        if (!this.running) break; // stop() aborted the long poll — clean exit
        this.runInBase(() =>
          this.log.error({ err }, 'jobs consumer: ReceiveMessage failed — backing off'),
        );
        await this.sleep(this.deps.receiveErrorBackoffMs ?? 5000);
        continue;
      }

      const messages = received.Messages ?? [];
      if (messages.length === 0) continue;
      // In parallel on purpose: each message's 120s visibility budget starts
      // at receive, so serializing a batch would burn slot N's budget while
      // slots 1..N-1 run. handleMessage never rejects.
      await Promise.all(messages.map((message) => this.handleMessage(message)));
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    const sqsMessageId = message.MessageId;

    let parsed: unknown;
    try {
      parsed = JSON.parse(message.Body ?? '') as unknown;
    } catch (err) {
      this.runInBase(() =>
        this.log.error(
          { err, sqsMessageId },
          'jobs consumer: unparseable message body — deleting poison message',
        ),
      );
      await this.deleteMessage(message, 'poison');
      return;
    }

    try {
      await this.deps.dispatch(parsed);
    } catch (err) {
      if (err instanceof MalformedJobEnvelopeError) {
        // dispatchJob already ERROR-logged the rejection; redelivery can
        // never fix a malformed envelope — delete instead of DLQ-cycling.
        this.runInBase(() =>
          this.log.warn(
            { sqsMessageId },
            'jobs consumer: malformed job envelope — deleting poison message',
          ),
        );
        await this.deleteMessage(message, 'poison');
        return;
      }
      // Handler (or unknown-job) failure. dispatchJob ERROR-logged it inside
      // the job's own correlation context — warn (not error) here so one
      // failure costs exactly one ERROR line. NO delete: visibility timeout
      // redelivers; the 5th receive dead-letters (DLQ-depth alarm).
      this.runInBase(() =>
        this.log.warn(
          { sqsMessageId },
          'jobs consumer: dispatch failed — message left for redelivery (DLQ after 5 receives)',
        ),
      );
      return;
    }

    await this.deleteMessage(message, 'done');
  }

  private async deleteMessage(message: Message, reason: 'done' | 'poison'): Promise<void> {
    try {
      await this.deps.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.deps.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    } catch (err) {
      // The message will redeliver after the visibility timeout (at-least-
      // once); nothing is lost — log and move on.
      this.runInBase(() =>
        this.log.error(
          { err, sqsMessageId: message.MessageId, reason },
          'jobs consumer: DeleteMessage failed — message will redeliver',
        ),
      );
    }
  }

  private runInBase<T>(fn: () => T): T {
    return runWithContext(this.baseContext, fn);
  }

  /** Abort-aware backoff so stop() never waits out an error backoff. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.abort?.signal;
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
