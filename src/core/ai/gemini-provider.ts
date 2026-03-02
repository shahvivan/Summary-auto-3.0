import { config } from "../../config.js";

export class GeminiProvider {
  readonly name = "gemini" as const;

  constructor(
    private readonly apiKey: string = config.geminiApiKey,
    private readonly model: string = config.geminiModel,
  ) {}

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async generate(prompt: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error("Gemini API key is missing (GEMINI_API_KEY)");
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
}
