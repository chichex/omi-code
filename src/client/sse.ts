// Lector de Server-Sent Events sobre el body de fetch.

export interface SseFrame {
	event: string | undefined;
	data: string;
}

function parseFrame(raw: string): SseFrame | null {
	let event: string | undefined;
	const data: string[] = [];
	for (const line of raw.split("\n")) {
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
	}
	return data.length === 0 ? null : { event, data: data.join("\n") };
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true });
			for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
				const frame = parseFrame(buffer.slice(0, end));
				buffer = buffer.slice(end + 2);
				if (frame !== null) yield frame;
			}
		}
	} finally {
		// Cerrar el reader corta la conexión si el caller dejó de leer antes del fin.
		await reader.cancel().catch(() => undefined);
	}
}
