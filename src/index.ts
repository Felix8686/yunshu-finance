import { createTransactions, isUpdateProcessed, runReport, undoLatestTransactionGroup, type ReportResult, type SummaryResult } from "./db";
import { interpretFinanceCommand, interpretFinanceCommandFromImage } from "./deepseek";
import { MediaDownloadError, MediaTooLargeError, arrayBufferToBase64, fetchTelegramMedia, transcribeVoice } from "./media";
import type { Env, FinanceCommand } from "./types";

interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
  width: number;
  height: number;
}

interface TelegramDocument {
  file_id: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVoice {
  file_id: string;
  mime_type?: string;
  file_size?: number;
  duration?: number;
}

interface TelegramUpdate {
  message?: {
    message_id: number;
    text?: string;
    caption?: string;
    photo?: TelegramPhotoSize[];
    document?: TelegramDocument;
    voice?: TelegramVoice;
    chat: { id: number };
    from?: { id: number };
  };
}

const SUPPORTED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const VISION_FALLBACK_MODEL = "deepseek-v4-flash-vision-exp";

function pickLargestPhoto(photo: TelegramPhotoSize[]): TelegramPhotoSize {
  return photo.reduce((largest, item) => ((item.file_size ?? 0) > (largest.file_size ?? 0) ? item : largest));
}

function yuan(fen: number): string {
  return `¥${(fen / 100).toFixed(2)}`;
}

function summaryLines(label: string, summary: SummaryResult): string[] {
  const balance = summary.income_fen - summary.expense_fen;
  return [
    label,
    `收入：${yuan(summary.income_fen)}`,
    `支出：${yuan(summary.expense_fen)}`,
    `结余：${balance < 0 ? "-" : "+"}${yuan(Math.abs(balance))}`,
    `记录：${summary.count} 笔`,
  ];
}

function deltaText(name: string, current: number, previous: number): string {
  const delta = current - previous;
  if (delta === 0) return `${name}：持平`;
  const direction = delta > 0 ? "增加" : "减少";
  const absolute = yuan(Math.abs(delta));
  if (previous === 0) return `${name}：${direction} ${absolute}`;
  const percent = (Math.abs(delta) / previous) * 100;
  return `${name}：${direction} ${absolute}（${percent.toFixed(1)}%）`;
}

function renderReport(result: ReportResult): string {
  if (result.kind === "summary") {
    return summaryLines(result.range.label, result.summary).join("\n");
  }

  if (result.kind === "details") {
    const lines = summaryLines(result.range.label, result.summary);
    if (result.rows.length === 0) return `${lines.join("\n")}\n\n没有找到明细。`;
    lines.push("", "明细：");
    for (const row of result.rows) {
      const sign = row.type === "expense" ? "-" : "+";
      const description = row.description ? ` ${row.description}` : "";
      lines.push(`${row.occurred_at.slice(0, 10)} ${sign}${yuan(row.amount_fen)} ${row.category}${description} · ${row.account}`);
    }
    return lines.join("\n");
  }

  if (result.kind === "category_breakdown") {
    const lines = summaryLines(result.range.label, result.summary);
    if (result.rows.length === 0) return `${lines.join("\n")}\n\n没有找到分类数据。`;
    lines.push("", "分类：");
    for (const row of result.rows) {
      const name = row.type === "expense" ? "支出" : "收入";
      lines.push(`${name} · ${row.category}：${yuan(row.amount_fen)}（${row.count} 笔）`);
    }
    return lines.join("\n");
  }

  const lines = [
    ...summaryLines(result.range.label, result.current),
    "",
    ...summaryLines(result.compare_range.label, result.previous),
    "",
    "变化：",
    deltaText("收入", result.current.income_fen, result.previous.income_fen),
    deltaText("支出", result.current.expense_fen, result.previous.expense_fen),
  ];
  return lines.join("\n");
}

async function sendTelegram(env: Env, chatId: string, text: string, replyToMessageId?: string): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: text.slice(0, 4000),
  };
  if (replyToMessageId) {
    body.reply_to_message_id = Number(replyToMessageId);
    body.allow_sending_without_reply = true;
  }

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
  }
}

function renderCreate(command: Extract<FinanceCommand, { action: "create" }>): string {
  const lines = [`已记录 ${command.transactions.length} 笔：`];
  for (const item of command.transactions) {
    const sign = item.type === "expense" ? "-" : "+";
    const description = item.description ? ` ${item.description}` : "";
    lines.push(`${sign}${yuan(item.amount_fen)} ${item.category}${description} · ${item.account}`);
  }
  return lines.join("\n");
}

async function interpretPhoto(
  env: Env,
  timeZone: string,
  fileId: string,
  mimeType: string,
  caption: string,
): Promise<FinanceCommand> {
  const media = await fetchTelegramMedia(env, fileId);
  const imageBase64 = arrayBufferToBase64(media);
  const visionModel = env.DEEPSEEK_VISION_MODEL || VISION_FALLBACK_MODEL;
  return interpretFinanceCommandFromImage(env.DEEPSEEK_API_KEY, visionModel, timeZone, imageBase64, mimeType, caption);
}

