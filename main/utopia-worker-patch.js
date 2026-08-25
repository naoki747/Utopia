(() => {
  "use strict";

  /*
   * 二重実行を防止する。
   */
  if (window.__utopiaWorkerPatchInstalled) {
    return;
  }

  window.__utopiaWorkerPatchInstalled = true;

  const NativeWorker = window.Worker;
  const NativeSharedWorker = window.SharedWorker;

  if (typeof NativeWorker !== "function") {
    console.error(
      "[Utopia Worker Patch] Native Worker is unavailable.",
    );

    return;
  }

  /*
   * __uv$configが利用可能になるまで待つ。
   *
   * HTMLのhead先頭へ注入するため、
   * パッチ実行時点でuv.config.jsがまだ未実行の可能性がある。
   */
  function waitForUvConfig(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();

      const timer = setInterval(() => {
        const config = window.__uv$config;

        const isReady =
          config &&
          typeof config.prefix === "string" &&
          typeof config.encodeUrl === "function" &&
          typeof config.decodeUrl === "function";

        if (isReady) {
          clearInterval(timer);
          resolve(config);
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);

          reject(
            new Error(
              "__uv$config did not become available.",
            ),
          );
        }
      }, 10);
    });
  }

  /*
   * 現在のUtopia URLから元のBloxd URLを復元する。
   */
  function getOriginalPageUrl(config) {
    try {
      const currentUrl = new URL(
        window.location.href,
      );

      const prefixIndex =
        currentUrl.pathname.indexOf(
          config.prefix,
        );

      if (prefixIndex === -1) {
        return null;
      }

      const encodedPart =
        currentUrl.pathname.slice(
          prefixIndex + config.prefix.length,
        );

      if (!encodedPart) {
        return null;
      }

      const decodedUrl =
        config.decodeUrl(encodedPart);

      if (
        typeof decodedUrl !== "string" ||
        !/^https?:\/\//i.test(decodedUrl)
      ) {
        return null;
      }

      /*
       * 通常はdecodeUrlの結果に元のクエリも含まれる。
       * そのため現在のUtopia側searchは追加しない。
       */
      return new URL(decodedUrl);
    } catch (error) {
      console.warn(
        "[Utopia Worker Patch] Original page URL decode failed:",
        error,
      );

      return null;
    }
  }

  /*
   * 渡されたWorker URLを元サイト基準の絶対URLへ変換する。
   */
  function resolveOriginalWorkerUrl(
    input,
    config,
  ) {
    const stringUrl =
      input instanceof URL
        ? input.href
        : String(input);

    /*
     * Blob Workerとdata Workerはそのまま使う。
     */
    if (
      stringUrl.startsWith("blob:") ||
      stringUrl.startsWith("data:")
    ) {
      return stringUrl;
    }

    const originalPageUrl =
      getOriginalPageUrl(config);

    if (originalPageUrl) {
      return new URL(
        stringUrl,
        originalPageUrl,
      ).href;
    }

    /*
     * 元URLを取得できなかった場合のフォールバック。
     */
    return new URL(
      stringUrl,
      window.location.href,
    ).href;
  }

  /*
   * 元サイトのWorker URLを/service/ URLへ変換する。
   */
  function createProxiedWorkerUrl(
    input,
    config,
  ) {
    const resolvedUrl =
      resolveOriginalWorkerUrl(
        input,
        config,
      );

    /*
     * BlobとdataはURLエンコードしない。
     */
    if (
      resolvedUrl.startsWith("blob:") ||
      resolvedUrl.startsWith("data:")
    ) {
      return {
        original: String(input),
        resolved: resolvedUrl,
        proxied: resolvedUrl,
      };
    }

    const resolved = new URL(resolvedUrl);

    /*
     * すでにUtopiaの/service/配下なら、
     * 二重にエンコードしない。
     */
    if (
      resolved.origin ===
        window.location.origin &&
      resolved.pathname.startsWith(
        config.prefix,
      )
    ) {
      return {
        original: String(input),
        resolved: resolved.href,
        proxied: resolved.href,
      };
    }

    const proxied =
      window.location.origin +
      config.prefix +
      config.encodeUrl(resolved.href);

    return {
      original: String(input),
      resolved: resolved.href,
      proxied,
    };
  }

  /*
   * Workerオプションをコピーする。
   */
  function normalizeWorkerOptions(options) {
    if (
      options === undefined ||
      options === null
    ) {
      return undefined;
    }

    /*
     * 元オブジェクトを直接変更しない。
     */
    return {
      ...options,
    };
  }

  /*
   * UV設定を同期的に取得する。
   *
   * Workerコンストラクタ自体は同期APIなので、
   * constructor内でawaitは使えない。
   */
  function getUvConfigSynchronously() {
    const config = window.__uv$config;

    if (
      !config ||
      typeof config.prefix !== "string" ||
      typeof config.encodeUrl !== "function" ||
      typeof config.decodeUrl !== "function"
    ) {
      return null;
    }

    return config;
  }

  /*
   * Workerコンストラクタを置き換える。
   */
  class UtopiaWorker extends NativeWorker {
    constructor(url, options) {
      const config =
        getUvConfigSynchronously();

      if (!config) {
        console.warn(
          "[Utopia Worker Patch] Worker was created before __uv$config became available:",
          {
            url: String(url),
            options,
          },
        );

        /*
         * UV設定がない状態では、勝手な変換をしない。
         */
        super(url, options);
        return;
      }

      let result;

      try {
        result = createProxiedWorkerUrl(
          url,
          config,
        );
      } catch (error) {
        console.error(
          "[Utopia Worker Patch] Worker URL rewrite failed:",
          {
            url: String(url),
            options,
            error,
          },
        );

        super(url, options);
        return;
      }

      const workerOptions =
        normalizeWorkerOptions(options);

      console.info(
        "[Utopia Worker Patch] Worker URL rewritten:",
        {
          original: result.original,
          resolved: result.resolved,
          proxied: result.proxied,
          options: workerOptions,
        },
      );

      super(
        result.proxied,
        workerOptions,
      );

      this.addEventListener(
        "error",
        event => {
          console.error(
            "[Utopia Worker Patch] Worker error:",
            {
              originalUrl:
                result.original,
              resolvedUrl:
                result.resolved,
              proxiedUrl:
                result.proxied,
              options:
                workerOptions,
              message:
                event.message || null,
              filename:
                event.filename || null,
              line:
                event.lineno || null,
              column:
                event.colno || null,
              event,
            },
          );
        },
      );

      this.addEventListener(
        "messageerror",
        event => {
          console.error(
            "[Utopia Worker Patch] Worker message error:",
            {
              originalUrl:
                result.original,
              proxiedUrl:
                result.proxied,
              event,
            },
          );
        },
      );
    }
  }

  /*
   * Workerの静的プロパティや継承関係を
   * できるだけ元のWorkerへ合わせる。
   */
  try {
    Object.setPrototypeOf(
      UtopiaWorker,
      NativeWorker,
    );
  } catch (error) {
    console.warn(
      "[Utopia Worker Patch] Failed to copy Worker constructor prototype:",
      error,
    );
  }

  window.Worker = UtopiaWorker;

  /*
   * SharedWorkerも同じ方法で修正する。
   */
  if (
    typeof NativeSharedWorker === "function"
  ) {
    class UtopiaSharedWorker extends NativeSharedWorker {
      constructor(url, options) {
        const config =
          getUvConfigSynchronously();

        if (!config) {
          console.warn(
            "[Utopia Worker Patch] SharedWorker was created before __uv$config became available:",
            {
              url: String(url),
              options,
            },
          );

          super(url, options);
          return;
        }

        let result;

        try {
          result =
            createProxiedWorkerUrl(
              url,
              config,
            );
        } catch (error) {
          console.error(
            "[Utopia Worker Patch] SharedWorker URL rewrite failed:",
            {
              url: String(url),
              options,
              error,
            },
          );

          super(url, options);
          return;
        }

        console.info(
          "[Utopia Worker Patch] SharedWorker URL rewritten:",
          result,
        );

        super(
          result.proxied,
          normalizeWorkerOptions(options),
        );
      }
    }

    try {
      Object.setPrototypeOf(
        UtopiaSharedWorker,
        NativeSharedWorker,
      );
    } catch (error) {
      console.warn(
        "[Utopia Worker Patch] Failed to copy SharedWorker constructor prototype:",
        error,
      );
    }

    window.SharedWorker =
      UtopiaSharedWorker;
  }

  /*
   * ConsoleからURL変換をテストできる関数。
   */
  window.__utopiaTestWorkerUrl = input => {
    const config =
      getUvConfigSynchronously();

    if (!config) {
      throw new Error(
        "__uv$config is unavailable.",
      );
    }

    return createProxiedWorkerUrl(
      input,
      config,
    );
  };

  waitForUvConfig()
    .then(config => {
      console.info(
        "[Utopia Worker Patch] Installed:",
        {
          prefix: config.prefix,
          originalPage:
            getOriginalPageUrl(config)
              ?.href || null,
        },
      );
    })
    .catch(error => {
      console.error(
        "[Utopia Worker Patch] UV configuration error:",
        error,
      );
    });
})();