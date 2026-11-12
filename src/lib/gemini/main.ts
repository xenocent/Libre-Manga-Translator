import { MAKE_SITE_RULE_PROMPT } from "../adapters";
import { DefaultConfig } from "../configs";
import { drawNumberedBboxes } from "./utils";
import { buildTranslationPrompts } from "../prompts";
import {
  attachDiagnostics,
  clipRawResponse,
  isTranslationValidationError,
  mergeRunInfo,
  promptChars,
  validateTranslationResult,
  type LlmRunInfo,
} from "../server/validator";
import { normalizeGeminiUsageMetadata } from "../server/usage";
import { delayUnlessAborted, isRetryableRequestError } from "../server/main";

export async function translateWithGemini(
  imageSrc: string,
  bboxes: Bbox[],
  apiKey: string,
  targetLang: string,
  sourceLang: string,
  seriesContext?: SeriesContext,
  model = DefaultConfig.geminiModels[0].id,
  temperature = DefaultConfig.llmTemperature,
  /** Auto-Detect only: the script the OCR gate identified (LMT-030). */
  detectedLabel?: string | null,
  /** Cancels the in-flight request at the job deadline (LMT-010). */
  signal?: AbortSignal,
): Promise<TranslateResult> {
  // An aborted job must not pay for the (expensive) image conversion or open a
  // socket; the caller's reason carries the stage name.
  signal?.throwIfAborted();
  const cleanBase64 = (await drawNumberedBboxes(imageSrc, bboxes)).replace(
    /^data:image\/(png|jpeg|webp);base64,/,
    "",
  );
  const needsContext =
    !seriesContext?.summary ||
    !seriesContext?.dictionary ||
    (seriesContext?.translatedCount ?? 0) % DefaultConfig.minTranslations === 0;

  // "Auto-Detect" is a UI choice, not a language: name the script the gate
  // actually identified instead of dropping the clause and letting the model
  // guess the input language (LMT-030).
  const sourceClause =
    sourceLang === "Auto-Detect"
      ? detectedLabel
        ? ` FROM ${detectedLabel.toUpperCase()} (auto-detected script)`
        : " FROM the source language of the text in each box"
      : ` FROM ${sourceLang.toUpperCase()}`;

  const systemPrompt = `You are a professional manga translator${seriesContext?.seriesName ? ` working on "${seriesContext.seriesName}"` : ""}.
Translate the text in the numbered bounding boxes in the provided image${sourceClause} INTO ${targetLang.toUpperCase()}.
Maintain the tone and context of the scene.
${seriesContext?.summary ? `\nSeries context: ${seriesContext.summary}` : ""}
${seriesContext?.dictionary ? `\nTerm dictionary (always use these): ${seriesContext.dictionary}` : ""}
${seriesContext?.recentHistory?.length ? `\nPrevious pages for continuity:\n${seriesContext.recentHistory.map((h, i) => `Page -${seriesContext.recentHistory.length - i}: ${h.text}`).join("\n")}` : ""}

CRITICAL LANGUAGE INSTRUCTIONS:
1. The dialogue inside the "translations" array MUST be strictly in ${targetLang.toUpperCase()}. DO NOT transcribe or copy the original text from the image. You must output the translated meaning.
2. The "sourceTexts" array MUST contain the ORIGINAL text exactly as it appears in each numbered box, transcribed verbatim (not translated). If a box's text is illegible or empty, use an empty string.
${needsContext ? `3. The "summary" and "dictionary" fields MUST remain strictly in ENGLISH to act as a system memory pivot.` : ""}

Output strictly as valid JSON matching this structure without markdown formatting:
{
  "translations": ["translation for box 1", "translation for box 2"],
  "sourceTexts": ["original text in box 1", "original text in box 2"]${
    needsContext
      ? `,\n  "context": {\n    "summary": "...",\n    "dictionary": "..."\n  }`
      : ""
  }
}`;

  const userPrompt = `Please process the dialogue boxes found in the provided image.
${
  needsContext
    ? `\nAlso infer from this page:
1. A 1-2 sentence summary of the series tone, setting, and genre IN ENGLISH.
2. Any character names, places, or unique terms visible, formatted as "Original Term -> English Translation". If no specific terms are visible, output strictly "None". Do not explain or write sentences.`
    : ""
}`;

  const calls: LlmRunInfo[] = [];
  let first: { data: any; info: LlmRunInfo };
  try {
    first = await sendRequestToGemini(
      systemPrompt,
      userPrompt,
      apiKey,
      model,
      temperature,
      {
        mimeType: "image/jpeg",
        data: cleanBase64,
      },
      signal,
    );
  } catch (error) {
    throw attachDiagnostics(error, {
      promptChars: promptChars(systemPrompt, userPrompt),
    });
  }
  calls.push(first.info);

  try {
    return validateTranslationResult(first.data, bboxes.length, {
      sourceLang,
      targetLang,
      run: mergeRunInfo(calls),
    });
  } catch (error) {
    if (!isTranslationValidationError(error)) throw error;

    console.warn(
      `[gemini] validation failed (${error.code}): ${error.message} — requesting correction`,
    );
    try {
      const corrected = await sendRequestToGemini(
        systemPrompt,
        `${userPrompt}\n\nCORRECTION: ${error.message}\nReturn the full corrected JSON now.`,
        apiKey,
        model,
        temperature,
        {
          mimeType: "image/jpeg",
          data: cleanBase64,
        },
        signal,
      );
      calls.push(corrected.info);
      return validateTranslationResult(corrected.data, bboxes.length, {
        sourceLang,
        targetLang,
        run: mergeRunInfo(calls),
      });
    } catch (retryError) {
      throw attachDiagnostics(retryError, mergeRunInfo(calls));
    }
  }
}

