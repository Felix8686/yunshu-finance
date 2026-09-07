import {
  buildReceiptSourceId,
  downloadTelegramPhoto,
  formatReceiptSummary,
  reconcileReceipt
} from './receipt';
import { analyzeReceiptWithProvider } from './receipt-provider';
import type {
  Env,
  ParsedReceipt,
  ReceiptProcessResult,
  TelegramPhotoSize
} from './types';
import { canonicalizeJson, sha256Hex, type ReceiptCreatePlan } from './finance-v2/protocol';
import { readRuntimeControl } from './finance-v2/persistence';
import { buildReceiptFinanceTurn } from './finance-v2/turn';
import { handleFinanceV2Turn } from './finance-v2/service';

const STALE_PROCESSING_SECONDS = 240;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const PROVIDER_TIMEOUT_MS = 120_000;
const RECEIPT_CONFIDENCE_MIN = 0.8;
const TOTAL_CONFIDENCE_MIN = 0.9;
const ITEM_CONFIDENCE_MIN = 0.55;
const MAX_LOW_CONFIDENCE_ITEM_RATIO = 0.25;

interface ReceiptJobRow {
  job_id: string;
  turn_id: string;
  status: string;
  lease_owner: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  attempt_count: number;
  route_epoch: number;
  receipt_artifact_id: string | null;
}

interface ReceiptArtifactRow {
  receipt_artifact_id: string;
  artifact_json: string;
}

function changes(result: unknown): number {
  return Number((result as { meta?: { changes?: number } } | undefined)?.meta?.changes || 0);
}

function jobIdFor(sourceId: string): string {
  return sourceId;
}

function artifactIdFor(sourceId: string): string {
  return `artifact_${sourceId}`;
}

function receiptFence(job: ReceiptJobRow): { sql: string; params: unknown[] } {
  return {
    sql: `EXISTS (
      SELECT 1 FROM finance_receipt_jobs j
       JOIN finance_runtime_control c ON c.control_id = 'primary'
      WHERE j.job_id = ? AND j.status = 'processing'
        AND j.lease_owner = ? AND j.lease_epoch = ? AND j.route_epoch = ?
        AND c.config_epoch = j.route_epoch
        AND c.receipt_route_mode = 'v2'
    )`,
    params: [job.job_id, job.lease_owner, job.lease_epoch, job.route_epoch]
  };
}

async function loadJob(env: Env, jobId: string): Promise<ReceiptJobRow | null> {
  return env.DB.prepare(
    `SELECT job_id, turn_id, status, lease_owner, lease_epoch,
            lease_expires_at, attempt_count, route_epoch, receipt_artifact_id
       FROM finance_receipt_jobs WHERE job_id = ?`
  ).bind(jobId).first<ReceiptJobRow>();
}

