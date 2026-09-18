/*
 * Bloxd proxy service worker
 *
 * 主な処理:
 * 1. Ultraviolet経由でリクエストを取得する
 * 2. BloxdのHTMLへWorker修正スクリプトを注入する
 * 3. Worker JavaScriptとWasmのContent-Typeを補正する
 * 4. Worker関連リクエストをConsoleへ記録する
 */

/*
 * 重要:
 * 現在のarc-sw.jsに別のimportScriptsがある場合は、
 * 下の3行ではなく、既存のimportScriptsを残してください。
 */
importScripts("/uv/uv.bundle.js");
importScripts("/uv/uv.config.js");
importScripts("/uv/uv.sw.js");

/*
 * UVServiceWorkerが読み込めなかった場合に、
 * 原因を分かりやすく表示する。
 */
if (typeof UVServiceWorker !== "function") {
  throw new Error(
    "[Bloxd] UVServiceWorker was not loaded. Check importScripts paths.",
  );
}

const uvServiceWorker = new UVServiceWorker();

/*
 * WorkerやWasmに関係しそうなURLか判定する。
 */
function isWorkerRelatedRequest(request) {
  const url = request.url.toLowerCase();
  const destination = request.destination;

  return (
    destination === "worker" ||
    destination === "sharedworker" ||
    url.includes("worker") ||
    url.includes("mesh") ||
    url.includes("mesher") ||
    url.includes("chunk") ||
    url.includes("terrain") ||
    url.includes(".wasm")
  );
}

/*
 * プロキシURLから元サイトのURLを復元する。
 *
 * 例:
 * https://bloxd.example/service/エンコード済みURL
 *
 * から:
 * https://bloxd.io/play/...
 *
 * を取得する。
 */
function decodeOriginalUrl(requestUrl) {
  try {
    if (
      typeof __uv$config !== "object" ||
      !__uv$config ||
      typeof __uv$config.prefix !== "string" ||
      typeof __uv$config.decodeUrl !== "function"
    ) {
      return null;
    }

    const parsedUrl = new URL(requestUrl);
    const prefix = __uv$config.prefix;
    const prefixIndex = parsedUrl.pathname.indexOf(prefix);

    if (prefixIndex === -1) {
      return null;
    }

    let encodedUrl = parsedUrl.pathname.slice(
      prefixIndex + prefix.length,
    );

    if (!encodedUrl) {
      return null;
    }

    /*
     * パスにクエリが含まれない構成向け。
     * UVのdecodeUrlには基本的にエンコード部分だけを渡す。
     */
    const decodedUrl = __uv$config.decodeUrl(encodedUrl);

    if (
      typeof decodedUrl !== "string" ||
      !/^https?:\/\//i.test(decodedUrl)
    ) {
      return null;
    }

    return decodedUrl;
  } catch (error) {
    console.warn("[Bloxd SW] URL decode failed:", {
      requestUrl,
      error,
    });

    return null;
  }
}

/*
 * リクエスト先がBloxdか確認する。
 */
function isBloxdRequest(request) {
  const originalUrl = decodeOriginalUrl(request.url);

  if (!originalUrl) {
    return false;
  }

  try {
    const hostname = new URL(originalUrl).hostname.toLowerCase();

    return (
      hostname === "bloxd.io" ||
      hostname === "www.bloxd.io" ||
      hostname.endsWith(".bloxd.io")
    );
  } catch {
    return false;
  }
}

/*
 * HTMLレスポンスか判定する。
 */
function isHtmlResponse(response) {
  const contentType =
    response.headers.get("content-type") || "";

  return contentType
    .toLowerCase()
    .includes("text/html");
}

/*
 * Worker修正スクリプトが二重注入されるのを防ぐためのID。
 */
const WORKER_PATCH_ID = "bloxd-worker-url-patch";

/*
 * BloxdのHTMLへWorker修正スクリプトを注入する。
 *
 * Workerが作られる前に実行する必要があるため、
 * <head>の直後へ挿入する。
 */
async function injectWorkerPatch(request, response) {
  if (!response || !response.ok) {
    return response;
  }

  if (!isBloxdRequest(request)) {
    return response;
  }

  if (!isHtmlResponse(response)) {
    return response;
  }

  let html;

  try {
    html = await response.text();
  } catch (error) {
    console.error(
      "[Bloxd SW] Failed to read Bloxd HTML:",
      error,
    );

    return response;
  }

  /*
   * すでに注入されている場合は追加しない。
   */
  if (html.includes(`id="${WORKER_PATCH_ID}"`)) {
    return rebuildTextResponse(response, html);
  }

  const patchTag = [
    `/bloxd-worker-patch.js`,
    `</script>`,
  ].join("");

  /*
   * <head>の開始直後が最優先。
   */
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    html = html.replace(
      /<head(?:\s[^>]*)?>/i,
      match => `${match}\n${patchTag}\n`,
    );
  } else if (/<!doctype[^>]*>/i.test(html)) {
    html = html.replace(
      /<!doctype[^>]*>/i,
      match => `${match}\n${patchTag}\n`,
    );
  } else {
    html = `${patchTag}\n${html}`;
  }

  console.info(
    "[Bloxd SW] Worker patch injected into Bloxd HTML:",
    decodeOriginalUrl(request.url),
  );

  return rebuildTextResponse(response, html);
}

