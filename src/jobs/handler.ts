// Handler de un job: plantillas y chequeo estático del POST firmado por el disparador.

import { HEADER_SIGNATURE, HEADER_TIMESTAMP } from "../protocol/constants.ts";
import { ENV_TRIGGER_SECRET } from "../protocol/constants.ts";

export type HandlerLanguage = "go" | "ts" | "python";

interface Rule {
	label: string;
	pattern: RegExp;
}

const SECRET_RULE: Rule = { label: ENV_TRIGGER_SECRET, pattern: new RegExp(ENV_TRIGGER_SECRET) };
const TIMESTAMP_RULE: Rule = { label: HEADER_TIMESTAMP, pattern: /x-omi-timestamp/i };
const SIGNATURE_RULE: Rule = { label: HEADER_SIGNATURE, pattern: /x-omi-signature/i };

const RULES: Record<HandlerLanguage, readonly Rule[]> = {
	go: [
		SECRET_RULE,
		{ label: "trigger.Verify o HMAC-SHA256 con hmac.Equal", pattern: /trigger\.Verify\(|hmac\.Equal\(/ },
		{ label: `${HEADER_TIMESTAMP} y ${HEADER_SIGNATURE}`, pattern: /trigger\.HeaderSignature|X-Omi-Signature/ },
		{ label: "antigüedad de X-Omi-Timestamp", pattern: /time\.Now\(\)\.Unix\(\)[\s\S]*timestamp\s*<\s*now\s*-\s*300/ },
	],
	ts: [
		SECRET_RULE,
		TIMESTAMP_RULE,
		SIGNATURE_RULE,
		{ label: "HMAC-SHA256 (createHmac)", pattern: /createHmac\(\s*["']sha256["']/ },
		{ label: "comparación en tiempo constante (timingSafeEqual)", pattern: /timingSafeEqual/ },
		{ label: "antigüedad de X-Omi-Timestamp", pattern: /Math\.abs\([\s\S]*Date\.now\(\)[\s\S]*>\s*300/ },
	],
	python: [
		SECRET_RULE,
		TIMESTAMP_RULE,
		SIGNATURE_RULE,
		{ label: "HMAC-SHA256 (hmac.new con sha256)", pattern: /hmac\.new\([\s\S]*sha256/ },
		{ label: "comparación en tiempo constante (hmac.compare_digest)", pattern: /compare_digest/ },
		{ label: "antigüedad de X-Omi-Timestamp", pattern: /abs\(time\.time\(\)[\s\S]*>\s*300/ },
	],
};

/** Chequeo estático orientativo: exige firma y ventana temporal, no prueba su implementación. */
export function checkHandler(source: string, language: HandlerLanguage): string[] {
	return RULES[language].filter((rule) => !rule.pattern.test(source)).map((rule) => rule.label);
}

export function languageOf(file: string): HandlerLanguage | null {
	if (file.endsWith(".go")) return "go";
	if (file.endsWith(".py")) return "python";
	return /\.[cm]?[jt]sx?$/.test(file) ? "ts" : null;
}

export function handlerTemplate(language: HandlerLanguage, path: string): string {
	return TEMPLATES[language](path);
}

const TEMPLATES: Record<HandlerLanguage, (path: string) => string> = {
	go: (path) => `package main

import (
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/chichex/omi/trigger"
)

// Registrar con mux.HandleFunc("POST ${path}", handleJob).
func handleJob(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "cuerpo ilegible", http.StatusBadRequest)
		return
	}
	timestamp, err := strconv.ParseInt(r.Header.Get(trigger.HeaderTimestamp), 10, 64)
	now := time.Now().Unix()
	if err != nil || timestamp < now-300 || timestamp > now+300 {
		http.Error(w, "timestamp inválido o vencido", http.StatusUnauthorized)
		return
	}
	secret := []byte(os.Getenv("${ENV_TRIGGER_SECRET}"))
	if !trigger.Verify(secret, r.Header.Get(trigger.HeaderTimestamp), body, r.Header.Get(trigger.HeaderSignature)) {
		http.Error(w, "firma inválida", http.StatusUnauthorized)
		return
	}
	// Tu job acá. Un 2xx marca la corrida como exitosa.
	w.WriteHeader(http.StatusNoContent)
}
`,
	ts: (path) => `// Handler de POST ${path}. Pasá el cuerpo crudo, antes de parsearlo.
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyOmiJob(headers: Record<string, string | undefined>, rawBody: Buffer): boolean {
	const secret = process.env.${ENV_TRIGGER_SECRET} ?? "";
	const timestamp = headers["x-omi-timestamp"] ?? "";
	const signature = headers["x-omi-signature"] ?? "";
	if (secret === "" || !signature.startsWith("sha256=") || !/^\\d+$/.test(timestamp)) return false;
	const seconds = Number(timestamp);
	if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(Date.now() / 1000) - seconds) > 300) return false;
	const expected = \`sha256=\${createHmac("sha256", secret).update(\`\${timestamp}.\`).update(rawBody).digest("hex")}\`;
	const received = Buffer.from(signature);
	const computed = Buffer.from(expected);
	return received.length === computed.length && timingSafeEqual(received, computed);
}
`,
	python: (path) => `# Handler de POST ${path}. Pasá el cuerpo crudo, antes de parsearlo.
import hashlib
import hmac
import os
import time


def verify_omi_job(headers, raw_body: bytes) -> bool:
    secret = os.environ.get("${ENV_TRIGGER_SECRET}", "").encode()
    timestamp = headers.get("X-Omi-Timestamp", "")
    signature = headers.get("X-Omi-Signature", "")
    if not secret or not signature.startswith("sha256=") or not timestamp.isascii() or not timestamp.isdecimal() or len(timestamp) > 19:
        return False
    if abs(time.time() - int(timestamp)) > 300:
        return False
    mac = hmac.new(secret, f"{timestamp}.".encode() + raw_body, hashlib.sha256)
    return hmac.compare_digest("sha256=" + mac.hexdigest(), signature)
`,
};