async function ensureAndClaimJob(
  env: Env,
  sourceId: string,
  turnId: string,
  attachmentRef: string,
  caption: string,
  routeEpoch: number
): Promise<{ job: ReceiptJobRow | null; duplicate: boolean; inProgress: boolean }> {
  const jobId = jobIdFor(sourceId);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO finance_receipt_jobs (
       job_id, ledger_scope_id, turn_id, source_event_id, attachment_ref,
       caption, status, route_epoch
     ) VALUES (?, 'personal:primary', ?, ?, ?, ?, 'queued', ?)`
  ).bind(jobId, turnId, sourceId, attachmentRef, caption.trim().slice(0, 1000) || null, routeEpoch).run();

  const before = await loadJob(env, jobId);
  if (!before) throw new Error('FINANCE_RECEIPT_JOB_NOT_FOUND');
  if (before.status === 'committed' || before.status === 'rejected' || before.status === 'failed_terminal') {
    return { job: before, duplicate: true, inProgress: false };
  }
  const owner = `receipt_${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + STALE_PROCESSING_SECONDS * 1000).toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE finance_receipt_jobs
        SET status = 'processing', lease_owner = ?, lease_epoch = lease_epoch + 1,
            lease_expires_at = ?, attempt_count = attempt_count + 1,
            updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND route_epoch = ? AND attempt_count < 3
        AND (status = 'queued' OR status = 'artifact_ready'
             OR (status = 'processing' AND lease_expires_at < ?))
        AND EXISTS (
          SELECT 1 FROM finance_runtime_control c
           WHERE c.control_id = 'primary'
             AND c.config_epoch = finance_receipt_jobs.route_epoch
             AND c.receipt_route_mode = 'v2'
        )`
  ).bind(owner, expiresAt, jobId, before.route_epoch, new Date().toISOString()).run();
  if (changes(claimed) !== 1) {
    const current = await loadJob(env, jobId);
    return {
      job: current,
      duplicate: current?.status === 'committed' || current?.status === 'rejected' || current?.status === 'failed_terminal',
      inProgress: current?.status === 'queued' || current?.status === 'processing' || current?.status === 'artifact_ready'
    };
  }
  const after = await loadJob(env, jobId);
  return { job: after, duplicate: false, inProgress: false };
}

async function finishJob(env: Env, job: ReceiptJobRow, status: 'queued' | 'artifact_ready' | 'committed' | 'rejected' | 'failed_terminal', artifactId: string | null, errorCode: string | null): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE finance_receipt_jobs
        SET status = ?, receipt_artifact_id = COALESCE(?, receipt_artifact_id),
            lease_expires_at = NULL, completed_at = CASE
              WHEN ? IN ('committed', 'rejected', 'failed_terminal') THEN CURRENT_TIMESTAMP
              ELSE completed_at END,
            updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND status IN ('processing', 'artifact_ready')
        AND lease_owner = ? AND lease_epoch = ?`
  ).bind(status, artifactId, status, job.job_id, job.lease_owner, job.lease_epoch).run();
  if (changes(result) !== 1) return false;
  if (errorCode) {
    await env.DB.prepare(
      `UPDATE ingestion_log SET status = ?, error_message = ?
        WHERE source = 'telegram' AND source_id = ?`
    ).bind(status === 'rejected' ? 'rejected' : 'failed', errorCode.slice(0, 300), job.job_id).run();
  } else if (status === 'committed') {
    await env.DB.prepare(
      `UPDATE ingestion_log SET status = 'parsed', error_message = NULL
        WHERE source = 'telegram' AND source_id = ?`
    ).bind(job.job_id).run();
  }
  return true;
}

async function startProviderAttempt(env: Env, job: ReceiptJobRow, provider: string): Promise<string> {
  const providerAttemptId = `provider_${crypto.randomUUID()}`;
  const fence = receiptFence(job);
  const result = await env.DB.prepare(
    `INSERT INTO finance_receipt_provider_attempts (
       provider_attempt_id, ledger_scope_id, job_id, provider,
       job_lease_epoch, attempt_number, status, started_at
     ) SELECT ?, 'personal:primary', ?, ?, ?, ?, 'started', CURRENT_TIMESTAMP
        WHERE ${fence.sql}`
  ).bind(
    providerAttemptId,
    job.job_id,
    provider,
    job.lease_epoch,
    Math.max(1, job.attempt_count),
    ...fence.params
  ).run();
  if (changes(result) !== 1) throw new Error('RECEIPT_JOB_FENCE_LOST');
  return providerAttemptId;
}

async function finishProviderAttempt(env: Env, job: ReceiptJobRow, providerAttemptId: string, status: 'succeeded' | 'failed' | 'unknown', errorCode: string | null): Promise<void> {
  const fence = receiptFence(job);
  await env.DB.prepare(
    `UPDATE finance_receipt_provider_attempts
        SET status = ?, finished_at = CURRENT_TIMESTAMP, error_code = ?
      WHERE provider_attempt_id = ? AND job_id = ? AND job_lease_epoch = ?
        AND ${fence.sql}`
  ).bind(status, errorCode, providerAttemptId, job.job_id, job.lease_epoch, ...fence.params).run();
}

