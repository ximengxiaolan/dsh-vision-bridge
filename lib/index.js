// dsh-vision-bridge
//
// Composer-attached images become text before they reach a text-only model.
// Two seams on the host llm service:
//
//  1. resolveModelInfo is patched to claim `image` input so the session
//     admission in dsh-host-apiproxy lets a pasted image into the session
//     (DeepSeek routes are otherwise refused with MODEL_DOES_NOT_SUPPORT_IMAGES).
//
//  2. streamWithRegistration is wrapped: every request headed to a model that
//     does NOT natively accept images has its image blocks replaced with a
//     text description produced by an OpenAI-compatible vision model, so the
//     text-only provider never sees a raw image.
//
// The pasted image itself stays in the session log (the UI keeps rendering
// it); only the model-visible request carries the description.
import Schema from '@deepseek-ai/schemastery';

export const name = 'dsh-vision-bridge';
export const inject = ['llm', 'attachments'];

export const Config = Schema.object({
    apiKey: Schema.string().default(process.env.VISION_API_KEY ?? ''),
    baseURL: Schema.string().default(process.env.VISION_BASE_URL ?? ''),
    model: Schema.string().default(process.env.VISION_MODEL ?? ''),
    lang: Schema.string().default(process.env.VISION_LANG ?? 'zh'),
    timeoutMs: Schema.number().default(180000),
    enabled: Schema.boolean().default(true),
});

/** Collect every durable image block in a content tree (nested tool results included). */
function collectImageBlocks(content, out) {
    if (!Array.isArray(content)) return;
    for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        if (block.type === 'image' && block.attachment !== null && typeof block.attachment === 'object') {
            out.push(block);
        }
        else if (Array.isArray(block.content)) {
            collectImageBlocks(block.content, out);
        }
    }
}

export function apply(ctx, config) {
    const { llm, attachments } = ctx;
    const warn = typeof ctx.logger?.warn === 'function' ? ctx.logger.warn.bind(ctx.logger) : console.warn;

    const origResolve = llm.resolveModelInfo.bind(llm);
    const origStream = llm.streamWithRegistration.bind(llm);

    // Per-process description cache keyed by attachment id: the same pasted
    // image is re-sent on every later turn until compaction, and each re-send
    // would otherwise cost another vision call.
    const cache = new Map();
    const CACHE_MAX = 256;

    // ── seam 1: admission passes images for every route ─────────────────────
    if (config.enabled) {
        llm.resolveModelInfo = async (provider, model, signal) => {
            const info = await origResolve(provider, model, signal);
            if (info !== null && typeof info === 'object' && Array.isArray(info.inputModalities) && !info.inputModalities.includes('image')) {
                return { ...info, inputModalities: [...info.inputModalities, 'image'] };
            }
            return info;
        };
    }

    async function describeBlock(block, signal) {
        const id = String(block.attachment.attachmentId ?? '');
        if (id !== '' && cache.has(id)) return cache.get(id);
        const description = await describeOnce(block, signal);
        if (id !== '') {
            cache.set(id, description);
            if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        }
        return description;
    }

    async function describeOnce(block, signal) {
        try {
            const stored = await attachments.readImage(block.attachment, signal);
            const mediaType = block.attachment.mediaType ?? 'image/png';
            const dataUrl = `data:${mediaType};base64,${Buffer.from(stored.data).toString('base64')}`;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), config.timeoutMs);
            try {
                const base = String(config.baseURL ?? '').replace(/\/+$/, '');
                const response = await fetch(`${base}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
                    body: JSON.stringify({
                        model: config.model,
                        messages: [{
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: config.lang === 'en'
                                        ? 'Describe this image in detail: visible text (verbatim), objects, layout, colors and anything relevant.'
                                        : '请详细描述这张图片的内容：包括可见的文字（逐字）、物体、布局、颜色等关键信息。',
                                },
                                { type: 'image_url', image_url: { url: dataUrl } },
                            ],
                        }],
                    }),
                    signal: controller.signal,
                });
                if (!response.ok) {
                    const detail = await response.text().catch(() => '');
                    throw new Error(`vision API ${response.status}: ${detail.slice(0, 200)}`);
                }
                const json = await response.json();
                const text = json?.choices?.[0]?.message?.content;
                if (typeof text !== 'string' || text.length === 0) throw new Error('vision API returned an empty description');
                return text;
            }
            finally {
                clearTimeout(timer);
            }
        }
        catch (error) {
            const reason = error?.name === 'AbortError' ? 'timeout' : (error?.message ?? String(error));
            return `[图片识别失败: ${reason}]`;
        }
    }

    // ── seam 2: image blocks → text before a text-only provider ─────────────
    function transformContent(content, byBlock) {
        if (!Array.isArray(content)) return content;
        let changed = false;
        const next = content.map((block) => {
            if (block !== null && typeof block === 'object' && block.type === 'image' && byBlock.has(block)) {
                changed = true;
                return {
                    type: 'text',
                    text: `[用户附上的图片已由视觉模型自动识别（${config.model}）]\n${byBlock.get(block)}`,
                };
            }
            if (block !== null && typeof block === 'object' && Array.isArray(block.content)) {
                const nested = transformContent(block.content, byBlock);
                if (nested !== block.content) {
                    changed = true;
                    return { ...block, content: nested };
                }
            }
            return block;
        });
        return changed ? next : content;
    }

    async function transformRequest(options) {
        if (!config.enabled || !Array.isArray(options.messages)) return options;
        // A model that natively accepts images keeps its raw image blocks.
        try {
            const info = await origResolve(options.provider, options.model, options.signal);
            if (Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')) return options;
        }
        catch {
            // Resolution failed; treat as text-only and transform.
        }
        const images = [];
        for (const message of options.messages) collectImageBlocks(message?.content, images);
        if (images.length === 0) return options;
        const byBlock = new Map();
        for (const block of images) {
            if (!byBlock.has(block)) byBlock.set(block, await describeBlock(block, options.signal));
        }
        const newMessages = options.messages.map((message) => {
            if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return message;
            const newContent = transformContent(message.content, byBlock);
            return newContent === message.content ? message : { ...message, content: newContent };
        });
        return { ...options, messages: newMessages };
    }

    if (config.enabled) {
        llm.streamWithRegistration = function (options, prepared) {
            return (async function* () {
                let final = options;
                try {
                    final = await transformRequest(options);
                }
                catch (error) {
                    warn(`dsh-vision-bridge: image transform failed, sending request as-is: ${error?.message ?? error}`);
                }
                yield* origStream(final, prepared);
            })();
        };
    }

    ctx.on('dispose', () => {
        llm.resolveModelInfo = origResolve;
        llm.streamWithRegistration = origStream;
    });
}
