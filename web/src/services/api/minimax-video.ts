import axios from "axios";
import { nanoid } from "nanoid";
import { miniMaxVideoParameters } from "@/lib/minimax-video";
import { dataUrlToFile } from "@/lib/image-utils";
import { getMediaBlob, resolveMediaUrl } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, modelOptionName, withLocalProxy, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceVideo, ReferenceAudio } from "@/types/media";
import type { VideoGenerationTask, VideoGenerationTaskState } from "./video";

type Options = { signal?: AbortSignal; videos?: ReferenceVideo[]; audios?: ReferenceAudio[] };
type ApiError = { message?: string; status_msg?: string } | string;
type Response = {
    task_id?: string;
    file?: { file_id?: string };
    base_resp?: { status_code?: number | string; status_msg?: string };
    error?: ApiError;
    task?: { id?: string; status?: string; error?: ApiError; base_resp?: { status_code?: number | string; status_msg?: string }; content?: { url?: string; video_url?: string } };
};
type Content = { type: "text"; text: string } | { type: "image_url"; role: "first_frame" | "last_frame" | "reference_image"; image_url: { url: string } } | { type: "video_url"; role: "reference_video"; video_url: { url: string } } | { type: "audio_url"; role: "reference_audio"; audio_url: { url: string } };

// Provider-specific wire format lives here; task lifecycle remains shared in video.ts.
function apiUrl(config: AiConfig, version: "v1" | "v2", path: string) {
    const root = config.baseUrl.trim().replace(/\/+$/, "").replace(/\/minimax(?:\/v[12])?$/i, "").replace(/\/openai\/v1$/i, "");
    return withLocalProxy(`${root}/minimax/${version}${path}`);
}

function headers(config: AiConfig) {
    return { Authorization: `Bearer ${config.apiKey}` };
}

function errorText(error?: ApiError): string {
    return typeof error === "string" ? error : error?.message || error?.status_msg || "";
}

function assertResponse(payload: Response) {
    if (!payload) throw new Error("H3 返回了空响应");
    const base = payload.base_resp || payload.task?.base_resp;
    if (base?.status_code !== undefined && String(base.status_code) !== "0") throw new Error(`${base.status_msg || "H3 请求失败"} (${base.status_code})`);
    if (payload.error || payload.task?.error) throw new Error(errorText(payload.error || payload.task?.error) || "H3 请求失败");
}

function requestError(error: unknown): Error {
    if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) return new DOMException("Aborted", "AbortError");
    if (axios.isAxiosError<Response>(error)) {
        const data = error.response?.data;
        return new Error(errorText(data?.error || data?.task?.error || data?.base_resp || data?.task?.base_resp) || (error.response ? `H3 请求失败（HTTP ${error.response.status}）` : "H3 网络请求失败，请检查网络或本地代理"));
    }
    return error instanceof Error ? error : new Error("H3 请求失败");
}

async function upload(config: AiConfig, file: File, options?: Options) {
    const body = new FormData();
    body.append("purpose", "video_generation_input");
    body.append("file", file);
    const { data } = await axios.post<Response>(apiUrl(config, "v1", "/files/upload"), body, { headers: headers(config), signal: options?.signal });
    assertResponse(data);
    if (!data.file?.file_id) throw new Error("H3 素材上传没有返回文件 ID");
    return `mm_file://${data.file.file_id}`;
}

async function mediaFile(item: ReferenceVideo | ReferenceAudio, signal?: AbortSignal) {
    let blob = item.storageKey ? await getMediaBlob(item.storageKey) : null;
    if (!blob) {
        const url = await resolveMediaUrl(item.storageKey, item.url);
        if (!url) throw new Error(`无法读取参考素材：${item.name}`);
        const response = await fetch(withLocalProxy(url), { signal });
        if (!response.ok) throw new Error(`无法读取参考素材：${item.name}（HTTP ${response.status}）`);
        blob = await response.blob();
    }
    if (!blob.size) throw new Error(`参考素材为空：${item.name}`);
    return new File([blob], item.name, { type: item.type || blob.type });
}

export async function createMiniMaxVideoTask(config: AiConfig, model: string, prompt: string, images: ReferenceImage[], options?: Options): Promise<VideoGenerationTask> {
    try {
        // Validate before uploading any files or creating a billable task.
        const parameters = miniMaxVideoParameters(config, Boolean(images.length || options?.videos?.length || options?.audios?.length));
        const content: Content[] = [{ type: "text", text: prompt }];
        const frames = config.videoMode !== "reference" && images.length <= 2;
        if (frames && images.length && (options?.videos?.length || options?.audios?.length)) throw new Error("首尾帧模式不能混用视频或音频参考，请选择全能参考");
        for (const [index, image] of images.entries()) {
            const url = await upload(config, dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) }), options);
            content.push({ type: "image_url", role: frames ? (index ? "last_frame" : "first_frame") : "reference_image", image_url: { url } });
        }
        for (const video of options?.videos || []) content.push({ type: "video_url", role: "reference_video", video_url: { url: await upload(config, await mediaFile(video, options?.signal), options) } });
        for (const audio of options?.audios || []) content.push({ type: "audio_url", role: "reference_audio", audio_url: { url: await upload(config, await mediaFile(audio, options?.signal), options) } });
        const { data } = await axios.post<Response>(apiUrl(config, "v2", "/video_generation"), {
            model: modelOptionName(model), content,
            ...parameters,
            context_ir_enabled: false,
            aigc_watermark: boolConfig(config.videoWatermark, false),
        }, { headers: { ...headers(config), "Idempotency-Key": `infinite-canvas-${nanoid()}` }, signal: options?.signal });
        assertResponse(data);
        const id = data.task_id || data.task?.id;
        if (!id) throw new Error("H3 没有返回视频任务 ID");
        return { id, provider: "minimax", model };
    } catch (error) {
        throw requestError(error);
    }
}

export async function pollMiniMaxVideoTask(config: AiConfig, task: VideoGenerationTask, options?: Options): Promise<VideoGenerationTaskState> {
    try {
        const { data } = await axios.get<Response>(apiUrl(config, "v2", `/query/video_generation/${encodeURIComponent(task.id)}`), { headers: headers(config), signal: options?.signal });
        const status = data?.task?.status?.toLowerCase();
        if (["failed", "cancelled", "canceled", "expired"].includes(status || "")) return { status: "failed", error: errorText(data.task?.error || data.task?.base_resp || data.error || data.base_resp) || "H3 视频生成失败" };
        assertResponse(data);
        if (!status) throw new Error("H3 查询响应缺少任务状态");
        const url = data.task?.content?.url || data.task?.content?.video_url;
        if (url) return { status: "completed", result: { url, mimeType: "video/mp4" } };
        if (["succeeded", "completed", "success"].includes(status)) {
            const response = await axios.get<Blob>(apiUrl(config, "v2", `/video_generation/${encodeURIComponent(task.id)}/content`), { headers: headers(config), responseType: "blob", signal: options?.signal });
            if (!response.data.type.startsWith("video/")) throw new Error("H3 没有返回有效视频文件");
            return { status: "completed", result: { blob: response.data } };
        }
        return { status: "pending" };
    } catch (error) {
        throw requestError(error);
    }
}