export async function translateTextWithGemini(
  text: string,
  apiKey: string,
  targetLang: string,
  sourceLang: string,
  seriesContext?: SeriesContext,
  model = DefaultConfig.geminiModels[0].id,
  temperature = DefaultConfig.llmTemperature,
  /** Auto-Detect only: the script the OCR gate identified (LMT-030). */
  detectedLabel?: string | null,
  /** Cancels the in-flight request at the job deadline (LMT-010). */
  signal?: AbortSignal,
): Promise<TranslateResult> {
  const { systemPrompt, userPrompt } = buildTranslationPrompts(
    [text],
    targetLang,
    sourceLang,
    seriesContext,
    detectedLabel,
  );

  const calls: LlmRunInfo[] = [];
  let first: { data: any; info: LlmRunInfo };
  try {
    first = await sendRequestToGemini(
      systemPrompt,
      userPrompt,
      apiKey,
      model,
      temperature,
      undefined,
      signal,
    );
  } catch (error) {
    throw attachDiagnostics(error, {
      promptChars: promptChars(systemPrompt, userPrompt),
    });
  }
  calls.push(first.info);

  try {
    return validateTranslationResult(first.data, 1, {
      sourceTexts: [text],
      sourceLang,
      targetLang,
      run: mergeRunInfo(calls),
    });
  } catch (error) {
    if (!isTranslationValidationError(error)) throw error;

    console.warn(
      `[gemini:text] validation failed (${error.code}): ${error.message} - requesting correction`,
    );
    try {
      const corrected = await sendRequestToGemini(
        systemPrompt,
        `${userPrompt}\n\nCORRECTION: ${error.message}\nReturn the full corrected JSON now.`,
        apiKey,
        model,
        temperature,
        undefined,
        signal,
      );
      calls.push(corrected.info);
      return validateTranslationResult(corrected.data, 1, {
        sourceTexts: [text],
        sourceLang,
        targetLang,
        run: mergeRunInfo(calls),
      });
    } catch (retryError) {
      throw attachDiagnostics(retryError, mergeRunInfo(calls));
    }
  }
}

export async function makeSiteRuleWithGemini(
  title: string,
  path: string,
  apiKey: string,
  model = DefaultConfig.geminiModels[0].id,
  temperature = DefaultConfig.llmTemperature,
  signal?: AbortSignal,
) {
  const prompt = MAKE_SITE_RULE_PROMPT(title, path);

  const { data } = await sendRequestToGemini(
    prompt.system,
    prompt.user,
    apiKey,
    model,
    temperature,
    undefined,
    signal,
  );
  return data;
}

/** Gemini answers a throttled request with a status and usually a wait hint. */
class GeminiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryDelayMs?: number,
  ) {
    super(`Gemini API Error: ${message}`);
    this.name = "GeminiRequestError";
  }
}

