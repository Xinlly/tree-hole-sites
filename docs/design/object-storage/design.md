# 对象存储改造设计：SQLite 与阿里云 OSS 可配置切换

- 分支：`feat/object-storage`
- 基线：`develop@002be78`（标准 Node Next.js 16 + better-sqlite3 自托管，线上 http://192.168.0.183）
- 后端（已拍板，不做选型比较）：**阿里云 OSS，走 S3 兼容协议，`@aws-sdk/client-s3`**
- 本文件为唯一提交物（本阶段不写产品代码）

## 0. 目标与边界

把存储层从"写死 better-sqlite3"改为"统一 Store 接口 + 两个实现（SQL / Object-OSS）+ `STORAGE_TYPE` 切换"。

边界（K2）：
- 鉴权（`tree-hole-auth.ts`）、UI（`page.tsx`）、5 个路由的对外 HTTP 行为全部不变。
- 只新增"切换 + 两实现共存 + 一次性迁移"所必需的代码；不做双写、不做多实例支持、不加缓存层、不加存储前缀等未要求的可配置项。
- 密钥/连接串只走环境变量（EnvironmentFile 0600），不入库、不打印。

## 1. 统一 Store 接口与文件拆分

### 1.1 接口（新文件 `app/api/store/types.ts`）

```ts
export interface Store {
  ensureInitialized(): Promise<void>;
  listMessages(): Promise<StoredMessage[]>;
  createMessage(nickname: string, content: string): Promise<void>;
  deleteMessage(id: number): Promise<void>;
  listEntries(): Promise<StoredEntry[]>;
  createEntry(mood: string, content: string, reply: string): Promise<void>;
  deleteEntry(id: number): Promise<void>;
}
```

- `StoredEntry{id,mood,content,reply,createdAt}`、`StoredMessage{id,nickname,content,createdAt}` 两个类型定义从 `tree-hole-store.ts` 移入 `types.ts`。
- `normalizeNickname` / `toErrorMessage` 是纯函数、与存储后端无关：**保留在 `tree-hole-store.ts` 不动**（不进接口，避免无谓的类化）。
- 现 `ensureTables()` 语义是"确保存储就绪"（SQL 建表）。接口中命名为 `ensureInitialized()`，各实现内部对应：SQL=建表 DDL；Object=确保集合对象可访问（见 1.4）。对外门面仍导出 `ensureTables` 名（见 1.5），路由零改动。

### 1.2 SQL 实现（新文件 `app/api/store/sql-store.ts`）

- 把现 `tree-hole-store.ts` 的全部 better-sqlite3 逻辑原样平移为 `class SqlStore implements Store`：
  单例连接、`TREE_HOLE_DB_PATH ?? "./data/tree-hole.db"`、`mkdirSync(dirname)`、两表两索引 DDL、6 个查询函数（SQL 文本、`ORDER BY id DESC LIMIT 100`、参数绑定）逐字不变。
- 不改 SQL、不改时间戳/ id 语义。

### 1.3 Object 实现（新文件 `app/api/store/object-store.ts`）

- `class ObjectStore implements Store`，构造时用 `@aws-sdk/client-s3` 的 `S3Client`：

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

new S3Client({
  region: process.env.STORAGE_OBJECT_REGION,
  endpoint: process.env.STORAGE_OBJECT_ENDPOINT,   // 如 https://s3.oss-cn-hangzhou.aliyuncs.com
  credentials: {
    accessKeyId: process.env.STORAGE_OBJECT_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGE_OBJECT_SECRET_ACCESS_KEY,
  },
  // 硬上限（非 SDK 默认值——已核 SDK 源码，默认 requestTimeout=undefined=无限等待）：
  requestHandler: new NodeHttpHandler({
    requestTimeout: 5000,      // 单个请求最多 5s
    connectionTimeout: 3000,   // 建连最多 3s
  }),
});
```

> `@smithy/node-http-handler` 随 `@aws-sdk/client-s3` 传递安装，不新增直接依赖。超时/连接失败即 reject，由路由现有 `toErrorMessage` 返回 500、UI 走现有失败提示；不做缓存、不静默降级。

- **禁止设置 `forcePathStyle`**：阿里云 OSS 仅支持虚拟托管风格（bucket 作子域名），path style 会被拒（依据：阿里云《S3 兼容性支持范围差异详解》）。AWS SDK v3 默认即 vhost，bucket 由 `GetObject/PutObject` 的 `Bucket` 参数参与签名与寻址。
- 使用命令：`GetObject`、`PutObject`（不引入 presigner、不引入额外 AWS 包）。
- endpoint 用 S3 兼容格式：`https://s3.oss-<region>.aliyuncs.com`（依据：阿里云《如何使用 AWS SDK 访问 OSS》）。本站为 PVE 内网普通 VM（非阿里云 ECS/VPC），**用公网 endpoint**；`-internal` 内网 endpoint 仅在同地域阿里云 VPC 内可用，本机不适用。

