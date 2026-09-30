# 分块对象存储（Chunked Object Storage）设计 v2

- 状态：待复审（已按第二轮 review 修订 P0/P1/P2）
- 分支：`feat/chunked-object-storage`，基线 develop `72a8d52`
- 取代：当前「整个集合一个 JSON 对象、每次读-改-写整文件」的实现
- 参考：思源笔记对象存储同步引擎 dejavu（`siyuan-note/dejavu`）；调研见 `temp/object-db-research/report.md`、`temp/siyuan-s3-research/report.md`

## 1. 背景、问题与目标

现状：访客留言、树洞封存各存为一个 JSON 对象（`visitor-messages.json`、`tree-hole-entries.json`），每新增一条都 GET 整个对象 → 修改 → PUT 整个对象。

- 写代价随总量 O(n) 增长；为给该模式续命，强制只留最近 100 条、丢弃历史。
- 根因是「整对象读改写」，不是 JSON 格式（实测解析 1 万条约 2ms）。
- SQLite 文件不能直接放对象存储：只有整对象 GET/PUT，无随机写、无跨对象锁，会损坏。
- 调研结论：不存在「裸对象存储当 OLTP 主库、开箱即用」的成熟产品；RDS/PolarDB 起步百元月级，Tablestore 引入持续云依赖，对本场景过重。

目标：不引入数据库服务，把写代价降为与总量无关，保留全部历史、支持分页，单屏请求数最少，且崩溃后状态始终自洽。

## 2. 核心结构：内嵌活动区 + 不可变封存块 + 单提交点

首轮设计把「活动块」作为独立可覆盖对象，与 pointer 构成两个对象，崩溃在两者之间会撕裂。本版消除该独立对象：

- **状态对象（state，即提交点）**：每集合唯一一个，活动区（≤20 条）直接内嵌。新增留言只重写这一个对象，单对象 PUT 天然原子。
- **封存块（sealed block）**：活动区满 20 时，把这 20 条整体写成一个**不可变**新对象，随后在同一次流程里重写 state：活动区清空、指向新块。
- **顺序保证**：块先写好，最后重写 state = 提交点。崩溃在写块后、提交前：旧 state 仍内嵌全部 20 条，旧状态完整可读；已写块只是内容重复的孤儿，不丢数据。

块大小 = 20（=一屏）。不采用思源 256KB–1MB 的 CDC 大块：留言流无原地编辑，块对齐分页才能「一次请求得一屏」。

## 3. 对象布局

两集合独立：`messages`（访客留言）、`entries`（树洞封存）。新对象全部在 `v2/` 前缀，与旧对象隔离。

```
v2/{collection}/state.json.gz                      # 状态对象（内嵌活动区；唯一提交点，可覆盖）
v2/{collection}/blocks/{invertedBlockId}.json.gz   # 封存块（gzip；不可变）
v2/{collection}/tombstones.json.gz                 # 已删除条目 id 列表（gzip；低频覆盖）
```

- `{collection}` ∈ `messages` | `entries`；对象正文统一 gzip（见 §6）。

### 3.1 状态对象结构

```json
{
  "version": 2,
  "active": [ { "id": "01J...", "content": "...", "createdAt": "2026-09-30T07:12:00Z" } ],
  "headBlockKey": "v2/messages/blocks/ZZZZ...json.gz",
  "tombstonesKey": "v2/messages/tombstones.json.gz",
  "updatedAt": 1759200000000
}
```

- `active`：活动区，按 id 倒序（新在前），0–20 条；gzip 后约 1–2KB。
- `headBlockKey`：最新封存块；null 表示尚无封存块。
- 首页读 state：`active` 不足一屏时，再并行 GET `headBlockKey`。

### 3.2 ID 与排序

- 条目 id 由**服务端**在收到请求时用 **monotonic ULID** 生成（`ulid` 依赖的 `monotonicFactory`），不使用客户端时间。
- 单进程内同毫秒连续创建，随机段自动严格递增，保证先后。
- 封存块在封存时刻获得 blockId（ULID），块内按条目 id 倒序。
- ListObjectsV2 仅按 key 字典序升序返回。块 key 用 **invertedBlockId**：对 ULID 的 Crockford Base32 字符按字母表对称位置取反（f(i)=31−i）。blockId 越大（越新）→ inverted 越小 → LIST 升序越靠前。块正文同时保存原始 blockId。
- 排序唯一依据为 ULID / key；`createdAt` 仅用于展示；**不用 OSS `LastModified` 排序**。
- 一个进程内条目 id 与块 id 共用同一 monotonic 工厂实例。

