// HTTP 错误与异步处理器的公共件。服务函数算出结果后只有两种出路：返回结果，
// 或者抛 HttpError；由 asyncHandler 统一翻译成响应，业务层不再自己碰 req/res。
// 翻译约定：返回普通值 => res.json(value)（200）；返回 RawResponse => 按它的状态码与头发送；
// 抛 HttpError => res.status(status).json({ code, message, error, ...extra })；
// 返回 undefined 或自己写了 res => 不发任何东西；其它异常 => 500。

class HttpError extends Error {
  // error 是响应体里 error 键上的原值，通常是字符串，也可能是结构化对象。OpenAI 兼容的
  // 端点会返回结构化对象，那时必须原样保留，压成字符串就变了形状。
  constructor(status, error, extra, headers) {
    super(typeof error === "string" ? error : String(error));
    this.name = "HttpError";
    this.status = status;
    this.error = error; // 原值（字符串或对象），响应体直接用它
    this.extra = (extra && typeof extra === "object") ? extra : {};
    // 可选的响应头（例如 503 上的 Retry-After）。不传时不额外设任何头。
    this.headers = (headers && typeof headers === "object") ? headers : null;
  }
}

// 非 JSON 的成功响应（二进制或流式）。服务函数返回它而不是自己写 res，
// 于是服务函数不必认识 req/res。
class RawResponse {
  constructor({ status = 200, headers = {}, body } = {}) {
    this.status = status;
    this.headers = headers || {};
    this.body = body;
  }
}

// 把服务函数包成 Express 处理函数。fn 是 async (req, res) => result；
// format500 是可选的 (err) => string，保住调用方的 500 文案格式。
function asyncHandler(fn, format500) {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .then((result) => {
        if (res.headersSent) return;
        if (result === undefined) return;
        if (result instanceof RawResponse) {
          res.status(result.status);
          for (const [k, v] of Object.entries(result.headers)) res.set(k, v);
          return res.send(result.body);
        }
        res.json(result);
      })
      .catch((err) => {
        if (res.headersSent) return;
        if (err instanceof HttpError) {
          const body = (err.error !== undefined) ? err.error : err.message;
          if (err.headers) { for (const [k, v] of Object.entries(err.headers)) res.set(k, v); }
          const message = typeof body === "string" ? body : (body && body.message) || String(body);
          const code = err.extra.code || (body && body.code) || "REQUEST_FAILED";
          return res.status(err.status).json({ code, message, error: body, ...err.extra });
        }
        const msg = typeof format500 === "function"
          ? format500(err)
          : (err && err.message ? err.message : String(err));
        return res.status(500).json({ code: "INTERNAL_ERROR", message: msg, error: msg });
      });
  };
}

module.exports = { HttpError, asyncHandler, RawResponse };
