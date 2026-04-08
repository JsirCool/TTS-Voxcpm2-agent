import { getServices } from "@/lib/factory";
import { handleError } from "../../_http";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { episodes, logs, progress } = getServices();
    const ep = await episodes.get(id);
    if (!ep) {
      return new Response(
        JSON.stringify({ error: "not_found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    const [logTail, running, currentStage] = await Promise.all([
      logs.tail(id, 100),
      progress.isRunning(id),
      progress.getCurrentStage(id),
    ]);
    return Response.json({
      episode: { ...ep, currentStage },
      logTail,
      running,
      currentStage,
    });
  } catch (e) {
    return handleError(e);
  }
}
