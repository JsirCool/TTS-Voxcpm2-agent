import { getServices } from "@/lib/factory";
import { handleError } from "../../../_http";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { export: exportSvc } = getServices();
    const body = await request.json();
    const targetDir = body?.targetDir as string | undefined;
    if (!targetDir) {
      return new Response(
        JSON.stringify({ error: "invalid_input", message: "targetDir required" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const result = await exportSvc.exportTo(id, targetDir);
    return Response.json(result);
  } catch (e) {
    return handleError(e);
  }
}
