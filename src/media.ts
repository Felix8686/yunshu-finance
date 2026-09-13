import type { Env } from "./types";

const TELEGRAM_FILE_API = "https://api.telegram.org/file/bot";

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export class MediaTooLargeError extends Error {
  constructor() {
    super("media exceeds supported size");
  }
}

export class MediaDownloadError extends Error {
  constructor() {
    super("media download failed");
  }
}

interface TelegramRemoteFile {
  ok?: boolean;
  result?: {
    file_path?: string;
    file_size?: number;
  };
}

// Thin fetcher: file_id -> getFile -> one streamed download, nothing persisted.
export async function fetchTelegramMedia(
  env: Env,
  fileId: string,
  maxBytes: number = MAX_MEDIA_BYTES,
): Promise<ArrayBuffer> {
  let info: TelegramRemoteFile;
  try {
    const infoResponse = await fetch(`${TELEGRAM_FILE_API}${env.TELEGRAM_BOT_TOKEN}/getFile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    info = (await infoResponse.json()) as TelegramRemoteFile;
  } catch {
    throw new MediaDownloadError();
  }

  const filePath = info.result?.file_path;
  if (!info.ok || !filePath) throw new MediaDownloadError();
  if ((info.result?.file_size ?? 0) > maxBytes) throw new MediaTooLargeError();

  let media: ArrayBuffer;
  try {
    const response = await fetch(`${TELEGRAM_FILE_API}${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
    if (!response.ok) throw new MediaDownloadError();
    media = await response.arrayBuffer();
  } catch (error) {
    if (error instanceof MediaDownloadError) throw error;
    throw new MediaDownloadError();
  }
  if (media.byteLength > maxBytes) throw new MediaTooLargeError();
  return media;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

// Whisper only "hears" the audio; intent, categories and time ranges stay
// entirely with the DeepSeek text interpreter downstream.
export async function transcribeVoice(env: Env, fileId: string): Promise<string> {
  const audio = await fetchTelegramMedia(env, fileId);
  const audioBase64 = arrayBufferToBase64(audio);
  const result = (await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio: audioBase64,
  })) as { text?: string };
  return (result.text ?? "").trim();
}
