// src/framework/pick-request/server.js
// The Node side of request-a-pick: an http+SSE server holding one active batch,
// a blocking CLI client (requestPicks), and CLI output formatting. 127.0.0.1 only.
//
// Threat model. While this is listening, any page the developer visits can reach
// http://127.0.0.1:<port> from their browser. Everything here exists to make that
// harmless:
//   * a per-process bearer token gates every route (the browser gets it through the
//     app URL, the CLI through ~/.partforge/pick-<port>.token),
//   * Origin is never reflected unless it is loopback, and `*` is never emitted, so
//     a foreign page cannot read the SSE stream or any response,
//   * Host must name loopback, so a rebound DNS name pointing at 127.0.0.1 is refused,
//   * bodies are capped, and
//   * /resolve payloads are shape-checked and stripped of control characters before
//     they can reach the agent's stdout — that print is a prompt-injection channel.
import { createServer, request as httpRequest } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createBatch, view, resolve, cancel, timeout, result } from "./batch.js";
import { formatSelection } from "../selection/format.js";
import {
  PICK_SERVER_DEFAULT_PORT, PICK_SERVER_DEFAULT_TIMEOUT_MS, PICK_SERVER_DEFAULT_HOST,
  isLoopbackOrigin, isLoopbackHost,
} from "./endpoint.js";

export { PICK_SERVER_DEFAULT_PORT, PICK_SERVER_DEFAULT_TIMEOUT_MS } from "./endpoint.js";

const MAX_BODY_BYTES = 256 * 1024;   // no route needs more; anything bigger is abuse
const MAX_SELECTION_CHARS = 16 * 1024;
const MAX_STRING_CHARS = 512;
const MAX_PARAM_KEYS = 200;
const MAX_PROMPTS = 32;
const MAX_PROMPT_CHARS = 2000;

// Control characters (plus the Unicode line separators) are what let injected text
// forge extra CLI lines in the agent's stdout. Fold them to spaces rather than drop
// them, so "a\nb" cannot silently become the single token "ab".
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
export const sanitizeText = (s, max = MAX_STRING_CHARS) =>
  String(s).replace(CONTROL_CHARS, " ").slice(0, max);

export function mintPickToken() {
  return randomBytes(32).toString("base64url");
}

