import pdfParse from "pdf-parse";
import type { DownloadedPdf } from "./downloader.js";

export async function extractPdfText(pdf: DownloadedPdf): Promise<string> {
  if (pdf.plainText !== undefined) {
    return pdf.plainText.trim();
  }

  if (pdf.sourceType === "ppt") {
    return `Presentation material "${pdf.sourceTitle}" was downloaded, but binary PPT text extraction is unavailable in this build.`;
  }

  const parsed = await pdfParse(pdf.bytes);
  return parsed.text.trim();
}
