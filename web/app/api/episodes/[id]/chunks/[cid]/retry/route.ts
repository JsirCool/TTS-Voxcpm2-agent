import { getServices } from "@/lib/factory";
import { handleError } from "../../../../../_http";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; cid: string }> },
) {
  try {
    const { id, cid } = await params;
    const { runner } = getServices();
    const url = new URL(request.url);
    const qCount = url.searchParams.get("count");
    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {}
    const count = Number(qCount ?? body?.count ?? 1);
    if (!Number.isFinite(count) || count < 1 || count > 16) {
      return new Response(
        JSON.stringify({
          error: "invalid_input",
          message: "count must be 1..16",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const result = await runner.retryChunk(id, cid, {
      count,
      params: (body?.params as Record<string, unknown>) ?? undefined,
    });
    return Response.json(result);
  } catch (e) {
    return handleError(e);
  }
}
