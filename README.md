# OpenSource Scout Agent

面向个人的开源贡献机会发现与辅助工作台。当前为 **v2 / M0–M3 本地已实施，M4/M5 设计待实现**，以 [当前路线图](docs/开发路线图.md) 为准。公开报告与运维工具已实现；真实模型闭环、Linux/HTTPS 和 2核2GB 容量验收仍待有效凭据和服务器环境，不代表已上线或通过云端验收。

Vue 3 + TypeScript + Fastify + SQLite，一个 Node 进程提供构建后的页面和 API。用户通过浏览器访问云端服务。

核心设计已恢复“自动发现适合我的开源贡献机会”：画像 → 立即/定时 GitHub 发现 → 规则与可选少量模型评估 → 私有候选 → 人工选择/状态复核 → 原有深入分析与待验证补丁。**M5 尚未实现**，当前可用入口仍是手动添加 Issue；完整贡献需要系统外验证和提交。模型评估默认关闭，定时需显式启用，不因修改文档开始扫描或付费。

## 当前可用

- 管理员登录、持久会话、退出、登录限速、同源和 CSRF 检查。
- 手动添加公开 GitHub Issue；仓库入口有限列表选择，固定 Commit 获取有界文本源码。
- 持久任务、单执行器、重复提交保护、取消、手动重试、重启中断与累计模型预算。
- DeepSeek JSON 分析、精确引文核对、来源/疑点/计划与实际用量页面，完成后等待人工审查。
- 修改计划版本与 Commit/hash 确认、每版单次补丁生成、严格统一 Diff 检查、私有审核包下载。
- 人工审核状态与手工 PR 链接/状态记录；补丁固定 UNVERIFIED，项目编译/测试 NOT_RUN，PR 来源 MANUAL。
- 游客首页、公开报告列表/详情；管理员脱敏预览、明确确认发布、撤回独立白名单快照。
- 数据库/任务/计划/审核包/发布历史配额、过期预览与会话清理、运行资源观察及带校验清单的备份恢复。
- 模型标识、凭据环境变量引用和有界资源设置，SQLite WAL 和校验和迁移。
- 健康检查 `/api/health`、结构化脱敏日志、Linux 单服务部署示例。

设计文档入口见 [v2 文档导航与实施状态](docs/文档导航与实施状态.md)、[M4 联调设计](docs/M4真实模型联调设计.md)、[M5 自动发现设计](docs/M5自动发现设计.md) 与 [验收发布标准](docs/验收与发布标准.md)。设计修订号 2.2 不表示产品已发布；[M5 使用说明](docs/M5使用说明.md) 是预期流程，不表示已有按钮。

使用见 [M1 使用说明](docs/M1使用说明.md)、[M2 使用说明](docs/M2使用说明.md)、[M3 使用与运维](docs/M3使用与运维.md)。首页默认游客入口 `/#/reports`，管理员登录 `/#/login`，私有工作台 `/#/workspace`。Markdown 按纯文本展示，不执行 HTML。浏览器测试夹具明确标记 FIXTURE，不能当作真实分析或真实模型生成的补丁。

目标代码仅作为不可信文本；应用没有 Shell、安装、构建、测试第三方项目或 GitHub 写入入口。未来补丁固定 `UNVERIFIED`，目标项目测试 `NOT_RUN`，手工 PR 信息 `MANUAL`。

## 开发与验证

已验证 Node **24.16.0**、npm **11.13.0**；依赖精确版本见 package-lock.json。生产使用 Node 24 LTS 的最新安全补丁，升级后重跑验证。开发用命令：

```sh
npm ci
npm run typecheck
npm run build
npm test
```

本地调试正式构建：复制 `.env.example` 到 `.env`，设置 `NODE_ENV=development`、`APP_ORIGIN=http://127.0.0.1:3000`、`DB_PATH=data/scout.sqlite` 和生成后的密码 hash。运行 `npm start`，浏览器访问该地址。密码必须 12–256 字符；通过标准输入传给 `node scripts/hash-password.mjs`，避免把密码写进命令参数、终端历史或仓库。

```sh
# Linux: 输入不会显示；hash 输出后写入私有 .env，勿提交
read -rs -p 'Admin password: ' scout_password
printf '%s' "$scout_password" | node scripts/hash-password.mjs
unset scout_password
```

PowerShell 可用 `Read-Host -MaskInput` 接收密码，再通过管道传给脚本；不要在命令中写真实密码。hash 在环境文件中用单引号包围。生产模式必须 HTTPS；只允许匹配 APP_ORIGIN 的 Origin 进行变更。会话有效期 1–24 小时，默认 12 小时，最多保留 20 个会话。修改管理员 hash 后应停止服务并清空 sessions 表，再重启。

## Git 约定

`main` 保存集成基线；每阶段使用 `feat/m3-public-reports` 一类短期分支。修复使用 `fix/...`。提交说明使用“功能：”“修复：”“测试：”“文档：”“运维：”等中文前缀，按可审阅的小改动提交；检查通过后经 PR 审核合入 main。作者/提交者使用 GitHub 用户名及隐私 noreply 邮箱，不使用真实姓名或个人邮箱。禁止提交 `.env`、数据库、日志、node_modules 与构建产物。交付时附中文 PR 标题、描述与合并提交说明，不自动合并主分支。

本仓库开发所需 Git push 与产品的 GitHub 只读权限属于不同操作；产品不持有写入工具。

## 部署与阶段证据

见 [部署、备份与恢复](docs/部署运维.md)、[M0 验证记录](evidence/M0/验收记录.md)、[M1 验证记录](evidence/M1/验收记录.md)、[M2 验证记录](evidence/M2/验收记录.md)、[M3 验证记录与 F01–F12 结论](evidence/M3/验收记录.md)。Linux/systemd/HTTPS 和 2GB 容量仍需在真实云环境验证，本机结果不能替代这些验收。