### 1.4 Object 初始化与就绪检查

- `ensureInitialized()`：读一次两个集合对象；若对象不存在（`NoSuchKey`）则视为空集合并落一个初始结构（见 §4），不报错。
- **不做 `CreateBucket`**：bucket 需预先在 OSS 控制台建好（部署前置步骤）。理由：最小权限（AK 只给读写对象、不给建桶），且避免代码触碰账户级资源。
- bucket 不存在 / 凭证错误 / 无网络：由首次真实请求抛出，经路由现有的 `toErrorMessage` 返回 500（与 SQL 异常同一路径）。

### 1.5 工厂与门面

- 新文件 `app/api/store/index.ts`：
  - `getStore(): Store`：读 `STORAGE_TYPE`（见 §2），惰性构造并缓存**单例**（SQL 单连接 / Object 单 S3Client 与串行队列）。
  - 非法值在首次取 store 时直接抛错（fail-fast）。
- 改 `app/api/tree-hole-store.ts` 为**薄门面**（保持现有全部导出名，5 个路由零改动）：

```ts
export type { StoredEntry, StoredMessage } from "./store/types";
const store = () => getStore();
export const ensureTables = () => store().ensureInitialized();
export const listMessages = () => store().listMessages();
export const createMessage = (n: string, c: string) => store().createMessage(n, c);
export const deleteMessage = (id: number) => store().deleteMessage(id);
export const listEntries = () => store().listEntries();
export const createEntry = (m: string, c: string, r: string) => store().createEntry(m, c, r);
export const deleteEntry = (id: number) => store().deleteEntry(id);
export function normalizeNickname(...) { /* 原实现逐字保留 */ }
export function toErrorMessage(...) { /* 原实现逐字保留 */ }
```

函数仍为 `async`（返回 Promise），签名与类型逐字不变。

## 2. 配置切换

### 2.1 环境变量（命名对齐现有 `TREE_HOLE_*` 风格，定稿）

| 变量 | 用途 | 缺省 |
|---|---|---|
| `STORAGE_TYPE` | `sql` \| `object` | **`sql`** |
| `STORAGE_OBJECT_ENDPOINT` | OSS S3 兼容 endpoint，如 `https://s3.oss-cn-hangzhou.aliyuncs.com` | 无 |
| `STORAGE_OBJECT_REGION` | 地域 ID，如 `cn-hangzhou` | 无 |
| `STORAGE_OBJECT_BUCKET` | 预建 bucket 名 | 无 |
| `STORAGE_OBJECT_ACCESS_KEY_ID` | RAM 用户 AK | 无 |
| `STORAGE_OBJECT_SECRET_ACCESS_KEY` | RAM 用户 SK | 无 |

全部经 `/etc/tree-hole/tree-hole.env`（0600）注入，不入库、不进日志。

### 2.2 默认值建议：`sql`

理由：现网升级后**不新增任何强制配置即可继续运行**，行为与 002be78 完全一致；object 为显式 opt-in，降低升级与回滚风险。

### 2.3 失败行为（明确，不做"智能兜底"）

- `STORAGE_TYPE` 为非 `sql|object` 的值：首次调用即抛 `Invalid STORAGE_TYPE "<v>" (expected sql|object)`，路由返回 500。**不静默回退 SQL**（静默回退会掩盖配置错误、可能写错存储）。
- `STORAGE_TYPE=object` 但 5 个对象变量任一缺失：`getStore()` 构造时抛 `Missing object storage config: STORAGE_OBJECT_*`，500。
- endpoint/region/bucket 逻辑不一致（如 endpoint 地域与 region 不符）：不在代码校验，由 OSS 返回的签名/寻址错误暴露。

## 3. 对象存储后端（已定：阿里云 OSS / S3 兼容）

