# 本地 H3 接入

## 配置

在配置界面新增渠道，协议选择「秘塔 MiniMax H3」，Base URL 为 `https://metaso.cn/api`，填入自己的 API Key。模型为 `MiniMax-H3`，能力为视频。

使用内置协议时无需调用脚本；已有脚本优先执行，改用内置协议时需要手动清空该模型的旧脚本。不会自动改写现有渠道或密钥。

秘塔 H3 原生协议只用于视频，其他平台可以继续使用 OpenAI / Gemini 或自定义脚本。新的原生协议应在 `web/src/services/api/` 增加独立适配器，再接入已有创建/查询任务流程，不复制画布页面或引入品牌替换。

图片通过 H3 文件上传接口提交；首尾帧模式下，一张图为首帧、两张图为首尾帧，超过两张沿用原版的全能参考行为。视频和音频可用于全能参考。有首尾帧图片时不能混用视频/音频参考。

界面提供 768P 和 2K，时长范围为 4–15 秒，空设置默认 768P、6 秒。旧设置的 720 映射为 768P，不把 1080P 静默升级到 2K。提交前检查时长、分辨率和比例，不合法时直接显示错误，不上传素材或创建任务。保留用户已有参数，超出范围的旧设置需要用户手动修改。

任务 ID 和协议保存到画布节点，刷新后通过共享任务机制继续查询；现有轮询次数和间隔没有改变。错误显示不代表余额已经补足，余额不足仍需在秘塔账户处理。

API Key 保存在浏览器本地，由浏览器直连平台（开启本地代理时经代理转发），不是服务器托管密钥。画布和素材也主要保存在浏览器本地，部署前建议导出备份。

## Docker

`docker-compose.yml` 仍是官方镜像部署，未修改。项目已有的 `docker-compose.local.yml` 用于构建本地源码，也未修改。两份配置使用同一个端口，不能同时运行。

当前部署为 Compose 项目 `infinite-canvas-h3`，容器 `infinite-canvas-h3-app-1`，镜像 `infinite-canvas:local`，访问 `http://localhost:3000/`。旧官方容器改名为 `infinite-canvas-official-backup`，已停止并关闭自动重启，没有删除。浏览器里的原画布和素材没有清空。

现有「秘塔 H3」渠道已通过配置界面切换到原生协议，根地址为 `https://metaso.cn/api`，密钥未修改。旧脚本备份在 `/Users/yuhongdong/Documents/Codex/2026-10-04/https-github-com-basketikun-infinite-canvas/outputs/metaso-h3-before-native.js`，随后清空脚本以启用内置调用。Agents 渠道未修改。

后续构建更新（在本仓库根目录执行）：

```sh
docker compose -f docker-compose.local.yml -p infinite-canvas-h3 up -d --build
```

回滚容器（不要同时启动两个占用 3000 端口的服务）：

```sh
docker compose -f docker-compose.local.yml -p infinite-canvas-h3 stop
docker update --restart=unless-stopped infinite-canvas-official-backup
docker start infinite-canvas-official-backup
```

回滚旧版后若继续使用 H3，还需在界面把其协议改回 OpenAI、地址改回 `https://metaso.cn/api/minimax` 并恢复备份脚本。旧版本没有本次新增的原生协议。

## 已完成验证

- Vite 生产构建和 Docker 镜像构建成功；服务首页与静态 CSS 返回 HTTP 200。
- 禁网容器运行 11 项测试，全部通过。H3 测试使用模拟响应，不调用真实平台。
- 独立测试站点 `127.0.0.1:3001` 上验证 H3 控件的 768P/2K 和 15 秒上限、2K 历史保存、渠道配置刷新后保留；模拟余额不足时工作台及画布显示错误并恢复生成按钮，没有一直转圈。
- 正式站点确认原有画布仍为 2 个节点、1 条连线；原渠道密钥没有重新填写或修改。
- TypeScript 检查未完全通过：未修改的 `web/src/components/layout/model-script-editor.tsx:58` 使用了当前 Ant Design 类型不接受的 `styles.content`。生产构建不受阻，未顺手修改此原有问题。

## 待验证

- 配置保存、重载、导入导出后，渠道协议和密钥保持正确。
- 无参考图、单图、首尾帧、多图、视频/音频参考的请求与平台接口一致。
- 余额不足、鉴权失败、上传失败、网络断开和缺失参考图片能够显示错误并结束转圈。
- 生成期间停止、刷新、查询超时后继续查询，以及终态失败后重新生成。
- 原有 OpenAI / Gemini、Agnes 脚本、本地代理和 WebDAV 同步不受影响。
- 真实平台的付费生成未测试；成功响应、参考上传及失败状态已做模拟测试，不应视作所有模式已完成真实验收。
