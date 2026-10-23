import { dialog, shell, BrowserWindow } from "electron";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import type { RingingClient } from "./ringing-client.js";
import type { AttachmentUploadWire, ScreenshotWire } from "./types.js";

export async function pickDirectory(win?: BrowserWindow | null): Promise<string | null> {
  const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
}

export async function pickAttachments(win?: BrowserWindow | null): Promise<string[]> {
  const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) {
    return [];
  }
  return result.filePaths;
}

export async function openExternalUrl(urlStr: string): Promise<void> {
  if (!urlStr || typeof urlStr !== "string") return;
  if (/^https?:\/\//i.test(urlStr)) {
    await shell.openExternal(urlStr);
  } else {
    console.warn(`[native] Refusing to open unsafe URL: ${urlStr}`);
  }
}

export async function captureScreenshot(mode: "selection" | "fullscreen"): Promise<ScreenshotWire | null> {
  // Linux 平台截图支持：目前推荐使用系统快捷键 + 拖拽/添加附件
  console.info(`[native] Screenshot requested (${mode}), fallback to system tool advised.`);
  return null;
}

export async function uploadAttachment(
  client: RingingClient,
  seed: string,
  filePath: string
): Promise<AttachmentUploadWire> {
  const st = statSync(filePath);
  const name = basename(filePath);
  const buffer = readFileSync(filePath);

  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const mediaType = guessMediaType(name);

  const res = await client.uploadContent(seed, name, buffer, mediaType);

  return {
    content_id: res.content_id || sha256,
    sha256: res.sha256 || sha256,
    media_type: res.media_type || mediaType,
    name,
    size: st.size,
    truncated: Boolean(res.truncated),
  };
}

function guessMediaType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain";
    case "json":
      return "application/json";
    case "md":
      return "text/markdown";
    default:
      return "application/octet-stream";
  }
}