async function storeArtifact(
  env: Env,
  job: ReceiptJobRow,
  providerAttemptId: string,
  artifactId: string,
  receipt: ParsedReceipt,
  reconciliation: ReturnType<typeof reconcileReceipt>
): Promise<void> {
  const artifact = { receipt, reconciliation };
  const artifactJson = canonicalizeJson(artifact);
  const artifactHash = await sha256Hex(artifactJson);
  const fence = receiptFence(job);
  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO finance_receipt_artifacts (
       receipt_artifact_id, ledger_scope_id, job_id, turn_id, source_event_id,
       attachment_ref, provider_attempt_id, job_lease_epoch, schema_version,
       artifact_json, artifact_hash
     ) SELECT ?, 'personal:primary', ?, ?, ?, ?, ?, ?, 2, ?, ?
        WHERE ${fence.sql}`
  ).bind(
    artifactId,
    job.job_id,
    job.turn_id,
    job.job_id,
    job.job_id,
    providerAttemptId,
    job.lease_epoch,
    artifactJson,
    artifactHash,
    ...fence.params
  ).run();
  if (changes(insert) !== 1) {
    const existing = await env.DB.prepare(
      `SELECT receipt_artifact_id FROM finance_receipt_artifacts WHERE job_id = ?`
    ).bind(job.job_id).first<{ receipt_artifact_id: string }>();
    if (existing?.receipt_artifact_id !== artifactId) throw new Error('RECEIPT_ARTIFACT_CONFLICT');
  }
  const marked = await env.DB.prepare(
    `UPDATE finance_receipt_jobs SET status = 'artifact_ready', receipt_artifact_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND status = 'processing' AND lease_owner = ? AND lease_epoch = ?
        AND ${fence.sql}`
  ).bind(artifactId, job.job_id, job.lease_owner, job.lease_epoch, ...fence.params).run();
  if (changes(marked) !== 1) throw new Error('RECEIPT_JOB_FENCE_LOST');
}

async function loadArtifact(env: Env, artifactId: string): Promise<{ receipt: ParsedReceipt; reconciliation: ReturnType<typeof reconcileReceipt> } | null> {
  const row = await env.DB.prepare(
    `SELECT receipt_artifact_id, artifact_json FROM finance_receipt_artifacts WHERE receipt_artifact_id = ?`
  ).bind(artifactId).first<ReceiptArtifactRow>();
  if (!row) return null;
  const parsed = JSON.parse(row.artifact_json) as { receipt: ParsedReceipt; reconciliation: ReturnType<typeof reconcileReceipt> };
  if (!parsed.receipt || !parsed.reconciliation) throw new Error('RECEIPT_ARTIFACT_INVALID');
  return parsed;
}

function validateReceiptSafety(receipt: ParsedReceipt): string | null {
  if (!receipt.is_receipt) return 'NOT_RECEIPT';
  if (!Number.isFinite(receipt.total_amount) || receipt.total_amount <= 0 || receipt.total_amount > 1_000_000) return 'INVALID_TOTAL';
  if (receipt.currency !== 'CNY') return 'UNSUPPORTED_CURRENCY';
  if (receipt.confidence < RECEIPT_CONFIDENCE_MIN) return 'LOW_RECEIPT_CONFIDENCE';
  if (receipt.total_confidence < TOTAL_CONFIDENCE_MIN) return 'LOW_TOTAL_CONFIDENCE';
  if (receipt.items.length === 0 || receipt.items.length > 200) return 'INVALID_ITEM_COUNT';
  let lowConfidenceItems = 0;
  for (const item of receipt.items) {
    if (!item.name || item.quantity <= 0 || item.quantity > 10000) return 'INVALID_ITEM';
    if (!Number.isFinite(item.line_total) || item.line_total < 0 || item.line_total > 1_000_000) return 'INVALID_ITEM_AMOUNT';
    if (item.confidence < ITEM_CONFIDENCE_MIN) lowConfidenceItems += 1;
  }
  return lowConfidenceItems / receipt.items.length > MAX_LOW_CONFIDENCE_ITEM_RATIO
    ? 'TOO_MANY_LOW_CONFIDENCE_ITEMS'
    : null;
}

function normalizeOccurredAt(value: string, fallback: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(value)) return value.slice(0, 19);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T12:00:00`;
  return fallback;
}

function yuanToFen(value: number): number {
  return Math.round(Math.max(0, value) * 100);
}

function accountName(paymentMethod: string): string {
  const value = paymentMethod.trim();
  if (!value || value === '未识别') return '未指定';
  if (/支付宝/.test(value)) return '支付宝';
  if (/微信/.test(value)) return '微信';
  if (/现金/.test(value)) return '现金';
  return value.slice(0, 80);
}

function categoryName(receipt: ParsedReceipt): string {
  let foodFen = 0;
  let dailyFen = 0;
  let otherFen = 0;
  for (const item of receipt.items) {
    const fen = yuanToFen(item.line_total);
    if (['食品', '饮料', '生鲜', '零食'].includes(item.category)) foodFen += fen;
    else if (['日用品', '清洁用品', '个护', '家居'].includes(item.category)) dailyFen += fen;
    else otherFen += fen;
  }
  if (foodFen >= dailyFen && foodFen >= otherFen) return '餐饮';
  if (dailyFen >= foodFen && dailyFen >= otherFen) return '日用品';
  return '其他支出';
}

