# 四层空间（公共 / 口令 / 个人 / 管理员）设计

状态：待复审（已按 reviewer `c80c7eb6` 第一轮 REQUEST_CHANGES 修订：P0×1 + P1×7 全闭合，P2 作为实现说明）
分支：`feat/spaces-four-layer`（基线 develop `4bd8cab`）
日期：2026-10-01

---

## 1. 背景与目标

当前系统只有一个树洞、一个共享口令。任何人拿到同一口令看到同一份留言；系统分不清"你是谁"，只有"知道口令 / 不知道"和"是不是管理员"。

本次在**不破坏管理员全局可见性**的前提下，把树洞划分为**四个可见性层级**：

| 层 | 如何进入 | 能看到什么 | 能写什么 |
|---|---|---|---|
| **① 公共空间** | 输入公共口令（现有 `TREE_HOLE_PASSWORD`） | 本空间的留言 + 封存 | 留言、封存（同其他空间） |
| **② 口令空间** | 输入**某一把口令**（像进入公共空间一样进入） | **仅当前这把口令下**的留言 + 封存 | 当前口令空间内的留言与封存；持口令者均可改 |
| **③ 个人空间** | **个人账号 + 密码**登录 | **仅本人**的留言 + 封存 | 本人的留言与封存 |
| **④ 管理员** | 管理员口令（现有 `TREE_HOLE_ADMIN_PASSWORD`） | **以上各层全部**留言与封存，带空间标注 | 回复、删除/整理、锁定/解锁、开通账号 |

### 硬需求（用户逐条确认）

1. 公共空间**仍需密码**，即现有用户口令；**不开放**匿名访问。
2. 口令空间＝**B 方案**：它不出现在公共列表里；输入口令进入一个独立空间，**只看到当前口令下的内容**。
3. **口令共用**：一把口令＝一个空间。任何持该口令的人进入同一空间，可看、可写、**可修改该空间内任意留言与封存**。
4. 留言和封存上有「**锁定**」按钮（不叫"封存"，避免与现有「封存这一刻」冲突）。**锁定只作用于"能否修改"，与能否查看无关**：锁定后内容仍可见，空间成员永久不可再改。
5. 个人空间需要**正规账号**（用户名 + 密码）；**不开放注册**，账号只能由管理员后台开通；忘记密码由管理员重置，**重置后旧持票人立即被踢出**。
6. **公共 / 口令 / 个人三个空间功能完全一样**：留言（messages）与树洞封存（entries，mood+心事+回复）在三层都可用、完全对称。
7. 已登录账号的用户可在**右上角账户图标处快速切换公共空间 / 个人空间**。
8. 管理员对四层所有内容保持可见、可整理（现有能力保留）。

### 成员 vs 管理员的操作边界（对称落地）

| 操作 | 空间成员 | 管理员 |
|---|---|---|
| 写留言 / 写封存 | ✅ | ✅（管理员不在他人个人空间代写） |
| 修改本空间任意留言（含署名 nickname、正文 content） | ✅（锁定→409） | ✅（不受锁定限制） |
| 修改本空间封存的 `mood` + 心事正文 `content` | ✅（锁定→409） | ✅（不受锁定限制） |
| 锁定 / 解锁 | 成员仅可 `locked=true`（锁定后成员不可改、不可再锁） | ✅（可锁定、**可解锁**） |
| 写 / 改封存里的**回复 `reply`** | ❌（回复由树洞/管理员独占） | ✅ |
| 删除留言 / 封存 | ❌ | ✅（独占，保持现状） |

> - **nickname 可改性（回应评审 P2-7）**：口令空间内"可修改任意留言"**包含署名**——因为口令共用、空间内不区分个人，持口令者可同时改署名与正文；`updatedAt` 记录最近修改。
> - **reply 语义**：是树洞对写作者的回应，属管理员侧，成员只读；锁定不影响管理员回复。
> - 删除沿用现有"仅管理员"。

### 本期明确不做（K2 / K3）

- 口令空间不做只读分享链接（本期是"可一起写的房间"）。
- 不保留编辑历史 / 版本 diff。
- 不做邮箱注册、邮箱找回、第三方登录、图形验证码、防刷限流（公共空间本身有口令）。
- **不提供"删除口令空间"路由**（typo 房间的清理）：管理员本期无法删空间，只能清空内容；若需删空间后续再做（见 §3.3 typo 说明）。

