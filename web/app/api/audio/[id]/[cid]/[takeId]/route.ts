import { createReadStream, statSync } from "fs";
import { Readable } from "stream";
import { getServices } from "@/lib/factory";
import { handleError } from "../../../../_http";

export async function GET(
  _req: Request,
  {
    params,
  }: {
    params: Promise<{ id: string; cid: string; takeId: string }>;
  },
) {
  try {
    const { id, cid, takeId } = await params;
    const { audio } = getServices();
    // special token "current" means "use selected take"
    const resolvedTake = takeId === "current" ? undefined : takeId;
    const filePath = await audio.getTakeFile(id, cid, resolvedTake);
    const stat = statSync(filePath);
    const stream = Readable.toWeb(
      createReadStream(filePath),
    ) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(stat.size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
