export function encodeComponent(s: string): string {
  return encodeURIComponent(s);
}

export function decodeComponent(s: string): { ok: true; value: string } | { ok: false; message: string } {
  try {
    return { ok: true, value: decodeURIComponent(s) };
  } catch {
    return { ok: false, message: "Malformed percent-encoding" };
  }
}

export interface QueryParam {
  key: string;
  value: string;
}

export interface UrlParts {
  protocol: string; // without the colon
  username: string;
  password: string;
  hostname: string;
  port: string;
  pathname: string;
  hash: string; // without the #
  params: QueryParam[];
}

function decodeSafe(s: string): string {
  const r = decodeComponent(s);
  return r.ok ? r.value : s;
}

export function parseUrl(text: string): { ok: true; parts: UrlParts } | { ok: false; message: string } {
  const t = text.trim();
  if (!t) return { ok: false, message: "Enter a URL" };
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return { ok: false, message: "Not a valid absolute URL (include the scheme, e.g. https://)" };
  }
  return {
    ok: true,
    parts: {
      protocol: u.protocol.replace(/:$/, ""),
      username: decodeSafe(u.username),
      password: decodeSafe(u.password),
      hostname: u.hostname,
      port: u.port,
      pathname: u.pathname,
      hash: u.hash.replace(/^#/, ""),
      params: [...u.searchParams.entries()].map(([key, value]) => ({ key, value })),
    },
  };
}

export function buildQuery(params: readonly QueryParam[]): string {
  return params
    .filter((p) => p.key !== "" || p.value !== "")
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join("&");
}

export function buildUrl(p: UrlParts): string {
  const auth = p.username ? `${encodeURIComponent(p.username)}${p.password ? ":" + encodeURIComponent(p.password) : ""}@` : "";
  const host = p.hostname.includes(":") && !p.hostname.startsWith("[") ? `[${p.hostname}]` : p.hostname;
  const port = p.port ? `:${p.port}` : "";
  const q = buildQuery(p.params);
  const path = p.pathname || (host ? "/" : "");
  return `${p.protocol}://${auth}${host}${port}${path}${q ? "?" + q : ""}${p.hash ? "#" + p.hash : ""}`;
}