---

## 2. 核心概念：空间（Scope）

每条留言、每条封存附加同一个**空间归属**：

```
type ScopeKind = "public" | "pass" | "user";
type Scope = { kind: ScopeKind; id: string };
```

| kind | id 取值 | 说明 |
|---|---|---|
| `public` | `""` | 唯一的公共空间 |
| `pass` | `sha256(passphrase)`（十六进制） | 一把口令派生一个稳定空间 id；口令**不入库、不回显** |
| `user` | 用户账号 id（ULID） | 一个账号一个个人空间 |

**口令空间＝能力（capability）模型**：口令既是进门凭证，也是空间寻址方式。
- 服务器不保存口令明文，只保存其 `sha256` 作为空间 id。
- 进入口令空间：客户端提交口令 → 服务器算 `id=sha256(passphrase)` → 建立会话 → 之后只在该 id 下读写。
- **无法枚举"有哪些口令空间"**（不知道口令就不知道 id）；管理员通过**空间索引**（§4.5）看到全部。

---

## 3. 身份与会话（鉴权下沉到服务端）

### 3.1 现状问题

当前 `GET/POST /api/messages`、`/api/entries` **没有任何服务端鉴权**：前端有密码门，但直接 `curl /api/messages` 即可读、`-X POST` 即可写。四层把"只让本人 / 持口令者看"变成硬需求，**鉴权必须下沉到 API**。

### 3.2 Cookie 设计

沿用 HttpOnly Cookie，按层分设：

| Cookie | 内容 | 证明什么 | 如何获得 |
|---|---|---|---|
| `tree_hole_session`（保留） | `sha256("tree-hole:v1:"+公共口令)` | 已通过**公共口令** | `/api/unlock` |
| `tree_hole_pass_session`（新） | 空间 id（=`sha256(口令)`） | 已进入**某口令空间** | `/api/pass/unlock` |
| `tree_hole_user_session`（新） | 签名令牌（§3.4，**含 tokenVersion**） | 已登录**某个人账号** | `/api/account/login` |
| `tree_hole_admin_session`（保留） | 现有管理员会话 | **管理员**，跨所有空间 | `/api/admin/unlock` |

- 所有 Cookie：`httpOnly`、`sameSite=lax`、`path=/`、`secure=false`（内网 HTTP，同现状）。
- **三个普通会话相互独立、可同时存在**（已登录账号也保留公共会话，便于右上角快速切换）。

### 3.3 口令空间会话与"恒 200"解锁语义（回应评审 P1-5）

- 登录成功后 Cookie = 空间 id；一次只持有"当前口令空间"，换空间需重输口令（Cookie 被替换）。
- **`POST /api/pass/unlock` 恒返回 200，不存在"口令错误"概念。**
  - 服务端只保存"已存在空间 id 集合"（=索引）。若对"输入口令对应空间不存在"返回 401，等于给了无速率限制的**在线口令枚举 oracle**（设计明确不做防刷），故一律 200、置 cookie。
  - typo 口令 → 进入一个空房间，前端显示"该空间还没有内容，第一条内容将建立这个空间"；只有真正写入第一条内容时才经 `ensurePassSpace` 建立索引。
  - 本期无"删除口令空间"路由；垃圾/typo 空间由管理员在后台清空内容（空间入口仍在索引中），删除空间留待后续。
- 会话只证明"你在这个空间里"，不附带超级权限。

### 3.4 个人账号会话（含 tokenVersion 的签名令牌）

个人 Cookie 需携带用户 id、令牌版本且不可伪造，采用**无状态 HMAC 令牌**。**令牌版本纳入签名载荷**，否则改密/重置无法让旧令牌失效（原方案 P0）：

```
cookie = userId + "." + tokenVersion + "." + expiresAt + "." + sig
sig    = base64url( HMAC-SHA256( SIGN_SECRET,
                                 userId + ":" + tokenVersion + ":" + expiresAt ) )
```

- 校验流程：解析四段 → 重算 `sig` 常量时间比对 → 检查 `expiresAt`（未过期）→ 从账号记录读当前 `tokenVersion` 与 `active`：
  - 账号 `active=false` → 401；
  - 令牌 `tokenVersion != 账号当前 tokenVersion` → 401（**改密 / 重置密码后旧令牌立即失效**）。
