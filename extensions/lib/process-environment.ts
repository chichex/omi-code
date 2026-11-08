// PI_PACKAGE_DIR/OMI_RUNTIME_DIR describen sólo al host instalado, no a sus hijos.
// La identidad agéntica y PI_CODING_AGENT_DIR sí se heredan deliberadamente.
export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const child = { ...env };
	delete child.PI_PACKAGE_DIR;
	delete child.OMI_RUNTIME_DIR;
	return child;
}
