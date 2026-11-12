# AGENT.md — Tree Hole Sites（树洞「嘟」）接手代理须知

> 本文件是**静态知识**：项目是什么、怎么跑、结构与红线，长期有效。
> 当前进度、分支快照、待办等**动态交接**信息见同目录 `HANDOFF.md`。
> 面向使用者的安装/配置说明以 `README.md` 为准，本文不照抄，只做指针与代理侧补充。

## 1. 项目是什么

自托管的树洞 / 匿名留言板 Web 应用，单仓 Next.js（App Router）。

- 框架：Next.js 16（`output: "standalone"`）+ React 19 + TypeScript + Tailwind CSS 4。
- 运行时：Node.js `>= 22.13`（实测环境 Node 22.x）。
- 数据：默认本地 SQLite（`better-sqlite3`），**无 Cloudflare/D1 运行时依赖**；另可选 S3 兼容对象存储（阿里云 OSS）作为后端，两者实现同一 `Store` 接口、由环境变量切换。
- 形态：四类空间（公共 / 口令 / 个人账号 / 管理员），HttpOnly cookie 会话，服务端鉴权。
- 产品文案与命名偏温暖语气（应用名「嘟」），改动用户可见文案时保持这一基调。

## 2. 目录结构

```
app/
  layout.tsx            根布局；本地 Geist 字体（app/fonts/*.woff2），离线构建，禁用 Google Fonts
  globals.css           Tailwind 入口与全局样式
  page.tsx              单页前端（约 2.3k 行）：空间栏/密码门/留言封存卡片/管理员后台/无限列表
  chatgpt-auth.ts       模板残留：ChatGPT 站点登录适配，当前未被产品引用（见 HANDOFF 待办）
  api/
    route.ts 各端点      App Router 路由（session/unlock/account/pass/messages/entries/admin…）
    tree-hole-auth.ts   鉴权门面：四类 cookie、权限矩阵、HMAC 令牌、同源 CSRF 校验
    tree-hole-store.ts  业务门面：分页参数、错误映射，转发到 Store
    store/
      types.ts          Store 接口、领域类型（Scope/StoredMessage/StoredEntry/账号…）、错误类
      index.ts          getStore() 单例工厂，按 STORAGE_TYPE 选 SqlStore / ObjectStore
      sql-store.ts      SQLite 实现（启动自建表，ULID 文本主键）
      object-store.ts   S3/OSS 实现（v3 分块日志布局：active 热区 + block 封存 + tombstone）
      cursor.ts         游标编解码
db/                     Drizzle 脚手架（schema.ts 仍是旧 D1 表，产品运行不引用；见 HANDOFF 待办）
drizzle/                Drizzle 迁移产物
docs/design/            四份设计文档（对象存储/分块存储/自托管 Node/四层空间）
examples/d1/            早期 D1 参考代码，非运行应用
public/                 静态资源（favicon 等）
scripts/                一次性数据迁移脚本（legacy→v2、sql→object、v2→v3）
tests/                  node:test 测试（store / HTTP 端到端 / 权限 / 同源 / 迁移）
next.config.ts          仅 output:"standalone"
```

本地工具产物 `graphify-out/`、`outputs/`、构建产物 `.next/`、数据 `data/`、`var/`、所有 `.env*` 均已在 `.gitignore`，不得入库。

## 3. 常用命令

```bash
npm install
npm run dev       # 本地开发
npm run build     # 生产构建；产出 .next/standalone（含 server.js）
npm run start     # next start
npm test          # 先 build，再 node --test tests/*.test.mjs（store 单测 + standalone HTTP 端到端）
npm run lint      # ESLint
npm run db:generate  # 改动 Drizzle schema 后生成迁移（注意 db/ 当前与运行时表脱节）
```