- `SIGN_SECRET`：新增环境变量 `TREE_HOLE_SIGN_SECRET`（部署时生成随机串，随 0600 env）；未配置则用 `TREE_HOLE_ADMIN_PASSWORD` 经 SHA-256 派生（改管理员口令会使个人登录态失效，可接受）。
- 无状态 → 无会话表、无清理负担；主动失效由签名内 tokenVersion + 账号 active 共同保证（无需服务端会话表）。
- 查账号：本期用 `listUsers()` 内存查找（量小，回应评审 P2-8），不新增 `getUserById`。

### 3.5 服务端鉴权规则（路由强制）

统一守卫，路由读写前调用：

| 请求 | 守卫 |
|---|---|
| 公共空间读写 | 有 `tree_hole_session` **或**管理员 |
| 口令空间读写（含修改/锁定） | `pass 会话 id == 目标空间 id` **或**管理员 |
| 个人空间读 | `user 会话 userId == 目标空间 id` **或**管理员 |
| 个人空间写（留言/封存） | `user 会话 userId == 目标空间 id`（管理员不代写） |
| 写 / 改封存 `reply` | 仅管理员 |
| 删除留言 / 封存 | 仅管理员 |
| 后台账号管理 / 跨空间列表 | 仅管理员 |

- 未通过认证 → `401`；已登录但访问非本人空间 → `403`。
- **scopeId 来源（回应评审 P1-2/P1-3）**：
  - **成员路由**（含 GET 与所有 POST/PATCH/lock）：请求必须带 `?scope=public\|pass\|user`；服务端**只从对应会话 Cookie 派生 scopeId**，忽略任何客户端传入的 scopeId；缺失/非法 scope → `400`。
  - **管理员按 :id 操作的路由**（delete/reply/lock）：管理员为可信方，请求体须带**完整 scope `{kind,id}`**（管理员可直传 scopeId，不违反"成员侧 scopeId 不可信"——该原则限定于成员路由）；服务端据此定位容器，不做全桶扫描。

---

## 4. 数据模型变更

### 4.1 Message

```
StoredMessage {
  id: string;                 // ULID
  scopeKind: "public"|"pass"|"user";
  scopeId: string;            // public=""; pass=sha256(口令); user=userId
  nickname: string;
  content: string;
  createdAt: string;
  locked: boolean;            // 默认 false
  updatedAt?: string;         // 最近修改（未改不存在）
}
```

### 4.2 Entry（封存，同样空间化）

```
StoredEntry {
  id: string;
  scopeKind: "public"|"pass"|"user";
  scopeId: string;
  mood: string;
  content: string;
  reply: string;              // 仅管理员可写；成员只读
  createdAt: string;
  locked: boolean;
  updatedAt?: string;
}
```

- 成员修改：message 覆盖 `nickname`+`content`；entry 覆盖 `mood`+`content`；统一置 `updatedAt`。
- `locked=true`：成员修改/锁定 → 409；管理员仍可改、可解锁、可回复。
- **修改一律原地进行（§5 方案 Y），保留 id 与排序。**

### 4.3 Store 接口（已补齐索引方法，回应评审 P1-4）

```ts
interface Store {
  ensureInitialized(): Promise<void>;

  // —— 留言：按空间 ——
  listMessages(scope: Scope, o: ListOptions): Promise<Page<StoredMessage>>;
  createMessage(scope: Scope, nickname: string, content: string): Promise<void>;
  updateMessage(scope: Scope, id: string, patch: { nickname: string; content: string }): Promise<void>;
  setMessageLocked(scope: Scope, id: string, locked: boolean): Promise<void>;
  deleteMessage(scope: Scope, id: string): Promise<void>;

  // —— 封存：按空间 ——
  listEntries(scope: Scope, o: ListOptions): Promise<Page<StoredEntry>>;
  createEntry(scope: Scope, mood: string, content: string, reply: string): Promise<void>;
  updateEntry(scope: Scope, id: string, patch: { mood: string; content: string }): Promise<void>;
  setEntryReply(scope: Scope, id: string, reply: string): Promise<void>;   // 管理员
  setEntryLocked(scope: Scope, id: string, locked: boolean): Promise<void>;
  deleteEntry(scope: Scope, id: string): Promise<void>;

  // —— 账号 ——
  createUser(username: string, password: string): Promise<StoredUser>;
  listUsers(): Promise<StoredUser[]>;
  setUserPassword(userId: string, password: string): Promise<void>;   // 同时 tokenVersion+1
  setUserActive(userId: string, active: boolean): Promise<void>;
  findUserByLogin(username: string, password: string): Promise<StoredUser | null>;

  // —— 口令空间索引 ——
  listPassSpaces(): Promise<PassSpace[]>;                    // { id, createdAt }
  ensurePassSpace(id: string): Promise<void>;                // 幂等：存在则 no-op
}

// 管理员专用聚合（服务层，不在 Store）：
listAllAcrossScopes(): Promise<{ messages: StoredMessage[]; entries: StoredEntry[] }>;
```