const tokenMatches = (given, expected) => {
  const a = Buffer.from(typeof given === "string" ? given : "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// EventSource cannot set headers, so the token must also be accepted in the query
// string; POSTs prefer a header. Both are equally secret — the URL never leaves the
// machine.
const tokenFrom = (req, query) => {
  const header = req.headers["x-pick-token"];
  if (typeof header === "string" && header) return header;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return query.get("token") ?? "";
};

const isVec3 = (v) => Array.isArray(v) && v.length === 3
  && v.every((n) => typeof n === "number" && Number.isFinite(n));

// Whitelist the Selection shape resolveSelection() produces. Unknown keys are dropped
// rather than passed through: whatever survives here is printed to the agent, so the
// set of things that can reach it must be closed, not open.
function sanitizeSelection(selection) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    return { error: "selection must be an object" };
  }
  let encoded;
  try { encoded = JSON.stringify(selection); } catch { return { error: "selection is not serialisable" }; }
  if (!encoded || encoded.length > MAX_SELECTION_CHARS) return { error: "selection too large" };
  if (typeof selection.subPart !== "string") return { error: "selection.subPart must be a string" };

  const out = { subPart: sanitizeText(selection.subPart) };
  for (const key of ["point", "normal"]) {
    if (selection[key] === undefined) continue;
    if (!isVec3(selection[key])) return { error: `selection.${key} must be 3 finite numbers` };
    out[key] = [...selection[key]];
  }
  if (selection.params !== undefined) {
    const p = selection.params;
    if (!p || typeof p !== "object" || Array.isArray(p)) return { error: "selection.params must be an object" };
    const keys = Object.keys(p);
    if (keys.length > MAX_PARAM_KEYS) return { error: "selection.params has too many keys" };
    out.params = {};
    for (const k of keys) {
      const v = p[k];
      const ok = (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" || v === null
        || typeof v === "string";
      if (!ok) return { error: `selection.params.${sanitizeText(k, 40)} must be a primitive` };
      out.params[sanitizeText(k, 80)] = typeof v === "string" ? sanitizeText(v) : v;
    }
  }
  if (selection.feature !== undefined) {
    const f = selection.feature;
    if (!f || typeof f !== "object" || Array.isArray(f) || typeof f.label !== "string") {
      return { error: "selection.feature must be { label }" };
    }
    out.feature = { label: sanitizeText(f.label) };
  }
  return { selection: out };
}

function sanitizePrompts(prompts) {
  if (!Array.isArray(prompts) || prompts.length === 0) return { error: "prompts must be a non-empty array" };
  if (prompts.length > MAX_PROMPTS) return { error: "prompts must be a non-empty array of at most 32 strings" };
  if (!prompts.every((p) => typeof p === "string")) return { error: "prompts must be a non-empty array of strings" };
  return { prompts: prompts.map((p) => sanitizeText(p, MAX_PROMPT_CHARS)) };
}

const corsHeaders = (allowOrigin) => (allowOrigin
  // `vary` because the same URL answers differently per Origin — never let a cache
  // hand a foreign page a response minted for the local app.
  ? { "access-control-allow-origin": allowOrigin, vary: "origin" }
  : { vary: "origin" });

const json = (res, code, obj, allowOrigin) => {
  res.writeHead(code, { "content-type": "application/json", ...corsHeaders(allowOrigin) });
  res.end(JSON.stringify(obj));
};

const readBody = (req) => new Promise((resolve_) => {
  let b = "";
  let size = 0;
  let settled = false;
  const settle = (v) => { if (!settled) { settled = true; resolve_(v); } };
  req.on("data", (c) => {
    if (settled) return;
    size += c.length;
    if (size > MAX_BODY_BYTES) { settle({ _tooLarge: true }); return; }
    b += c;
  });
  req.on("end", () => {
    if (!b) { settle({}); return; }
    try { settle(JSON.parse(b)); } catch { settle({ _parseError: true }); }
  });
  req.on("error", () => settle({ _parseError: true }));
});

export function createPickServer({
  port = PICK_SERVER_DEFAULT_PORT,
  timeoutMs = PICK_SERVER_DEFAULT_TIMEOUT_MS,
  token = mintPickToken(),
} = {}) {
  let batch = null;        // the one active batch (or null)
  let pending = null;      // { res, timer, allowOrigin } — the held POST /request response
  const sseClients = new Set();
  const allSockets = new Set(); // track every socket for forceful teardown

  const sse = (event, data) => {
    for (const res of sseClients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const finish = () => {                 // resolve the held /request with the result
    if (pending) {
      clearTimeout(pending.timer);
      json(pending.res, 200, result(batch), pending.allowOrigin);
      pending = null;
    }
    sse("cleared", {});
    batch = null;
  };

  // The body was over the cap. readBody already stopped buffering, so memory is
  // bounded; drain the rest so the 413 reaches the client cleanly instead of being
  // RST'd away by an immediate destroy, and hang up on anyone still streaming after.
  const tooLarge = (req, res, allowOrigin) => {
    req.resume();
    res.writeHead(413, { "content-type": "application/json", connection: "close", ...corsHeaders(allowOrigin) });
    res.end(JSON.stringify({ error: "body too large" }));
    const kill = setTimeout(() => { if (!req.readableEnded) req.destroy(); }, 250);
    kill.unref?.(); // a pending hang-up must never hold the process open
    req.on("end", () => clearTimeout(kill));
  };

  const server = createServer(async (req, res) => {
    const bound = server.address()?.port ?? port;
    // 1. DNS-rebinding guard. A foreign name that resolves to 127.0.0.1 still carries
    //    its own Host, so this refuses the request before any state is touched.
    if (!isLoopbackHost(req.headers.host, bound)) return json(res, 400, { error: "bad host" }, null);

    // 2. Origin. Absent means a native client (the CLI); present must be loopback. An
    //    arbitrary origin is never reflected, and `*` is never emitted.
    const origin = req.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      return json(res, 403, { error: "origin not allowed" }, null);
    }
    const allowOrigin = origin ?? null;

    // 3. Preflight is answered before the token check on purpose: browsers never put
    //    credentials on an OPTIONS, and a 401 here would mask the real error.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...corsHeaders(allowOrigin),
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,authorization,x-pick-token",
        "access-control-max-age": "600",
      });
      return res.end();
    }

    const [path, rawQuery = ""] = req.url.split("?");
    // 4. Token on every route.
    if (!tokenMatches(tokenFrom(req, new URLSearchParams(rawQuery)), token)) {
      return json(res, 401, { error: "unauthorized" }, allowOrigin);
    }

    if (req.method === "POST" && path === "/request") {
      if (batch) return json(res, 409, { status: "busy" }, allowOrigin);
      const body = await readBody(req);
      if (body._tooLarge) return tooLarge(req, res, allowOrigin);
      if (body._parseError) return json(res, 400, { error: "invalid JSON" }, allowOrigin);
      const checked = sanitizePrompts(body.prompts);
      if (checked.error) return json(res, 400, { error: checked.error }, allowOrigin);
      batch = createBatch(checked.prompts);
      pending = { res, allowOrigin, timer: setTimeout(() => { timeout(batch); finish(); }, timeoutMs) };
      // A dropped client (Ctrl-C'd CLI) must free the slot immediately, not wedge
      // every new request behind 409-busy until timeoutMs. Drop `pending` first so
      // finish() never writes to the dead socket. (This also fires after a normal
      // finish(), where `pending` is already null — the guard makes it a no-op.)
      res.on("close", () => {
        if (pending?.res !== res) return;
        clearTimeout(pending.timer);
        pending = null;
        if (batch) { cancel(batch); finish(); }
      });
      sse("prompt", view(batch));
      return; // held open until finish()
    }
    if (req.method === "GET" && path === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive",
        ...corsHeaders(allowOrigin),
      });
      res.write(": connected\n\n"); // SSE comment — flushes headers, makes fetch() resolve
      sseClients.add(res);
      if (batch) res.write(`event: prompt\ndata: ${JSON.stringify(view(batch))}\n\n`); // replay current
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (req.method === "POST" && path === "/resolve") {
      const body = await readBody(req);
      if (body._tooLarge) return tooLarge(req, res, allowOrigin);
      if (body._parseError) return json(res, 400, { error: "invalid JSON" }, allowOrigin);
      const { id, index, selection } = body;
      if (typeof id !== "string" || !Number.isInteger(index) || index < 0) {
        return json(res, 400, { error: "id must be a string and index a non-negative integer" }, allowOrigin);
      }
      const checked = sanitizeSelection(selection);
      if (checked.error) return json(res, 400, { error: checked.error }, allowOrigin);
      if (batch && id === batch.id) {
        resolve(batch, index, checked.selection);
        if (view(batch).status === "collecting") sse("prompt", view(batch));
        else finish();
      }
      return json(res, 200, { ok: true }, allowOrigin);
    }
    if (req.method === "POST" && path === "/cancel") {
      const body = await readBody(req);
      if (body._tooLarge) return tooLarge(req, res, allowOrigin);
      if (body._parseError) return json(res, 400, { error: "invalid JSON" }, allowOrigin);
      const { id } = body;
      if (batch && id === batch.id) { cancel(batch); finish(); }
      return json(res, 200, { ok: true }, allowOrigin);
    }
    return json(res, 404, { error: "not found" }, allowOrigin);
  });

  server.on("connection", (socket) => {
    allSockets.add(socket);
    socket.on("close", () => allSockets.delete(socket));
  });

  return {
    token,
    start: () => new Promise((res_) => server.listen(port, PICK_SERVER_DEFAULT_HOST, () => res_({ port: server.address().port }))),
    stop: () => new Promise((res_) => {
      // If a batch is active, cancel it and resolve the held /request cleanly
      // so any awaiting requestPicks() gets a result instead of a socket hang-up.
      if (batch) { cancel(batch); finish(); }
      for (const c of sseClients) c.end();
      server.close(() => res_());
      // destroy any lingering sockets (SSE keep-alive) so server.close resolves
      for (const s of allSockets) s.destroy();
    }),
  };
}

