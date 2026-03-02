import { config } from "../../config.js";

const CHATPDF_ENDPOINT = "https://api.chatpdf.com/v1/chats/message";

export class ChatPdfProvider {
  readonly name = "chatpdf" as const;

  constructor(
    private readonly apiKey: string = config.chatpdfApiKey,
    private readonly sourceId: string = config.chatpdfSourceId,
  ) {}

  isConfigured(): boolean {
    return this.apiKey.length > 0 && this.sourceId.length > 0;
  }

  async generate(prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error("ChatPDF API key is missing (CHATPDF_API_KEY)");
    }
    if (!this.sourceId) {
      throw new Error("ChatPDF source id is missing (CHATPDF_SOURCE_ID)");
    }

    const response = await fetch(CHATPDF_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({
        sourceId: this.sourceId,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`ChatPDF transport failure (${response.status}): ${body.slice(0, 240)}`);
    }

    const payload = (await response.json()) as { content?: string };
    if (!payload.content) {
      throw new Error("ChatPDF returned no content");
    }
    return payload.content;
  }
}
