# FileTrans

基于 Electron + React + TypeScript 的双栏 SSH/SFTP 文件传输客户端，交互风格参照 FileZilla。中文界面，支持 Linux 与 macOS。

- 左侧本地面板 + 右侧远程面板，每个连接一个独立标签页（独立 SFTP 会话）
- 站点管理、Host Key（TOFU）校验、密码加密保存
- 目录递归传输、断点续传、失败自动重试、暂停/恢复/取消、冲突处理、symlink 智能跟进
- 大文件并行分块下载（默认 8 并发，可在传输设置中调整）
- FileZilla 风格传输队列：总体进度 + 正在传输的每个文件进度/速度，可拖拽调整高度

## 功能概览

| 分类 | 能力 |
| --- | --- |
| 浏览 | 双栏、多标签页、路径输入、返回上次路径、主目录、刷新（F5 同时刷新两侧）、列排序、列宽拖拽调整（双击恢复默认；列宽总宽超出面板时按各列超出最小值的部分等比收缩，永不溢出到相邻面板）、多选、`..` 上级、键盘操作（↑/↓ 移动选中、Enter 打开、Backspace 返回上级、首字母跳转且连按循环）、最近访问路径（本地与各站点各保存 5 条，重启后仍可一键跳转） |
| 文件操作 | 新建目录（支持多级路径，自动创建父目录，已有目录不报错）、重命名、删除（批量）、修改权限、清理传输临时文件（空白处右键） |
| 传输 | 上传/下载、目录递归、面板间拖拽、系统文件拖入远程、同时传输文件数（1-8 可配置，默认 3）、单文件并行分块下载（4MB 分块） |
| 同步 | 基于 rsync 的目录同步（调用本机 rsync）：本地↔远程双向、内容镜像、未变化文件自动跳过、排除规则（默认 `.venv*`）、可选镜像删除、压缩（优先 zstd，按能力降级为 zlib 或关闭）、进度与日志在传输队列展示、可取消 |
| 传输优化 | 断点续传（跨重启依据 `.filetrans-part.json` 旁挂状态恢复，状态缺失或不自洽则重新下载）、失败重试（默认 2 次）、暂停/恢复/取消、连接断开自动暂停并在重连后续传、单文件并行下载数（1-16 可配置）、保留时间戳与权限、单个文件失败后跳过并继续传输其余文件（失败与跳过清单分列在传输队列展示） |
| 冲突处理 | 覆盖 / 续传 / 跳过 / 取消（目标已存在时弹窗） |
| symlink | 范围内 → 重建链接并重映射目标；范围外 → 解引用复制；悬空 → 原样保留；环防护 |
| 站点 | 密码/密钥认证、默认远程路径、safeStorage 加密保存密码、Host Key TOFU 信任 |
| 安全 | contextIsolation + preload 白名单 IPC，渲染层无 Node 权限 |
| 外观 | 浅色 / 深色 / 跟随系统三种主题（顶栏右侧切换，重启后保留）；同步设置 Electron `nativeTheme`，macOS 标题栏与系统对话框随之切换；文件按扩展名显示类型图标 |
| 系统托盘 | 关闭窗口最小化到托盘（macOS 为黑色模板图自适应菜单栏明暗，Linux/Ubuntu 为彩色图标），后台继续传输；托盘菜单「显示 FileTrans / 退出 FileTrans」，退出前有进行中任务确认；托盘创建失败时回退为关闭即退出 |

## 技术栈

Electron 44 · electron-vite 5 · Vite 7 · React 19 · Zustand 5 · Tailwind CSS 4 · @tanstack/react-virtual · ssh2 · lucide-react · TypeScript 7 · Vitest 5

## 架构

三层 + 共享层。路径别名：`@shared`（三层通用）→ `src/shared`，`@`（仅渲染层）→ `src/renderer/src`。