- `ensurePassSpace` 在某空间**第一条内容（留言或封存）**写入时调用，按 id 去重。
- 该共享索引对象**需要自己独立的串行队列**（§5），因为现有"空间×集合"队列覆盖不到它；`users` 集合同理独立队列。

### 4.4 账号（user）

```
StoredUser {
  id: string;          // ULID
  username: string;    // 唯一，大小写不敏感
  passwordHash: string;// sha256("tree-hole-user:v1:" + password)
  createdAt: string;
  active: boolean;
  tokenVersion: number;// 初始 1；改密/重置/停用 +1（停用同时 active=false）
}
```

- `username`：trim、1–32 字符 `[A-Za-z0-9_.-]`；重名 → 409。密码 ≥ 6。
- **object 模式大小写不敏感查重（回应评审 P2-4）**：users state 写入前按 `username.toLowerCase()` 自行查重（SQL 用 `COLLATE NOCASE`）。
- 改密/重置：`setUserPassword` 更新 `passwordHash` 并令 `tokenVersion+1`（原子）→ 旧令牌因版本不符立即 401。
- 启停：`setUserActive(false)` 令 `active=false`（可同时 bump 版本，非必须——active 已使旧令牌 401）；**`setUserActive(true)` 不 bump tokenVersion**，重新启用后其停用前的有效令牌恢复使用（active 放行即视为允许，明确语义、不靠猜）。

### 4.5 口令空间索引

```
pass-space-index: Array<{ id: string; createdAt: string }>
```

- 仅在 `ensurePassSpace(id)` 首次见到 id 时追加；id 去重、幂等。
- 计数不固化，管理员查看时按空间实时统计；索引只管"存在性 + 入口"。

---

## 5. 对象存储布局（object 模式）

在现有 v2 上引入空间层级，前缀升 `v3`：

```
v3/public/messages/state.json.gz
v3/public/messages/blocks/{invertedBlockId}.json.gz
v3/public/messages/tombstones.json.gz
v3/public/entries/state.json.gz
v3/public/entries/blocks/...
v3/public/entries/tombstones.json.gz

v3/pass/{scopeId}/messages/{state,blocks,tombstones}...
v3/pass/{scopeId}/entries/{state,blocks,tombstones}...

v3/user/{userId}/messages/{state,blocks,tombstones}...
v3/user/{userId}/entries/{state,blocks,tombstones}...

v3/pass-space-index.json.gz     # 独立队列
v3/users/state.json.gz          # 独立队列；账号量小，常驻 state.active
```

- 每个"空间 × 集合（messages/entries）"是**独立分块容器**，完整复用现有 chunked：不可变块 + pointer、afterId 游标（含 blockKey hint）、收集期 seen 去重、先墓碑后 state、gzip 按字节读（`transformToByteArray`）。
- **游标校验（回应评审 P1-1）**：`store/cursor.ts` 现有正则 `^v2/(messages|entries)/blocks/...` 会拒绝所有 v3 键。改为识别 v3 三类前缀：
  - `^v3/public/(messages|entries)/blocks/...`
  - `^v3/pass/[0-9a-f]{64}/(messages|entries)/blocks/...`
  - `^v3/user/[0-9HJKMNPQRTVWXY]{26}/(messages|entries)/blocks/...`（Crockford ULID 字符集，大写；长度按实际）
  - `index 0..19` 限制、块大小 20 保留；`cursor.ts` 列入改动面（§11）。

### 5.1 修改策略：一律原地改（方案 Y，回应评审 P1-6）

**决定：active 与封存块的成员修改都走原地改写，不用"墓碑+新 id"。**

