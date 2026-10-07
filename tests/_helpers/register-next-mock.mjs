// 测试夹具：拦截 next/headers；并为无扩展名的项目内相对导入补 .ts（Next 允许，node ESM 不允许）。
// 必须在被测路由模块“动态 import 之前”完成 registerHooks。
import { AsyncLocalStorage } from "node:async_hooks";
import { registerHooks } from "node:module";

export const requestStorage = new AsyncLocalStorage();

const mockUrl = new URL("./next-headers-mock.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/headers") {
      return { url: mockUrl, shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const code = error && error.code;
      const isRelative =
        specifier.startsWith(".") || specifier.startsWith("/");
      if (code === "ERR_MODULE_NOT_FOUND" && isRelative && context.parentURL) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
