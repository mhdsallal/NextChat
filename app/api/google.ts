import { NextRequest, NextResponse } from "next/server";
import { auth } from "./auth";
import { getServerSideConfig } from "@/app/config/server";
import { ApiPath, GEMINI_BASE_URL, ModelProvider } from "@/app/constant";
import { prettyObject } from "@/app/utils/format";

// Module-level singleton — avoids re-running on every request
const serverConfig = getServerSideConfig();

// Normalize base URL once, not on every request
const BASE_URL = (() => {
  let url = serverConfig.googleUrl || GEMINI_BASE_URL;
  if (!url.startsWith("http")) url = `https://${url}`;
  if (url.endsWith("/")) url = url.slice(0, -1);
  return url;
})();

const TIMEOUT_MS = 10 * 60 * 1000;

function extractApiKey(req: NextRequest): string {
  const raw = req.headers.get("x-goog-api-key")
    ?? req.headers.get("Authorization")
    ?? "";
  return raw.trim().replace(/^Bearer\s+/i, "").trim();
}

export async function handle(
  req: NextRequest,
  { params }: { params: { provider: string; path: string[] } },
) {
  if (req.method === "OPTIONS") {
    return new NextResponse(null, { status: 204 }); // 204 is correct for OPTIONS
  }

  const authResult = auth(req, ModelProvider.GeminiPro);
  if (authResult.error) {
    return NextResponse.json(authResult, { status: 401 });
  }

  const token = extractApiKey(req);
  const apiKey = token || serverConfig.googleApiKey;

  if (!apiKey) {
    return NextResponse.json(
      { error: true, message: "missing GOOGLE_API_KEY in server env vars" },
      { status: 401 },
    );
  }

  try {
    return await proxyRequest(req, apiKey);
  } catch (e) {
    console.error("[Google]", e);
    return NextResponse.json(prettyObject(e), { status: 502 });
  }
}

export const GET = handle;
export const POST = handle;
export const runtime = "edge";
export const preferredRegion = [
  "bom1", "cle1", "cpt1", "gru1", "hnd1",
  "iad1", "icn1", "kix1", "pdx1", "sfo1", "sin1", "syd1",
];

async function proxyRequest(req: NextRequest, apiKey: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const path = req.nextUrl.pathname.replace(ApiPath.Google, "");
  const isSSE = req.nextUrl.searchParams.get("alt") === "sse";
  const fetchUrl = `${BASE_URL}${path}${isSSE ? "?alt=sse" : ""}`;

  const fetchOptions: RequestInit = {
    method: req.method,
    body: req.body,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "x-goog-api-key": apiKey, // already resolved — no need to re-read headers
    },
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  try {
    const res = await fetch(fetchUrl, fetchOptions);
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    newHeaders.set("X-Accel-Buffering", "no");

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