- standalone 产物入口：`.next/standalone/server.js`。
- **部署坑（必读）**：`output:"standalone"` 下构建产物默认不含静态资源，打包前必须
  `cp -a .next/static/. .next/standalone/.next/static/`，否则线上 CSS/JS 404。
- 验证纪律：改动后至少跑 `npm run lint`、`npm test`；UI/动效改动需真机浏览器验证，不得只凭构建通过宣称视觉 OK。

## 4. 配置（环境变量，均不入库）

来源：对 `app/`、`scripts/` 全量 `process.env.*` 实测，共 10 个。

| 变量 | 作用 | 缺省/备注 |
|---|---|---|
| `TREE_HOLE_PASSWORD` | 访客解锁站点的密码 | 空则视为未配置、无法解锁 |
| `TREE_HOLE_ADMIN_PASSWORD` | 管理员密码 | 缺省回退 `TREE_HOLE_PASSWORD` |
| `TREE_HOLE_DB_PATH` | SQLite 文件路径 | 默认 `./data/tree-hole.db`，父目录自动创建 |
| `TREE_HOLE_SIGN_SECRET` | 账号会话 HMAC 签名密钥 | 缺省由管理员口令的 SHA-256 派生 |
| `STORAGE_TYPE` | 存储后端 `sql` \| `object` | 默认 `sql`；非法值启动即抛错 |
| `STORAGE_OBJECT_ENDPOINT` | S3 兼容端点（阿里云 OSS 公网 endpoint） | object 模式必填 |
| `STORAGE_OBJECT_REGION` | 区域 | object 模式必填 |
| `STORAGE_OBJECT_BUCKET` | 预建桶名（不自动 CreateBucket） | object 模式必填 |
| `STORAGE_OBJECT_ACCESS_KEY_ID` | RAM AK（仅授该桶读写） | object 模式必填 |
| `STORAGE_OBJECT_SECRET_ACCESS_KEY` | RAM SK | object 模式必填 |

object 模式缺任一 `STORAGE_OBJECT_*`，`getStore()` 在构造阶段即抛 `Missing object storage config`，**不静默回退 SQL**。
生产通过权限 0600 的 EnvironmentFile 注入；密钥/连接串禁止写进代码、日志、提交。

## 5. 分支模型

- `main`：发布分支，只接收稳定代码，版本号在 release 合并时固化（见 `chore(release): pin version`）。
- `develop`：日常开发与集成分支，代理的常规改动落这里并正常 push。
- `feat/*`：特性分支，合并后删除（历史保留在主线）。
- 远端 `origin`：https://github.com/Xinlly/tree-hole-sites.git

## 6. 代理操作红线

1. **未经 xavier 明确授权，禁止 push `main`**；常规改动提交到 `develop` 并 push。
2. 提交只显式 `git add <具体文件>`，**严禁 `git add -A` / `git add .`**，避免带入未跟踪产物。
3. 严禁提交 `.env*`、`data/`、`var/`、密钥、证书、token、真实连接串。
4. AI 代提交署名固定为 `Dora <52117993+Xinlly@users.noreply.github.com>`（用 `GIT_AUTHOR_*`/`GIT_COMMITTER_*` 临时 env，不改 git config）。
5. 不改动 `README.md`、`docs/` 与无关代码，除非任务明确要求；不做顺手重构/格式化。
6. 网络受限环境：外网走本地代理 `127.0.0.1:35353`；国内站点/阿里云 OSS 直连。push 优先 `gh auth token` 注入凭据，token 不进 remote 配置、不进进程列表明文。
7. 反代部署必须透传 `X-Forwarded-Proto` 与 `X-Forwarded-Host`，否则登录类端点的同源校验（`assertSameOrigin`）会误判 403。
8. ObjectStore 仅支持**单 Node 进程 / 单 systemd 实例**，无多实例锁，禁止水平扩第二实例（最后写覆盖风险）。
9. 数据迁移 / DDL / 批量删除属 CRITICAL：先备份、有回滚方案、经授权再执行。
