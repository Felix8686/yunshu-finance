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
import {
  canonicalizeJson,
  sha256Hex,
  type ReceiptArtifact,
  type ReceiptCreatePlan,
  type ReceiptEnvelope,
  type ReceiptJob,
  type ReceiptProvider,
  type ReceiptProviderAttemptStatus,
  type ReceiptJobStatus,
  type TurnContextSnapshot
} from './finance-v2/protocol';
import { readRuntimeControl } from './finance-v2/persistence';
import { MAX_OPERATION_ATTEMPTS, MAX_RECEIPT_ITEMS } from './finance-v2/capacity';
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
  source_event_id: string;
  attachment_ref: string;
  caption: string | null;
  status: ReceiptJobStatus;
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
    `SELECT job_id, turn_id, source_event_id, attachment_ref, caption, status, lease_owner, lease_epoch,
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
      WHERE job_id = ? AND route_epoch = ? AND attempt_count < ?
        AND (status = 'queued' OR status = 'artifact_ready'
             OR (status = 'processing' AND lease_expires_at < ?))
        AND EXISTS (
          SELECT 1 FROM finance_runtime_control c
           WHERE c.control_id = 'primary'
             AND c.config_epoch = finance_receipt_jobs.route_epoch
             AND c.receipt_route_mode = 'v2'
        )`
  ).bind(owner, expiresAt, jobId, before.route_epoch, MAX_OPERATION_ATTEMPTS, new Date().toISOString()).run();
  if (changes(claimed) !== 1) {
    const current = await loadJob(env, jobId);
    if (current?.status === 'processing') {
      const latestRuntime = await readRuntimeControl(env.DB);
      if (latestRuntime.receipt_route_mode !== 'v2') throw new Error('RECEIPT_ROUTE_RETRY');
      if (latestRuntime.config_epoch !== current.route_epoch) {
        const recovered = await env.DB.prepare(
          `UPDATE finance_receipt_jobs
              SET status = CASE WHEN receipt_artifact_id IS NULL THEN 'queued' ELSE 'artifact_ready' END,
                  route_epoch = ?, lease_owner = NULL, lease_expires_at = NULL,
                  updated_at = CURRENT_TIMESTAMP
            WHERE job_id = ? AND status = 'processing' AND route_epoch = ?`
        ).bind(latestRuntime.config_epoch, jobId, current.route_epoch).run();
        if (changes(recovered) === 1) throw new Error('RECEIPT_ROUTE_RETRY');
      }
    }
    if (current && (current.status === 'queued' || current.status === 'artifact_ready')) {
      if (current.attempt_count >= MAX_OPERATION_ATTEMPTS) {
        await env.DB.prepare(
          `UPDATE finance_receipt_jobs
              SET status = 'failed_terminal', lease_owner = NULL, lease_expires_at = NULL,
                  completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE job_id = ? AND status IN ('queued', 'artifact_ready') AND attempt_count >= ?`
        ).bind(jobId, MAX_OPERATION_ATTEMPTS).run();
        const settled = await loadJob(env, jobId);
        return {
          job: settled,
          duplicate: settled?.status === 'failed_terminal',
          inProgress: false
        };
      }
      const latestRuntime = await readRuntimeControl(env.DB);
      if (latestRuntime.receipt_route_mode !== 'v2') {
        throw new Error('RECEIPT_ROUTE_RETRY');
      }
      if (latestRuntime.config_epoch !== current.route_epoch) {
        await env.DB.prepare(
          `UPDATE finance_receipt_jobs
              SET route_epoch = ?, updated_at = CURRENT_TIMESTAMP
            WHERE job_id = ? AND status IN ('queued', 'artifact_ready') AND route_epoch = ?`
        ).bind(latestRuntime.config_epoch, jobId, current.route_epoch).run();
        throw new Error('RECEIPT_ROUTE_RETRY');
      }
      throw new Error('RECEIPT_CLAIM_RETRY');
    }
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
        AND lease_owner = ? AND lease_epoch = ? AND route_epoch = ?
        AND EXISTS (
          SELECT 1 FROM finance_runtime_control c
           WHERE c.control_id = 'primary'
             AND c.config_epoch = finance_receipt_jobs.route_epoch
             AND c.receipt_route_mode = 'v2'
        )`
  ).bind(status, artifactId, status, job.job_id, job.lease_owner, job.lease_epoch, job.route_epoch).run();
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

async function startProviderAttempt(env: Env, job: ReceiptJobRow, provider: ReceiptProvider): Promise<string> {
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

async function finishProviderAttempt(env: Env, job: ReceiptJobRow, providerAttemptId: string, status: Exclude<ReceiptProviderAttemptStatus, 'started'>, errorCode: string | null): Promise<void> {
  const fence = receiptFence(job);
  const result = await env.DB.prepare(
    `UPDATE finance_receipt_provider_attempts
        SET status = ?, finished_at = CURRENT_TIMESTAMP, error_code = ?
      WHERE provider_attempt_id = ? AND job_id = ? AND job_lease_epoch = ?
        AND ${fence.sql}`
  ).bind(status, errorCode, providerAttemptId, job.job_id, job.lease_epoch, ...fence.params).run();
  if (changes(result) !== 1) throw new Error('RECEIPT_JOB_FENCE_LOST');
}

async function storeArtifact(
  env: Env,
  job: ReceiptJobRow,
  providerAttemptId: string,
  artifactId: string,
  receipt: ParsedReceipt,
  reconciliation: ReturnType<typeof reconcileReceipt>
): Promise<ReceiptArtifact> {
  const artifactBody: Omit<ReceiptArtifact, 'artifact_hash'> = {
    schema_version: 2,
    receipt_artifact_id: artifactId,
    job_id: job.job_id,
    turn_id: job.turn_id,
    source_event_id: job.source_event_id,
    attachment_ref: job.attachment_ref,
    provider_attempt_id: providerAttemptId,
    job_lease_epoch: job.lease_epoch,
    merchant: receipt.merchant.trim() || null,
    total_fen: reconciliation.receipt_total_fen,
    currency: 'CNY',
    occurred_at: receipt.occurred_at.trim() || null,
    payment_hint: receipt.payment_method.trim() || null,
    items: receipt.items.map((item, index) => ({
      item_key: `receipt_item_${index + 1}`,
      name: item.name.trim(),
      quantity: item.quantity,
      unit_price_fen: item.unit_price === null ? null : Math.round(item.unit_price * 100),
      line_total_fen: Math.round(item.line_total * 100),
      raw_category_label: item.category,
      mapped_category: item.category,
      category_mapping_version: 'receipt-item-v1' as const,
      confidence: item.confidence
    })),
    reconciliation: {
      status: reconciliation.ok
        ? reconciliation.difference_fen === 0 ? 'matched' : 'within_rounding_tolerance'
        : 'mismatch',
      items_total_fen: reconciliation.items_total_fen,
      receipt_total_fen: reconciliation.receipt_total_fen,
      delta_fen: reconciliation.difference_fen,
      tolerance_fen: 2
    },
    validated_at: new Date().toISOString()
  };
  const artifactHash = await sha256Hex(canonicalizeJson(artifactBody));
  const artifact: ReceiptArtifact = { ...artifactBody, artifact_hash: artifactHash };
  const artifactJson = canonicalizeJson(artifact);
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
    job.source_event_id,
    job.attachment_ref,
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
  return artifact;
}

async function loadArtifact(env: Env, artifactId: string): Promise<{ receipt: ParsedReceipt; reconciliation: ReturnType<typeof reconcileReceipt>; artifact: ReceiptArtifact } | null> {
  const row = await env.DB.prepare(
    `SELECT receipt_artifact_id, artifact_json FROM finance_receipt_artifacts WHERE receipt_artifact_id = ?`
  ).bind(artifactId).first<ReceiptArtifactRow>();
  if (!row) return null;
  const artifact = JSON.parse(row.artifact_json) as ReceiptArtifact;
  if (artifact.schema_version !== 2 || artifact.receipt_artifact_id !== artifactId || !Array.isArray(artifact.items) || !artifact.reconciliation) {
    throw new Error('RECEIPT_ARTIFACT_INVALID');
  }
  const { artifact_hash: storedHash, ...artifactBody } = artifact;
  if (storedHash !== await sha256Hex(canonicalizeJson(artifactBody))) throw new Error('RECEIPT_ARTIFACT_HASH_MISMATCH');
  const receipt: ParsedReceipt = {
    is_receipt: true,
    merchant: artifact.merchant || '',
    occurred_at: artifact.occurred_at || '',
    currency: artifact.currency,
    total_amount: artifact.total_fen / 100,
    subtotal_amount: null,
    discount_amount: 0,
    tax_amount: 0,
    rounding_amount: 0,
    payment_method: artifact.payment_hint || '',
    confidence: 1,
    total_confidence: 1,
    items: artifact.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unit_price: item.unit_price_fen === null || item.unit_price_fen === undefined ? null : item.unit_price_fen / 100,
      line_total: item.line_total_fen / 100,
      category: item.mapped_category,
      confidence: item.confidence
    })),
    rejection_reason: ''
  };
  return {
    receipt,
    reconciliation: {
      ok: artifact.reconciliation.status === 'matched' || artifact.reconciliation.status === 'within_rounding_tolerance',
      items_total_fen: artifact.reconciliation.items_total_fen,
      discount_fen: 0,
      tax_fen: 0,
      rounding_fen: 0,
      expected_total_fen: artifact.reconciliation.receipt_total_fen - artifact.reconciliation.delta_fen,
      receipt_total_fen: artifact.reconciliation.receipt_total_fen,
      difference_fen: artifact.reconciliation.delta_fen
    },
    artifact
  };
}

function protocolReceiptJob(job: ReceiptJobRow): ReceiptJob {
  return {
    schema_version: 2,
    job_id: job.job_id,
    ledger_scope_id: 'personal:primary',
    turn_id: job.turn_id,
    source_event_id: job.source_event_id,
    attachment_ref: job.attachment_ref,
    caption: job.caption,
    status: job.status,
    lease_owner: job.lease_owner,
    lease_epoch: job.lease_epoch,
    lease_expires_at: job.lease_expires_at,
    attempt_count: job.attempt_count,
    route_epoch: job.route_epoch,
    receipt_artifact_id: job.receipt_artifact_id
  };
}

async function loadReceiptContextSnapshot(env: Env, turnId: string): Promise<TurnContextSnapshot> {
  const row = await env.DB.prepare(
    `SELECT context_snapshot_json, context_snapshot_hash FROM finance_turns WHERE turn_id = ?`
  ).bind(turnId).first<{ context_snapshot_json: string | null; context_snapshot_hash: string | null }>();
  if (!row?.context_snapshot_json || !row.context_snapshot_hash) throw new Error('RECEIPT_CONTEXT_SNAPSHOT_MISSING');
  if (await sha256Hex(row.context_snapshot_json) !== row.context_snapshot_hash) throw new Error('RECEIPT_CONTEXT_SNAPSHOT_HASH_MISMATCH');
  const snapshot = JSON.parse(row.context_snapshot_json) as TurnContextSnapshot;
  if (snapshot.schema_version !== 2 || snapshot.turn_id !== turnId) throw new Error('RECEIPT_CONTEXT_SNAPSHOT_INVALID');
  if (!/^[a-f0-9]{64}$/.test(snapshot.catalog_hash) || !/^[a-f0-9]{64}$/.test(snapshot.snapshot_hash)) throw new Error('RECEIPT_CONTEXT_SNAPSHOT_INVALID');
  const { snapshot_hash: storedSnapshotHash, ...snapshotBody } = snapshot;
  if (storedSnapshotHash !== await sha256Hex(canonicalizeJson({ ...snapshotBody, snapshot_hash: '' }))) throw new Error('RECEIPT_CONTEXT_SNAPSHOT_HASH_MISMATCH');
  return snapshot;
}

function validateReceiptSafety(receipt: ParsedReceipt): string | null {
  if (!receipt.is_receipt) return 'NOT_RECEIPT';
  if (!Number.isFinite(receipt.total_amount) || receipt.total_amount <= 0 || receipt.total_amount > 1_000_000) return 'INVALID_TOTAL';
  if (receipt.currency !== 'CNY') return 'UNSUPPORTED_CURRENCY';
  if (receipt.confidence < RECEIPT_CONFIDENCE_MIN) return 'LOW_RECEIPT_CONFIDENCE';
  if (receipt.total_confidence < TOTAL_CONFIDENCE_MIN) return 'LOW_TOTAL_CONFIDENCE';
  if (receipt.items.length === 0 || receipt.items.length > MAX_RECEIPT_ITEMS) return 'INVALID_ITEM_COUNT';
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
      `SELECT status, turn_id FROM finance_receipt_jobs WHERE job_id = ?`
    ).bind(jobIdFor(sourceId)).first<{ status: string; turn_id: string }>();
    let committedJob = existingJob?.status === 'committed';
    if (existingJob && !committedJob) {
      const committedOperation = await env.DB.prepare(
        `SELECT operation_id FROM finance_operations
          WHERE turn_id = ? AND operation_type = 'receipt_create' AND status = 'committed'
          LIMIT 1`
      ).bind(existingJob.turn_id).first<{ operation_id: string }>();
      if (committedOperation) {
        const settled = await env.DB.prepare(
          `UPDATE finance_receipt_jobs
              SET status = 'committed', lease_owner = NULL, lease_expires_at = NULL,
                  completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
            WHERE job_id = ? AND status IN ('queued', 'processing', 'artifact_ready')`
        ).bind(jobIdFor(sourceId)).run();
        committedJob = changes(settled) === 1 || existingJob.status === 'committed';
      }
    }
    return {
      ok: true,
      duplicate: true,
      transactionId: existingTransaction.id,
      message: '这张小票已经记录过，没有重复记账。',
      viaOutbox: committedJob
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
  let receiptData: { receipt: ParsedReceipt; reconciliation: ReturnType<typeof reconcileReceipt>; artifact?: ReceiptArtifact } | null = null;
  let providerAttemptId: string | null = null;
  let financeCommitted = false;
  let committedTransactionId: string | undefined;
  let committedMessage = '';
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
      receiptData = { receipt, reconciliation };
    }

    const safetyError = validateReceiptSafety(receiptData.receipt);
    if (safetyError) {
      if (!await finishJob(env, jobRow, 'rejected', receiptData.artifact ? artifactId : null, safetyError)) throw new Error('RECEIPT_JOB_FENCE_LOST');
      return { ok: false, message: safetyMessage(safetyError) };
    }
    if (!receiptData.reconciliation.ok) {
      if (!await finishJob(env, jobRow, 'rejected', receiptData.artifact ? artifactId : null, `AMOUNT_MISMATCH:${receiptData.reconciliation.difference_fen}`)) throw new Error('RECEIPT_JOB_FENCE_LOST');
      return { ok: false, message: '小票金额核对失败，请确认小票是否拍摄完整、清晰后再发送。' };
    }
    if (!receiptData.artifact) {
      if (!providerAttemptId) throw new Error('RECEIPT_ARTIFACT_MISSING');
      receiptData.artifact = await storeArtifact(env, jobRow, providerAttemptId, artifactId, receiptData.receipt, receiptData.reconciliation);
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
              receiptArtifact: receiptData.artifact || receiptData
            }
          }
        : { structuredPlan: plan }),
      telegramDestinationId: String(job.chatId),
      telegramThreadId: job.threadId ? String(job.threadId) : null
    });
    if (response.result.kind !== 'success' || response.result.commit_status !== 'committed') {
      if (!await finishJob(env, jobRow, 'failed_terminal', artifactId, response.result.kind === 'error' || response.result.kind === 'rejected' ? response.result.error.code : 'RECEIPT_FINANCE_NOT_COMMITTED')) throw new Error('RECEIPT_JOB_FENCE_LOST');
      return { ok: false, message: '小票识别完成，但统一记账没有提交成功，请稍后重试。' };
    }
    financeCommitted = true;
    committedTransactionId = response.result.transaction_ids?.[0];
    committedMessage = formatReceiptSummary(receiptData.receipt, receiptData.reconciliation);
    if (!receiptData.artifact) throw new Error('RECEIPT_ARTIFACT_MISSING');
    const envelope: ReceiptEnvelope = {
      schema_version: 2,
      job: protocolReceiptJob(jobRow),
      artifact: receiptData.artifact,
      source_turn: turn,
      context_snapshot: await loadReceiptContextSnapshot(env, turn.turn_id)
    };
    if (envelope.context_snapshot.catalog_hash.length !== 64) throw new Error('RECEIPT_CONTEXT_SNAPSHOT_INVALID');
    if (!await finishJob(env, jobRow, 'committed', artifactId, null)) throw new Error('RECEIPT_JOB_FENCE_LOST');
    return {
      ok: true,
      transactionId: committedTransactionId,
      itemCount: receiptData.receipt.items.length,
      message: committedMessage,
      viaOutbox: true
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (financeCommitted) {
      if (!await finishJob(env, jobRow, 'committed', artifactId, null)) throw new Error('RECEIPT_JOB_FENCE_LOST');
      return {
        ok: true,
        transactionId: committedTransactionId,
        itemCount: receiptData?.receipt.items.length,
        message: committedMessage || '已完成记账，但回执审计确认需要稍后补齐。',
        viaOutbox: true
      };
    }
    if (providerAttemptId) {
      await finishProviderAttempt(env, jobRow, providerAttemptId, retryableProviderError(message) ? 'unknown' : 'failed', message);
    }
    if ((retryableProviderError(message) || message === 'RECEIPT_JOB_FENCE_LOST') && jobRow.attempt_count < MAX_OPERATION_ATTEMPTS) {
      await finishJob(env, jobRow, 'queued', null, message);
      throw new Error(`RECEIPT_RETRYABLE:${message}`);
    }
    if (!await finishJob(env, jobRow, 'failed_terminal', null, message)) throw new Error('RECEIPT_JOB_FENCE_LOST');
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
