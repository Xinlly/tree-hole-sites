"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// §7.1：四类相互独立的层；右侧账户入口在三者 + 管理入口间切换
type ScopeKind = "public" | "pass" | "user";
type Layer = ScopeKind | "admin";

type ListResponse<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

type Message = {
  id: string;
  nickname: string;
  content: string;
  locked: boolean;
  createdAt: string;
  updatedAt?: string;
};

type Entry = {
  id: string;
  mood: string;
  content: string;
  reply: string;
  locked: boolean;
  createdAt: string;
  updatedAt?: string;
};

// 管理端条目额外带空间归属（§6 GET /api/admin/items）
type AdminMessage = Message & { scopeKind: ScopeKind; scopeId: string };
type AdminEntry = Entry & { scopeKind: ScopeKind; scopeId: string };

type Account = {
  id: string;
  username: string;
  active: boolean;
  tokenVersion: number;
  createdAt: string;
};

type PassSpace = { id: string; createdAt: string; label?: string };

type SessionInfo = {
  public: boolean;
  admin: boolean;
  passId: string | null;
  passLabel: string | null;
  username: string | null;
};

type SessionResponse = {
  unlocked: boolean;
  admin: boolean;
  passId: string | null;
  passLabel: string | null;
  username: string | null;
};

// /api/session 字段名与页面所用 SessionInfo 不同，仅在此处映射一次
function toSessionInfo(data: SessionResponse): SessionInfo {
  return {
    public: data.unlocked,
    admin: data.admin,
    passId: data.passId,
    passLabel: data.passLabel,
    username: data.username,
  };
}

const SPACE_NAME: Record<Layer, string> = {
  public: "公共空间",
  pass: "口令空间",
  user: "个人空间",
  admin: "管理员空间",
};

// mood 固定且正向在前（愉悦、幸福排在低落之前）
const moods = [
  { label: "愉悦", tone: "把这份亮亮的心情好好收进口袋。" },
  { label: "幸福", tone: "愿这一刻被温柔地记住很久。" },
  { label: "轻松", tone: "把这一点点晴朗也好好收起来。" },
  { label: "想念", tone: "有些名字会在心里亮很久。" },
  { label: "低落", tone: "给自己一点靠岸的时间。" },
  { label: "焦虑", tone: "先把呼吸放慢，事情可以一件件来。" },
  { label: "委屈", tone: "你不需要证明这份难受才是真的。" },
];

// 统一的 Morandi 渐变背景（浅粉 · 浅紫 · 浅蓝）
const MORANDI_GRADIENT =
  "bg-[radial-gradient(circle_at_12%_12%,rgba(246,196,214,0.48),transparent_30%),radial-gradient(circle_at_82%_18%,rgba(205,202,232,0.48),transparent_29%),radial-gradient(circle_at_76%_82%,rgba(190,216,235,0.5),transparent_34%),linear-gradient(145deg,#f8eef4_0%,#f4edf9_44%,#edf6fb_100%)]";

// 统一操作按钮：柔和小药丸（替代旧的文字下划线链接）
const PILL =
  "rounded-full border border-[#e4d6e6] bg-[#fffafd] px-3 py-1 text-xs text-[#756a8a] transition hover:border-[#c7b9e8] hover:bg-white disabled:cursor-not-allowed disabled:opacity-50";
const PILL_PRIMARY =
  "rounded-full bg-[#b9addd] px-3 py-1 text-xs text-white transition hover:bg-[#a699cf] disabled:cursor-not-allowed disabled:opacity-50";
// 柔和危险色（删除用）：淡粉底+粉褐字，仍是 Morandi 调
const PILL_DANGER =
  "rounded-full border border-[#eccfd8] bg-[#fdf2f5] px-3 py-1 text-xs text-[#a36978] transition hover:border-[#dfb4c1] hover:bg-white disabled:cursor-not-allowed disabled:opacity-50";

export default function Home() {
  const [view, setView] = useState<Layer>("public");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exitSeq, setExitSeq] = useState(0);
  // 顶部 sticky 框架的真实矩形（供管理员悬浮批量栏定位）；Y 由 CSS sticky 负责，这里只读数
  const [bar, setBar] = useState<BarGeometry>(
    { q: 0, top: 0, left: 0, right: 0, h: 48 },
  );
  const onGeometry = useCallback((next: BarGeometry) => {
    setBar((prev) =>
      Math.abs(prev.q - next.q) > 0.001 ||
      Math.abs(prev.top - next.top) > 0.5 ||
      Math.abs(prev.left - next.left) > 0.5 ||
      Math.abs(prev.right - next.right) > 0.5 ||
      Math.abs(prev.h - next.h) > 0.5
        ? next
        : prev,
    );
  }, []);

  const refreshSession = useCallback(async () => {
    const res = await fetch("/api/session", { cache: "no-store" });
    const data = (await res.json()) as SessionResponse;
    setSession(toSessionInfo(data));
  }, []);

  const [loadError, setLoadError] = useState(false);
  const [retrySeq, setRetrySeq] = useState(0);

  // 冷导航后的首个会话加载：单次 6s 超时，失败最多重试 3 次（退避 400/900/1600ms）；
  // retrySeq 变化（点「再试一次」）时重走同一流程
  useEffect(() => {
    const backoff = [400, 900, 1600];
    let cancelled = false;
    let sleepTimer: ReturnType<typeof setTimeout> | undefined;
    let activeController: AbortController | null = null;
    void (async () => {
      for (let attempt = 0; attempt <= backoff.length; attempt++) {
        const controller = new AbortController();
        activeController = controller;
        const timer = setTimeout(() => controller.abort(), 6000);
        try {
          const res = await fetch("/api/session", {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`session request failed: ${res.status}`);
          const data = (await res.json()) as SessionResponse;
          clearTimeout(timer);
          if (!cancelled) setSession(toSessionInfo(data));
          return;
        } catch {
          clearTimeout(timer);
          if (cancelled) return;
          if (attempt < backoff.length) {
            await new Promise((resolve) => {
              sleepTimer = setTimeout(resolve, backoff[attempt]);
            });
          }
        }
        if (cancelled) return;
      }
      if (!cancelled) setLoadError(true);
    })();
    return () => {
      cancelled = true;
      activeController?.abort();
      if (sleepTimer) clearTimeout(sleepTimer);
    };
  }, [retrySeq]);

  const go = (layer: Layer) => {
    setView(layer);
    setMenuOpen(false);
  };

  // 退出当前成员空间：调对应端点 → 刷新会话 → 用 key 变化强制 MemberSpace 重挂载显示入口
  const exitCurrent = async () => {
    const endpoint =
      view === "public"
        ? "/api/logout"
        : view === "pass"
          ? "/api/pass/exit"
          : view === "user"
            ? "/api/account/logout"
            : "/api/admin/exit";
    await fetch(endpoint, { method: "POST" });
    await refreshSession();
    setExitSeq((n) => n + 1);
  };

  return (
    <main className="min-h-screen bg-[#f8eef4] text-[#5d5868]">
      <section className="relative min-h-screen px-5 py-6 sm:px-8 lg:px-12">
        <div className={`absolute inset-0 ${MORANDI_GRADIENT}`} />

        <div className="relative mx-auto flex max-w-7xl flex-col gap-6">
          <p className="text-sm text-[#a986a3]">
            浅粉 · 浅紫 · 浅蓝的明媚树洞
          </p>
          <StickyHeader
            view={view}
            session={session}
            menuOpen={menuOpen}
            onToggleMenu={() => setMenuOpen((open) => !open)}
            onCloseMenu={() => setMenuOpen(false)}
            onGo={go}
            onExit={() => void exitCurrent()}
            onGeometry={onGeometry}
          />

          {loadError ? (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <p className="text-sm leading-7 text-[#756a8a]">
                树洞的小门刚刚没有被轻轻敲开，
                <br />
                也许是风把信号吹乱了。歇一口气，再试一次好吗？
              </p>
              <button
                type="button"
                className={PILL_PRIMARY}
                onClick={() => {
                  setLoadError(false);
                  setRetrySeq((n) => n + 1);
                }}
              >
                再试一次
              </button>
            </div>
          ) : session === null ? (
            <LoadingSpinner label="正在加载…" />
          ) : view === "admin" ? (
            <AdminLayer
              unlocked={session.admin}
              barGeometry={bar}
              onSessionRefresh={refreshSession}
            />
          ) : (
            <MemberSpace
              key={`${view}-${exitSeq}`}
              kind={view}
              canManage={view === "user" || session.admin}
              onEntered={refreshSession}
            />
          )}
        </div>
      </section>
    </main>
  );
}

