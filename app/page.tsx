"use client";

import Image from "next/image";
import {
  FormEvent,
  Fragment,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type StoredEntry = {
  id: string;
  mood: string;
  content: string;
  reply: string;
  createdAt: string;
};

type StoredMessage = {
  id: string;
  nickname: string;
  content: string;
  createdAt: string;
};

const moods = [
  { label: "愉悦", tone: "把这份亮亮的心情好好收进口袋。" },
  { label: "幸福", tone: "愿这一刻被温柔地记住很久。" },
  { label: "轻松", tone: "把这一点点晴朗也好好收起来。" },
  { label: "想念", tone: "有些名字会在心里亮很久。" },
  { label: "低落", tone: "给自己一点靠岸的时间。" },
  { label: "焦虑", tone: "先把呼吸放慢，事情可以一件件来。" },
  { label: "委屈", tone: "你不需要证明这份难受才是真的。" },
];

const replies = [
  "这句话已经被树洞接住了。今晚不用把自己解释得很完整。",
  "你可以先停在这里。没有人催你立刻变好。",
  "谢谢你把它放下。那些没说出口的部分，也被好好听见了。",
  "愿这段心事离开你的肩膀一点点，哪怕只是一点点。",
  "这里不会评判你。你写下来的这一刻，就已经在照顾自己。",
  "愿这份幸福被好好收藏，等以后想起来也还是暖的。",
];

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function Home() {
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    fetch("/api/session")
      .then((response) => response.json())
      .then((session) => setUnlocked(Boolean(session.unlocked)))
      .catch(() => setUnlocked(false));
  }, []);

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    setUnlocked(false);
  }

  if (!unlocked) return <PasswordGate onUnlock={() => setUnlocked(true)} />;
  return <TreeHole onLogout={handleLogout} />;
}

function PasswordGate({ onUnlock }: { onUnlock: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    const response = await fetch("/api/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }).catch(() => null);

    setLoading(false);
    if (response?.ok) {
      onUnlock();
      return;
    }

    setError("密码不对。树洞还在这里，慢慢来。");
  }

  return (
    <main className="min-h-screen bg-[#f8eef4] text-[#5d5868]">
      <section className="relative flex min-h-screen items-center justify-center overflow-hidden px-5 py-8">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_16%_20%,rgba(244,196,210,0.48),transparent_30%),radial-gradient(circle_at_82%_18%,rgba(205,202,232,0.5),transparent_32%),radial-gradient(circle_at_76%_84%,rgba(190,216,235,0.5),transparent_34%)]" />
        <form
          className="relative w-full max-w-md rounded-lg border border-[#ead8e5] bg-[#fff9fc]/92 p-6 shadow-xl shadow-[#d4b9c9]/20 sm:p-8"
          onSubmit={submitPassword}
        >
          <p className="text-sm text-[#a986a3]">普通浏览器可访问</p>
          <h1 className="mt-2 text-4xl font-semibold text-[#756a8a]">
            嘟
          </h1>
          <p className="mt-3 leading-7 text-[#7b7481]">
            输入密码后进入。封存和留言会被安全地保存到服务器，管理员可查看整理。
          </p>

          <label className="mt-8 block text-sm font-medium" htmlFor="password">
            输入密码
          </label>
          <input
            autoComplete="current-password"
            autoFocus
            className="mt-2 w-full rounded-lg border border-[#ead8e5] bg-[#fffafd] px-4 py-3 text-lg outline-none transition focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
            id="password"
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />

          {error && (
            <p className="mt-3 rounded-lg bg-[#f5dce2] px-4 py-3 text-sm text-[#965c6d]">
              {error}
            </p>
          )}

          <button
            className="mt-5 w-full rounded-lg bg-[#b9addd] px-5 py-3 font-medium text-white transition hover:bg-[#a699cf] disabled:cursor-not-allowed disabled:bg-[#d5cdda]"
            disabled={loading || !password.trim()}
            type="submit"
          >
            {loading ? "正在验证..." : "进入树洞"}
          </button>
        </form>
      </section>
    </main>
  );
}