- **active 内**：修改条目后随 state 整写（近乎免费，state 本来就要整写）。
- **封存块内**：在该"空间×集合"的串行队列内，读该小块（≤20 条）→ 定位 id 替换字段、置 `updatedAt` → 重写同一块对象（块仍是不可变语义下的整体覆盖写；该块已封存，覆盖仅由队列内受控改写触发，不新增追加路径）。
- **后果（明确认领）**：id 不变、排序位置不变（`createdAt` 保留，`updatedAt` 作为修改时间依据）、外部持有的 :id 与游标全部继续有效。
- 锁定后：成员修改/锁定 409；管理员的改/解锁走同一队列原地改。
- 对应验收见 A12。

### 5.2 现有数据迁移（object，用户已定：一次性复制到公共）

- 迁移脚本读 `v2/messages`、`v2/entries`（state，必要时块/墓碑），给每条补 `scopeKind="public"/scopeId=""/locked=false`，写入 `v3/public/{messages,entries}`。
- **幂等策略（回应评审 P2-5）**：以"每集合 state 成功 PUT + 完成标记对象"为准；完成标记存在即整体跳过，可安全重跑（不采用"逐条跳过"）。
- **块 / 墓碑一并处理**：若 v2 已存在块或墓碑，脚本一并搬块，并把 state 内 `headBlockKey`、`tombstonesKey` 的 `v2/...` 引用改写为 `v3/public/...`，迁移墓碑防已删项复活。
- **state.version 提升**：写入 v3 的 state 标 `version=3`（现有 `STATE_VERSION=2`）。
- 旧 `v2/**` 全部保留不删（回滚用）；口令/个人空间、账号从空开始。

### 5.3 SQL 模式表结构

```
CREATE TABLE visitor_messages (
  id TEXT PRIMARY KEY,                 -- ULID（现有 SQL 原为 INTEGER）
  scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
  nickname TEXT NOT NULL, content TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT
);
CREATE INDEX visitor_messages_scope_idx ON visitor_messages (scope_kind, scope_id, id);

CREATE TABLE tree_hole_entries (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
  mood TEXT NOT NULL, content TEXT NOT NULL, reply TEXT NOT NULL DEFAULT '',
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT
);
CREATE INDEX tree_hole_entries_scope_idx ON tree_hole_entries (scope_kind, scope_id, id);

CREATE TABLE tree_hole_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, token_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE pass_space_index (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
```

- 生产用 object 模式；SQL id 由 INTEGER 转 TEXT，存量由迁移脚本处理，本期无 SQL 生产数据。

---

## 6. API 路由

| 方法 & 路径 | 作用 | 守卫 |
|---|---|---|
| `POST /api/unlock`（保留） | 公共口令登录（错口令→401） | — |
| `POST /api/pass/unlock`（新） | `{passphrase}` → 置 pass 会话（**恒 200**） | — |
| `POST /api/pass/exit`（新） | 清 pass 会话 | — |
| `POST /api/account/login`（新） | `{username,password}` → 置 user 会话（失败→401） | — |
| `POST /api/account/logout`（新） | 清 user 会话 | — |
| `GET /api/messages`（改） | `?scope=` + cursor/limit | 对应会话/管理员 |
| `POST /api/messages`（改） | **必须 `?scope=`**；按对应空间写 | 对应空间会话 |
| `PATCH /api/messages/:id`（改） | **必须 `?scope=`**；`{nickname,content}`；locked→409 | 本空间成员/管理员 |
| `POST /api/messages/:id/lock`（改） | **成员必须 `?scope=`**，body `{locked:true}`；管理员走 body 完整 scope 且可 false | 本空间/管理员 |
| `DELETE /api/messages/:id`（改） | 管理员：body 完整 scope | 仅管理员 |
| `GET /api/entries`（改） | `?scope=` | 对应会话/管理员 |
| `POST /api/entries`（改） | **成员必须 `?scope=`**，body `{mood,content}`（reply 见下） | 本空间成员/管理员 |
| `PATCH /api/entries/:id`（改） | **必须 `?scope=`**；`{mood,content}`；locked→409 | 本空间成员/管理员 |
| `POST /api/entries/:id/reply`（新） | 管理员：body 完整 scope + `{reply}` | 仅管理员 |
| `POST /api/entries/:id/lock`（改） | 同 messages lock | 本空间/管理员 |
| `DELETE /api/entries/:id`（改） | 管理员：body 完整 scope | 仅管理员 |
| `GET /api/admin/items`（改） | 跨空间留言+封存（带 scope）、口令空间列表 | 仅管理员 |
| `POST /api/admin/users`（新） | 开通账号 | 仅管理员 |
| `GET /api/admin/users`（新） | 列账号（不含哈希） | 仅管理员 |
| `POST /api/admin/users/:id/reset-password`（新） | 重置（tokenVersion+1） | 仅管理员 |
| `POST /api/admin/users/:id/active`（新） | 启停 | 仅管理员 |