```
src/
├── main/                  # 主进程
│   ├── index.ts           # BrowserWindow 创建（zoomFactor 1.25）、app.setName('FileTrans')
│   ├── ipc.ts             # IPC handler 注册与组装（SessionManager/TransferManager/RsyncManager）
│   ├── storage.ts         # 站点与 known-hosts 持久化（safeStorage 加密密码）
│   ├── local/fs.ts        # 本地文件系统操作
│   ├── rsync/             # rsync 同步（args/progress/runner：spawn+askpass+临时 known_hosts）
│   └── sftp/
│       ├── manager.ts     # SessionManager：Map<sessionId, SftpSession> 多会话、Host Key 校验
│       ├── session.ts     # 单个 SFTP 会话封装（ssh2）
│       └── transfer.ts    # TransferManager：传输引擎（递归展开/并发/续传/重试/进度）
├── preload/index.ts       # contextBridge 暴露 window.api（白名单）
├── shared/                # 主/渲染共享
│   ├── types.ts           # 全部领域类型（SiteConfig/TransferGroup/DirListing…）
│   ├── api.ts             # FileTransApi 接口（window.api 类型）
│   ├── ipc.ts             # IPC channel 常量
│   ├── path.ts / format.ts# posix 路径工具 / 大小、速度、模式格式化
└── renderer/src/          # React 渲染层
    ├── App.tsx            # 布局：Toolbar/TabBar/双面板/TransferPanel/StatusBar/各对话框
    ├── pane.ts            # 面板抽象：usePane/readPane/paneNavigate/paneGoBack…
    ├── actions.ts         # 用户操作入口（传输/重命名/删除/权限/右键菜单项）
    ├── components/        # Toolbar、TabBar、FilePane、FileTable、TransferPanel、各类 Dialog
    ├── stores/            # zustand：tabs(远程标签+历史)、files(本地)、sites、transfers、settings、ui
    └── utils/             # 排序、错误消息、样式常量
tests/                     # Vitest 单测 + 真实 SFTP 集成测试
scripts/                   # 图标生成、桌面入口安装、启动器
```

### 关键设计

- **多标签/多会话**：主进程 `SessionManager` 持有多个 `SftpSession`；所有 SFTP 与传输 IPC 都带 `sessionId`，关闭标签只断开对应会话。远程面板状态（路径、列表、选中、排序、路径历史）随标签独立；本地面板全局共享。
- **传输引擎**：一次 `transfers.start()` = 一个 `TransferGroup`。点击传输后**立即创建任务组**（状态「展开目录中」，可随时取消），目录树在后台展开为 `Job[]`（文件）/`DirJob[]`（目录）/`LinkJob[]`（符号链接）；远程目录按 16 并发并行 readdir 展开（同名路径只调度一次，避免经 symlink 与普通路径重复遍历），冲突检测在展开完成后进行；最多 3 个文件并发，300ms 定时 flush 进度；事件 `evt:transfer-update` 推送 `TransferGroup`，其中 `activeFiles` 仅包含正在传输的文件（名称/大小/已传字节/单文件速度）。
- **并行分块下载**：单个大文件（≥ 8MB）按并发数把剩余区间均分成若干连续分段（每段 ≥ 4MB），每个 worker 用一条流式请求（256KB 读块）连续读完自己的段，避免反复重建 SFTP 请求导致的速率抖动；暂停/失败后按每段已落盘的字节偏移继续，恢复时仅重传未完成部分。
- **暂停/恢复/取消**：通过 `abort` 中断流并保留已写入部分，恢复时按目标端字节偏移续传；中断错误用标记区分于真实失败，避免误重试。
- **失败处理**：单个文件重试耗尽后记为失败并跳过，其余文件继续传输；结束后整组状态为失败并汇总失败清单（最多展示 50 条），完整重跑可用续传补齐。
- **续传校验**：比对已传前缀确认目标端内容可信，前缀 ≤ 8MB 时逐 256KB 全量校验，超过则均匀采样 8 块（含首尾），避免大文件恢复时全量回读。
- **路径历史**：每个面板维护 `back: string[]`（上限 50）。双击目录、地址栏跳转、主目录、`..` 都会入栈；刷新不入栈；返回时出栈。
- **Host Key**：首次连接弹出指纹对话框（仅本次/信任并记住），信任记录存本机 `known-hosts.json`；不读写 `~/.ssh/known_hosts`。

## 运行数据

| 位置 | 内容 |
| --- | --- |
| `~/.config/FileTrans/sites.json`（Linux） | 站点配置，密码/passphrase 经 Electron safeStorage 加密 |
| `~/.config/FileTrans/known-hosts.json` | 已信任的 Host Key 指纹 |
| localStorage `filetrans-transfer-settings` | 续传/重试/时间戳/权限等传输选项 |
| localStorage `filetrans-queue-height` | 传输队列面板高度 |
| localStorage `filetrans-theme` | 主题（跟随系统/浅色/深色） |

> `app.setName('FileTrans')` 必须在 `app.whenReady()` 之前调用，否则数据会落到 `~/.config/Electron`。

## 开发

要求 Node `^20.19.0 || >=22.12.0`（Vite 7 要求），开发环境使用 Node 24。

```bash
npm install
npm run dev          # electron-vite dev（已带 --noSandbox）
```

其他常用命令：

```bash
npm run typecheck    # tsc 检查 main/preload + renderer 两套 tsconfig
npm test             # Vitest 单测（集成测试无环境变量时自动跳过）
npm run build        # electron-vite build → out/
```

### 同步功能（rsync）

工具栏「同步…」打开对话框，分别填写/预填本地目录与远程目录（预填优先级：面板单选目录 > 上次同步使用的目录 > 面板当前路径），选择方向后启动。语义对齐 shell 里的 `rcp`：

