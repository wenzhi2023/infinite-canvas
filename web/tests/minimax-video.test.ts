import { afterEach, expect, mock, spyOn, test } from "bun:test";
import axios from "axios";
import { miniMaxVideoParameters } from "../src/lib/minimax-video";
import type { AiConfig } from "../src/stores/use-config-store";

mock.module("@/i18n", () => ({ default: { t: (key: string) => key } }));

mock.module("@/stores/use-config-store", () => ({
    boolConfig: (value: string, fallback: boolean) => value ? value === "true" : fallback,
    modelOptionName: (value: string) => value.split("::").pop(),
    withLocalProxy: (value: string) => value,
}));
mock.module("@/services/image-storage", () => ({ imageToDataUrl: async (image: { dataUrl: string }) => image.dataUrl }));
mock.module("@/services/file-storage", () => ({ getMediaBlob: async () => new Blob(["reference"], { type: "video/mp4" }), resolveMediaUrl: async (_key: string, url: string) => url }));
const { createMiniMaxVideoTask, pollMiniMaxVideoTask } = await import("../src/services/api/minimax-video");
const config = { baseUrl: "https://metaso.cn/api", apiKey: "test-only", videoSeconds: "6", vquality: "720", size: "16:9", videoMode: "frames", videoWatermark: "false" } as AiConfig;
const image = { id: "image", name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,YQ==" };
const task = { id: "task-test", provider: "minimax" as const, model: "channel::MiniMax-H3" };
afterEach(() => mock.restore());

test("defaults to 768P and six seconds without silently upcharging", () => {
    expect(miniMaxVideoParameters({ ...config, vquality: "", videoSeconds: "", size: "auto" }, false)).toEqual({ duration: 6, resolution: "768P", ratio: "16:9" });
    expect(miniMaxVideoParameters({ ...config, vquality: "2K", size: "auto" }, true)).toEqual({ duration: 6, resolution: "2K", ratio: "adaptive" });
    expect(() => miniMaxVideoParameters({ ...config, vquality: "1080" }, false)).toThrow("不会自动升级");
});

test("rejects invalid duration before any network request", async () => {
    const post = spyOn(axios, "post").mockRejectedValue(new Error("unexpected network"));
    for (const value of ["3", "16", "6.5", "NaN"]) await expect(createMiniMaxVideoTask({ ...config, videoSeconds: value }, task.model, "test", [image])).rejects.toThrow("4–15");
    expect(post).not.toHaveBeenCalled();
});

test("creates JSON video tasks using native endpoints", async () => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { task_id: task.id, base_resp: { status_code: 0 } } });
    expect(await createMiniMaxVideoTask(config, task.model, "test", [])).toEqual(task);
    expect(post.mock.calls[0][0]).toBe("https://metaso.cn/api/minimax/v2/video_generation");
    expect(post.mock.calls[0][1]).toMatchObject({ model: "MiniMax-H3", duration: 6, resolution: "768P", ratio: "16:9" });
});

test("uploads first/last frames and assigns their roles", async () => {
    const post = spyOn(axios, "post").mockResolvedValueOnce({ data: { file: { file_id: "first" } } }).mockResolvedValueOnce({ data: { file: { file_id: "last" } } }).mockResolvedValueOnce({ data: { task_id: task.id } });
    await createMiniMaxVideoTask(config, task.model, "test", [image, { ...image, id: "last" }]);
    expect(post.mock.calls[0][0]).toBe("https://metaso.cn/api/minimax/v1/files/upload");
    expect((post.mock.calls[0][1] as FormData).get("purpose")).toBe("video_generation_input");
    expect((post.mock.calls[2][1] as { content: unknown[] }).content).toEqual([{ type: "text", text: "test" }, { type: "image_url", role: "first_frame", image_url: { url: "mm_file://first" } }, { type: "image_url", role: "last_frame", image_url: { url: "mm_file://last" } }]);
});

test("uploads video and audio in reference mode", async () => {
    const post = spyOn(axios, "post").mockResolvedValueOnce({ data: { file: { file_id: "video" } } }).mockResolvedValueOnce({ data: { file: { file_id: "audio" } } }).mockResolvedValueOnce({ data: { task_id: task.id } });
    await createMiniMaxVideoTask({ ...config, videoMode: "reference" }, task.model, "test", [], { videos: [{ id: "v", name: "v.mp4", type: "video/mp4", url: "", storageKey: "v" }], audios: [{ id: "a", name: "a.mp3", type: "audio/mpeg", url: "", storageKey: "a" }] });
    expect((post.mock.calls[2][1] as { content: unknown[] }).content).toContainEqual({ type: "video_url", role: "reference_video", video_url: { url: "mm_file://video" } });
    expect((post.mock.calls[2][1] as { content: unknown[] }).content).toContainEqual({ type: "audio_url", role: "reference_audio", audio_url: { url: "mm_file://audio" } });
});

test("reports insufficient credits rather than creating a pending task", async () => {
    spyOn(axios, "post").mockResolvedValue({ data: { base_resp: { status_code: 1008, status_msg: "H3 积分余额不足" } } });
    await expect(createMiniMaxVideoTask(config, task.model, "test", [])).rejects.toThrow("H3 积分余额不足 (1008)");
});

test("queries pending, successful, and failed native tasks", async () => {
    const get = spyOn(axios, "get").mockResolvedValueOnce({ data: { task: { status: "running" } } }).mockResolvedValueOnce({ data: { task: { status: "succeeded", content: { url: "https://example.com/test.mp4" } } } }).mockResolvedValueOnce({ data: { task: { status: "failed", error: { message: "generation failed" } } } });
    expect(await pollMiniMaxVideoTask(config, task)).toEqual({ status: "pending" });
    expect(await pollMiniMaxVideoTask(config, task)).toEqual({ status: "completed", result: { url: "https://example.com/test.mp4", mimeType: "video/mp4" } });
    expect(await pollMiniMaxVideoTask(config, task)).toEqual({ status: "failed", error: "generation failed" });
    expect(get.mock.calls[0][0]).toContain("/minimax/v2/query/video_generation/task-test");
});

test("missing task status fails explicitly instead of spinning indefinitely", async () => {
    spyOn(axios, "get").mockResolvedValue({ data: {} });
    await expect(pollMiniMaxVideoTask(config, task)).rejects.toThrow("缺少任务状态");
});
