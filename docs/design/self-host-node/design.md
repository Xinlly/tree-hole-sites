# 自托管解耦设计：Cloudflare Vinext + D1 → 标准 Next.js + 本地 SQLite

- 分支：`feat/self-host-node`
- 基线：`50143dc`（main/develop 同点）
- 方案：管理者已拍板方案 B，本文只做实施设计
- 目标环境：PVE Ubuntu 24.04.5 VM（192.168.0.183，2C/2G），Node 22.13+

## 1. 现状勘察结论（只读，已逐文件核实）

| 事实 | 证据 |
|---|---|
| 站点全部数据访问集中在 `app/api/tree-hole-store.ts`，手写 SQL + D1 API（prepare/bind/run/all/batch、`globalThis.TREE_HOLE_DB`） | 见该文件全文 |
| 上层 9 个 route 只依赖 store 的导出函数，不碰 D1 类型 | `app/api/**/route.ts` 全部已读 |
| `db/index.ts` 是唯一 `cloudflare:workers` + `drizzle-orm/d1` 引用点；无本站代码引用它，仅 `examples/d1/app/api/notes/route.ts` 引用其 `getDb` | 全仓 grep |
| `worker/index.ts` 职责=Cloudflare 边缘入口：注入密码 env、挂 D1 binding、`/_vinext/image` 图片优化、转交 vinext app-router | 见该文件全文 |
| `vite.config.ts` 是 vinext + @cloudflare/vite-plugin + wrangler D1/R2 绑定配置；其引用的 `./build/sites-vite-plugin` 在仓库中**不存在**（模板残留） | `build/` 目录不存在 |
| `.openai/hosting.json` 唯一消费者是 `vite.config.ts`（取 d1/r2 绑定名） | grep 全仓 |
| `tests/rendered-html.test.mjs` 依赖 `dist/server/index.js`（vinext build 产物的 worker）+ 手工 fake D1 | 见测试全文 |
| `examples/d1/` 位于根 `app/` 之外，标准 Next 不将其识别为路由，天然不进运行时构建；但其 `.ts` 在根 tsconfig `include: **/*.ts` 范围内，可能被 `next build` 类型检查纳入 | `tsconfig.json` |
| 鉴权全部走 `process.env` + Next `cookies()` + `crypto.subtle`，无任何 Cloudflare 专有 API | `tree-hole-auth.ts` |

### 可行性 spike（/tmp/bspike，不涉及产品代码）

- `npm install better-sqlite3` → 装到 **13.0.3**，**无需本机编译**：包内自带 `prebuilds/linux-x64.node`（glibc）及 musl/arm64/darwin/win 预编译件。
- 在本 NixOS 环境实际 `require('better-sqlite3')` 建库建表、预编译语句 insert/select 成功执行。
- `drizzle-orm@0.45.2` 的 `drizzle-orm/better-sqlite3` 入口实际加载、执行成功。
- 结论：Ubuntu 目标机无需 build-essential，只需系统自带的 `libstdc++6`（Ubuntu 默认安装）。

## 2. 改动文件清单与改法

### 2.1 `app/api/tree-hole-store.ts`（重写数据层，核心改动）

- 删除 `declare global { var TREE_HOLE_DB }` 与 `getDb()`。
- 模块作用域懒初始化单例 better-sqlite3 连接：
  - 路径 `process.env.TREE_HOLE_DB_PATH ?? "./data/tree-hole.db"`；
  - 首次使用时 `mkdirSync(dirname, { recursive: true })` 后 `new Database(path)`。
- SQL 全部保留原文，D1 API 与 better-sqlite3 一一对应：
  - `ensureTables`：`db.batch([...])` → 一次 `db.exec(四条 DDL 串联)`（SQLite 可一次执行多语句）；
  - list：`prepare(sql).all()` → better-sqlite3 `prepare(sql).all()`，仍过现有 `toEntry/toMessage`；
  - create/delete：`prepare(sql).bind(...).run()` → `prepare(sql).run(...)`。
- **保留全部导出函数签名与语义**（函数仍为 `async`，上层 `await` 零改动）；`normalizeNickname/toErrorMessage` 与两个类型定义一字不动。
- store 内继续使用手写 SQL（与原 D1 prepare/bind 形态一一对应，改动最小），不套 drizzle 查询构造器——drizzle 仅保留在 `db/index.ts`。理由：硬套 drizzle 重写全部查询不产生收益，违反 K2。

### 2.2 `db/index.ts`（改驱动，不删除）

