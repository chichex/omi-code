// Render del kit de publicación de internal/api/kit.go para una organización de prueba.

export function renderKit(org: string, project: string, service: string, port: number): Record<string, string> {
	const registry = `registry-${org}.ohmyinfra.test`;
	const repository = `${org}/${project}/${service}`;
	const script = [
		"#!/bin/sh",
		"set -eu",
		': "${VERSION:?definí VERSION}"',
		': "${IMAGE_TAR:?definí IMAGE_TAR}"',
		': "${OMI_REGISTRY_PASSWORD:?definí OMI_REGISTRY_PASSWORD}"',
		`REGISTRY="\${REGISTRY:-${registry}}"`,
		'"$regctl_dir/regctl" registry set "$REGISTRY" --tls "$REGISTRY_TLS" --blob-chunk 52428800 --blob-max 52428800 --skip-check',
		`"$regctl_dir/regctl" image import "$REGISTRY/${repository}:$VERSION" "$IMAGE_TAR"`,
	].join("\n");
	const workflow = [
		`# .github/workflows/publicar-${service}.yml`,
		`# Monorepo: el tag ${service}/v1.4.2 publica ${service}:1.4.2. Multi-repo: el tag v1.4.2.`,
		`name: Publicar ${service}`,
		"on:",
		"  push:",
		`    tags: ["${service}/v*", "v*"]`,
		"jobs:",
		"  publicar:",
		"    runs-on: ubuntu-latest",
		"    steps:",
		"      - uses: actions/checkout@v4",
		"      - name: Build con los labels del contrato",
		"        run: |",
		"          docker build \\",
		'            --label org.opencontainers.image.version="$VERSION" \\',
		'            --label org.opencontainers.image.revision="$GITHUB_SHA" \\',
		'            --label org.opencontainers.image.created="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\',
		`            -t ${service}:"$VERSION" .`,
		`          docker save ${service}:"$VERSION" -o image.tar`,
		`      - name: Publicar en ${registry}`,
		"        env:",
		"          IMAGE_TAR: image.tar",
		"          OMI_REGISTRY_PASSWORD: ${{ secrets.OMI_REGISTRY_PASSWORD }}",
		"        run: |",
		...script.split("\n").map((line) => `          ${line}`),
	].join("\n");
	return {
		registry_hostname: registry,
		repository,
		image: `${registry}/${repository}`,
		push_username: "ci-push",
		workflow,
		dockerfile: `# Ejemplo para Node.js\nFROM node:22-alpine\nENV PORT=${port}\nEXPOSE ${port}\nCMD ["node", "server.js"]\n`,
		contract: `- Una imagen por service, con el nombre asignado: ${registry}/${repository}\n- HTTP en el puerto ${port} (OMI también inyecta PORT): /health responde 200 cuando la instancia puede atender y /version devuelve la versión.\n`,
		push_script: script,
	};
}