- 不做 MinIO 自建 vs 云的选型比较（管理者已删除该议题）。
- 代码只依赖 S3 协议，理论上后端可替换为任何 S3 兼容服务；但本次只按阿里云 OSS 验收。
- 新增依赖：`@aws-sdk/client-s3`（实测 npm 最新版 **3.1142.0**，`engines.node >=20.0.0`，本项目 Node 22 满足；client-s3 包 unpacked ≈ 3.3 MB，**未含 smithy 等传递依赖，总体 node_modules 增量与运行时 RSS 增量标 [UNCERTAIN]，真机验收时实测**）。
- 纯 JS 依赖、无原生模块：Next standalone 的文件追踪对普通 JS 包生效，"漏原生模块"问题不存在；但仍须真机启动 object 模式 standalone 验证（见 §8）。

## 4. 对象布局

### 4.1 两个候选

- **A：每集合一个 JSON 对象（读-改-写、整体覆盖）**
  bucket 内两个 key：`visitor-messages.json`、`tree-hole-entries.json`。
  写操作：GetObject → 内存改数组/计数器 → PutObject 整体覆盖。
- B：每记录一个对象 + 索引对象（`messages/<id>.json` + `messages-index.json`）
  写需同时维护记录对象与索引，删除/列表依赖索引一致性；对象数与请求数随记录增长。

### 4.2 推荐：A（单集合单 JSON）

依据：每表上限 100 条（现有 `LIMIT 100` 语义保持），单条中文内容 ≤1500 字，整对象量级约 100–300 KB；低并发内网小站。
- A 一次 PUT **原子替换整个集合**，不存在"记录与索引不一致"；对象数恒定为 2，排查/迁移直观。
- B 的分片优势（大集合、高并发、单记录可寻址）在本场景全部用不上，却引入双对象一致性与更多请求，违 K2。

### 4.3 对象内结构（承载 id 与时间戳，见 §5）

```json
{
  "nextId": 3,
  "items": [ { "id": 2, "nickname": "匿名", "content": "…", "createdAt": "2026-09-29 12:34:56" } ]
}
```

- `items` 顺序：内存中按 id 升序维护，落盘同序；`list*` 返回前做 id 倒序（对齐现有 `ORDER BY id DESC`）。
- 超过 100 条时：追加后若长度 >100，丢弃 id 最小的旧条目（对齐现有"只保留最近 100"语义；SQL 下列表只取 100 但旧行仍在库——**语义差异**：对象模式为控制对象大小不保留 100 条之外的历史。两者对用户可见结果一致（列表都是最近 100），管理员也只能看到 100。记录在案）。
- key 名固定、不加前缀（如需隔离用独立 bucket）。

## 5. ID 与时间戳

- **id**：由对象内 `nextId` 生成。create 时取 `nextId` 为新 id、随后 `nextId+1` 落盘。单调递增、删除不复用（对齐 SQLite `AUTOINCREMENT` 的用户可见语义）。两个集合各自独立计数。
- **createdAt**：由应用在写入时生成，格式与 SQLite `CURRENT_TIMESTAMP` 完全一致——UTC、`YYYY-MM-DD HH:MM:SS`（用一个约 10 行的本地格式化函数，不引日期库）。
  - 现状：SQL `DEFAULT CURRENT_TIMESTAMP` 在 insert 时由 SQLite 写入 UTC 该格式串；UI（`page.tsx`）按字符串解析并以 `Intl` 转本地时区显示。Object 模式保持同一字符串形状，UI 零改动。
  - SQL 模式仍由 SQLite 默认值产生，两种后端该字段外观一致。

## 6. 一致性与并发

- **单 Node 进程内串行**（实现，必需）：ObjectStore 内对每个集合维护一条 Promise 链（互斥），所有"读-改-写"入队执行，单进程内无竞态。
  - **链任务必须内部 catch（实现必需防御）**：入队的每个读-改-写任务自身必须捕获 reject，不能让一次失败（含 5s 超时）冒泡成 Promise 链的 reject——否则链尾被污染、后续所有读写永挂。要求队头任务超时/失败后，队列仍能正常接收并执行下一个任务（失败仅作用于当次请求、经路由返回 500）。
- **多实例/多进程不支持**（明确声明）：生产为单 systemd 实例（与现 SQLite 单写者约束相同）。object 模式下若同时跑第二个进程（手工/误启动），最后整体覆盖者获胜，可能丢更新——与"SQLite 多进程写"一样不在支持范围。
  - 不引入分布式锁、不引入 S3 条件写（`If-Match` ETag）重试逻辑：K2，单实例场景无必要。
  - 若将来确需多实例，再用条件写（PutObject `If-Match` 读时 ETag + 冲突重读重试）或独立锁，属独立事项。