有引用方（examples），删除会破坏 examples 且违反"不改 examples 业务代码"。改为：

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export function getDb() {
  const dbPath = process.env.TREE_HOLE_DB_PATH ?? "./data/tree-hole.db";
  return drizzle(new Database(dbPath), { schema });
}
```

`db/schema.ts` 不动。

### 2.3 删除 Cloudflare 运行时与工具链

- 删除 `worker/index.ts`（连带空的 `worker/` 目录）。图片优化由标准 Next 内置 `/_next/image` 覆盖：`page.tsx` 只通过 `next/image` 引用 `/morandi-companions.png`，未使用任何 vinext 专有端点。
- 删除 `vite.config.ts`（整体为 vinext/vite/wrangler 服务，标准 Next 无 vite）。
- 删除 `.openai/hosting.json`（连带 `.openai/`）：vinext 控制面模板文件，唯一消费者 vite.config 已删，改造后无用途。

### 2.4 `package.json`

- scripts 改为：
  - `dev`: `next dev`
  - `build`: `next build`
  - `start`: `next start`
  - `test`: `npm run build && node --test tests/`
  - `lint`、`db:generate` 保留不动。
- dependencies 增加 `better-sqlite3`。
- devDependencies 增加 `@types/better-sqlite3`。
- 删除仅服务 vinext/vite/Cloudflare 工具链的依赖：`vinext`、`@cloudflare/vite-plugin`、`wrangler`、`vite`、`@vitejs/plugin-react`、`@vitejs/plugin-rsc`、`react-server-dom-webpack`。
- 包管理器以 **npm** 为准（本机与 Ubuntu VM 均原生可用）；worker 执行 `npm install` 更新 `package-lock.json`，并用 `corepack pnpm@9 install --lockfile-only` 同步 `pnpm-lock.yaml`，保持双 lockfile 与 package.json 一致、无需做删除决策。

### 2.5 `next.config.ts`

- 增加 `output: "standalone"`。
- 若实测 standalone 漏带 better-sqlite3（见风险 R2），追加 `serverExternalPackages: ["better-sqlite3"]`；仍漏则用 `outputFileTracingIncludes`。以实测结果为准，不预先堆砌。

### 2.6 `.gitignore`

- 增加 `/data/`（SQLite 数据库目录）。其余不动。

### 2.7 测试改造（`tests/`）

原测试依赖 vinext worker 入口与 fake D1，标准 Next 无此入口。拆为三个 node:test 文件，覆盖原全部断言：

1. `tests/rendered-html.test.mjs`：保留原"源码静态断言"（`app/page.tsx` 中文案顺序、Morandi、防乱码），删除 worker/fakeDb 相关代码。
2. `tests/store.test.mjs`（新增）：用临时唯一 DB 路径（`os.tmpdir()`），对真实 SQLite 执行全部 store 函数——create/list/delete 留言与封存、`normalizeNickname`；验证插入后可列出、id 倒序、删除后消失。
3. `tests/http.test.mjs`（新增）：build 后 spawn `.next/standalone/server.js`（env 注入 `TREE_HOLE_PASSWORD=open-sesame`、`TREE_HOLE_ADMIN_PASSWORD=admin-sesame`、`TREE_HOLE_DB_PATH=临时文件`、`PORT=3100`），等待端口可用后通过真实 HTTP 断言：
   - 未登录 GET `/` 返回 200 text/html，含"输入密码/进入树洞"，无乱码；
   - 错误密码 401 且无 set-cookie；正确密码 200 且 set-cookie 含 `tree_hole_session=` 与 `HttpOnly`；
   - POST 留言/封存 201，GET 列表可见且中文不损坏；
   - 管理员解锁、admin/items 查看、DELETE 删除后列表清零。
   - 测试结束 kill 子进程。

此方案同时验证 standalone 部署件本身（含原生模块），数据保真用真实 SQLite，不再需要手工 fake。

### 2.8 `examples/d1`（不改业务代码）

- 标准 Next 不编译其路由；它只在根 tsconfig 的类型检查范围内。
- `next build` 实测：若 examples 导致类型检查失败，最小处理为在 `tsconfig.json` 的 `exclude` 增加 `"examples"`（它本就不是应用的一部分），**不删除、不改写 examples 任何代码**；eslint 同理，若报错再对 examples 加 ignore。以实测为准。

### 2.9 `README.md`（文档同步）

现有内容全部围绕 vinext/Cloudflare，改造后过时。最小重写：标准 Next 启动方式、必需环境变量（`TREE_HOLE_PASSWORD` / `TREE_HOLE_ADMIN_PASSWORD` / `TREE_HOLE_DB_PATH`）、`data/` 不入库、指向本设计文档。不保留 vinext/SIWC 脚手架段落（`chatgpt-auth.ts` 代码保留不动）。

## 3. 影响面

- **运行时**：Cloudflare Workers 边缘运行时 → Node 22 上 `next start` / standalone server。
- **数据**：D1（远端 SQLite）→ 本地 SQLite 文件，单文件、随部署目录。
- **构建链**：移除 vite/vinext/wrangler，回归 next 自身构建。
- **不变**：所有 API 路径、请求/响应结构、鉴权/cookie/密码语义、UI、`db/schema.ts` 表结构、`chatgpt-auth.ts` 等脚手架。
- **部署**：产出 standalone 单目录；systemd + nginx（见 §6）。

## 4. 风险与前置异常

- **R1 原生模块在 Ubuntu 的可用性**：spike 已证实 13.0.3 带 linux-x64 glibc prebuild，本机加载成功；Ubuntu 24.04 默认含 libstdc++6。残余风险：无（最终以 Gate/真机部署为准，本线不部署）。
- **R2 standalone 是否含原生 .node（关键实测点）**：Next 的文件追踪可能漏 better-sqlite3。验收必须实际启动 `.next/standalone/server.js` 并打通一个写库请求；漏则按 2.5 加配置后重测，不接受"build 成功"单独作为结论。
- **R3 secure cookie 与"先 HTTP 80"冲突（需协调者知悉）**：`tree-hole-auth.ts` 中两个 cookie 均 `secure: true`。浏览器在纯 `http://` 下**不会保存** secure cookie，访客/管理员解锁必然失败（浏览器标准行为）。任务书同时要求"鉴权保持不动"与"nginx 先 HTTP 80"，二者不可兼得。选项：
  - (a) 部署时 nginx 直接配 TLS（自签证书，内网浏览器有警告）——不改代码，**建议**；
  - (b) 坚持明文 HTTP，则必须改 cookie secure 标志——超出本次解耦范围，须另行批准。
  - 本设计按"鉴权不动"执行，部署建议按 (a)，请协调者在 Gate 前确认。
