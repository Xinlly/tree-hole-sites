import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pageSource = await readFile(path.join(root, "app/page.tsx"), "utf8");
const layoutSource = await readFile(path.join(root, "app/layout.tsx"), "utf8");

test("home page keeps the password gate markup", () => {
  assert.match(pageSource, /<main className="min-h-screen bg-\[#f8eef4\] text-\[#5d5868\]">/);
  assert.match(pageSource, /输入密码/);
  assert.match(pageSource, /进入树洞/);
});

test("home page keeps the tree hole interaction surface", () => {
  assert.match(pageSource, /封存这一刻/);
  assert.match(pageSource, /留给我/);
  assert.match(pageSource, /树洞回声/);
});

test("layout keeps the Chinese title 嘟", () => {
  // 标准 Next 无 worker 渲染：原 <title>嘟</title> 渲染断言改为对 layout metadata 的静态源码断言。
  assert.match(layoutSource, /title:\s*"嘟"/);
});

test("page includes positive moods first, bright Morandi copy, companion art, and admin mode", () => {
  const page = pageSource;

  assert.match(page, /嘟/);
  assert.ok(page.indexOf("愉悦") < page.indexOf("低落"));
  assert.ok(page.indexOf("幸福") < page.indexOf("低落"));
  assert.match(page, /想对我说什么/);
  assert.match(page, /管理者查看/);
  assert.match(page, /morandi-companions\.png/);
  assert.match(page, /浅粉/);
  assert.match(page, /浅紫/);
  assert.match(page, /浅蓝/);
  assert.doesNotMatch(page, /涓|鎶|鏍戞礊|�/);
});
