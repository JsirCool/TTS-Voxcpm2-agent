import { createReadStream, statSync } from "fs";
import { Readable } from "stream";
import { getServices } from "@/lib/factory";
import { handleError } from "../../_http";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { preview } = getServices();
    const filePath = await preview.getPreviewFile(id);
    const stat = statSync(filePath);
    const stream = Readable.toWeb(
      createReadStream(filePath),
    ) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": String(stat.size),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