- **R4 时间戳语义**：D1 与 SQLite 的 `CURRENT_TIMESTAMP` 均为 UTC、格式 `YYYY-MM-DD HH:MM:SS`，页面按本地时区 `Intl` 解析，行为一致。
- **R5 id 语义**：SQLite `AUTOINCREMENT` 与 D1 同样保证删除后 id 不复用。
- **R6 连接模型**：单 systemd 实例 = 单连接单例；默认 journal 模式对低并发小站足够，不引入 WAL 等额外配置（K2）。Next dev 热重载可能产生多连接，仅开发期现象，不处理。
- **R7 2GB 内存**：不在 VM 构建；传输 standalone 产物。运行期内存属部署阶段实测项（§6 步骤含 `free -h` 检查）。

## 5. 验收标准（本线内全部实测）

1. `npm install` 退出 0，better-sqlite3 实际可 `require`。
2. `npm run lint` 退出 0。
3. `npm run build` 退出 0；`tests/http` 实际启动 standalone server 跑通写库请求（验证 R2）。
4. `npm test` 退出 0，含：静态断言、真实 SQLite 数据层 CRUD、HTTP 端到端全部原语义（密码门 HTML、401、HttpOnly cookie、留言/封存、管理员查看与删除）。
5. 残留 grep：产品代码中 `cloudflare`、`vinext`、`wrangler`、`D1Database`、`TREE_HOLE_DB` 为 **0**（排除 `examples/`、lockfile、本文档）；examples 业务代码零改动。
6. `git status` 中不出现 `data/` 或任何 `.env*`。

## 6. 部署步骤（供协调者 Gate 通过后执行；本 planner 不部署）

1. 构建机（本机）：`npm ci && npm run build`；组装产物目录：
   `.next/standalone/` + 复制 `.next/static` → `.next/standalone/.next/static`、`public/` → `.next/standalone/public`。
2. 传输到 VM：`rsync -az` 产物到 `/opt/tree-hole/`（Ubuntu Node 22 由 NodeSource 或 nvm 安装，需 22.13+）。
3. systemd：新建 `tree-hole` 用户；`/etc/systemd/system/tree-hole.service`：
   `WorkingDirectory=/opt/tree-hole`、`ExecStart=/usr/bin/node server.js`、
   `EnvironmentFile=/etc/tree-hole/tree-hole.env`（0600，含 `TREE_HOLE_PASSWORD`/`TREE_HOLE_ADMIN_PASSWORD`/`TREE_HOLE_DB_PATH=/var/lib/tree-hole/tree-hole.db`，密码绝不入库）；`Restart=always`。
4. nginx：80 端口 `proxy_pass http://127.0.0.1:3000`，带 `X-Forwarded-For/Proto/Host`；**按 R3 建议尽快加 TLS（443）**。
5. 备份：每日 cron 对 DB 做 `sqlite3 <db> ".backup <dest>"`（安装 sqlite3）或冷拷贝到 `/var/backups/tree-hole/`，保留 7 份。
6. 上线后实测：`systemctl status`、`free -h`、浏览器走完整解锁/留言/封存/管理员流程。

## 7. 执行编排（顺序闸）

1. 本设计落盘并 commit（planner 执行），冻结 worker 基线 SHA。
2. 派 1 名 worker（accept_edits）按 §2 实现，worker 不 commit / 不 push / 不部署，但需在回报前自跑 lint/build/test。
3. planner 独立核实磁盘 diff（仅任务内改动、无夹带、无半成品）。
4. 派 fresh reviewer（default 只读）审 diff 裁决；返工由 planner 再派 worker。
5. 全链路通过后 planner 向协调者回报，由协调者执行 Gate、合并与部署。
