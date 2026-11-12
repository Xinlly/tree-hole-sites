# HANDOFF.md — Tree Hole Sites 动态交接

> 本文件是**动态交接**：当前进度、分支快照、数据落点、待办。静态知识见 `AGENT.md`。
> 所有“已核实事实”均由本次接手代理在 **2026-11-12** 于 primary 工作区实跑只读命令复核，命令口径随条标注；与任务书不一致处已显式纠偏，勿照抄旧描述。

## 1. 当前分支 / 工作区快照（实测）

复核命令：`git branch -vv`、`git worktree list`、`git branch -r`、`git rev-parse`。

- primary 工作区路径：`/var/lib/hermes/workspace/projects/our/tree-hole-sites`
- 本地分支（仅 3 个）：
  - `develop` → `2726035`，跟踪 `origin/develop`，track 干净（无 ahead/behind）
  - `main` → `c1f27dc`，跟踪 `origin/main`，track 干净
  - `release-v1.1.0` → `c1f27dc`，upstream 显示 `origin/main`（与 main 同点）——**去留待 xavier 定，勿删**
- 远端分支：`origin/main`、`origin/develop`、`origin/feat/chunked-object-storage`、`origin/HEAD→main`
- main 与 develop 关系：`develop` 已全部并入 main；`main` 相对 develop 多 4 个提交（两次 release merge + 两次版本 pin：`c2ac9ce`/`2d7e4c2` v1.0.0、`16b71e8`/`c1f27dc` v1.1.0），develop 相对 main 无独有提交。
- 当前已发布版本：**v1.1.0**（tag 已在远端，main=`c1f27dc`）。

### 工作区已收敛（与任务书事实 1 一致，实测确认）
- `git worktree list` 现**仅 primary 一条**；`/tmp/th-develop`、`/tmp/th-v110` 两个临时 worktree 已移除/prune，物理目录不存在。
- 4 个本地 `feat/*` 分支（object-storage / chunked-object-storage / self-host-node / spaces-four-layer）均已删除，本地 `git branch` 不再出现；其内容已并入主线（此前 `git cherry`/`merge-base --is-ancestor` 验证零独有提交）。注意远端仍保留 `origin/feat/chunked-object-storage`。
- primary 工作区 `git status`：除未跟踪的 `docs/acceptance/` 外干净。

## 2. 设计文档指针（实测存在）

`docs/design/` 下 4 份，均含背景、决策与分支基线：
- `object-storage/design.md` — 对象存储选型与 S3 兼容方案（阿里云 OSS + `@aws-sdk/client-s3`，`STORAGE_TYPE` 切换）
- `chunked-object-storage/design.md` — 分块对象布局（active 热区 + block 封存 + tombstone）
- `self-host-node/design.md` — 自托管 Node（standalone）部署
- `four-layer-spaces/design.md` — 四层空间（公共/口令/个人/管理员）与账号鉴权

### ⚠️ 纠偏：任务书事实 2「对象存储只交付设计、未写产品代码」已过时
实测 `app/api/store/object-store.ts` 为 **833 行完整实现**，与 `sql-store.ts` 共同实现 `store/types.ts` 的 `Store` 接口，由 `store/index.ts` 按 `STORAGE_TYPE` 选择；并已随 **v1.1.0 上线 raiyun2**（生产用 `STORAGE_TYPE=object` + 阿里云 OSS）。即对象存储**设计与产品代码均已交付并在生产运行**，不是“仅设计”。

## 3. 验收截图（未跟踪，待办）

`docs/acceptance/` 4 张 PNG 实测存在但**未入 git**（`git status` 显示 `?? docs/acceptance/`）：
`01-gate.png`、`02-home.png`、`03-sealed.png`、`04-logged-out.png`。
- 原因：primary 长期检出在发布分支，未擅自提交。
- **待办：建议随 develop 入库**（需一次显式 `git add docs/acceptance/` 并提交，本次文档任务不含此项，未动）。

## 4. 外移研究报告指针（路径已纠偏）

任务书写的 `…/siyuan-s3/report.md` 实测**不存在**；真实落点与校验：
- 路径：`/var/lib/hermes/workspace/work/research-archive/siyuan-s3/siyuan-s3-research-report.md`
- sha256（实测）：`890502fea120e0445605081d3dd786f20d021fe863bd19edabbba691954d98ed`
- 本仓不保留该报告副本，仅存此指针。

## 5. Paseo 编排侧现状

- 管理者通告口径：本项目 Paseo 侧现仅余 tree-hole 协调者一个 agent，其余 research/reviewer/worker 已随工作区归档。
- 复核边界：本会话的 `list_agents` 按调用方作用域仅能看到自身，无法独立枚举他项目/已归档 agent，故此条采信管理者通告，未在本机二次证伪。

## 6. 未完成项 / 待办（按优先级）

1. **待 xavier 决策**
   - 本地 `release-v1.1.0` 分支去留（与 main 同点 `c1f27dc`）。
   - `docs/acceptance/` 4 张截图是否随 develop 入库。
   - 功能 parity（对照 2026-08-03 原版）确认丢失的 4 项是否恢复：封存随机暖语、封存回声确认卡片、实时字数徽章、密码框 autoFocus/autoComplete；另有 3 项削弱（分层退出、列表密度、中文日期）。详见 `temp/treehole-feature-parity-20261010/parity.md`（仓库外临时目录）。
2. **代码卫生（方案已出，未动工）**
   - `app/chatgpt-auth.ts` 模板残留、零产品引用，建议确认后删。
   - `db/schema.ts` 仍是旧 D1 两表，与 SqlStore 运行时自建表脱节（drizzle 不被产品引用）：删 `db/`+drizzle，或对齐真实 v3 表。
   - `package.json` name 仍为 `site-creator-vinext-starter`；develop 上 version 停在 `0.1.0`（仅发布分支 bump）。
3. **安全加固（CRITICAL，需专项设计 + 授权，勿与小改混做）**
   - 密码为单次 `sha256(前缀+密码)`，非慢哈希（建议 scrypt/argon2 + 存量惰性升级）。
   - 会话 cookie 未按外部协议条件化 `Secure`。
   - 登录强依赖反代透传 `X-Forwarded-Proto/Host`（raiyun2 曾因此 403），需写入部署硬前置。
4. **运行约束**：ObjectStore 单进程/单实例，禁水平扩容；部署文档需写明。

## 7. 数据落点

- SQL 模式：默认 `./data/tree-hole.db`（可用 `TREE_HOLE_DB_PATH` 覆盖），`data/` 已 gitignore。
- Object 模式：阿里云 OSS 桶，键布局 `v3/...`（users / pass-space-index 单文档 + 各 scope×集合的 state/block/tombstone），凭据经 0600 EnvironmentFile，不入库。
- 一次性迁移脚本：`scripts/migrate-legacy-to-v2.mjs`、`migrate-sql-to-object.mjs`、`migrate-v2-to-v3-public.mjs`（仅停机态运行）。

## 8. 本次交接文档提交说明

- `AGENT.md`、`HANDOFF.md` 为新增，提交在 `develop`（仓库存在 develop 分支，按纪律落开发分支并正常 push）。
- 未改动 `README.md`、`docs/` 与任何代码；未提交 `docs/acceptance/`；无密钥/敏感值。