/*
 * 本文を変更したレスポンスを安全に作り直す。
 *
 * 元のContent-LengthやContent-Encodingを残すと、
 * ブラウザが本文を正常に読めない可能性がある。
 */
function rebuildTextResponse(response, body) {
  const headers = new Headers(response.headers);

  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  headers.delete("content-md5");

  headers.set(
    "content-type",
    "text/html; charset=utf-8",
  );

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/*
 * Worker用JavaScriptとWasmのMIMEタイプを補正する。
 */
function fixWorkerMimeType(request, response) {
  if (!response) {
    return response;
  }

  const requestUrl = request.url;
  const lowerUrl = requestUrl.toLowerCase();
  const destination = request.destination;

  const isWorker =
    destination === "worker" ||
    destination === "sharedworker";

  const isJavaScript =
    isWorker ||
    /\.m?js(?:[?#]|$)/i.test(requestUrl);

  const isWasm =
    /\.wasm(?:[?#]|$)/i.test(requestUrl);

  if (!isJavaScript && !isWasm) {
    return response;
  }

  /*
   * 404 HTMLをJavaScript扱いにしても直らないため、
   * 正常レスポンスだけを補正する。
   */
  if (!response.ok) {
    console.error(
      "[Bloxd SW] Worker resource request failed:",
      {
        requestUrl,
        originalUrl: decodeOriginalUrl(requestUrl),
        destination,
        status: response.status,
        contentType:
          response.headers.get("content-type"),
      },
    );

    return response;
  }

  const headers = new Headers(response.headers);
  const oldContentType =
    headers.get("content-type") || "";

  if (isWasm) {
    headers.set(
      "content-type",
      "application/wasm",
    );
  } else if (isJavaScript) {
    /*
     * text/htmlだった場合は、404ページなどがステータス200で
     * 返っている可能性もあるため警告する。
     */
    if (
      oldContentType
        .toLowerCase()
        .includes("text/html")
    ) {
      console.error(
        "[Bloxd SW] A Worker request returned HTML:",
        {
          requestUrl,
          originalUrl: decodeOriginalUrl(requestUrl),
          destination,
          status: response.status,
          contentType: oldContentType,
        },
      );

      /*
       * 中身がHTMLの場合、Content-Typeだけ変えると
       * SyntaxErrorになるため、そのまま返して診断可能にする。
       */
      return response;
    }

    headers.set(
      "content-type",
      "application/javascript; charset=utf-8",
    );
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/*
 * Worker関連リクエストの状態を記録する。
 */
function logWorkerResponse(request, response) {
  if (!isWorkerRelatedRequest(request)) {
    return;
  }

  console.info("[Bloxd SW] Worker-related response:", {
    requestUrl: request.url,
    originalUrl: decodeOriginalUrl(request.url),
    destination: request.destination,
    status: response?.status,
    redirected: response?.redirected,
    responseUrl: response?.url,
    contentType:
      response?.headers?.get("content-type") || null,
    contentLength:
      response?.headers?.get("content-length") || null,
  });
}

/*
 * Service Workerのfetch処理本体。
 */
async function handleProxyRequest(event) {
  const request = event.request;

  try {
    /*
     * /service/配下など、Ultravioletが処理するリクエストは
     * UVServiceWorkerへ渡す。
     */
    let response = await uvServiceWorker.fetch(event);

    logWorkerResponse(request, response);

    /*
     * 先にWorkerやWasmのMIMEを補正する。
     */
    response = fixWorkerMimeType(
      request,
      response,
    );

    /*
     * BloxdのHTMLならWorkerパッチを注入する。
     *
     * injectWorkerPatch内でresponse.text()を使うため、
     * HTMLレスポンスだけが新しいResponseへ変換される。
     */
    response = await injectWorkerPatch(
      request,
      response,
    );

    return response;
  } catch (error) {
    console.error(
      "[Bloxd SW] Proxy request failed:",
      {
        requestUrl: request.url,
        originalUrl: decodeOriginalUrl(
          request.url,
        ),
        destination: request.destination,
        error,
      },
    );

    /*
     * UV側で失敗した場合に直接fetchすると、
     * プロキシを迂回したりCORSで失敗したりするため、
     * 原則として勝手なフォールバックは行わない。
     */
    return new Response(
      [
        "Bloxd proxy request failed.",
        "",
        `URL: ${request.url}`,
        `Error: ${error?.message || String(error)}`,
      ].join("\n"),
      {
        status: 502,
        headers: {
          "content-type":
            "text/plain; charset=utf-8",
        },
      },
    );
  }
}

/*
 * すべてのfetchイベントを処理する。
 */
self.addEventListener("fetch", event => {
  event.respondWith(handleProxyRequest(event));
});

/*
 * 更新したService Workerを早めに有効化する。
 */
self.addEventListener("install", event => {
  console.info("[Bloxd SW] Installing.");

  event.waitUntil(self.skipWaiting());
});

/*
 * 開いているページを新しいService Workerの制御下へ置く。
 */
self.addEventListener("activate", event => {
  console.info("[Bloxd SW] Activated.");

  event.waitUntil(self.clients.claim());
});