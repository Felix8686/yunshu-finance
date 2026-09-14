import { canonicalizeJson, sha256Hex, type FinancePresentation, type FinanceResult, type RenderPayload } from './protocol';
import { assertRenderCapacity } from './capacity';

function yuan(fen: number): string {
  return `¥${(fen / 100).toFixed(2)}`;
}

function resultText(result: FinanceResult, presentation: FinancePresentation): string {
  if (result.kind === 'clarification') return result.clarification.message;
  if (result.kind === 'rejected' || result.kind === 'error') return result.error.safe_message;
  const lines: string[] = [];
  if (result.operation === 'create' || result.operation === 'receipt_create') {
    const count = result.transaction_ids?.length || 0;
    if (result.operation === 'receipt_create') {
      const merchant = result.receipt_merchant ? ` · ${result.receipt_merchant}` : '';
      const total = typeof result.receipt_total_fen === 'number' ? ` ${yuan(result.receipt_total_fen)}` : '';
      const itemCount = typeof result.receipt_item_count === 'number' ? `，${result.receipt_item_count} 项` : '';
      lines.push(`已记录购物小票${merchant}${total}${itemCount}。`);
    } else {
      lines.push(`已记录 ${count || 1} 笔。`);
    }
  } else if (result.operation === 'update') {
    lines.push(`已更新 ${result.transaction_ids?.length || 0} 笔。`);
  } else if (result.operation === 'delete') {
    lines.push(`已撤销 ${result.transaction_ids?.length || 0} 笔。`);
  } else if (result.operation === 'restore') {
    lines.push(`已恢复 ${result.transaction_ids?.length || 0} 笔。`);
  }
  if (result.summary) {
    lines.push(`共 ${result.summary.transaction_count} 笔，支出 ${yuan(result.summary.expense_fen)}，收入 ${yuan(result.summary.income_fen)}。`);
  }
  if (result.rows?.length) {
    result.rows.forEach((row, index) => {
      const snapshot = row.snapshot as Record<string, unknown>;
      const amount = typeof snapshot.amount_fen === 'number' ? ` ${yuan(snapshot.amount_fen)}` : '';
      const merchant = typeof snapshot.merchant === 'string' && snapshot.merchant ? ` · ${snapshot.merchant}` : '';
      lines.push(`${index + 1}. ${row.entity_id}${amount}${merchant}`);
    });
    if (result.page?.has_next || (presentation.page_size && result.rows.length >= presentation.page_size)) lines.push('可以继续说“下一页”。');
  }
  if (result.operation === 'analyze' && result.analysis_data) lines.push(`分析：${JSON.stringify(result.analysis_data)}`);
  if (result.operation === 'compare' && result.comparison_data) lines.push(`对比：${JSON.stringify(result.comparison_data)}`);
  return lines.join('\n') || '已完成。';
}

function splitTelegramText(text: string, max = 4096): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= max) {
      current = candidate;
    } else {
      if (current) parts.push(current);
      if (line.length <= max) current = line;
      else {
        for (let offset = 0; offset < line.length; offset += max) parts.push(line.slice(offset, offset + max));
        current = '';
      }
    }
  }
  if (current) parts.push(current);
  return parts.length ? parts : [''];
}

export async function renderFinanceResult(
  result: FinanceResult,
  presentation: FinancePresentation = {}
): Promise<{ payload: RenderPayload; render_hash: string }> {
  const parts = splitTelegramText(resultText(result, presentation)).map((text, partIndex) => ({ partIndex, text }));
  const telegramParts = [];
  for (const part of parts) {
    telegramParts.push({
      part_index: part.partIndex,
      text: part.text,
      part_hash: await sha256Hex(part.text)
    });
  }
  const payload: RenderPayload = { schema_version: 2, telegram_parts: telegramParts };
  assertRenderCapacity(payload);
  return { payload, render_hash: await sha256Hex(canonicalizeJson(payload)) };
}
