import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";

export interface DownloadedPdf {
  resourceId: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceType: "pdf" | "ppt";
  bytes: Buffer;
  plainText?: string;
}

function mockTextPathFromMaterialUrl(url: string): string {
  const noScheme = url.replace(/^mock:\/\//, "");
  const txtName = noScheme.replace(/\.(pdf|ppt|pptx)$/i, ".txt");
  return path.join(config.mockDir, "pdf-text", txtName);
}

export async function downloadPdf(params: {
  resourceId: string;
  title: string;
  url: string;
  type: "pdf" | "ppt";
  cookies?: string;
}): Promise<DownloadedPdf> {
  if (params.url.startsWith("mock://")) {
    const file = mockTextPathFromMaterialUrl(params.url);
    const text = await fs.readFile(file, "utf8");
    return {
      resourceId: params.resourceId,
      sourceTitle: params.title,
      sourceUrl: params.url,
      sourceType: params.type,
      bytes: Buffer.from(text, "utf8"),
      plainText: text,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const headers: Record<string, string> = {};
    if (params.cookies) {
      headers["Cookie"] = params.cookies;
    }

    const response = await fetch(params.url, { signal: controller.signal, headers });
    if (!response.ok) {
      throw new Error(`Failed to download PDF (${response.status}): ${params.url}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);

    // Guard: if Moodle returned an HTML login page instead of a binary file,
    // throw a descriptive error rather than handing garbled HTML to pdf-parse.
    const prefix = bytes.slice(0, 5).toString("ascii");
    if (prefix.startsWith("<!") || prefix.toLowerCase().startsWith("<html")) {
      throw new Error(
        `auth_html_response: Moodle returned an HTML page instead of a PDF/PPT for "${params.title}". ` +
          `The session cookies may have expired — re-open the app so Playwright can refresh the session.`,
      );
    }

    return {
      resourceId: params.resourceId,
      sourceTitle: params.title,
      sourceUrl: params.url,
      sourceType: params.type,
      bytes,
    };
  } finally {
    clearTimeout(timeout);
  }
}