async function handleUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message?.from) return;

  const chatId = String(message.chat.id);
  const messageId = String(message.message_id);

  if (String(message.from.id) !== env.OWNER_TELEGRAM_ID) {
    await sendTelegram(env, chatId, "该机器人仅供所有者使用。", messageId);
    return;
  }

  // Deterministic replay guard: a redelivered update must never reach the
  // interpreter again, so state-changing actions execute exactly once.
  if (await isUpdateProcessed(env.DB, chatId, messageId)) {
    await sendTelegram(env, chatId, "这条消息已经处理过，没有重复执行。", messageId);
    return;
  }

  const timeZone = env.APP_TIMEZONE || "Asia/Shanghai";
  const model = env.DEEPSEEK_MODEL || "deepseek-chat";

  let command: FinanceCommand;
  let rawText: string;
  try {
    if (message.text) {
      command = await interpretFinanceCommand(env.DEEPSEEK_API_KEY, model, timeZone, message.text);
      rawText = message.text;
    } else if (Array.isArray(message.photo) && message.photo.length > 0) {
      const photo = pickLargestPhoto(message.photo);
      command = await interpretPhoto(env, timeZone, photo.file_id, "image/jpeg", message.caption ?? "");
      rawText = `[image] ${message.caption ?? ""}`.trim();
    } else if (message.document && SUPPORTED_IMAGE_MIME.has(message.document.mime_type ?? "")) {
      command = await interpretPhoto(env, timeZone, message.document.file_id, message.document.mime_type as string, message.caption ?? "");
      rawText = `[image] ${message.caption ?? ""}`.trim();
    } else if (message.voice) {
      const transcript = await transcribeVoice(env, message.voice.file_id);
      if (!transcript) {
        await sendTelegram(env, chatId, "语音识别失败，请重新发送。", messageId);
        return;
      }
      command = await interpretFinanceCommand(env.DEEPSEEK_API_KEY, model, timeZone, transcript);
      rawText = `[voice] ${transcript}`;
    } else if (message.document) {
      await sendTelegram(env, chatId, "目前只支持图片和语音消息。", messageId);
      return;
    } else {
      return;
    }
  } catch (error) {
    if (error instanceof MediaTooLargeError) {
      await sendTelegram(env, chatId, "文件过大，目前无法处理。", messageId);
      return;
    }
    if (error instanceof MediaDownloadError) {
      await sendTelegram(env, chatId, "文件下载失败，请重新发送。", messageId);
      return;
    }
    const isImage = Array.isArray(message.photo) || (!!message.document && SUPPORTED_IMAGE_MIME.has(message.document.mime_type ?? ""));
    if (!message.text && isImage) {
      await sendTelegram(env, chatId, "图片无法读取，请重新发送。", messageId);
      return;
    }
    if (!message.text && message.voice) {
      await sendTelegram(env, chatId, "语音识别失败，请重新发送。", messageId);
      return;
    }
    throw error;
  }

  console.log(`yunshu command chat=${chatId} msg=${messageId} text=${JSON.stringify(rawText.slice(0, 200))} command=${JSON.stringify(command)}`);

  if (command.action === "create") {
    const result = await createTransactions(env.DB, command.transactions, {
      chatId,
      messageId,
      rawText,
    });
    const reply = result.duplicate
      ? "这条消息已经处理过，没有重复入账。"
      : renderCreate(command);
    await sendTelegram(env, chatId, reply, messageId);
    return;
  }

  if (command.action === "report") {
    const report = await runReport(env.DB, command);
    await sendTelegram(env, chatId, renderReport(report), messageId);
    return;
  }

  if (command.action === "undo") {
    const result = await undoLatestTransactionGroup(env.DB, chatId, messageId);
    const reply = result.duplicate
      ? "这条撤销已经执行过，没有重复删除。"
      : result.found
        ? `已撤销最近一次记账，共 ${result.count} 笔。`
        : "没有可撤销的记账记录。";
    await sendTelegram(env, chatId, reply, messageId);
    return;
  }

  if (command.action === "clarify") {
    await sendTelegram(env, chatId, command.question, messageId);
    return;
  }

  await sendTelegram(env, chatId, command.message, messageId);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "yunshu-finance",
        version: "0.1.0",
      });
    }

    if (request.method !== "POST" || url.pathname !== "/telegram/webhook") {
      return new Response("Not Found", { status: 404 });
    }

    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!env.TELEGRAM_SECRET_TOKEN || secret !== env.TELEGRAM_SECRET_TOKEN) {
      console.log(`yunshu auth failed expected_len=${env.TELEGRAM_SECRET_TOKEN?.length ?? -1} got_len=${secret?.length ?? -1}`);
      return new Response("Unauthorized", { status: 401 });
    }

    let update: TelegramUpdate;
    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    try {
      await handleUpdate(env, update);
    } catch (error) {
      console.error("yunshu request failed", error);
      const message = update.message;
      if (message?.chat?.id && message.message_id) {
        try {
          await sendTelegram(env, String(message.chat.id), "处理失败，请稍后重试。", String(message.message_id));
        } catch (sendError) {
          console.error("yunshu error reply failed", sendError);
        }
      }
    }

    return new Response("OK");
  },
};
