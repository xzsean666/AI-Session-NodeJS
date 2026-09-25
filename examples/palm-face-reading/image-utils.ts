import * as fs from "node:fs";
import * as path from "node:path";
import type { MessageContentPart } from "../../dist/index.mjs";

export interface LabeledImageItem {
  /**
   * 本地文件路径、网络 HTTP(S) URL 或 Base64 Data URI
   */
  pathOrUrl: string;
  /**
   * 图片语义标签，如："面相正面照"、"右手手相特写"、"左手手相" 等
   */
  label?: string;
  /**
   * OpenAI 视觉细节精度配置（默认为 "high"）
   */
  detail?: "auto" | "low" | "high";
}

export type ImageInput =
  | string
  | LabeledImageItem
  | Array<string | LabeledImageItem>;

/**
 * 将本地图片路径转换为标准 Base64 Data URI 字符串
 */
export function fileToDataUri(filePathOrUrl: string): string {
  if (
    filePathOrUrl.startsWith("http://") ||
    filePathOrUrl.startsWith("https://") ||
    filePathOrUrl.startsWith("data:")
  ) {
    return filePathOrUrl;
  }

  const resolvedPath = path.resolve(filePathOrUrl);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`图片文件不存在: ${resolvedPath}`);
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
  };
  const mimeType = mimeMap[ext] || "image/jpeg";
  const fileBuffer = fs.readFileSync(resolvedPath);
  const base64Data = fileBuffer.toString("base64");
  return `data:${mimeType};base64,${base64Data}`;
}

/**
 * 将文字提示词与单张或多张图片（面相照、手相照）组装为标准多模态消息内容数组
 */
export function createMultimodalMessage(
  textPrompt: string,
  images?: ImageInput
): MessageContentPart[] | string {
  if (!images) {
    return textPrompt;
  }

  const normalizedItems: LabeledImageItem[] = [];

  if (typeof images === "string") {
    normalizedItems.push({ pathOrUrl: images });
  } else if (Array.isArray(images)) {
    for (const img of images) {
      if (typeof img === "string") {
        normalizedItems.push({ pathOrUrl: img });
      } else if (img && typeof img === "object") {
        normalizedItems.push(img);
      }
    }
  } else if (typeof images === "object") {
    normalizedItems.push(images);
  }

  if (normalizedItems.length === 0) {
    return textPrompt;
  }

  const parts: MessageContentPart[] = [];

  // 首先放入主文字提示词
  parts.push({
    type: "text",
    text: textPrompt,
  });

  // 逐一处理每一张图片，注入清晰的标注提示与 image_url 载荷
  normalizedItems.forEach((item, index) => {
    const dataUri = fileToDataUri(item.pathOrUrl);
    const labelText = item.label
      ? `【传入图片 ${index + 1}：${item.label}】`
      : `【传入图片 ${index + 1}】`;

    parts.push({
      type: "text",
      text: labelText,
    });

    parts.push({
      type: "image_url",
      image_url: {
        url: dataUri,
        detail: item.detail || "high",
      },
    });
  });

  return parts;
}

/**
 * 专为【面手合参】打造的便捷图文构建器，支持同时传入面相照与手相照
 */
export function createCombinedMultimodalMessage(options: {
  textPrompt: string;
  faceImage?: string;
  palmImage?: string;
  leftPalmImage?: string;
  rightPalmImage?: string;
  extraImages?: Array<{ pathOrUrl: string; label: string }>;
}): MessageContentPart[] | string {
  const images: LabeledImageItem[] = [];

  if (options.faceImage) {
    images.push({
      pathOrUrl: options.faceImage,
      label: "当事人面相正面特写照",
    });
  }

  if (options.palmImage) {
    images.push({
      pathOrUrl: options.palmImage,
      label: "当事人手相手掌纹理特写照",
    });
  }

  if (options.leftPalmImage) {
    images.push({
      pathOrUrl: options.leftPalmImage,
      label: "当事人左手掌纹（先天禀赋盘）",
    });
  }

  if (options.rightPalmImage) {
    images.push({
      pathOrUrl: options.rightPalmImage,
      label: "当事人右手掌纹（后天造化盘）",
    });
  }

  if (options.extraImages) {
    for (const extra of options.extraImages) {
      images.push({
        pathOrUrl: extra.pathOrUrl,
        label: extra.label,
      });
    }
  }

  return createMultimodalMessage(options.textPrompt, images);
}

/**
 * 检查图片物理信息与可用性
 */
export function inspectImage(filePathOrUrl: string): {
  isRemoteUrl: boolean;
  exists: boolean;
  mimeType: string;
  sizeBytes?: number;
  sizeMb?: string;
  warning?: string;
} {
  if (
    filePathOrUrl.startsWith("http://") ||
    filePathOrUrl.startsWith("https://") ||
    filePathOrUrl.startsWith("data:")
  ) {
    return {
      isRemoteUrl: true,
      exists: true,
      mimeType: "image/jpeg",
    };
  }

  const resolved = path.resolve(filePathOrUrl);
  if (!fs.existsSync(resolved)) {
    return {
      isRemoteUrl: false,
      exists: false,
      mimeType: "unknown",
      warning: `文件未找到: ${resolved}`,
    };
  }

  const stat = fs.statSync(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
  };
  const mimeType = mimeMap[ext] || "application/octet-stream";
  const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
  let warning: string | undefined;

  if (stat.size > 15 * 1024 * 1024) {
    warning = `图片较大 (${sizeMb} MB)，上传至 Vision LLM 可能耗时较久，建议压缩至 10MB 以内。`;
  }

  return {
    isRemoteUrl: false,
    exists: true,
    mimeType,
    sizeBytes: stat.size,
    sizeMb,
    warning,
  };
}

/**
 * 拍摄专业相学照片的标准建议
 */
export const PHOTO_CAPTURE_TIPS = `
【大宗师相学拍照最佳实践指南】：
1. 👤 面相拍摄建议：
   - 保持正面水平平视机位，切忌 45 度俯拍（导致下巴削尖假象）或仰拍（导致下停虚大）。
   - 室内自然柔和采光，避免强烈的单侧射灯（造成阴阳脸）或正上方顶灯（造成假性眼窝阴影）。
   - 尽量关闭手机“深度美颜磨皮”功能，以便大宗师准确观察印堂骨肉、山根起伏与卧蚕气色。
2. 🖐️ 手相拍摄建议：
   - 手掌自然放平摊开，五指微微分开，手心切忌用力向后紧绷反张（会导致明堂假性扯平）。
   - 尽量在靠窗自然光下采用【斜向侧光】照射，让掌纹凹槽产生自然阴影对比，纹理最清晰。
   - 建议同时拍摄左手（先天根基盘）与右手（后天作为盘）两张照片。
`.trim();