/** Reads the error body once, keeping the provider message and wait hint. */
async function toGeminiRequestError(
  response: Response,
): Promise<GeminiRequestError> {
  let message = response.statusText;
  let retryDelayMs: number | undefined;
  try {
    const err = (await response.json())?.error;
    message = err?.message ?? message;
    retryDelayMs = parseRetryDelayMs(
      response.headers.get("retry-after"),
      err?.details?.find((d: { retryDelay?: string }) => d?.retryDelay)
        ?.retryDelay,
    );
  } catch {
    // A proxy or gateway error page is not JSON; status alone still routes the
    // retry decision.
  }
  return new GeminiRequestError(message, response.status, retryDelayMs);
}

/**
 * Google's RetryInfo reports `45s`; the standard header reports seconds or an
 * HTTP date. Whichever is present wins, RetryInfo first because it is precise.
 */
function parseRetryDelayMs(
  header: string | null,
  retryDelay?: string,
): number | undefined {
  const seconds = /^(\d+(?:\.\d+)?)s$/.exec(retryDelay ?? "");
  if (seconds) return Math.ceil(parseFloat(seconds[1]) * 1000);
  if (!header) return undefined;
  const asNumber = Number(header);
  if (Number.isFinite(asNumber)) return Math.max(0, Math.ceil(asNumber * 1000));
  const deadline = Date.parse(header);
  return Number.isNaN(deadline)
    ? undefined
    : Math.max(0, deadline - Date.now());
}

export async function sendRequestToGemini(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
  model: string,
  temperature: number,
  data?: {
    mimeType: string;
    data: string;
  },
  /** Cancels the in-flight request at the job deadline (LMT-010). */
  signal?: AbortSignal,
): Promise<{ data: any; info: LlmRunInfo }> {
  // Google API keys are printable ASCII. A key pasted with a stray space,
  // zero-width character or smart quote would otherwise reach the header and
  // make fetch() throw an opaque "invalid header value" TypeError.
  const key = apiKey.trim();
  if (!key || /[^\x21-\x7e]/.test(key)) {
    throw new Error(
      "Gemini API key is empty or contains invisible/non-ASCII characters — re-paste it",
    );
  }

  // Key travels in the header, never the URL: query strings are persisted in
  // intermediary and server-side request logs.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        {
          role: "user",
          parts: [
            { text: userPrompt },
            ...(data ? [{ inlineData: data }] : []),
          ],
        },
      ],
      generationConfig: {
        temperature,
        responseMimeType: "application/json",
      },
    }),
    signal,
  };

  let response = await fetch(url, requestInit);

  // A free-tier key is throttled constantly, and every throttled page used to
  // fail outright while the queue fired the next one into the same window.
  // Wait out the provider's own hint instead.
  for (let attempt = 0; !response.ok; attempt++) {
    const error = await toGeminiRequestError(response);
    if (
      !isRetryableRequestError(error) ||
      attempt >= DefaultConfig.geminiMaxRetries ||
      signal?.aborted
    ) {
      throw error;
    }
    const waitMs =
      error.retryDelayMs ?? DefaultConfig.geminiRetryDelayMs * (attempt + 1);
    console.warn(
      `[gemini] HTTP ${error.status} - retrying in ${waitMs}ms (attempt ${attempt + 2} of ${DefaultConfig.geminiMaxRetries + 1})`,
    );
    if (!(await delayUnlessAborted(waitMs, signal))) throw error;
    response = await fetch(url, requestInit);
  }

  const result = await response.json();
  const resultText = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!resultText) {
    throw new Error("Gemini API returned empty response parts");
  }

  // Gemini reports STOP / MAX_TOKENS / SAFETY / ...; MAX_TOKENS is the cut
  // signal the Debug export surfaces (LMT-032).
  const finishReason: string | undefined = result.candidates?.[0]?.finishReason;
  const info: LlmRunInfo = {
    rawResponse: clipRawResponse(resultText),
    finishReason: typeof finishReason === "string" ? finishReason : undefined,
    promptChars: promptChars(systemPrompt, userPrompt),
    usage: normalizeGeminiUsageMetadata(result.usageMetadata),
  };

  try {
    return { data: JSON.parse(resultText), info };
  } catch (error) {
    throw attachDiagnostics(
      new Error(
        `Gemini returned invalid JSON: ${(error as Error).message}`,
      ),
      info,
    );
  }
}
