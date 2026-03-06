import { config } from "../../config.js";

type GeminiPayload = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  promptFeedback?: { blockReason?: string };
};

export class GeminiProvider {
  readonly name = "gemini" as const;

  constructor(
    private readonly apiKey: string = config.geminiApiKey,
    private readonly model: string = config.geminiModel,
  ) {}

  isConfigured(): boolean {
    return this.apiKey.trim().length > 0 && this.model.trim().length > 0;
  }

  private endpoint(): string {
    return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.model,
    )}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
  }

  private extractText(payload: GeminiPayload): string {
    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      const blocked = payload.promptFeedback?.blockReason;
      throw new Error(blocked ? `Gemini blocked request: ${blocked}` : "Gemini returned no content");
    }
    return text;
  }

  async generate(prompt: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error("Provider misconfigured: Gemini API key/model missing (GEMINI_API_KEY/GEMINI_MODEL)");
    }

    const response = await fetch(this.endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, topP: 0.1, responseMimeType: "application/json" },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Gemini transport failure (${response.status}): ${body.slice(0, 240)}`);
    }

    return this.extractText((await response.json()) as GeminiPayload);
  }

  /**
   * Send a PDF (or any file) to Gemini as INLINE base64 data alongside a prompt.
   *
   * This is the preferred path for lecture-slide PDFs (typically 1–8 MB):
   *  • No upload / polling / file-management needed
   *  • Single HTTP request → response, just like a normal text prompt
   *  • Gemini reads the PDF visually — no text extraction, no garbled words
   *
   * Falls back gracefully when the response signals the file is too large
   * (413 / REQUEST_TOO_LARGE) so the caller can try the Files API instead.
   */
  async generateWithInlinePdf(bytes: Buffer, prompt: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error("Provider misconfigured: Gemini API key/model missing");
    }

    const base64 = bytes.toString("base64");

    const response = await fetch(this.endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inline_data: { mime_type: "application/pdf", data: base64 } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: { temperature: 0, topP: 0.1 },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Gemini inline PDF failure (${response.status}): ${body.slice(0, 320)}`);
    }

    return this.extractText((await response.json()) as GeminiPayload);
  }

  /**
   * Upload a file to the Gemini Files API and wait for it to become ACTIVE.
   * Used as fallback for very large PDFs (>15 MB) that exceed the inline limit.
   */
  async uploadFile(bytes: Buffer, mimeType: string, displayName: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error("Provider misconfigured: Gemini API key/model missing");
    }

    const boundary = `upload_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const metaJson = JSON.stringify({ file: { display_name: displayName } });

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n`, "utf8"),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, "utf8"),
      bytes,
      Buffer.from(`\r\n--${boundary}--`, "utf8"),
    ]);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: "POST",
        headers: {
          "X-Goog-Upload-Protocol": "multipart",
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
      },
    );

    if (!response.ok) {
      const err = await response.text().catch(() => "");
      throw new Error(`Gemini file upload failed (${response.status}): ${err.slice(0, 320)}`);
    }

    const payload = (await response.json()) as { file?: { uri?: string; name?: string } };
    const uri = payload.file?.uri;
    const fileName = payload.file?.name;
    if (!uri) throw new Error("Gemini file upload: no URI in response");

    // The Files API processes files asynchronously — poll until ACTIVE.
    if (fileName) {
      for (let poll = 0; poll < 20; poll++) {
        const stateResp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${encodeURIComponent(this.apiKey)}`,
        ).catch(() => null);
        if (stateResp?.ok) {
          const stateData = (await stateResp.json().catch(() => ({}))) as { state?: string };
          if (stateData.state === "ACTIVE") break;
          if (stateData.state === "FAILED") throw new Error(`Gemini file processing failed for "${displayName}"`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
      }
    }

    return uri;
  }

  /** Delete a previously-uploaded Files API file (best-effort cleanup). */
  async deleteFile(fileUri: string): Promise<void> {
    const match = fileUri.match(/files\/[^/?]+/);
    if (!match) return;
    await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${match[0]}?key=${encodeURIComponent(this.apiKey)}`,
      { method: "DELETE" },
    ).catch(() => undefined);
  }

  /** Generate content using a previously-uploaded Files API file URI. */
  async generateWithFileUri(fileUri: string, mimeType: string, prompt: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error("Provider misconfigured: Gemini API key/model missing");
    }

    const response = await fetch(this.endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { file_data: { mime_type: mimeType, file_uri: fileUri } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: { temperature: 0, topP: 0.1 },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Gemini file-URI transport failure (${response.status}): ${body.slice(0, 240)}`);
    }

    return this.extractText((await response.json()) as GeminiPayload);
  }
}
