import { getServices } from "@/lib/factory";
import { handleError } from "../_http";

export async function GET() {
  try {
    const { episodes } = getServices();
    const list = await episodes.list();
    return Response.json({ episodes: list });
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(request: Request) {
  try {
    const { episodes } = getServices();
    const contentType = request.headers.get("content-type") ?? "";

    let id: string | null = null;
    let scriptJson: unknown = null;

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      id = (form.get("id") as string | null) ?? null;
      const file = form.get("script") as File | null;
      if (!file) {
        return new Response(
          JSON.stringify({ error: "invalid_input", message: "script file required" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const text = await file.text();
      scriptJson = JSON.parse(text);
    } else {
      const body = await request.json();
      id = body.id;
      scriptJson = body.script;
    }

    if (!id) {
      return new Response(
        JSON.stringify({ error: "invalid_input", message: "id required" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const ep = await episodes.create(id, scriptJson);
    return Response.json({ episode: ep }, { status: 201 });
  } catch (e) {
    return handleError(e);
  }
}