- **成员 reply 强制落空（回应评审 P1-7）**：非管理员 POST entries 即便携带 `reply` 字段，服务端**一律丢弃、强制写 `""`**（不返回 400，避免客户端探测）；仅管理员可经 `/api/entries/:id/reply` 写回复。
- **管理员创建封存同样写 `reply=""`（回应复审 P2-1）**：统一规则——任何创建（POST entries）都不带回复，回复**一律走** `/api/entries/:id/reply`，避免实现者各自解读。
- **前端移除随机 reply**：删除 `app/page.tsx:176,182` 封存时客户端生成 reply 的逻辑；成员界面 reply 区显示"暂无回复"空状态。封存即时随机回复这一旧体验随之消失。
- **旧路由收口（回应评审 P2-6）**：删除现有 `/api/admin/messages/[id]`、`/api/admin/entries/[id]`，避免与新带 scope 的删除入口两套并存。

---

## 7. 前端交互

### 7.1 导航（右上角账户图标）
- 未登录：「公共空间」「进入口令空间」「登录个人账号」。
- 已登录：「公共空间」「我的空间」一键切换；显示用户名 + 退出。
- 口令空间：弹层输口令进入，顶部显示"口令空间 · 返回"；空房间显示"该空间还没有内容"。

### 7.2 三个空间完全一致的主界面
- 留言流（InfiniteList）+ 留言输入框；封存区（mood + 心事 + 回复展示）+ 封存表单「封存这一刻」。
- 留言与封存条目悬停出现「修改」；编辑态保存走 PATCH（原地改、id/位置不变）。
- 每条留言 / 封存可「**锁定**」：确认框"锁定后空间成员将无法修改"；锁定后显示 🔒、成员的修改/锁定入口消失；**内容仍正常显示**；管理员可解锁。
- 封存回复区对成员只读，空时显示"暂无回复"；管理员处可写回复。

### 7.3 管理员后台
- 留言与封存按空间分组或加「空间」列（公共 / 口令:<短id> / 用户:<用户名>）；删除、回复、解锁照旧。
- 「账号管理」：开通 / 列表 / 重置密码 / 停用启用。
- 「口令空间」：经 `listPassSpaces` 列索引，点入只读查看。

### 7.4 UI 状态完备性（工程红线）
每空间覆盖加载态、空状态、错误态（401 重登录 / 403 提示）、权限态；响应式与可访问性对齐现有组件；复用 InfiniteList/卡片/开关，不新增多余全局抽象。

---

## 8. 关键失败场景与防御

| 场景 | 行为 |
|---|---|
| 直接 `curl /api/messages\|entries` 无会话 | **401**（修复现状裸奔） |
| A 口令会话改传 B 空间 / 用户改传他人 scopeId | scopeId 只从会话派生 → 403/忽略参数 |
| 成员变更路由漏带 `scope` | 400 |
| 修改已锁定内容 | 服务端 `locked` → 409；前端隐藏入口作纵深 |
| 成员尝试写 reply / 删除 | reply 字段被丢弃；删除路由 401/403 |
| **重置密码 / 改密后旧令牌** | 令牌 tokenVersion ≠ 账号版本 → **401，立即失效** |
| 停用账号 | active=false → 401 |
| 修改与锁定并发 | 同一"空间×集合"串行队列 |
| 封存崩溃孤儿块 | seen 去重 + 先墓碑后 state；容器按空间隔离 |
| 账号重名 / 大小写变体 | 唯一约束/小写查重 → 409 |
| 管理员跨空间删除 | 强制管理员守卫 + body 完整 scope；墓碑按容器隔离 |
| typo 口令 | 恒 200 进入空房；不写内容则不建索引 |

---

## 9. 发布与迁移步骤

