# AGENTS.md

FileTrans：Electron + React + TypeScript 的双栏 SSH/SFTP 文件传输客户端（中文界面）。
功能与架构细节见 `README.md`，本文件只列代理必须遵守的工作约定。

## 必守规则

1. **每次代码改动完成后都必须重新打包安装**：运行 `npm run package:linux`（内部会先执行 `npm run build`）。
   - 桌面入口 `scripts/filetrans-launcher.sh` 直接运行 `dist/linux-unpacked/`，不重新打包改动不会生效。
   - 打包后提醒用户：完全退出 FileTrans 再重启（重启会中断进行中的传输）。
   - 仅当用户明确在跑 `npm run dev`（HMR 开发模式）时才可跳过打包。
2. 改动后至少运行 `npm run typecheck && npm test`，两者都必须通过。
3. 不写代码注释（项目约定）；UI 文案与错误信息统一中文。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 类型检查（node + web） | `npm run typecheck` |
| 单元测试（无环境变量时跳过集成测试） | `npm test` |
| 单个测试文件 | `npx vitest run tests/xxx.test.ts` |
| 构建到 `out/` | `npm run build` |
| 打包 Linux（AppImage + deb + linux-unpacked） | `npm run package:linux` |
| 开发模式（无需打包） | `npm run dev` |

## 代码约定

- IPC 变更四处同步：`src/shared/ipc.ts`（channel）、`src/shared/api.ts`（接口）、`src/preload/index.ts`（桥接）、`src/main/ipc.ts`（handler）。
- 类型集中 `src/shared/types.ts`；渲染层内部类型放 `src/renderer/src/types.ts`；路径别名 `@shared` / `@`。
- 渲染层状态用 zustand；需跨重启保留的用 persist + localStorage（参考 `stores/settings.ts`、`stores/visits.ts`）。
- 运行时依赖仅 `ssh2`，不新增依赖，优先复用现有库。

## 测试约定

- 主进程传输引擎测试用 `tests/transfer-engine.test.ts` 的 FakeSession 模式。
- 渲染层 store 测试在 node 环境需 stub `window` / `localStorage`；这类测试一律放在 `tests/renderer/` 下（参考 `tests/renderer/visits.test.ts`），两个 tsconfig 已按目录通配，无需再逐个文件登记。
- 真实 SFTP / rsync 行为走 `tests/sftp-e2e.test.ts`、`tests/sync-e2e.test.ts`（需要环境变量，默认跳过）。
