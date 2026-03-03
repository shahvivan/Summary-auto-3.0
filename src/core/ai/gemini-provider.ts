import { config } from "../../config.js";

export class GeminiProvider {
  readonly name = "gemini" as const;

  constructor(
    private readonly apiKey: string = config.geminiApiKey,
    private readonly model: string = config.geminiModel,
  ) {}

  isConfigured(): boolean {
    return this.apiKey.trim().length > 0 && this.model.trim().length > 0;
  }

  async generate(prompt: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error("Provider misconfigured: Gemini API key/model missing (GEMINI_API_KEY/GEMINI_MODEL)");
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.model,
    )}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          topP: 0.1,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Gemini transport failure (${response.status}): ${body.slice(0, 240)}`);
    }

    const payload = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
      promptFeedback?: { blockReason?: string };
    };

    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      const blocked = payload.promptFeedback?.blockReason;
      throw new Error(blocked ? `Gemini blocked request: ${blocked}` : "Gemini returned no content");
    }

    return text;
  }

  /**
   * Upload a file (PDF, PPT, etc.) to the Gemini Files API.
   * Returns the file URI for use in generateWithFileUri().
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

    const payload = (await response.json()) as { file?: { uri?: string } };
    const uri = payload.file?.uri;
    if (!uri) {
      throw new Error("Gemini file upload: no URI in response");
    }
    return uri;
  }

  /** Delete a previously-uploaded file (best-effort cleanup). */
  async deleteFile(fileUri: string): Promise<void> {
    const match = fileUri.match(/files\/[^/?]+/);
    if (!match) return;
    await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${match[0]}?key=${encodeURIComponent(this.apiKey)}`,
      { method: "DELETE" },
    ).catch(() => undefined);
  }

  /**
   * Generate content using a previously-uploaded file plus a text prompt.
   * Returns the raw text from the first candidate.
   */
  async generateWithFileUri(fileUri: string, mimeType: string, prompt: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error("Provider misconfigured: Gemini API key/model missing");
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.model,
    )}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const response = await fetch(endpoint, {
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
        generationConfig: {
          temperature: 0,
          topP: 0.1,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Gemini transport failure (${response.status}): ${body.slice(0, 240)}`);
    }

    const payload = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
      promptFeedback?: { blockReason?: string };
    };

    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      const blocked = payload.promptFeedback?.blockReason;
      throw new Error(blocked ? `Gemini blocked request: ${blocked}` : "Gemini returned no content");
    }

    return text;
  }
}
