import { inferVideoRatio } from "./media-size";

export const MINIMAX_SECONDS_MIN = 4;
export const MINIMAX_SECONDS_MAX = 15;
export const MINIMAX_SECONDS_DEFAULT = 6;

export function miniMaxVideoParameters(config: { videoSeconds: string; vquality: string; size: string }, hasReferences: boolean) {
    const duration = Number(config.videoSeconds.trim() || MINIMAX_SECONDS_DEFAULT);
    if (!Number.isInteger(duration) || duration < MINIMAX_SECONDS_MIN || duration > MINIMAX_SECONDS_MAX) throw new Error("H3 视频时长必须为 4–15 秒的整数，请修改视频设置");
    const quality = config.vquality.trim().toLowerCase();
    const resolution = !quality || ["720", "720p", "768", "768p"].includes(quality) ? "768P" : quality === "2k" ? "2K" : "";
    if (!resolution) throw new Error("H3 仅支持 768P 或 2K，请明确选择分辨率；不会自动升级为 2K");
    if (config.size.includes(":") && !["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(config.size)) throw new Error("H3 不支持所选视频比例，请修改视频设置");
    const ratio = inferVideoRatio(config.size || "auto");
    return { duration, resolution, ratio: ratio === "auto" ? (hasReferences ? "adaptive" : "16:9") : ratio };
}