function buildReceiptPlan(
  receipt: ParsedReceipt,
  reconciliation: ReturnType<typeof reconcileReceipt>,
  jobId: string,
  artifactId: string,
  turnId: string,
  localNow: string,
  caption: string
): ReceiptCreatePlan {
  const merchant = receipt.merchant.trim().slice(0, 160) || '未识别商家';
  return {
    schema_version: 2,
    plan_id: `plan_${artifactId}`,
    plan_version: 1,
    base_session_version: 0,
    source_turn_id: turnId,
    ledger_scope_id: 'personal:primary',
    confidence: receipt.total_confidence,
    presentation: { mode: 'summary', compact: true },
    operation: 'receipt_create',
    receipt_job_id: jobId,
    receipt_artifact_id: artifactId,
    receipt_merchant: merchant,
    receipt_total_fen: reconciliation.receipt_total_fen,
    receipt_item_count: receipt.items.length,
    entries: [{
      client_entry_key: `receipt_${jobId}`,
      type: 'expense',
      money: { amount_fen: reconciliation.receipt_total_fen, currency: 'CNY' },
      occurred_at: normalizeOccurredAt(receipt.occurred_at, localNow),
      account: { kind: 'account', value: accountName(receipt.payment_method) },
      category: { kind: 'category', value: categoryName(receipt) },
      merchant,
      description: `购物小票 · ${merchant} · ${receipt.items.length}项${caption.trim() ? ` · ${caption.trim().slice(0, 160)}` : ''}`,
      items: receipt.items.map((item, index) => ({
        client_item_key: `receipt_item_${index + 1}`,
        name: item.name.trim().slice(0, 160),
        quantity: item.quantity,
        unit_price_fen: item.unit_price === null ? null : yuanToFen(item.unit_price),
        line_total_fen: yuanToFen(item.line_total),
        category: item.category,
        confidence: item.confidence
      }))
    }]
  };
}

function retryableProviderError(message: string): boolean {
  return /TIMEOUT|HTTP_(408|409|425|429|5\d\d)|NETWORK|FETCH|TRANSPORT/i.test(message);
}

function safetyMessage(code: string): string {
  if (code === 'UNSUPPORTED_CURRENCY') return '目前只支持人民币小票，没有记账。';
  if (code === 'LOW_RECEIPT_CONFIDENCE' || code === 'LOW_TOTAL_CONFIDENCE' || code === 'TOO_MANY_LOW_CONFIDENCE_ITEMS') return '小票识别结果不够可靠，请把小票铺平、保证光线充足后重新拍摄。';
  if (code === 'INVALID_ITEM_COUNT' || code === 'INVALID_ITEM' || code === 'INVALID_ITEM_AMOUNT') return '商品明细无法可靠确认，请重新拍清晰一些。';
  return '这张图片看起来不像购物小票，没有记账。';
}