1. 特性分支 `feat/spaces-four-layer`（已建）。
2. 实现：Store 空间维度（messages+entries）、账号、空间索引（独立队列）、cursor v3、服务端守卫、前端；删旧 admin [id] 路由；补测试。
3. 迁移脚本（object）：v2 → v3/public（含块/墓碑/引用改写/version=3/完成标记）；旧对象保留。
4. Gate：tsc / eslint / 全测试 / build 全绿。
5. 低流量停机窗口：备份代码与 env → 部署 → 跑迁移 → 启动 → 真机验收（§10）。
6. 回滚：保留旧代码目录与 `v2` 对象；异常即退回旧版 + env；无数据删除。
7. 环境变量新增可选 `TREE_HOLE_SIGN_SECRET`。

---

## 10. 验收标准

### 10.1 单元 / 集成
- A1 无会话访问各 API → 401；公共/账号/管理员错误口令或凭据 → 401。**口令 unlock 恒 200（无错误口令概念）**。
- A2 各空间写入只出现在本空间；空间之间互不可见。
- A3 同口令两次进入看到同一集合；不同口令空间隔离。
- A4 空间成员可改任意留言（含署名）与封存（mood+正文，含他人所写）；`updatedAt` 更新；reply 成员不可写（字段被丢弃）。
- A5 锁定后仍可读，但成员修改/再锁 → 409；锁持久化（重启仍锁）；管理员可解锁、可改。
- A6 个人账号登录只读到本人；用户 A 读不到 B。
- A7 无注册路由；非管理员开通账号 → 401。
- A8 管理员跨空间列表含全部且 scope 标注正确；可开通/重置/停用；停用后登录被拒、旧会话读不到数据；**重置密码后旧令牌立即 401 失效（tokenVersion 进签名）**。
- A9 scopeId 越权：成员 query 指定他人空间无效（以会话为准）。
- A10 迁移：现有 3 留言 + 3 封存进入公共空间，字段/顺序一致、含 scope 字段；块/墓碑/引用一并正确；v2 保留；完成标记保证可重跑。
- A11 各"空间×集合"满 20 封存后分页顺序正确、无重复/漏条/复活；v3 游标能正常解码（cursor 正则覆盖三类前缀）。
- A12 **原地修改**：修改后 id 不变、排序位置不变（createdAt 保留）、updatedAt 更新；旧游标/链接继续有效；封存块内条目修改后块可正常读回。

### 10.2 真机
- 服务 active、首页 200；三层各走完写/读/改/锁定/回复。
- 抓包：越层请求 401/403；常规浏览无跨空间 LIST。
- 管理员后台四层齐全、账号管理可用。

---

## 11. 影响面

- 改：`store/types.ts`、`store/object-store.ts`、`store/sql-store.ts`、**`store/cursor.ts`（v3 正则，本轮补列）**、`tree-hole-store.ts`、`tree-hole-auth.ts`、`app/page.tsx`，messages/entries 路由、admin items 路由。
- 删：`app/api/admin/messages/[id]/route.ts`、`app/api/admin/entries/[id]/route.ts`。
- 新增：pass/account 路由、admin users 路由、两 Store 的账号与空间索引（独立队列）、v2→v3 迁移脚本、测试、本文档。
- 环境：新增可选 `TREE_HOLE_SIGN_SECRET`。
- 数据：messages 与 entries 均加空间维度；v2→v3/public 迁移（version=3）；旧数据保留可回滚。
- 风险点：服务端鉴权下沉（安全相关、最易出错）；封存块原地改写路径；SQL id 类型变化（生产用 object，影响低）。

---

## 12. 安全加固说明（评审 P2，实现期落实）

- **登录类端点 login-CSRF（P2-1）**：在 `/api/unlock`、`/api/pass/unlock`、`/api/account/login` 校验 `Origin` / `Sec-Fetch-Site`，拒绝跨站请求（sameSite=lax 对"无 cookie、会 Set-Cookie"的登录端点不构成防护）。
- **登出不吊销令牌（P2-2）**：无状态令牌被偷后，logout 只清本浏览器 cookie，令牌在过期前仍可重放；属无状态方案固有取舍，本期接受；要硬吊销需切服务端会话或维护吊销表（不做）。
- **密码哈希无盐单轮 sha256（P2-3）**：用户集泄露后可高速离线爆破；内网小规模、与现有口令风格一致，不阻断；后续如需加固改带盐慢哈希（如 scrypt/argon2）。
