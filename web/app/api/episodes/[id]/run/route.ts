import { getServices } from "@/lib/factory";
import { handleError } from "../../../_http";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { runner } = getServices();
    let options: { mode?: "fresh" | "text-only"; force?: boolean } | undefined;
    try {
      options = await request.json();
    } catch {
      options = undefined;
    }
    const result = await runner.runFull(id, options);
    return Response.json(result);
  } catch (e) {
    return handleError(e);
  }
}