export async function processReceiptQueueJobV3(env: Env, job: {
  chatId: number;
  threadId?: number | null;
  messageId: number;
  updateId: number;
  photo: TelegramPhotoSize;
  caption: string;
  localNow: string;
}): Promise<ReceiptProcessResult> {
  const runtime = await readRuntimeControl(env.DB);
  if (runtime.receipt_route_mode !== 'v2') {
    throw new Error('RECEIPT_V2_ROUTE_NOT_ACTIVE');
  }
  const sourceId = buildReceiptSourceId(job.chatId, job.photo, job.messageId, job.updateId);
  const existingTransaction = await env.DB.prepare(
    `SELECT id FROM transactions WHERE source = 'telegram' AND source_id = ? LIMIT 1`
  ).bind(sourceId).first<{ id: string }>();
  if (existingTransaction?.id) {
    const existingJob = await env.DB.prepare(
      `SELECT status FROM finance_receipt_jobs WHERE job_id = ?`
    ).bind(jobIdFor(sourceId)).first<{ status: string }>();
    return {
      ok: true,
      duplicate: true,
      transactionId: existingTransaction.id,
      message: '这张小票已经记录过，没有重复记账。',
      viaOutbox: existingJob?.status === 'committed'
    };
  }

  const jobId = jobIdFor(sourceId);
  const artifactId = artifactIdFor(sourceId);
  const firstTurn = await buildReceiptFinanceTurn({
    jobId,
    sourceEventId: sourceId,
    attachmentRef: artifactId,
    sessionKey: `telegram:${job.chatId}:topic:${job.threadId || 0}`,
    eventTime: job.localNow,
    caption: job.caption
  });
  const claim = await ensureAndClaimJob(env, sourceId, firstTurn.turn_id, artifactId, job.caption, runtime.config_epoch);
  if (!claim.job) throw new Error('FINANCE_RECEIPT_JOB_NOT_FOUND');
  if (claim.duplicate) {
    return {
      ok: claim.job.status === 'committed',
      duplicate: true,
      message: claim.job.status === 'committed' ? '这张小票已经处理过，没有重复记账。' : '这张小票已经结束处理，没有重复记账。',
      viaOutbox: claim.job.status === 'committed'
    };
  }
  if (claim.inProgress || !claim.job.lease_owner) {
    return { ok: true, duplicate: true, message: '这张小票正在处理中，请稍候。' };
  }

  const jobRow = claim.job;
  const turn = { ...firstTurn, turn_id: jobRow.turn_id };
  let receiptData: { receipt: ParsedReceipt; reconciliation: ReturnType<typeof reconcileReceipt> } | null = null;
  let providerAttemptId: string | null = null;
  try {
    if (jobRow.receipt_artifact_id) receiptData = await loadArtifact(env, jobRow.receipt_artifact_id);
    if (!receiptData) {
      providerAttemptId = await startProviderAttempt(env, jobRow, 'veryfi');
      const downloaded = await withTimeout(downloadTelegramPhoto(env, job.photo), DOWNLOAD_TIMEOUT_MS, 'TELEGRAM_DOWNLOAD_TIMEOUT');
      const receipt = await withTimeout(
        analyzeReceiptWithProvider(env, downloaded.bytes, downloaded.mimeType, job.localNow),
        PROVIDER_TIMEOUT_MS,
        'RECEIPT_PROVIDER_TIMEOUT'
      );
      const reconciliation = reconcileReceipt(receipt);
      await finishProviderAttempt(env, jobRow, providerAttemptId, 'succeeded', null);
      await storeArtifact(env, jobRow, providerAttemptId, artifactId, receipt, reconciliation);
      receiptData = { receipt, reconciliation };
    }

    const safetyError = validateReceiptSafety(receiptData.receipt);
    if (safetyError) {
      await finishJob(env, jobRow, 'rejected', artifactId, safetyError);
      return { ok: false, message: safetyMessage(safetyError) };
    }
    if (!receiptData.reconciliation.ok) {
      await finishJob(env, jobRow, 'rejected', artifactId, `AMOUNT_MISMATCH:${receiptData.reconciliation.difference_fen}`);
      return { ok: false, message: '小票金额核对失败，请确认小票是否拍摄完整、清晰后再发送。' };
    }

    const plan = buildReceiptPlan(
      receiptData.receipt,
      receiptData.reconciliation,
      jobId,
      artifactId,
      turn.turn_id,
      job.localNow,
      job.caption
    );
    const response = await handleFinanceV2Turn(env, turn, {
      ...(job.caption.trim()
        ? {
            orchestratorContext: {
              requiredOperation: 'receipt_create',
              baselinePlan: plan,
              receiptArtifact: receiptData
            }
          }
        : { structuredPlan: plan }),
      telegramDestinationId: String(job.chatId),
      telegramThreadId: job.threadId ? String(job.threadId) : null
    });
    if (response.result.kind !== 'success' || response.result.commit_status !== 'committed') {
      await finishJob(env, jobRow, 'failed_terminal', artifactId, response.result.kind === 'error' || response.result.kind === 'rejected' ? response.result.error.code : 'RECEIPT_FINANCE_NOT_COMMITTED');
      return { ok: false, message: '小票识别完成，但统一记账没有提交成功，请稍后重试。' };
    }
    await finishJob(env, jobRow, 'committed', artifactId, null);
    return {
      ok: true,
      transactionId: response.result.transaction_ids?.[0],
      itemCount: receiptData.receipt.items.length,
      message: formatReceiptSummary(receiptData.receipt, receiptData.reconciliation),
      viaOutbox: true
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (providerAttemptId) {
      await finishProviderAttempt(env, jobRow, providerAttemptId, retryableProviderError(message) ? 'unknown' : 'failed', message);
    }
    if (retryableProviderError(message) && jobRow.attempt_count < 3) {
      await finishJob(env, jobRow, 'queued', null, message);
      throw new Error(`RECEIPT_RETRYABLE:${message}`);
    }
    await finishJob(env, jobRow, 'failed_terminal', null, message);
    return { ok: false, message: '小票识别失败，数据未写入。请稍后重新发送或拍清晰一些。' };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