**时钟边界（如实标注）**：monotonic 状态仅存于单进程内存，对进程内时钟回拨有兜底；进程重启后状态丢失。
- 条目间排序残险＝重启叠加回拨、且落在同毫秒封存窗口（要求 20 条/毫秒级写入），现实不成立。
- **块排序的条件更宽**：只要重启后时钟被回拨到**上一次封存时刻之前**，新 blockId 就可能小于旧 blockId、inverted key 反而排到更旧块之后。低频写入时两次封存可相隔分钟级，**秒级 NTP 回拨即可越过**。此时 state.headBlockKey 显式指向新块、首屏仍正确，但依赖 LIST 字典序的块链走查可能倒置、漏走块。
- 本期接受该低概率残险、不持久化时间戳；对策＝VM 保持 NTP 同步、避免大幅 step；采用 afterId 游标后，必要时服务端可结合 headBlock 指针而非纯 LIST 顺序走块。

## 4. 读写流程

### 4.1 新增留言（append）

1. GET state（不存在视为空活动区、无块）。
2. 生成新 ULID，把新条目前插进 `active`。
3. 若 `active.length < 20`：gzip 后 PUT state，结束。**单对象、原子。**
4. 若 `active.length >= 20`（封存最旧 20 条；active 新在前）：
   a. 取最旧 20 条 `active.slice(length-20)` 生成 blockId，PUT `blocks/{invertedBlockId}.json.gz`（不可变）；
   b. PUT state：`active = active.slice(0, length-20)`、`headBlockKey` 指向新块、更新 `updatedAt`。
   - length=20 时 active'=[]；length=21 时 active' 留 1 条。
   - **提交点是 4b**。崩溃在 4a 后、4b 前：旧 state 仍内嵌全部 active（≥20 条），完整无损；新块为孤儿、不被引用，不影响读取，日后人工清理。
   - **为何必须允许 ≥20**：上一轮封存若在 4a 后、4b 前中断（或 4a 成功但客户端超时、请求链中断而进程存活），state.active 会带着 20 条落盘；下一次 append 即变 21。用 `>=20` + 取最旧 20 条可从此状态正常恢复，不存在无分支可走。
5. 同集合写操作全程经一条串行 Promise 链，严格串行。
6. **写接口为至少一次语义**：客户端在 PUT 成功但响应丢失/超时后重试同一 POST，服务端会生成新 ULID，可能产生「同内容、新 id」的重复留言。本期不做幂等键（K2）；由前端在提交期间防重复点击，崩溃后重试需用户自行确认。

### 4.2 列表读取：游标分页 + 跨块拼接（取代 offset）

采用**不透明游标（cursor）**的 keyset 分页。cursor 只编码**上一页最后返回条目的 ULID（`afterId` 阈值）**，不编码任何位置/序号——因此活动区前插、删除、封存都不会使游标失效。客户端不解析 cursor，只原样回传。

- 全局逻辑顺序＝条目 **ULID 降序**：`active`（全 ≤20，整体扫描很便宜）→ headBlock 起沿块链（key 升序＝时间倒序）→ 块内 id 降序。
- 算法：从活动区扫到块链，跳过墓碑，**只取 `id < afterId` 的存活项**，收满 `limit` 即止；首页无 afterId（从最大 id 起）。
- `nextCursor`＝本页最后返回项的 ULID。
- **深分页定位（避免逐块 GET，第三轮复审 nit 1）**：cursor 在 afterId 之外可附带不可变提示 `{blockKey,index}`（块不可变，该提示不损失 afterId 的抗变化性）。服务端直接从提示块起扫描，不从 headBlock 逐块 GET；若提示失效（块已归档等），回退为按 inverted key 反解 blockId 定位或从头扫描。实现从多块收集到的条目统一按 id 降序排序，消除 LIST 乱序影响。
- **为何 afterId 抗变化**：
  - 翻页间新留言前插 → 其 id > afterId，不进本窗口（由顶部刷新呈现），不重复不空洞；
  - 翻页间封存 → 条目按 id 在块中被找到，游标仍有效；
  - 翻页间删除 active 条目 → 按 id 阈值扫描，不依赖其原序号，不跳条。
- **服务端跨块消化**：若一个块经墓碑过滤后凑不满 limit，服务端在**同一请求内**继续沿块链（必要时有界 LIST 更旧块）补齐，直到收满或确认到末端——整 20 条全墓碑的块不产生 API 级空翻；只有真到末端才返回空页。
- **边界场景（一屏跨块）**：活动区 1 条、首屏需 20 条时，state 与 tombstones、headBlock **并行 GET**，从块补 19 条（实测 p50≈50ms，多读一块约 +1ms；拼接 <0.001ms）。
- `hasMore`：按「afterId 之后是否还存在候选」判定（当前块消费位之后还有项，或有界 LIST 探测到更旧块），**不按 `items.length==limit` 判定**，避免短页（被墓碑过滤）提前结束。
- 响应：`{ items, nextCursor, hasMore }`。首页不带 cursor。