// —— 顶部 sticky 框架：把“嘟”和空间切换栏套进同一元素，Y 全靠 CSS，JS 只管 X ——
function StickyHeader({
  view,
  session,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onGo,
  onExit,
  onGeometry,
}: {
  view: Layer;
  session: SessionInfo | null;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onGo: (layer: Layer) => void;
  onExit: () => void;
  onGeometry: (g: BarGeometry) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const duRef = useRef<HTMLHeadingElement>(null);
  const btnWrapRef = useRef<HTMLDivElement>(null);
  // 大字自然尺寸 & 末态行高（测量一次，resize 重测）
  const [dims, setDims] = useState({ duH: 0, duW: 0, duFs: 0, barH: 0 });
  const [q, setQ] = useState(0);

  const identity = barIdentity(view, session);
  const spaceLabel = SPACE_NAME[view];
  // 落入栏后视觉字号精确=14px（与栏内文字一致）：缩放比按真实自然字号算
  const K = dims.duFs > 0 ? 14 / dims.duFs : 0.34;
  const easeIO = (x: number) =>
    x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

  // 测量大字自然尺寸与末态行高
  const measure = useCallback(() => {
    const du = duRef.current;
    const btn = btnWrapRef.current;
    if (!du) return;
    setDims({
      duH: du.offsetHeight,
      duW: du.offsetWidth,
      duFs: parseFloat(getComputedStyle(du).fontSize) || 0,
      barH: btn ? btn.offsetHeight : 0,
    });
  }, []);

  useEffect(() => {
    measure();
    let raf = 0;
    const update = () => {
      raf = 0;
      const frame = frameRef.current;
      if (!frame) return;
      // 钉顶所需滚动量：框架自然顶到距视口顶 16
      const frameTopDoc = frame.getBoundingClientRect().top + window.scrollY;
      const R = Math.max(1, frameTopDoc - 16);
      const nq = Math.min(1, Math.max(0, window.scrollY / R));
      setQ(nq);
      const r = frame.getBoundingClientRect();
      onGeometry({
        q: nq,
        top: r.top,
        left: r.left,
        right: document.documentElement.clientWidth - r.right,
        h: r.height,
      });
    };
    const onScroll = () => {
      // hidden 自动化标签不跑 rAF：同步；正常用户走 rAF
      if (document.hidden) {
        update();
        return;
      }
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    const onResize = () => {
      measure();
      onScroll();
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(() => {
      measure();
      onScroll();
    });
    if (frameRef.current) ro.observe(frameRef.current);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [measure, onGeometry]);

  const e = easeIO(q);
  const scale = 1 + (K - 1) * e;

  const buttons = (
    <>
      <button type="button" onClick={onExit} className={PILL}>
        退出
      </button>
      <div className="relative">
        <button
          type="button"
          onClick={onToggleMenu}
          className="flex items-center gap-1 rounded-full border border-[#e4d6e6] bg-[#fffafd] px-3 py-1 text-xs text-[#756a8a] transition hover:border-[#c7b9e8] hover:bg-white"
          aria-label="切换空间"
          aria-expanded={menuOpen}
        >
          切换
          <span className={`transition ${menuOpen ? "rotate-180" : ""}`}>▾</span>
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-[60]" onClick={onCloseMenu} />
            <div className="absolute right-0 z-[70] mt-2 w-44 overflow-hidden rounded-2xl border border-[#ead8e5] bg-[#fff9fc] py-1 shadow-lg">
              {(["public", "pass", "user", "admin"] as Layer[]).map((layer) => (
                <button
                  key={layer}
                  type="button"
                  onClick={() => onGo(layer)}
                  className="flex w-full items-center justify-between px-4 py-2 text-left text-sm text-[#756a8a] transition hover:bg-[#f5edf8]"
                >
                  {SPACE_NAME[layer]}
                  {view === layer && <span className="text-[#b9addd]">✓</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );

  // 行高：从大字自然高(q=0)连续收到按钮自然高(q=1)
  const rowH = dims.duH && dims.barH
    ? dims.duH + (dims.barH - dims.duH) * e
    : undefined;

  // “空间·身份”淡入时机：嘟开始缩小后再出现
  const labelOp = 1;

  return (
    <div ref={frameRef} className="sticky top-4 z-50">
      <div
        className="relative flex items-center gap-1 px-4 sm:gap-2"
        style={{ height: rowH }}
      >
        {/* 装饰背景：零内容、绝对定位铺满，不占布局也不可能遮挡内容；随 q 淡入 */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full border border-[#e4d6e6] bg-[#fff9fc]/95 shadow-sm backdrop-blur-sm"
          style={{ opacity: q }}
        />

        {/* 嘟：满高定位盒负责纵向居中，h1 只做 scale —— 任何缩放比下中心恒=行中心，不飘 */}
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 flex h-full items-center"
          style={{ left: 16 }}
        >
          <h1
            ref={duRef}
            className="text-4xl font-semibold text-[#756a8a] sm:text-6xl"
            style={{
              transform: `scale(${scale})`,
              transformOrigin: "left center",
              fontWeight: Math.round(600 + (500 - 600) * q),
            }}
          >
            嘟
          </h1>
        </div>

        {/* 嘟占位：在文档流内，宽=嘟当前可视宽，把后面的圆点和文字顶到嘟右侧 */}
        <span className="shrink-0" style={{ width: (dims.duW || 0) * scale }} />

        {/* 空间圆点：独立于滑动内容组，永远在嘟右侧、吃行 gap（8px）；展开度 q 控制显隐 */}
        <span
          aria-hidden
          className="pointer-events-none inline-block h-2 w-2 shrink-0 rounded-full bg-[#b9addd]"
          style={{ opacity: q }}
        />

        {/* 空间·身份：flex-1 在文档流内；前后弹性空白按 q 分配自由空间——q=0 前空白 grow=1 把整组顶到右侧紧挨按钮，q=1 后空白 grow=1 把整组顶到左侧紧挨圆点，中间线性滑动。
            内容组 shrink-0：宽度恒为自然宽（max-w-full 仅窄宽时收敛），不随 q 被压缩，杜绝逐帧重排闪没 */}
        <span
          className="flex min-w-0 flex-1 items-center overflow-hidden"
          style={{ opacity: labelOp }}
        >
          <span
            aria-hidden
            className="min-w-0 basis-0"
            style={{ flexGrow: 1 - q }}
          />
          <span className="flex min-w-0 max-w-full shrink-0 items-center gap-1 sm:gap-2">
            <span className="block min-w-0 truncate whitespace-nowrap text-sm font-medium text-[#756a8a]">
              {spaceLabel}
            </span>
            {identity && (
              <>
                <SpaceDot />
                <span className="block min-w-0 truncate whitespace-nowrap text-sm text-[#a986a3]">
                  {identity}
                </span>
              </>
            )}
          </span>
          <span
            aria-hidden
            className="min-w-0 basis-0"
            style={{ flexGrow: q }}
          />
        </span>

        {/* 按钮：shrink-0 独立元素框，与文字之间是 flex 文档流边界 */}
        <div ref={btnWrapRef} className="flex shrink-0 items-center gap-2 py-1.5">{buttons}</div>
      </div>
    </div>
  );
}

// 大圆点（与 cef5ede 同一实心紫圆）；间距统一由父级控制为 8px
function SpaceDot() {
  return (
    <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#b9addd]" />
  );
}

// 收起/展开两态共用：口令优先回显用户认得的明文口令，缺失再回退哈希短标；个人给用户名
function barIdentity(view: Layer, session: SessionInfo | null) {
  if (view === "pass") {
    if (session?.passLabel) return session.passLabel;
    return session?.passId ? session.passId.slice(0, 8) : "";
  }
  return view === "user" && session?.username
    ? session.username
    : "";
}

type BarGeometry = { q: number; top: number; left: number; right: number; h: number };

// —— §7.2 普通空间：三空间完全一致的主界面 ——

function MemberSpace({
  kind,
  canManage,
  onEntered,
}: {
  kind: ScopeKind;
  canManage: boolean;
  onEntered?: () => Promise<void> | void;
}) {
  // checking=探针判定会话；in=已进入；out=展示对应入口
  const [auth, setAuth] = useState<"checking" | "in" | "out">("checking");
  const [probeError, setProbeError] = useState("");
  const [probeTick, setProbeTick] = useState(0);
  const [messageSeq, setMessageSeq] = useState(0);
  const [entrySeq, setEntrySeq] = useState(0);

  useEffect(() => {
    fetch(`/api/messages?scope=${kind}&limit=1`, { cache: "no-store" })
      .then((res) => {
        if (res.status === 401) {
          setAuth("out");
          return;
        }
        if (!res.ok) {
          setProbeError(`加载失败（${res.status}）`);
          return;
        }
        setAuth("in");
      })
      .catch(() => setProbeError("网络错误，请重试"));
  }, [kind, probeTick]);

  const retryProbe = () => {
    setProbeError("");
    setAuth("checking");
    setProbeTick((tick) => tick + 1);
  };

  if (auth === "checking") {
    return <LoadingSpinner label="正在进入空间…" />;
  }
  if (auth === "out") {
    return (
      <Gate
        kind={kind}
        onEntered={() => {
          setMessageSeq((n) => n + 1);
          setEntrySeq((n) => n + 1);
          setAuth("in");
          // 通知 Home 刷新会话（口令进入后顶部空间栏据此显示当前口令）
          void onEntered?.();
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {probeError && (
        <div className="rounded-lg border border-[#efc8d2] bg-[#fff9fc]/90 p-3 text-center text-sm text-[#965c6d]">
          {probeError}
          <button
            type="button"
            onClick={retryProbe}
            className="ml-3 text-[#965c6d] underline"
          >
            重试
          </button>
        </div>
      )}

      <div className="rounded-lg border border-[#ead8e5] bg-[#fff9fc]/72 p-4">
        <Image
          alt="睡睡小羊和小熊陪伴在树洞旁"
          className="h-auto w-full rounded-lg"
          height={768}
          priority
          src="/morandi-companions.png"
          width={1152}
        />
      </div>

      <WriteMessage
        kind={kind}
        onPosted={() => setMessageSeq((n) => n + 1)}
      />
      <div className="rounded-lg border border-[#ead8e5] bg-[#fff9fc]/82 p-5">
        <PanelTitle>留给我的话</PanelTitle>
        <InfiniteList<Message>
          key={`m-${messageSeq}`}
          fetchUrl={`/api/messages?scope=${kind}`}
          emptyText={
            kind === "pass" ? "该空间还没有内容" : "还没有留言。"
          }
          onUnauthorized={() => setAuth("out")}
          renderItem={(item, controls) => (
            <MessageCard
              kind={kind}
              canManage={canManage}
              message={item}
              onLocalChange={(partial) => controls.patch(partial)}
              onDelete={() => controls.remove()}
              onChanged={() => setMessageSeq((n) => n + 1)}
              onUnauthorized={() => setAuth("out")}
            />
          )}
        />
      </div>

      <WriteEntry
        kind={kind}
        onPosted={() => setEntrySeq((n) => n + 1)}
      />
      <div className="rounded-lg border border-[#ead8e5] bg-[#fff9fc]/82 p-5">
        <PanelTitle>最近封存</PanelTitle>
        <InfiniteList<Entry>
          key={`e-${entrySeq}`}
          fetchUrl={`/api/entries?scope=${kind}`}
          emptyText={
            kind === "pass" ? "该空间还没有内容" : "还没有封存的心事。"
          }
          onUnauthorized={() => setAuth("out")}
          renderItem={(item, controls) => (
            <EntryCard
              kind={kind}
              canManage={canManage}
              entry={item}
              onLocalChange={(partial) => controls.patch(partial)}
              onDelete={() => controls.remove()}
              onChanged={() => setEntrySeq((n) => n + 1)}
              onUnauthorized={() => setAuth("out")}
            />
          )}
        />
      </div>
    </div>
  );
}

// §7.1 各空间入口门
function Gate({
  kind,
  onEntered,
}: {
  kind: ScopeKind;
  onEntered: () => void;
}) {
  const [secret, setSecret] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError("");
    setLoading(true);
    try {
      let endpoint = "";
      let body: Record<string, string> = {};
      if (kind === "public") {
        endpoint = "/api/unlock";
        body = { password: secret };
      } else if (kind === "pass") {
        endpoint = "/api/pass/unlock";
        body = { passphrase: secret };
      } else {
        endpoint = "/api/account/login";
        body = { username, password };
      }
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // §3.3 口令空间恒 200，无“口令错误”概念
      if (!res.ok) {
        if (kind === "public") {
          setError("密码不对。树洞还在这里，慢慢来。");
        } else if (kind === "user") {
          setError("账号或密码错误");
        } else {
          setError(`请求失败（${res.status}），请重试`);
        }
        return;
      }
      onEntered();
    } catch {
      setError("网络错误，请重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-[68vh] items-center justify-center">
      <div className="w-full max-w-md rounded-lg border border-[#ead8e5] bg-[#fff9fc]/95 p-6 shadow-xl shadow-[#d4b9c9]/20 sm:p-8">
        {kind === "public" && (
          <p className="text-sm text-[#a986a3]">普通浏览器可访问</p>
        )}
        <h2 className="mt-2 text-4xl font-semibold text-[#756a8a]">
          {kind === "public" ? "嘟" : SPACE_NAME[kind]}
        </h2>
        <p className="mt-3 leading-7 text-[#7b7481]">
          {kind === "public"
            ? "输入密码后进入。你的封存和留言会被好好收着，管理员可以查看整理。"
            : kind === "pass"
              ? "输入口令进入一间属于这串口令的房间。任意口令都可以进入；若这串口令从无人使用，会看到一间空房间。"
              : "用账号和密码登录你的个人空间。"}
        </p>

        {kind === "user" && (
          <input
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="账号"
            className="mt-6 w-full rounded-lg border border-[#ead8e5] bg-[#fffafd] px-4 py-3 outline-none transition focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
          />
        )}

        <label
          htmlFor="gate-secret"
          className="mt-6 block text-sm font-medium text-[#70697a]"
        >
          {kind === "user" ? "密码" : "输入密码"}
        </label>
        <input
          id="gate-secret"
          type="password"
          value={kind === "user" ? password : secret}
          onChange={(event) =>
            kind === "user"
              ? setPassword(event.target.value)
              : setSecret(event.target.value)
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
          placeholder={
            kind === "user" ? "请输入密码" : kind === "pass" ? "请输入口令" : ""
          }
          className="mt-2 w-full rounded-lg border border-[#ead8e5] bg-[#fffafd] px-4 py-3 text-lg outline-none transition focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
        />

        {error && (
          <p className="mt-3 rounded-lg bg-[#f5dce2] px-4 py-3 text-sm text-[#965c6d]">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={
            loading ||
            (kind === "user"
              ? !username.trim() || !password
              : kind === "pass"
                ? false
                : !secret.trim())
          }
          className="mt-5 w-full rounded-lg bg-[#b9addd] px-5 py-3 font-medium text-white transition hover:bg-[#a699cf] disabled:cursor-not-allowed disabled:bg-[#d5cdda]"
        >
          {loading ? "正在验证..." : "进入树洞"}
        </button>
      </div>
    </div>
  );
}

function WriteMessage({
  kind,
  onPosted,
}: {
  kind: ScopeKind;
  onPosted: () => void;
}) {
  const [nickname, setNickname] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const submit = async () => {
    const text = content.trim();
    if (!text) return;
    setSaving(true);
    setStatus("");
    setError("");
    try {
      const res = await fetch(`/api/messages?scope=${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nickname: nickname.trim(),
          content: text,
        }),
      });
      if (res.status === 401) {
        setError("登录已失效，请重新进入");
        return;
      }
      if (!res.ok) {
        setError("保存失败，请稍后再试。");
        return;
      }
      setNickname("");
      setContent("");
      setStatus("已好好收下啦。");
      onPosted();
    } catch {
      setError("网络错误，请重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-[#ead8e5] bg-[#fff9fc]/88 p-5 shadow-xl shadow-[#d4b9c9]/12 sm:p-6">
      <h2 className="text-xl font-semibold text-[#756a8a]">想对我说什么</h2>
      <p className="mt-1 text-sm text-[#7b7481]">
        留下匿名昵称和想说的话，写入的日子会一并记着。
      </p>

      <label className="mt-4 block text-sm font-medium text-[#70697a]">
        匿名昵称
      </label>
      <input
        aria-label="匿名昵称"
        maxLength={24}
        value={nickname}
        onChange={(event) => setNickname(event.target.value)}
        placeholder="如：1、小太阳、路过的人"
        className="mt-2 w-full rounded-lg border border-[#ead8e5] bg-[#fffafd] px-4 py-3 outline-none transition placeholder:text-[#a99dad] focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
      />

      <textarea
        aria-label="想对我说什么"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder="比如：想对你说一句话。"
        rows={4}
        className="mt-4 w-full resize-none rounded-lg border border-[#ead8e5] bg-[#fffafd] p-4 leading-7 outline-none transition placeholder:text-[#a99dad] focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
      />

      {status && <p className="mt-3 text-sm text-[#7b7481]">{status}</p>}
      {error && <p className="mt-3 text-sm text-[#965c6d]">{error}</p>}

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving || !content.trim()}
          className="rounded-lg bg-[#a9cde6] px-5 py-3 font-medium text-white transition hover:bg-[#95bddb] disabled:cursor-not-allowed disabled:bg-[#d5cdda]"
        >
          {saving ? "正在保存..." : "留给我"}
        </button>
      </div>
    </div>
  );
}

function WriteEntry({
  kind,
  onPosted,
}: {
  kind: ScopeKind;
  onPosted: () => void;
}) {
  const [mood, setMood] = useState(moods[0].label);
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const selectedMood =
    moods.find((item) => item.label === mood) ?? moods[0];

  const submit = async () => {
    const text = content.trim();
    if (!text) return;
    setSaving(true);
    setStatus("");
    setError("");
    try {
      // §7.2：成员封存不携带 reply（后端亦丢弃）
      const res = await fetch(`/api/entries?scope=${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mood, content: text }),
      });
      if (res.status === 401) {
        setError("登录已失效，请重新进入");
        return;
      }
      if (!res.ok) {
        setError("保存失败，请稍后再试。");
        return;
      }
      setContent("");
      setStatus("好好收进口袋啦。");
      onPosted();
    } catch {
      setError("网络错误，请重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-[#ead8e5] bg-[#fff9fc]/88 p-5 shadow-xl shadow-[#d4b9c9]/12 sm:p-6">
      <p className="text-sm text-[#a986a3]">只属于你的封存</p>
      <h2 className="mt-1 text-2xl font-semibold text-[#756a8a]">
        把今天放进树洞
      </h2>
      <p className="mt-1 text-sm text-[#7b7481]">
        写完后轻轻封存，管理员会帮忙照看和整理。
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {moods.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => setMood(item.label)}
            className={`rounded-full border px-4 py-2 text-sm transition ${
              mood === item.label
                ? "border-[#b9addd] bg-[#b9addd] text-white"
                : "border-[#ead8e5] bg-[#fffafd] text-[#70697a] hover:border-[#c7b9e8]"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <textarea
        aria-label="写下你的心事"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        rows={6}
        placeholder="这里可以写开心、幸福、疲惫、秘密，或一句没地方说的话。"
        className="mt-4 w-full resize-none rounded-lg border border-[#ead8e5] bg-[#fffafd] p-4 text-lg leading-8 outline-none transition placeholder:text-[#a99dad] focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
      />

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-[#7b7481]">{status || selectedMood.tone}</p>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving || !content.trim()}
          className="rounded-lg bg-[#f0abc0] px-5 py-3 font-medium text-white transition hover:bg-[#e79bb3] disabled:cursor-not-allowed disabled:bg-[#d5cdda]"
        >
          {saving ? "正在保存..." : "封存这一刻"}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-[#965c6d]">{error}</p>}
    </div>
  );
}

function MessageCard({
  kind,
  canManage,
  message,
  onLocalChange,
  onDelete,
  onChanged,
  onUnauthorized,
}: {
  kind: ScopeKind;
  canManage: boolean;
  message: Message;
  onLocalChange?: (partial: Partial<Message>) => void;
  onDelete?: () => void;
  onChanged: () => void;
  onUnauthorized: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [nickname, setNickname] = useState(message.nickname);
  const [content, setContent] = useState(message.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleError = (res: Response) => {
    if (res.status === 401) {
      onUnauthorized();
      return "登录已失效";
    }
    return `操作失败（${res.status}）`;
  };

  const save = async () => {
    const text = content.trim();
    if (!text) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/messages/${message.id}?scope=${kind}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nickname: nickname.trim(), content: text }),
        },
      );
      if (!res.ok) {
        setError(handleError(res));
        if (res.status === 409) onChanged();
        return;
      }
      setEditing(false);
      onChanged();
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  };

  const setLock = async (locked: boolean) => {
    if (locked && !window.confirm("锁定后空间成员将无法修改，确定锁定？")) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/messages/${message.id}/lock?scope=${kind}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locked }),
        },
      );
      if (res.status === 409) {
        setError("该内容已锁定");
        onLocalChange?.({ locked: true });
        return;
      }
      if (!res.ok) {
        setError(handleError(res));
        return;
      }
      onLocalChange?.({ locked, updatedAt: new Date().toISOString() });
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  };

  const removeSelf = async () => {
    if (!window.confirm("确定删除这条留言？此操作不可撤销。")) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/messages/${message.id}?scope=${kind}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        setError(handleError(res));
        return;
      }
      onDelete?.();
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="rounded-lg border border-[#ead8e5] bg-[#fffafd] p-4">
      <div className="mb-2 flex items-center justify-between gap-2 text-sm text-[#a986a3]">
        <span>{message.nickname}</span>
        <time>
          {formatTime(message.createdAt)}
          {message.updatedAt ? " · 已编辑" : ""}
          {message.locked && " · 🔒 已锁定"}
        </time>
      </div>

      {editing ? (
        <>
          <input
            type="text"
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            maxLength={24}
            className="mb-2 w-full rounded-lg border border-[#ead8e5] px-3 py-1.5 text-sm outline-none focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
          />
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={3}
            className="w-full resize-none rounded-lg border border-[#ead8e5] px-3 py-2 text-sm outline-none focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
          />
        </>
      ) : (
        <p className="whitespace-pre-wrap leading-7">{message.content}</p>
      )}

      {error && <p className="mt-2 text-xs text-[#965c6d]">{error}</p>}

      <div className="mt-2.5 flex justify-end gap-2 border-t border-[#f1e7f0] pt-2.5">
        {editing ? (
          <>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setNickname(message.nickname);
                setContent(message.content);
              }}
              className={PILL}
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !content.trim()}
              className={PILL_PRIMARY}
            >
              保存
            </button>
          </>
        ) : (
          canManage && (
            <>
              {!message.locked && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  disabled={busy}
                  className={PILL}
                >
                  修改
                </button>
              )}
              <button
                type="button"
                onClick={() => void setLock(!message.locked)}
                disabled={busy}
                className={PILL}
              >
                {message.locked ? "解锁" : "锁定"}
              </button>
              <button
                type="button"
                onClick={() => void removeSelf()}
                disabled={busy}
                className={PILL_DANGER}
              >
                删除
              </button>
            </>
          )
        )}
      </div>
    </article>
  );
}

function EntryCard({
  kind,
  canManage,
  entry,
  onLocalChange,
  onDelete,
  onChanged,
  onUnauthorized,
}: {
  kind: ScopeKind;
  canManage: boolean;
  entry: Entry;
  onLocalChange?: (partial: Partial<Entry>) => void;
  onDelete?: () => void;
  onChanged: () => void;
  onUnauthorized: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [mood, setMood] = useState(entry.mood);
  const [content, setContent] = useState(entry.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleError = (res: Response) => {
    if (res.status === 401) {
      onUnauthorized();
      return "登录已失效";
    }
    return `操作失败（${res.status}）`;
  };

  const save = async () => {
    const moodText = mood.trim();
    const text = content.trim();
    if (!moodText || !text) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/entries/${entry.id}?scope=${kind}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mood: moodText, content: text }),
        },
      );
      if (!res.ok) {
        setError(handleError(res));
        if (res.status === 409) onChanged();
        return;
      }
      setEditing(false);
      onChanged();
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  };

  const setLock = async (locked: boolean) => {
    if (locked && !window.confirm("锁定后空间成员将无法修改，确定锁定？")) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/entries/${entry.id}/lock?scope=${kind}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locked }),
        },
      );
      if (res.status === 409) {
        setError("该内容已锁定");
        onLocalChange?.({ locked: true });
        return;
      }
      if (!res.ok) {
        setError(handleError(res));
        return;
      }
      onLocalChange?.({ locked, updatedAt: new Date().toISOString() });
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  };

  const removeSelf = async () => {
    if (!window.confirm("确定删除这条封存？此操作不可撤销。")) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/entries/${entry.id}?scope=${kind}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        setError(handleError(res));
        return;
      }
      onDelete?.();
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="rounded-lg border border-[#ead8e5] bg-[#fffafd] p-4">
      <div className="mb-2 flex items-center justify-between gap-2 text-sm text-[#a986a3]">
        <span className="rounded-full bg-[#f5edf8] px-3 py-0.5 text-[#756a8a]">
          {entry.mood}
        </span>
        <time>
          {formatTime(entry.createdAt)}
          {entry.updatedAt ? " · 已编辑" : ""}
          {entry.locked && " · 🔒 已锁定"}
        </time>
      </div>

      {editing ? (
        <>
          <input
            type="text"
            value={mood}
            onChange={(event) => setMood(event.target.value)}
            maxLength={24}
            className="mb-2 w-full rounded-lg border border-[#ead8e5] px-3 py-1.5 text-sm outline-none focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
          />
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={4}
            className="w-full resize-none rounded-lg border border-[#ead8e5] px-3 py-2 text-sm outline-none focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
          />
        </>
      ) : (
        <p className="whitespace-pre-wrap leading-7">{entry.content}</p>
      )}

      <div className="mt-3 rounded-lg bg-[#f5edf8]/70 p-3">
        <p className="mb-1 text-xs font-medium text-[#756a8a]">树洞回声</p>
        {entry.reply ? (
          <p className="whitespace-pre-wrap text-sm text-[#5d5868]">
            {entry.reply}
          </p>
        ) : (
          <p className="text-sm text-[#a99dad]">暂无回复</p>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-[#965c6d]">{error}</p>}

      <div className="mt-2.5 flex justify-end gap-2 border-t border-[#f1e7f0] pt-2.5">
        {editing ? (
          <>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setMood(entry.mood);
                setContent(entry.content);
              }}
              className={PILL}
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !mood.trim() || !content.trim()}
              className={PILL_PRIMARY}
            >
              保存
            </button>
          </>
        ) : (
          canManage && (
            <>
              {!entry.locked && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  disabled={busy}
                  className={PILL}
                >
                  修改
                </button>
              )}
              <button
                type="button"
                onClick={() => void setLock(!entry.locked)}
                disabled={busy}
                className={PILL}
              >
                {entry.locked ? "解锁" : "锁定"}
              </button>
              <button
                type="button"
                onClick={() => void removeSelf()}
                disabled={busy}
                className={PILL_DANGER}
              >
                删除
              </button>
            </>
          )
        )}
      </div>
    </article>
  );
}

// —— §7.3 管理员后台 ——

function AdminLayer({
  unlocked,
  barGeometry,
  onSessionRefresh,
}: {
  unlocked: boolean;
  barGeometry: BarGeometry;
  onSessionRefresh: () => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const unlock = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setError("管理员密码不对。");
        return;
      }
      await onSessionRefresh();
    } catch {
      setError("网络错误，请重试");
    } finally {
      setLoading(false);
    }
  };

  if (!unlocked) {
    return (
      <div className="flex min-h-[68vh] items-center justify-center">
        <div className="w-full max-w-md rounded-lg border border-[#ead8e5] bg-[#fff9fc]/95 p-6 shadow-xl shadow-[#d4b9c9]/20 sm:p-8">
          <h2 className="text-2xl font-semibold text-[#756a8a]">管理员空间</h2>
          <p className="mt-1 text-sm text-[#7b7481]">
            输入管理员密码进入。
          </p>
          <input
            aria-label="管理员密码"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void unlock();
            }}
            placeholder="输入管理员密码"
            className="mt-4 w-full rounded-lg border border-[#ead8e5] bg-[#fffafd] px-4 py-3 outline-none transition focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
          />
          {error && (
            <p className="mt-3 rounded-lg bg-[#f5dce2] px-4 py-3 text-sm text-[#965c6d]">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void unlock()}
            disabled={loading || !password.trim()}
            className="mt-5 w-full rounded-lg bg-[#b9addd] px-5 py-3 font-medium text-white transition hover:bg-[#a699cf] disabled:cursor-not-allowed disabled:bg-[#d5cdda]"
          >
            {loading ? "正在验证..." : "进入管理"}
          </button>
        </div>
      </div>
    );
  }

  return <AdminPanel barGeometry={barGeometry} onSessionRefresh={onSessionRefresh} />;
}

function AdminPanel({
  barGeometry,
  onSessionRefresh,
}: {
  barGeometry: BarGeometry;
  onSessionRefresh: () => Promise<void>;
}) {
  const [messages, setMessages] = useState<AdminMessage[]>([]);
  const [entries, setEntries] = useState<AdminEntry[]>([]);
  const [passSpaces, setPassSpaces] = useState<PassSpace[]>([]);
  const [users, setUsers] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<ScopeKind>("public");
  const [scopeFilter, setScopeFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  // 批量选择：key 前缀 M:（留言）/E:（封存），避免两类 id 撞值
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const togglePick = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // 批量操作当前 tab+筛选范围内勾选的项；成功即本地更新，不整表 reload
  const batchRun = async (
    prefix: "M" | "E",
    list: Array<AdminMessage | AdminEntry>,
    action: "lock" | "unlock" | "delete",
  ) => {
    const targets = list.filter((item) => picked.has(`${prefix}:${item.id}`));
    if (targets.length === 0) return;
    const base = prefix === "M" ? "messages" : "entries";
    if (
      action === "delete" &&
      !window.confirm(`确定删除选中的 ${targets.length} 条？此操作不可撤销。`)
    ) {
      return;
    }
    setBusy(true);
    setActionError("");
    const okIds = new Set<string>();
    let failed = 0;
    await Promise.all(
      targets.map(async (item) => {
        const scope = { scope: { kind: item.scopeKind, id: item.scopeId } };
        let res: Response;
        if (action === "delete") {
          res = await fetch(`/api/${base}/${item.id}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(scope),
          });
        } else {
          res = await fetch(`/api/${base}/${item.id}/lock`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...scope, locked: action === "lock" }),
          });
        }
        if (res.ok) okIds.add(item.id);
        else failed += 1;
      }),
    );
    const stamp = new Date().toISOString();
    if (prefix === "M") {
      setMessages((prev) =>
        action === "delete"
          ? prev.filter((it) => !okIds.has(it.id))
          : prev.map((it) =>
              okIds.has(it.id)
                ? { ...it, locked: action === "lock", updatedAt: stamp }
                : it,
            ),
      );
    } else {
      setEntries((prev) =>
        action === "delete"
          ? prev.filter((it) => !okIds.has(it.id))
          : prev.map((it) =>
              okIds.has(it.id)
                ? { ...it, locked: action === "lock", updatedAt: stamp }
                : it,
            ),
      );
    }
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of okIds) next.delete(`${prefix}:${id}`);
      return next;
    });
    if (failed > 0) setActionError(`${failed} 条操作失败，其余已完成`);
    setBusy(false);
  };

  const queryAll = useCallback(async () => {
    const [itemsRes, usersRes] = await Promise.all([
      fetch("/api/admin/items", { cache: "no-store" }),
      fetch("/api/admin/users", { cache: "no-store" }),
    ]);
    if (itemsRes.status === 401 || usersRes.status === 401) {
      await onSessionRefresh();
      return;
    }
    if (!itemsRes.ok || !usersRes.ok) {
      throw new Error("加载失败，请重试");
    }
    const items = (await itemsRes.json()) as {
      messages: AdminMessage[];
      entries: AdminEntry[];
      passSpaces: PassSpace[];
    };
    const usersData = (await usersRes.json()) as { users: Account[] };
    setMessages(items.messages);
    setEntries(items.entries);
    setPassSpaces(items.passSpaces);
    setUsers(usersData.users);
  }, [onSessionRefresh]);

  const reload = (): Promise<void> => {
    setLoading(true);
    setLoadError("");
    return queryAll()
      .catch((err: Error) => setLoadError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/items", { cache: "no-store" }),
      fetch("/api/admin/users", { cache: "no-store" }),
    ])
      .then(async ([itemsRes, usersRes]) => {
        if (itemsRes.status === 401 || usersRes.status === 401) {
          await onSessionRefresh();
          return;
        }
        if (!itemsRes.ok || !usersRes.ok) {
          setLoadError("加载失败，请重试");
          return;
        }
        const items = (await itemsRes.json()) as {
          messages: AdminMessage[];
          entries: AdminEntry[];
          passSpaces: PassSpace[];
        };
        const usersData = (await usersRes.json()) as { users: Account[] };
        setMessages(items.messages);
        setEntries(items.entries);
        setPassSpaces(items.passSpaces);
        setUsers(usersData.users);
      })
      .catch(() => setLoadError("网络错误，请重试"))
      .finally(() => setLoading(false));
  }, [onSessionRefresh]);

  // 管理员 :id 操作：body 必须带完整 scope
  const scopedBody = (item: { scopeKind: ScopeKind; scopeId: string }) => ({
    scope: { kind: item.scopeKind, id: item.scopeId },
  });

  const run = async (
    url: string,
    method: string,
    body: Record<string, unknown>,
  ) => {
    setBusy(true);
    setActionError("");
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        await onSessionRefresh();
        return;
      }
      if (!res.ok) {
        setActionError(`操作失败（${res.status}）`);
        return;
      }
      reload();
    } catch {
      setActionError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  };

  const toggleLock = (
    item: AdminMessage | AdminEntry,
    entryTarget: boolean,
  ) => {
    const base = entryTarget ? "entries" : "messages";
    void run(`/api/${base}/${item.id}/lock`, "POST", {
      ...scopedBody(item),
      locked: !item.locked,
    });
  };

  const remove = (item: AdminMessage | AdminEntry, entryTarget: boolean) => {
    const base = entryTarget ? "entries" : "messages";
    if (
      !window.confirm(
        `确定删除${SPACE_NAME[item.scopeKind]}的这条${entryTarget ? "封存" : "留言"}？`,
      )
    ) {
      return;
    }
    void run(`/api/${base}/${item.id}`, "DELETE", scopedBody(item));
  };

  const reply = (item: AdminEntry) => {
    const text = window.prompt("写下回复（锁定不影响回复）：", item.reply);
    if (text === null) return;
    void run(`/api/entries/${item.id}/reply`, "POST", {
      ...scopedBody(item),
      reply: text,
    });
  };

  const inView = <T extends { scopeKind: ScopeKind; scopeId: string }>(
    item: T,
  ) =>
    item.scopeKind === tab &&
    (scopeFilter === "" || item.scopeId === scopeFilter);

  const tabMessages = messages
    .filter(inView)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const tabEntries = entries
    .filter(inView)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {(["public", "pass", "user"] as ScopeKind[]).map((spaceKind) => (
          <button
            key={spaceKind}
            type="button"
            onClick={() => {
              setTab(spaceKind);
              setScopeFilter("");
            }}
            className={`rounded-full border px-4 py-2 text-sm transition ${
              tab === spaceKind
                ? "border-[#b9addd] bg-[#b9addd] text-white"
                : "border-[#ead8e5] bg-[#fffafd] text-[#70697a] hover:border-[#c7b9e8]"
            }`}
          >
            {SPACE_NAME[spaceKind]}
          </button>
        ))}
      </div>

      {tab === "pass" && (
        <div className="text-sm text-[#70697a]">
          <label htmlFor="pass-filter">口令空间：</label>
          <select
            id="pass-filter"
            value={scopeFilter}
            onChange={(event) => setScopeFilter(event.target.value)}
            className="rounded-lg border border-[#ead8e5] bg-[#fffafd] px-2 py-1"
          >
            <option value="">全部（{passSpaces.length}）</option>
            {passSpaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.label || `${space.id.slice(0, 8)}…`}（{formatTime(space.createdAt)}）
              </option>
            ))}
          </select>
          {passSpaces.length === 0 && (
            <span className="ml-3 text-[#a986a3]">还没有口令空间</span>
          )}
        </div>
      )}

      {tab === "user" && (
        <div className="text-sm text-[#70697a]">
          <label htmlFor="user-filter">账号空间：</label>
          <select
            id="user-filter"
            value={scopeFilter}
            onChange={(event) => setScopeFilter(event.target.value)}
            className="rounded-lg border border-[#ead8e5] bg-[#fffafd] px-2 py-1"
          >
            <option value="">全部（{users.length}）</option>
            {users.map((account) => (
              <option key={account.id} value={account.id}>
                {account.username}
              </option>
            ))}
          </select>
        </div>
      )}

      {actionError && (
        <p className="text-sm text-[#965c6d]">{actionError}</p>
      )}

      {loading ? (
        <LoadingSpinner label="正在加载全部空间…" />
      ) : loadError ? (
        <div className="rounded-xl border border-[#efc8d2] bg-[#f5dce2] p-6 text-center">
          <p className="text-sm text-[#965c6d]">{loadError}</p>
          <button
            type="button"
            onClick={() => void reload()}
            className="mt-3 rounded-full border border-[#e4d6e6] bg-[#fffafd] px-3 py-1 text-sm text-[#756a8a] transition hover:border-[#c7b9e8] hover:bg-white"
          >
            重试
          </button>
        </div>
      ) : (
        <>
          {picked.size > 0 && (
            <div
              className="fixed z-40 flex flex-wrap items-center gap-2 rounded-2xl border border-[#ead8e5] bg-[#fff9fc]/95 px-4 py-2.5 shadow-lg shadow-[#d4b9c9]/25 backdrop-blur-sm"
              style={{
                top: barGeometry.top + barGeometry.h + 12,
                left: barGeometry.left,
                right: barGeometry.right,
              }}
            >
              <span className="text-sm text-[#756a8a]">
                已选 {picked.size} 条
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void batchRun("M", tabMessages, "lock");
                  void batchRun("E", tabEntries, "lock");
                }}
                className={PILL}
              >
                批量锁定
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void batchRun("M", tabMessages, "unlock");
                  void batchRun("E", tabEntries, "unlock");
                }}
                className={PILL}
              >
                批量解锁
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void batchRun("M", tabMessages, "delete");
                  void batchRun("E", tabEntries, "delete");
                }}
                className={PILL_DANGER}
              >
                批量删除
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setPicked(new Set())}
                className="text-xs text-[#a986a3] underline"
              >
                清空选择
              </button>
            </div>
          )}
          <section>
            <p className="mb-2 text-sm font-semibold text-[#756a8a]">
              留言（{tabMessages.length}）
            </p>
            {tabMessages.length === 0 ? (
              <p className="rounded-lg bg-[#f5edf8]/80 p-4 text-center text-sm text-[#7b7481]">
                该范围没有留言
              </p>
            ) : (
              <div className="space-y-2">
                {tabMessages.map((item) => (
                  <AdminRow
                    key={item.id}
                    item={item}
                    entryTarget={false}
                    busy={busy}
                    checked={picked.has(`M:${item.id}`)}
                    onTogglePick={() => togglePick(`M:${item.id}`)}
                    onToggleLock={() => toggleLock(item, false)}
                    onDelete={() => remove(item, false)}
                  />
                ))}
              </div>
            )}
          </section>

          <section>
            <p className="mb-2 text-sm font-semibold text-[#756a8a]">
              封存（{tabEntries.length}）
            </p>
            {tabEntries.length === 0 ? (
              <p className="rounded-lg bg-[#f5edf8]/80 p-4 text-center text-sm text-[#7b7481]">
                该范围没有封存
              </p>
            ) : (
              <div className="space-y-2">
                {tabEntries.map((item) => (
                  <AdminRow
                    key={item.id}
                    item={item}
                    entryTarget
                    busy={busy}
                    checked={picked.has(`E:${item.id}`)}
                    onTogglePick={() => togglePick(`E:${item.id}`)}
                    onToggleLock={() => toggleLock(item, true)}
                    onDelete={() => remove(item, true)}
                    onReply={() => reply(item)}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <AccountSection users={users} reload={reload} />
    </div>
  );
}

function AdminRow({
  item,
  entryTarget,
  busy,
  checked,
  onTogglePick,
  onToggleLock,
  onDelete,
  onReply,
}: {
  item: AdminMessage | AdminEntry;
  entryTarget: boolean;
  busy: boolean;
  checked: boolean;
  onTogglePick: () => void;
  onToggleLock: () => void;
  onDelete: () => void;
  onReply?: () => void;
}) {
  return (
    <div className="rounded-lg border border-[#ead8e5] bg-[#fffafd] p-3">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-[#a986a3]">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={checked}
            onChange={onTogglePick}
            aria-label="选择该条"
            className="h-3.5 w-3.5 accent-[#b9addd]"
          />
          <span>
            {entryTarget
              ? `心情：${(item as AdminEntry).mood}`
              : (item as AdminMessage).nickname}
            {item.locked && " · 🔒"}
            {item.scopeKind !== "public" && ` · ${item.scopeId.slice(0, 8)}`}
          </span>
        </label>
        <span>{formatTime(item.createdAt)}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm text-[#5d5868]">
        {item.content}
      </p>
      {entryTarget && (
        <p className="mt-1 text-xs text-[#a986a3]">
          回复：{(item as AdminEntry).reply || "暂无回复"}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        {entryTarget && (
          <button
            type="button"
            onClick={onReply}
            disabled={busy}
            className={PILL}
          >
            回复
          </button>
        )}
        <button
          type="button"
          onClick={onToggleLock}
          disabled={busy}
          className={PILL}
        >
          {item.locked ? "解锁" : "锁定"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className={PILL_DANGER}
        >
          删除
        </button>
      </div>
    </div>
  );
}

// §7.3 账号管理（不开放注册，仅此入口）
function AccountSection({
  users,
  reload,
}: {
  users: Account[];
  reload: () => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(
          res.status === 409
            ? "用户名已存在"
            : data?.error ?? `创建失败（${res.status}）`,
        );
        return;
      }
      setUsername("");
      setPassword("");
      await reload();
    } catch {
      setError("网络错误，请重试");
    } finally {
      setSaving(false);
    }
  };

  const resetPassword = async (account: Account) => {
    const next = window.prompt(`为 ${account.username} 设置新密码（≥6 位）：`);
    if (next === null) return;
    if (next.length < 6) {
      setError("密码至少 6 位");
      return;
    }
    const res = await fetch(
      `/api/admin/users/${account.id}/reset-password`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: next }),
      },
    );
    if (!res.ok) {
      setError(`重置失败（${res.status}）`);
      return;
    }
    setError("");
    await reload();
  };

  const toggleActive = async (account: Account) => {
    const res = await fetch(`/api/admin/users/${account.id}/active`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !account.active }),
    });
    if (!res.ok) {
      setError(`操作失败（${res.status}）`);
      return;
    }
    setError("");
    await reload();
  };

  return (
    <section className="rounded-lg border border-[#ead8e5] bg-[#fff9fc]/86 p-5 shadow-xl shadow-[#d4b9c9]/12 sm:p-6">
      <h2 className="text-2xl font-semibold text-[#756a8a]">账号管理</h2>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <input
          type="text"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="账号（字母数字 _.-，≤32）"
          className="rounded-lg border border-[#ead8e5] bg-[#fffafd] px-4 py-2 text-sm outline-none focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
        />
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="初始密码（≥6 位）"
          className="rounded-lg border border-[#ead8e5] bg-[#fffafd] px-4 py-2 text-sm outline-none focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
        />
        <button
          type="button"
          onClick={() => void create()}
          disabled={saving || !username.trim() || password.length < 6}
          className="rounded-full bg-[#b9addd] px-4 py-2 text-sm text-white transition hover:bg-[#a699cf] disabled:cursor-not-allowed disabled:bg-[#d5cdda]"
        >
          {saving ? "创建中…" : "创建账号"}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-[#965c6d]">{error}</p>}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[#ead8e5] text-xs text-[#a986a3]">
              <th className="py-2 pr-3">账号</th>
              <th className="py-2 pr-3">状态</th>
              <th className="py-2 pr-3">令牌版本</th>
              <th className="py-2 pr-3">创建时间</th>
              <th className="py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((account) => (
              <tr key={account.id}>
                <td className="py-2 pr-3 text-[#5d5868]">
                  {account.username}
                </td>
                <td className="py-2 pr-3">
                  {account.active ? (
                    <span className="text-[#7b9e8a]">启用</span>
                  ) : (
                    <span className="text-[#b07c8d]">停用</span>
                  )}
                </td>
                <td className="py-2 pr-3 text-[#7b7481]">
                  {account.tokenVersion}
                </td>
                <td className="py-2 pr-3 text-[#7b7481]">
                  {formatTime(account.createdAt)}
                </td>
                <td className="py-2">
                  <button
                    type="button"
                    onClick={() => void resetPassword(account)}
                    className="mr-2 rounded-full border border-[#e4d6e6] bg-[#fffafd] px-3 py-1 text-xs text-[#756a8a] transition hover:border-[#c7b9e8] hover:bg-white"
                  >
                    重置密码
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggleActive(account)}
                    className="rounded-full border border-[#e4d6e6] bg-[#fffafd] px-3 py-1 text-xs text-[#756a8a] transition hover:border-[#c7b9e8] hover:bg-white"
                  >
                    {account.active ? "停用" : "启用"}
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-[#a986a3]">
                  还没有账号
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// —— 通用组件（沿用原有 Morandi 结构） ——

function InfiniteList<T extends { id: string }>({
  fetchUrl,
  renderItem,
  emptyText,
  onUnauthorized,
}: {
  fetchUrl: string;
  renderItem: (item: T, controls: { patch: (partial: Partial<T>) => void; remove: () => void }) => ReactNode;
  emptyText: string;
  onUnauthorized?: () => void;
}) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreRef = useRef(false);

  const parsePage = async (res: Response): Promise<ListResponse<T>> => {
    if (res.status === 401) {
      onUnauthorized?.();
      throw new Error("__unauthorized__");
    }
    if (!res.ok) {
      throw new Error(`加载失败（HTTP ${res.status}），请稍后重试`);
    }
    return (await res.json()) as ListResponse<T>;
  };

  const mergePage = (page: ListResponse<T>) => {
    setItems((prev) => {
      const map = new Map(prev.map((item) => [item.id, item]));
      for (const item of page.items) map.set(item.id, item);
      return Array.from(map.values());
    });
    setHasMore(page.hasMore);
    setCursor(page.hasMore ? page.nextCursor : null);
  };

  // 首载：挂载（或点击重试）无条件拉首页，不依赖哨兵是否在视口内
  useEffect(() => {
    let cancelled = false;
    fetch(fetchUrl)
      .then((res) => parsePage(res))
      .then((page) => {
        if (cancelled) return;
        mergePage(page);
        setInitialLoading(false);
      })
      .catch((fetchError: Error) => {
        if (cancelled || fetchError.message === "__unauthorized__") return;
        setError(fetchError.message);
        setInitialLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchUrl, reloadTick]);

  const loadMore = () => {
    if (loadingMoreRef.current || initialLoading || !hasMore) return;
    const key = cursor;
    if (!key) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError("");
    fetch(`${fetchUrl}&cursor=${encodeURIComponent(key)}`)
      .then((res) => parsePage(res))
      .then((page) => mergePage(page))
      .catch((fetchError: Error) => {
        if (fetchError.message !== "__unauthorized__") {
          setError(fetchError.message);
        }
      })
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  };

  // 哨兵进入视口 → 仅触发“加载更多”（首载不经过这里）
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (observerEntries) => {
        if (observerEntries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLoading, hasMore, cursor, fetchUrl]);

  const showEmpty =
    !initialLoading && !loadingMore && items.length === 0 && !error;

  return (
    <div className="space-y-3">
      {items.map((item) =>
        renderItem(item, {
          patch: (partial) =>
            setItems((prev) =>
              prev.map((it) => (it.id === item.id ? { ...it, ...partial } : it)),
            ),
          remove: () =>
            setItems((prev) => prev.filter((it) => it.id !== item.id)),
        }),
      )}

      {(initialLoading || loadingMore) && (
        <LoadingSpinner label="正在加载..." />
      )}

      {error && (
        <div className="rounded-lg border border-[#efc8d2] bg-[#f5dce2] p-4 text-center">
          <p className="text-sm text-[#965c6d]">{error}</p>
          <button
            type="button"
            onClick={() => {
              setError("");
              setInitialLoading(true);
              setReloadTick((tick) => tick + 1);
            }}
            className="mt-2 text-sm text-[#965c6d] underline"
          >
            点击重试
          </button>
        </div>
      )}

      {!hasMore && items.length > 0 && (
        <p className="py-2 text-center text-xs text-[#a986a3]">已经到底啦</p>
      )}
      {showEmpty && (
        <p className="rounded-lg bg-[#f5edf8]/80 p-6 text-center text-sm text-[#7b7481]">
          {emptyText}
        </p>
      )}

      <div ref={sentinelRef} />
    </div>
  );
}

function PanelTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-4 text-xl font-semibold text-[#756a8a]">{children}</h2>
  );
}

function LoadingSpinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-[#756a8a]">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#d6c9f2] border-t-[#b9addd]" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

function formatTime(iso: string) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