- 部署切换通过"改 EnvironmentFile + restart"完成，restart 期间无写入，新旧进程不并发。

## 7. 迁移（一次性，不做双写）

- 新文件 `scripts/migrate-sql-to-object.mjs`（Node 原生运行）：
  1. 用 better-sqlite3 打开现 DB（路径取 `TREE_HOLE_DB_PATH`），全量读两表（无 LIMIT）；
  2. 先按 id 升序排序、**只保留最近 100 行**再组装 §4.3 的 `items`（字段映射对齐 `toEntry/toMessage`）；
  3. **`nextId` 必须基于全量行的 `max(id)+1`**（即便旧行已被裁剪也不复用 id；空表为 1）；
  4. PutObject 覆盖两个 key。
- 执行流程（Gate 后，协调者/运维操作；本设计只给步骤）：
  1. 先在 OSS 控制台建好 bucket、创建仅授权该 bucket 读写对象的 RAM AK；
  2. 停机（`systemctl stop tree-hole`），跑迁移脚本（同时具备 SQL 路径与 OBJECT_* 环境变量）；
  3. 在 EnvironmentFile 设 `STORAGE_TYPE=object` + 5 个 OBJECT 变量，启动，按 §9 验收。
- **不做双写、不做启动自动迁移**：数据量小、停机窗口短（秒级），双写徒增复杂度与一致性风险（K2）。
- 脚本可重复执行（覆盖写）；但应在停机态运行，避免迁移后又有新 SQL 写入。

## 8. 测试策略

### 8.1 单测（`node --test`，进入现有 `npm test`）

- `tests/store.test.mjs`（现有，SQL CRUD/纯函数）：默认 `STORAGE_TYPE` 未设=sql，**继续覆盖 SqlStore，不改其断言**。
- 新增 `tests/object-store.test.mjs`：
  - 用 `aws-sdk-client-mock`（第三方包，devDependency）mock `S3Client.send`：验证
    首次读 NoSuchKey→空集合初始化；create→id 单调、createdAt 格式正确、中文保真；delete→覆盖后该 id 消失；100 条上限裁剪；list 倒序。
  - 同时验证并发两条 create 经串行队列不丢 id（计数正确）。
  - 局限显式记录：mock 只证明"我们的代码正确调用 SDK"，不证明真实 OSS 行为（vhost 寻址、签名、JSON 往返）——由 8.3 真机集成补齐。
- 新增 `tests/store-factory.test.mjs`：`STORAGE_TYPE=sql/object` 分别得到对应实现；非法值抛错；object 缺任一变量抛错。
- 不使用 testcontainers / 临时 MinIO（后端已不为 MinIO，且不在 2GB VM 引入 Docker）。

### 8.2 现有 9 测试不回归

- `tests/rendered-html`（源码断言）、`tests/http`（spawn standalone，注入密码与临时 DB）均不设 `STORAGE_TYPE` → 默认 sql → 路径与现在完全一致。
- 预期总数：9 → 12（新增 object 单测与 factory 用例，以实际为准）。

### 8.3 object 模式 standalone 真机验收（Gate/上线阶段，不进默认 test）

- 真机以 `STORAGE_TYPE=object` + 真实 OSS 变量启动 standalone：
  - **真机首个请求探针（首请求必验项，不阻断部署准备）**：接流量前先用真实凭证做一次最小 GetObject（探测 key）/PutObject，验证 vhost 寻址 + SigV4 + 无 chunked 报错，并重点确认新版 SDK PutObject 默认的 `x-amz-checksum-*` 头是否被 OSS 接受（此项当前 [UNCERTAIN]）；通过后再接流量。
  - 走完密码门→留言→封存→管理员查看/删除，实际打通 OSS 读写（对象 key 在控制台可见、JSON 内容正确）；
  - 实测并记录：进程 RSS 增量（回答 §3 的 [UNCERTAIN]）、首请求延迟；
  - **延迟上限（VM 实测目标，非预置结论）**：P95 `list` ≤500ms、`create` ≤1s；超时/连接失败 → reject → 路由现有 500 / UI 现有失败提示，不加缓存、不静默降级；
  - VM 出网前置检查：`curl https://s3.oss-<region>.aliyuncs.com` 可达（VM 当前经内网 NAT 出网，需确认到 OSS 公网 endpoint 的 443 放行；若 VM 走代理，AWS SDK 识别 `HTTPS_PROXY`，并注意 `NO_PROXY` 勿把本地链路误代理——此前本地 CDP 端口被代理出 502 的同类坑）。