### 4.3 删除：先落墓碑，再改 state（不重写不可变块）

- **所有删除（无论 id 在 `active` 内还是封存块内）统一两步**：
  1. **先把该 id 去重追加进 `tombstones.json.gz`**；
  2. 墓碑写成功后再改 state——id 在 `active` 则 splice 移除并 PUT state，在封存块则 state 本身不变。
- **理由**：删除事实必须跨对象持久化。封存「先 PUT 块后 PUT state」若在中途崩溃，会留下仍持该 id 的孤儿块；若 active 删除只改 state、不落墓碑，该孤儿块在深翻页 LIST 时会让已删项复活。先墓碑后 state 与迁移（§9）同序，且两步走同一集合串行链，不并发交错；墓碑 PUT 失败则不动 state，删除整体失败、可重试。
- 不重写不可变封存块；tombstones 为单数组对象、低频写，OSS PUT 原子，崩溃后要么旧要么新。
  - state 仅持有固定 `tombstonesKey`，**不缓存墓碑计数**。
  - 每次列表请求生命周期内读取一次 tombstones。
- 量级：上万条 id 压缩后仍仅几十 KB，本期接受其增长，不做 trim/GC（见 §5）。
- 删除不可逆，UI 需提示。

### 4.4 预加载

- 首屏：state；活动区不足 20 时并行 headBlock。
- 滚动接近底部：按 `nextCursor` 后台预取下一页；判断块存在/变化优先用 HeadObject 有界探测。
- 列表去重以条目 id 为键；已取内容前端缓存，回退不重复请求。

## 5. 孤儿与 GC：本期不做自动回收

- 唯一会产生孤儿的路径＝封存时崩溃（§4.1.4）。孤儿内容在崩溃前的旧 state 中均有副本，绝不持有唯一数据。
- 本期**不申请 DeleteObject、不实现自动 GC**：正常运行几乎不产生孤儿；确需清理时由 xavier 在 OSS 控制台对照 state 链路人工处理。
- 未来若引入按代不可变的自动 GC，再补 DeleteObject 与宽限窗口；本期不预留半成品抽象（K2）。

## 6. 压缩与加密

- 正文统一 **gzip**（Node 内置 `node:zlib`，零新依赖），`Content-Type: application/gzip`，读取后 gunzip；不引入 zstd（无内置、小 VM 待实测）。
- 本期不做对象加密。现有方案仅防其他访客、桶权限持有者可见明文；客户端加密属未来独立议题。

## 7. 鉴权：本期不变（与「公共/私有空间」改造解耦）

公共/私有空间与服务端鉴权加固已由 xavier 明确「先不急」，故**本期只改存储布局，不改变任何接口的可访问性**，避免两个风险耦合：

| 接口 | 现状可访问性（本期保持） |
|---|---|
| `GET /api/messages`、`POST /api/messages` | 公开（无登录态） |
| `GET /api/entries`、`POST /api/entries` | 维持现状 |
| 管理员列表/删除（`/api/admin/*`） | 维持 `isAdminUnlocked` |
| 解锁/登出（unlock/logout） | 维持现状 |

- 已知遗留（单列、不在本期修）：读 API 无服务端校验、密码门仅前端遮挡；管理员密码未显式设置时回退普通密码（`tree-hole-auth.ts:14`）。二者随未来「鉴权加固」单独发布，届时再补 `TREE_HOLE_ADMIN_PASSWORD` 的部署与 fail-fast。

## 8. OSS 权限（仅增量 ListObjects）

现状 AK 有 `oss:GetObject`、`oss:PutObject`，**不收窄、保留根目录 Get/Put**（迁移需 GET 旧对象）。

| 动作 | 用途 | 是否新增 |
|---|---|---|
| `oss:GetObject` / `oss:PutObject` | 读写各对象 | 已有，不收窄 |
| `oss:ListObjects` | 翻页列举更旧封存块、管理核对 | **新增** |
| `oss:DeleteObject` | —— | 本期不申请 |

ListObjects 策略：Resource=桶本身，Condition 用 **`StringLike` 且前缀 `v2/*`**（不能用 StringEquals 精确 `v2/`，否则 `v2/messages/blocks/` 等被拒）。最小 Bucket Policy 于实现阶段产出，先交 xavier 配置；不做 CreateBucket、不写 ACL。

