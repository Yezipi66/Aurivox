// ===========================
//  HTTP ERROR + ASYNC HANDLER
// ===========================
// Small infrastructure for the Stage-2 "thin handler / service" pattern. A
// service function computes a result and either RETURNS a result (a JSON-
// serialisable value sent as 200, or a RawResponse for binary/streaming
// replies) or THROWS an HttpError(status, error, extra) for any error response.
// asyncHandler adapts such a service into an Express handler and centralises
// error translation, so handlers stop threading req/res through deep business
// logic.
//
// Translation contract (matches the previous inline handlers byte-for-byte):
//   throw new HttpError(s, err, extra)  ->  res.status(s).json({ error: err, ...extra })
//       (err may be a string OR an object — the original value is preserved)
//   return <json value>                 ->  res.json(value)               (200)
//   return new RawResponse({...})        ->  res.status().set(headers).send(body)
//   return undefined / write to res      ->  asyncHandler sends nothing
//   uncaught non-HttpError err           ->  res.status(500).json({ error: format500(err) })

class HttpError extends Error {
  // `error` is the value placed under the JSON `error` key. It is usually a
  // string, but some OpenAI-compatible endpoints return a structured object
  // (e.g. { message, type, code, ... }); that object is preserved verbatim.
  constructor(status, error, extra) {
    super(typeof error === "string" ? error : String(error));
    this.name = "HttpError";
    this.status = status;
    this.error = error; // original value (string OR object), preserved for the body
    this.extra = (extra && typeof extra === "object") ? extra : {};
  }
}

// Descriptor for a non-JSON (binary/streaming) success response. A service
// returns one instead of touching res, keeping it free of req/res. Headers are
// applied in insertion order.
class RawResponse {
  constructor({ status = 200, headers = {}, body } = {}) {
    this.status = status;
    this.headers = headers || {};
    this.body = body;
  }
}

// fn: async (req, res) => result | throws. Return values:
//   - a RawResponse -> sent via res.status().set().send()
//   - any other defined value -> sent via res.json()
//   - undefined (or fn writes to res itself) -> asyncHandler sends nothing
// format500: optional (err) => string, used for the generic 500 fallback so the
// app's clientError() formatting is preserved.
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
          return res.status(err.status).json({ error: body, ...err.extra });
        }
        const msg = typeof format500 === "function"
          ? format500(err)
          : (err && err.message ? err.message : String(err));
        return res.status(500).json({ error: msg });
      });
  };
}

module.exports = { HttpError, asyncHandler, RawResponse };