- 浏览器截图验收可复用 `acceptance/` 方式（独立事项，不在本设计强制）。

## 9. 影响面、验收与回滚

### 9.1 受影响文件（实施期预期清单）

新增：
- `app/api/store/types.ts`、`sql-store.ts`、`object-store.ts`、`index.ts`
- `scripts/migrate-sql-to-object.mjs`
- `tests/object-store.test.mjs`、`tests/store-factory.test.mjs`

修改：
- `app/api/tree-hole-store.ts`（改为薄门面，类型转出）
- `package.json` / `package-lock.json`（+`@aws-sdk/client-s3`；devDeps +`aws-sdk-client-mock`）。本项目统一用 npm，不保留 pnpm-lock。

不动：`tree-hole-auth.ts`、`page.tsx`、5 个路由、`layout.tsx`、`db/`（drizzle 脚手架仍不被产品引用，沿用现状）、nginx 配置。

### 9.2 验收标准

1. `npm run lint`、`npm run build` 退出 0；`npm test` 全绿（默认 sql 路径行为与 002be78 一致）。
2. sql 模式：`tests/http` 端到端继续通过（SQLite 写库、登出清 cookie）。
3. object 模式（真机）：standalone 实启，留言/封存/删除全链路经 OSS 成功；bucket 内两个 JSON key 内容与结构符合 §4.3；id 单调不复用、createdAt 为 UTC 规定格式。
4. 迁移脚本：停机态从真实 SQLite 迁移后，object 列表与迁移前 SQL 列表端点返回结果一致（最近 100 条，字段一致）。
5. 非法 `STORAGE_TYPE`、缺 OBJECT 配置：明确 500 报错，不静默回退。
6. 工作区无 `.env*`、无 `data/` 入库；代码与日志不输出 AK/SK。

### 9.3 回滚

- 代码/配置回滚：EnvironmentFile 去掉 `STORAGE_TYPE=object`（或改回 `sql`）+ `systemctl restart tree-hole` 即回到 SQLite；SQLite 文件在切换期间不被写、原样保留。
  - **回滚的数据边界（管理者 2026-09-29 拍板，选 b：不提供反向回迁脚本）**：
    - “SQLite 文件原样保留”只保证文件不损坏，**不保证回滚后数据完整**——object 运行期间新增的 entries/messages 只存在于 OSS，切回 sql 后看到的是切换前的旧数据、新增内容不在 SQLite（仍留在 OSS）。
    - 因此该 env+restart 回滚**仅在“上线验证、object 尚未承载新数据”的窗口内是无损的**。
    - 一旦 object 已正式承载新数据，回滚到 sql 视为**人工数据回迁操作**：只能带回每集合最近 100 条、>100 条历史永久不可恢复，需人工执行（本设计不提供回迁脚本，K2、当前无真实回迁需求）。
    - 通用结论：>100 条之外的历史，在未来任何 object→sql 回迁中均永久不可恢复（对象布局本身不保留其外数据）。
- OSS 侧对象可保留（不影响 sql 运行），确认不需要后在控制台删除；RAM AK 可禁用。
- 分支未合并前的整体回滚：不合并 `feat/object-storage` 即可，develop/现网不受影响。

### 9.4 部署侧改动点（Gate 后执行）

- `/etc/tree-hole/tree-hole.env`（0600）：+6 个变量；
- OSS 控制台：建 bucket（私有、不公开读）、RAM 子账号 AK（仅该 bucket 对象读写）；
- VM 出网：确认到 OSS 公网 endpoint 的 TCP 443；
- systemd：仅 restart，`tree-hole.service` 单元本身**无需改**（EnvironmentFile 已承载新变量）；nginx 无需改（对外仍 80，无新增入站）。

## 10. 待实测项（[UNCERTAIN]，禁止凭空下结论）

1. `@aws-sdk/client-s3` 引入后的真实 RSS 增量与首请求延迟 → object 模式 standalone 真机实测。
2. VM 到 OSS 公网 endpoint 的出网连通性/是否需配代理 → 部署前 curl 实测。
3. 100–300 KB 对象在 VM 网络下 Get/Put 实际耗时 → 真机验收实测。
4. mock 库 `aws-sdk-client-mock` 与 SDK 3.1142 的兼容性（版本匹配、ESM 导入）→ 安装时以实际可导入、测试可跑为准；若不兼容，降级为在测试内手写一个极小的 S3Client 传输桩（仅注入我们用到的 Get/Put 响应），并在回报中说明。
]0;]0;]0;]0;]0;]0;