## 9. 迁移与切换（一次性，停机态）

脚本随 `scripts/` 提供，仅运行一次：

1. `systemctl stop tree-hole`，加载 env。
2. GET 旧根对象 `visitor-messages.json`、`tree-hole-entries.json`。旧 `createdAt` 为**秒级字符串**，按 UTC 解析。
3. 每条按旧 `createdAt` 生成 ULID（同秒按原数组顺序 monotonic）。旧对象 items 为**旧→新**数组序，而 active 规定**新在前**，故生成后需 `reverse()` 再放入。当前 2 留言 + 3 封存均 <20，直接内嵌为各集合 state 的 `active`，无封存块。
4. **先 PUT tombstones（空数组），后 PUT state**；读取侧对 tombstones 返回 404 容错（视为无墓碑），避免 state 已写、墓碑写失败造成半截（脚本可重跑覆盖，但容错更稳）。
5. **校验（字段映射，非字面 deep-equal）**：旧 id(number)→新 id(ULID) 已替换；其余字段与顺序逐条一致；state 结构完整。
6. 切流：代码读 `v2/`；旧根对象保留不删，观察一个发布周期，稳定后由 xavier 人工归档。
7. `systemctl start tree-hole`。

**重跑口径**：停机态可重跑，但每次 ULID 随机段不同、id 会变 → 切流后不得再重跑。

## 10. 存储切换与回滚

- 保持统一 Store 接口与 `STORAGE_TYPE`：`sql`（SQLite，回滚/离线）| `object`（对象存储，内部由整文件 JSON 换为分块）。
- 对象配置变量名不变（`STORAGE_OBJECT_REGION/ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET`）。
- **回滚（有条件，不做无损承诺）**：切回 `sql` 或旧版代码读旧根对象并重启，仅对**迁移前**数据无损；切换后新增内容只存在于 `v2/`，回滚会丢失这部分。实际在低流量、快速验收窗口内操作，风险可控。

## 11. 影响面

- 新增：分块对象存储实现、迁移脚本、单测；`ulid` 依赖。
- 修改：对象存储内部布局；列表接口改为游标分页；前端列表改无限滚动 + 预加载（IntersectionObserver）。
- 不变：SQL Store、写请求体、环境变量名、接口可访问性（鉴权）、nginx/系统服务、部署方式（standalone → tar.gz → SFTP）。
- 旧根对象、SQLite 文件验证期保留。

## 12. 验收标准

功能：
- F1 现有 2 留言、3 封存迁入后，除 id 替换外字段与顺序逐条一致。
- F2 新增严格在前；活动区满 20 正确封存（新条目只在块中）、活动区清空。
- F3 **边界场景**：活动区 1 + 封存块 20，首屏 20 条顺序正确（跨块拼接，无重复）。
- F4 删除：所有删除（active/封存块）先落墓碑再改 state；active 内移除生效，封存块内经墓碑过滤生效、封存块字节不变；active 删除同样写入墓碑。
- F5 **墓碑分页**：在逻辑位置 0/19/20/39 放墓碑，连续翻页断言无重复、无遗漏、hasMore 正确。
- F6 **afterId 游标在状态变化下稳定**（v2 复审新增，逐条构造）：
  1. 翻页之间新增留言 → 后续页不重发上页项，新留言经顶部刷新可见、不造成空洞；
  2. 翻页之间删除 active 条目 → 后续页不跳条；
  3. 翻页之间发生封存 → 游标仍能沿块取到后续、不重发；
  4. 整块 20 条全墓碑 → 服务端同请求内跨块消化，不产生 API 级空页；
  5. ≥3 个封存块连续走查 → 顺序与边界正确；
  6. active=20（封存中断遗留）后再写入 → 按 ≥20 正常封存恢复、不出现无分支/重复。
  7. 崩溃孤儿块 + active 删除：删除先落墓碑，孤儿块不再使已删项复活；墓碑写失败时 state 不变（可重试），墓碑成功但 state 崩溃重放后该 id 对所有副本均不返回。
- F7 无限滚动连续，预加载无重复/空洞。

性能（VM→上海 OSS 实测；测量口径：样本 ≥200 次，注明是否含冷 TLS，n=2/100/1000 三点对比）：
- 首屏 p95 ≤250ms（单 state）；跨块首屏 p95 ≤300ms。
- 新增 p95 ≤1000ms，且不随总量增长。

## 13. 明确不做

Rabin CDC；每写一条重写的全量清单/巨型 index；云端租约锁与三方合并；防 CDN 递增序号对象；对象/客户端加密；自动 GC 与 DeleteObject；鉴权/可访问性变更。