// CLI client: POST the prompts and await the held response (blocks until the batch
// reaches a terminal status server-side). Fails fast with a hint if nothing answers.
export function requestPicks({
  port = PICK_SERVER_DEFAULT_PORT, host = PICK_SERVER_DEFAULT_HOST, prompts, token,
}) {
  return new Promise((resolve_, reject) => {
    const payload = JSON.stringify({ prompts });
    const req = httpRequest(
      {
        host,
        port,
        path: "/request",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...(token ? { "x-pick-token": token } : {}),
        },
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          if (res.statusCode === 401) {
            reject(new Error(`pick-server on ${host}:${port} rejected the token (start it with \`partforge pick-serve\`, or pass --token)`));
            return;
          }
          try {
            resolve_(JSON.parse(b));
          } catch {
            reject(new Error(`unexpected response from pick-server on ${host}:${port} (is the app open and \`partforge pick-serve\` running?)`));
          }
        });
      },
    );
    req.on("error", (e) => reject(new Error(`could not reach pick-server on ${host}:${port} (is the app open and \`partforge pick-serve\` running?) — ${e.message}`)));
    req.end(payload);
  });
}

// Human-readable CLI output: one summary line per pick, then the raw JSON to parse.
// Every string here originated in the browser, so it is sanitised again on the way
// out — the server already stripped control characters, but this print is the last
// gate before text lands in an agent's context.
export function formatPickResult({ status, picks }) {
  const safePicks = Array.isArray(picks) ? picks : [];
  const lines = [`status: ${sanitizeText(status, 40)} (${safePicks.length} pick${safePicks.length === 1 ? "" : "s"})`];
  for (const { prompt, selection } of safePicks) {
    let summary;
    try {
      if (selection && selection.point && selection.normal && selection.params) {
        summary = formatSelection(selection, { style: "prompt" });
      } else {
        summary = selection?.subPart ?? JSON.stringify(selection);
      }
    } catch {
      summary = JSON.stringify(selection);
    }
    lines.push(`• "${sanitizeText(prompt, MAX_PROMPT_CHARS)}" → ${sanitizeText(summary, MAX_SELECTION_CHARS)}`);
  }
  lines.push("", JSON.stringify({ status, picks }, null, 2));
  return lines.join("\n");
}
