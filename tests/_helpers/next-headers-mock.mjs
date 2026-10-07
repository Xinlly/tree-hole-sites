// next/headers 替身：cookies() 读取 AsyncLocalStorage 中的请求存储
import { requestStorage } from "./register-next-mock.mjs";

export async function cookies() {
  const store = requestStorage.getStore();
  if (!store) {
    throw new Error("cookies() can only be called inside a request scope");
  }
  return {
    get(name) {
      const value = store.jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    // 支持两种调用：set(name, value) 与 Next 的 set({name, value, ...})
    set(arg1, arg2) {
      const name = typeof arg1 === "object" ? arg1.name : arg1;
      const rawValue = typeof arg1 === "object" ? arg1.value : arg2;
      const value = rawValue === undefined ? "" : rawValue;
      // 真实 Next：置空串 + maxAge:0 表示删除
      if (value === "") {
        store.jar.delete(name);
      } else {
        store.jar.set(name, value);
      }
      store.setCookies.push({ name, value });
    },
  };
}