function TreeHole({ onLogout }: { onLogout: () => void }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [nickname, setNickname] = useState("");
  const [mood, setMood] = useState(moods[0].label);
  const [sealed, setSealed] = useState<StoredEntry | null>(null);
  const [messageStatus, setMessageStatus] = useState("");
  const [entryStatus, setEntryStatus] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminStatus, setAdminStatus] = useState("");
  const [adminEntries, setAdminEntries] = useState<StoredEntry[]>([]);
  const [adminMessages, setAdminMessages] = useState<StoredMessage[]>([]);
  const [publicRefreshKey, setPublicRefreshKey] = useState(0);

  const selectedMood = useMemo(
    () => moods.find((item) => item.label === mood) ?? moods[0],
    [mood],
  );

  function refreshPublicLists() {
    setPublicRefreshKey((value) => value + 1);
  }

  async function sealEntry() {
    const trimmed = text.trim();
    if (!trimmed) return;
    const reply = replies[Math.floor(Math.random() * replies.length)];

    setEntryStatus("正在保存...");
    const response = await fetch("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: trimmed, mood, reply }),
    }).catch(() => null);

    if (!response?.ok) {
      setEntryStatus("保存失败，请稍后再试。");
      return;
    }

    setSealed({
      id: "",
      mood,
      content: trimmed,
      reply,
      createdAt: new Date().toISOString(),
    });
    setText("");
    setEntryStatus("已封存到服务器。");
    refreshPublicLists();
    if (adminUnlocked) await loadAdminItems();
  }

  async function sendNote() {
    const trimmed = note.trim();
    if (!trimmed) return;

    setMessageStatus("正在保存...");
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: trimmed,
        nickname: nickname.trim() || "匿名",
      }),
    }).catch(() => null);

    if (!response?.ok) {
      setMessageStatus("保存失败，请稍后再试。");
      return;
    }

    setNote("");
    setMessageStatus("已保存到服务器。");
    refreshPublicLists();
    if (adminUnlocked) await loadAdminItems();
  }

  async function unlockAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAdminStatus("正在验证...");
    const response = await fetch("/api/admin/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: adminPassword }),
    }).catch(() => null);

    if (!response?.ok) {
      setAdminStatus("管理员密码不对。");
      return;
    }

    setAdminUnlocked(true);
    setAdminStatus("已进入管理者查看模式。");
    await loadAdminItems();
  }

  async function loadAdminItems() {
    const response = await fetch("/api/admin/items").catch(() => null);
    if (!response?.ok) return;
    const body = (await response.json()) as {
      entries: StoredEntry[];
      messages: StoredMessage[];
    };
    setAdminEntries(body.entries);
    setAdminMessages(body.messages);
  }

  async function deleteAdminItem(type: "entries" | "messages", id: string) {
    const response = await fetch(`/api/admin/${type}/${id}`, {
      method: "DELETE",
    }).catch(() => null);
    if (!response?.ok) {
      setAdminStatus("删除失败，请稍后再试。");
      return;
    }
    setAdminStatus("已删除。");
    await loadAdminItems();
    refreshPublicLists();
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#f8eef4] text-[#5d5868]">
      <section className="relative min-h-screen px-5 py-6 sm:px-8 lg:px-12">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_12%_12%,rgba(246,196,214,0.48),transparent_30%),radial-gradient(circle_at_82%_18%,rgba(205,202,232,0.48),transparent_29%),radial-gradient(circle_at_76%_82%,rgba(190,216,235,0.5),transparent_34%),linear-gradient(145deg,#f8eef4_0%,#f4edf9_44%,#edf6fb_100%)]" />

        <div className="relative mx-auto flex max-w-7xl flex-col gap-6">
          <header className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-[#a986a3]">
                浅粉 · 浅紫 · 浅蓝的明媚树洞
              </p>
              <h1 className="mt-2 text-4xl font-semibold tracking-normal text-[#756a8a] sm:text-6xl">
                嘟
              </h1>
            </div>
            <button
              className="rounded-full border border-[#ead8e5] bg-[#fff9fc]/70 px-4 py-2 text-sm text-[#756a8a] transition hover:border-[#c7b9e8] hover:bg-white"
              onClick={onLogout}
              type="button"
            >
              退出
            </button>
          </header>

          <div className="grid gap-5 xl:grid-cols-[1.05fr_0.95fr_0.8fr]">
            <section className="flex min-h-[520px] flex-col rounded-lg border border-[#ead8e5] bg-[#fff9fc]/88 p-4 shadow-xl shadow-[#d4b9c9]/16 sm:p-6">
              <PanelTitle
                kicker="服务器封存"
                title="把今天放进树洞"
                subtitle="写完后封存，管理员可以在管理者查看模式里整理和删除。"
                badge={`${text.trim().length} 字`}
              />

              <div className="mb-4 flex flex-wrap gap-2">
                {moods.map((item) => (
                  <button
                    className={`rounded-full border px-4 py-2 text-sm transition ${
                      mood === item.label
                        ? "border-[#b9addd] bg-[#b9addd] text-white"
                        : "border-[#ead8e5] bg-[#fffafd] text-[#70697a] hover:border-[#c7b9e8]"
                    }`}
                    key={item.label}
                    onClick={() => setMood(item.label)}
                    type="button"
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <textarea
                aria-label="写下你的心事"
                className="min-h-[260px] flex-1 resize-none rounded-lg border border-[#ead8e5] bg-[#fffafd] p-4 text-lg leading-8 outline-none transition placeholder:text-[#a99dad] focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
                onChange={(event) => setText(event.target.value)}
                placeholder="这里可以写开心、幸福、疲惫、秘密，或一句没地方说的话。"
                value={text}
              />

              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-[#7b7481]">
                  {entryStatus || selectedMood.tone}
                </p>
                <button
                  className="rounded-lg bg-[#f0abc0] px-5 py-3 font-medium text-white transition hover:bg-[#e79bb3] disabled:cursor-not-allowed disabled:bg-[#d5cdda]"
                  disabled={!text.trim() || entryStatus === "正在保存..."}
                  onClick={sealEntry}
                  type="button"
                >
                  封存这一刻
                </button>
              </div>
            </section>

            <section className="grid gap-5">
              <div className="rounded-lg border border-[#ead8e5] bg-[#fff9fc]/84 p-5 shadow-xl shadow-[#d4b9c9]/12">
                <h2 className="text-xl font-semibold text-[#756a8a]">
                  想对我说什么
                </h2>
                <p className="mt-1 text-sm text-[#7b7481]">
                  留下匿名昵称和想说的话，服务器会自动保存写入日期。
                </p>
                <label className="mt-4 block text-sm font-medium text-[#70697a]">
                  匿名昵称
                </label>
                <input
                  aria-label="匿名昵称"
                  className="mt-2 w-full rounded-lg border border-[#ead8e5] bg-[#fffafd] px-4 py-3 outline-none transition placeholder:text-[#a99dad] focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
                  maxLength={24}
                  onChange={(event) => setNickname(event.target.value)}
                  placeholder="如：1、小太阳、路过的人"
                  value={nickname}
                />
                <textarea
                  aria-label="想对我说什么"
                  className="mt-4 min-h-36 w-full resize-none rounded-lg border border-[#ead8e5] bg-[#fffafd] p-4 leading-7 outline-none transition placeholder:text-[#a99dad] focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="比如：想对你说一句话。"
                  value={note}
                />
                <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-[#7b7481]">{messageStatus}</p>
                  <button
                    className="rounded-lg bg-[#a9cde6] px-5 py-3 font-medium text-white transition hover:bg-[#95bddb] disabled:cursor-not-allowed disabled:bg-[#d5cdda]"
                    disabled={!note.trim() || messageStatus === "正在保存..."}
                    onClick={sendNote}
                    type="button"
                  >
                    留给我
                  </button>
                </div>
              </div>

              <div className="rounded-lg border border-[#ead8e5] bg-[#fff9fc]/80 p-5">
                <h2 className="text-xl font-semibold text-[#756a8a]">
                  树洞回声
                </h2>
                <div className="mt-4 min-h-32 rounded-lg bg-[#f5edf8]/80 p-5">
                  {sealed ? (
                    <>
                      <p className="text-sm text-[#a986a3]">
                        {sealed.mood} · {formatDate(sealed.createdAt)}
                      </p>
                      <p className="mt-4 text-2xl leading-9 text-[#6a6178]">
                        {sealed.reply}
                      </p>
                    </>
                  ) : (
                    <p className="text-lg leading-8 text-[#7b7481]">
                      写下一段心事后，这里会出现一句只给你的温柔回应。
                    </p>
                  )}
                </div>
              </div>
            </section>

            <aside className="grid gap-5">
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

              <InfiniteList<StoredEntry>
                emptyText="还没有服务器封存。"
                endpoint="entries"
                refreshKey={publicRefreshKey}
                title="最近封存"
              >
                {(entry) => (
                  <article
                    className="rounded-lg border border-[#ead8e5] bg-[#fffafd] p-4"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2 text-sm text-[#a986a3]">
                      <span>{entry.mood}</span>
                      <time>{formatDate(entry.createdAt)}</time>
                    </div>
                    <p className="line-clamp-3 leading-7">{entry.content}</p>
                  </article>
                )}
              </InfiniteList>
              <InfiniteList<StoredMessage>
                emptyText="还没有留言。"
                endpoint="messages"
                refreshKey={publicRefreshKey}
                title="留给我的话"
              >
                {(message) => (
                  <article
                    className="rounded-lg border border-[#ead8e5] bg-[#fffafd] p-4"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2 text-sm text-[#a986a3]">
                      <span>{message.nickname}</span>
                      <time>{formatDate(message.createdAt)}</time>
                    </div>
                    <p className="line-clamp-4 leading-7">{message.content}</p>
                  </article>
                )}
              </InfiniteList>
            </aside>
          </div>

          <AdminPanel
            adminEntries={adminEntries}
            adminMessages={adminMessages}
            adminPassword={adminPassword}
            adminStatus={adminStatus}
            adminUnlocked={adminUnlocked}
            onDelete={deleteAdminItem}
            onPasswordChange={setAdminPassword}
            onSubmit={unlockAdmin}
          />
        </div>
      </section>
    </main>
  );
}

function PanelTitle({
  badge,
  kicker,
  subtitle,
  title,
}: {
  badge: string;
  kicker: string;
  subtitle: string;
  title: string;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-sm text-[#a986a3]">{kicker}</p>
        <h2 className="text-2xl font-semibold text-[#756a8a]">{title}</h2>
        <p className="mt-1 text-sm text-[#7b7481]">{subtitle}</p>
      </div>
      <span className="rounded-full bg-[#b9addd] px-3 py-1 text-sm text-white">
        {badge}
      </span>
    </div>
  );
}

type PageBody<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

const PAGE_LIMIT = 20;

// cursor 游标分页的无限滚动列表：IntersectionObserver 触发加载，
// 预加载下一页；已加载项按 id 缓存去重。
function InfiniteList<T extends { id: string }>({
  children,
  emptyText,
  endpoint,
  refreshKey,
  title,
}: {
  children: (item: T) => ReactNode;
  emptyText: string;
  endpoint: string;
  refreshKey: number;
  title: string;
}) {
  const [retryKey, setRetryKey] = useState(0);
  return (
    <InfiniteListImpl<T>
      emptyText={emptyText}
      endpoint={endpoint}
      key={`${refreshKey}:${retryKey}`}
      onRetry={() => setRetryKey((value) => value + 1)}
      title={title}
    >
      {children}
    </InfiniteListImpl>
  );
}

function InfiniteListImpl<T extends { id: string }>({
  children,
  emptyText,
  endpoint,
  onRetry,
  title,
}: {
  children: (item: T) => ReactNode;
  emptyText: string;
  endpoint: string;
  onRetry: () => void;
  title: string;
}) {
  const cacheRef = useRef(new Map<string, T>());
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const prefetchRef = useRef<{
    cursor: string;
    promise: Promise<PageBody<T>>;
  } | null>(null);

  const buildUrl = (cursorValue: string | null) =>
    `/api/${endpoint}?limit=${PAGE_LIMIT}${
      cursorValue ? `&cursor=${encodeURIComponent(cursorValue)}` : ""
    }`;

  const fetchPage = (cursorValue: string | null) =>
    fetch(buildUrl(cursorValue)).then(async (response) => {
      if (!response.ok) {
        throw new Error("request failed");
      }
      return (await response.json()) as PageBody<T>;
    });

  const applyPage = (page: PageBody<T>) => {
    const cache = cacheRef.current;
    const fresh = page.items.filter((item) => !cache.has(item.id));
    for (const item of fresh) {
      cache.set(item.id, item);
    }
    setItems((prev) => {
      const next = [...prev];
      for (const item of fresh) {
        if (!next.some((existing) => existing.id === item.id)) {
          next.push(item);
        }
      }
      return next;
    });
    setHasMore(page.hasMore);
    setCursor(page.hasMore ? page.nextCursor : null);
    if (page.hasMore && page.nextCursor) {
      prefetchRef.current = {
        cursor: page.nextCursor,
        promise: fetchPage(page.nextCursor),
      };
    }
  };

  // 首次加载：挂载即拉首页（刷新/重试由外层 key 重挂触发）
  useEffect(() => {
    let cancelled = false;
    fetchPage(null)
      .then((page) => {
        if (cancelled) return;
        applyPage(page);
        setInitialLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("加载失败，请稍后再试。");
        setInitialLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMore = () => {
    if (loadingMoreRef.current || initialLoading || !hasMore) {
      return;
    }
    const key = cursor;
    if (!key) {
      return;
    }
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError("");
    const prefetched = prefetchRef.current;
    const pagePromise =
      prefetched && prefetched.cursor === key
        ? prefetched.promise
        : fetchPage(key);
    if (prefetched && prefetched.cursor === key) {
      prefetchRef.current = null;
    }
    pagePromise
      .then((page) => {
        applyPage(page);
      })
      .catch(() => {
        prefetchRef.current = null;
        setError("加载失败，请稍后再试。");
      })
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  };
  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  });

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) {
      return;
    }
    const observer = new IntersectionObserver((observerEntries) => {
      if (observerEntries[0]?.isIntersecting) {
        loadMoreRef.current();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="rounded-lg border border-[#ead8e5] bg-[#fff9fc]/82 p-5 text-[#5d5868]">
      <h2 className="text-xl font-semibold text-[#756a8a]">{title}</h2>
      <div className="mt-4 space-y-3">
        {initialLoading ? (
          <p className="rounded-lg bg-[#f5edf8]/80 p-4 text-sm text-[#7b7481]">
            正在加载...
          </p>
        ) : error && items.length === 0 ? (
          <div className="rounded-lg bg-[#f5dce2] p-4 text-sm text-[#965c6d]">
            <p>{error}</p>
            <button
              className="mt-2 rounded-lg border border-[#efc8d2] px-3 py-1.5 text-[#9c5f72] transition hover:bg-[#fdeff3]"
              onClick={onRetry}
              type="button"
            >
              重试
            </button>
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-lg bg-[#f5edf8]/80 p-4 text-sm text-[#7b7481]">
            {emptyText}
          </p>
        ) : (
          <>
            {items.map((item) => (
              <Fragment key={item.id}>{children(item)}</Fragment>
            ))}
            {error ? (
              <div className="rounded-lg bg-[#f5dce2] p-4 text-sm text-[#965c6d]">
                <p>{error}</p>
                <button
                  className="mt-2 rounded-lg border border-[#efc8d2] px-3 py-1.5 text-[#9c5f72] transition hover:bg-[#fdeff3]"
                  onClick={loadMore}
                  type="button"
                >
                  重试
                </button>
              </div>
            ) : hasMore ? (
              <div ref={sentinelRef}>
                {loadingMore ? (
                  <p className="p-2 text-center text-sm text-[#7b7481]">
                    正在加载...
                  </p>
                ) : (
                  <div className="h-1" />
                )}
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function AdminPanel({
  adminEntries,
  adminMessages,
  adminPassword,
  adminStatus,
  adminUnlocked,
  onDelete,
  onPasswordChange,
  onSubmit,
}: {
  adminEntries: StoredEntry[];
  adminMessages: StoredMessage[];
  adminPassword: string;
  adminStatus: string;
  adminUnlocked: boolean;
  onDelete: (type: "entries" | "messages", id: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className="rounded-lg border border-[#ead8e5] bg-[#fff9fc]/86 p-5 shadow-xl shadow-[#d4b9c9]/12">
      <h2 className="text-2xl font-semibold text-[#756a8a]">管理者查看</h2>
      <p className="mt-1 text-sm text-[#7b7481]">
        管理者可查看所有服务器封存和留言，并逐条删除。
      </p>

      {!adminUnlocked ? (
        <form className="mt-4 flex flex-col gap-3 sm:flex-row" onSubmit={onSubmit}>
          <input
            aria-label="管理员密码"
            className="min-w-0 flex-1 rounded-lg border border-[#ead8e5] bg-[#fffafd] px-4 py-3 outline-none transition focus:border-[#b9addd] focus:ring-4 focus:ring-[#d6c9f2]/35"
            onChange={(event) => onPasswordChange(event.target.value)}
            placeholder="输入管理员密码"
            type="password"
            value={adminPassword}
          />
          <button
            className="rounded-lg bg-[#b9addd] px-5 py-3 font-medium text-white transition hover:bg-[#a699cf]"
            type="submit"
          >
            进入管理
          </button>
        </form>
      ) : (
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <AdminList
            items={adminEntries}
            onDelete={(id) => onDelete("entries", id)}
            title="全部封存"
            type="entry"
          />
          <AdminList
            items={adminMessages}
            onDelete={(id) => onDelete("messages", id)}
            title="全部留言"
            type="message"
          />
        </div>
      )}
      <p className="mt-3 text-sm text-[#a986a3]">{adminStatus}</p>
    </section>
  );
}

function AdminList({
  items,
  onDelete,
  title,
  type,
}: {
  items: Array<StoredEntry | StoredMessage>;
  onDelete: (id: string) => void;
  title: string;
  type: "entry" | "message";
}) {
  return (
    <div>
      <h3 className="font-semibold text-[#756a8a]">{title}</h3>
      <div className="mt-3 space-y-3">
        {items.length === 0 ? (
          <p className="rounded-lg bg-[#f5edf8]/80 p-4 text-sm text-[#7b7481]">
            暂时没有内容。
          </p>
        ) : (
          items.map((item) => (
            <article className="rounded-lg border border-[#ead8e5] bg-[#fffafd] p-4" key={item.id}>
              <div className="mb-2 flex items-center justify-between gap-2 text-sm text-[#a986a3]">
                <span>
                  {type === "entry"
                    ? (item as StoredEntry).mood
                    : (item as StoredMessage).nickname}
                </span>
                <time>{formatDate(item.createdAt)}</time>
              </div>
              <p className="leading-7">
                {type === "entry"
                  ? (item as StoredEntry).content
                  : (item as StoredMessage).content}
              </p>
              <button
                className="mt-3 rounded-lg border border-[#efc8d2] px-3 py-2 text-sm text-[#9c5f72] transition hover:bg-[#fdeff3]"
                onClick={() => onDelete(item.id)}
                type="button"
              >
                删除
              </button>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