- 参数按两端 rsync 能力协商：本机为 GNU rsync 且远端也是现代 GNU 时用 `-a -s --partial --no-owner --no-group --info=progress2,name [--zc=zstd]`；远端不支持时自动去掉 `-s`/`--info`，改用 `--progress`（并对含特殊字符的远端路径加引号）；本机为 openrsync 时用 `-rlptD --partial --progress`。压缩优先 zstd，降级 `-z`，源目录带尾部斜杠（内容镜像）
- macOS 自带 openrsync 开箱可用：启动时自动探测本机 rsync（优先 Homebrew/`/usr/local` 的现代 GNU rsync，回退系统自带 `/usr/bin/rsync`），并通过 SSH 探测远端 rsync 版本；openrsync 下进度为文件级（按已完成文件数计算百分比）
- 密码/口令通过临时 askpass 脚本（0700）非交互传给 ssh（`SSH_ASKPASS_REQUIRE=force`，要求 OpenSSH ≥ 8.4）；密钥认证走 `-i` + `IdentitiesOnly`
- Host Key 复用应用的 TOFU 结果：连接会话时记录的公钥写入临时 known_hosts（`StrictHostKeyChecking=yes`），任务结束即清理
- `--delete` 默认关闭，开启时二次确认；退出码 24（源文件消失）视为完成并记日志，23 等为失败
- 取消 = 终止进程组，`--partial` 保留已传部分，下次同步自动续传；app 退出时统一终止运行中的任务
- 同步成功后记住本次使用的本地目录，远程目录按站点分别记住，重启后仍生效
- 传输设置中的「禁用同步目录」：每行一个目录，列表中的目录（本地或远程）不能作为同步目录，比较时忽略结尾 `/` 与 `.`/`..`，渲染层与主进程各校验一次
- 依赖：本机与远程均需安装 rsync（macOS 系统自带 openrsync 即可）；远程缺失时任务失败并展示远端报错

### 集成测试（真实 SFTP）

`tests/sftp-e2e.test.ts` 需要本机可用的 sshd 与密钥，通过环境变量启用：

```bash
FILETRANS_TEST_SSH_PORT=22222 \
FILETRANS_TEST_SSH_KEY=/path/to/id_ed25519 \
FILETRANS_TEST_SSH_USER=$USER \
FILETRANS_TEST_DATA=/tmp/filetrans-test-data \
npm run test:integration
```

覆盖：目录递归上传/下载、symlink 跟随与重映射、断点续传、冲突处理等。

`tests/sync-e2e.test.ts` 覆盖 rsync 同步（同样依赖上述 sshd 环境变量，另可用 `FILETRANS_TEST_RSYNC_PATH=/usr/bin/rsync` 指定本机 rsync，用于验证 openrsync 路径）：上传镜像与排除、二次运行跳过、变化重传、可选镜像删除、下载镜像。

## 构建与打包

```bash
npm run package:linux   # → dist/FileTrans-0.1.0.AppImage、dist/filetrans_0.1.0_amd64.deb
npm run package:mac     # → dmg
```

Linux 桌面入口：

```bash
node scripts/generate-icon.mjs      # 生成 build/icon.png
npm run package:linux
./scripts/install-desktop.sh        # 安装应用列表/桌面图标，Exec 指向 filetrans-launcher.sh
```

启动器 `scripts/filetrans-launcher.sh` 会：检测到 X11 时加 `--ozone-platform=x11`；当 `chrome-sandbox` 非 root 且无 setuid 时自动加 `--no-sandbox`；`FILETRANS_OZONE=wayland` 可强制 Wayland。

### 环境注意事项

- AppImage 在部分发行版需要 `libfuse2`；缺失时可直接运行 `dist/linux-unpacked/filetrans`（或经由 launcher）。
- 开发机若 `chrome-sandbox` 未 setuid，需 `--no-sandbox`（`npm run dev` 已内置）。
- 界面整体通过 `webPreferences.zoomFactor = 1.25` 放大。

## 面向后续开发的约定

- **IPC 变更四处同步**：`src/shared/ipc.ts`（channel）、`src/shared/api.ts`（接口）、`src/preload/index.ts`（桥接）、`src/main/ipc.ts`（handler）。
- **类型集中在 `src/shared/types.ts`**，主/渲染共享；渲染层内部类型放 `src/renderer/src/types.ts`。
- **不写代码注释**（项目约定）；UI 文案统一中文。
- **验证要求**：改动后至少 `npm run typecheck && npm test`；涉及传输引擎补 `tests/transfer-engine.test.ts`，涉及真实 SFTP 行为补 `tests/sftp-e2e.test.ts`。
- **依赖保持精简**：运行时依赖仅 `ssh2`，其余均为 devDependencies。
