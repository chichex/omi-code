// Esquemas de las vistas de omi-api que usa el cliente. Sólo los campos que se leen:
// la API puede sumar otros sin romper nada.

import { Type, type Static } from "typebox";
import { PublishKitSchema } from "../project/kit.ts";

const OptionalString = Type.Optional(Type.String());

export const VariableSchema = Type.Object({
	name: Type.String(),
	secret: Type.Boolean(),
	value: Type.Union([Type.String(), Type.Null()]),
});

export const DeploymentSchema = Type.Object({
	id: Type.String(),
	service: Type.String(),
	environment: Type.String(),
	from_version: OptionalString,
	to_version: Type.String(),
	status: Type.String(),
	error: OptionalString,
	instance_log_id: OptionalString,
	instance_log_error: OptionalString,
	rollback: OptionalString,
	steps: Type.Array(Type.Object({ kind: Type.String(), instance: OptionalString, at: Type.String() })),
	target_instances: Type.Integer(),
	created_at: Type.String(),
});

export const EnvironmentSchema = Type.Object({
	name: Type.String(),
	state: Type.String(),
	hostname: Type.String(),
	visibility: Type.String(),
	current_version: OptionalString,
	last_error: OptionalString,
	variables: Type.Array(VariableSchema),
	managed_variables: Type.Array(Type.Object({ name: Type.String(), resource_slug: Type.String() })),
	access: Type.Object({ state: Type.String(), url: OptionalString }),
	last_deployment: Type.Optional(DeploymentSchema),
	promotion: Type.Optional(Type.Object({ version: OptionalString, blocked_reason: OptionalString })),
});

export const ServiceSchema = Type.Object({
	name: Type.String(),
	port: Type.Integer(),
	environments: Type.Array(EnvironmentSchema),
	versions: Type.Array(Type.Object({ tag: Type.String(), prerelease: Type.Boolean() })),
	version_scan: Type.Object({
		state: Type.String(),
		last_complete_at: Type.Union([Type.String(), Type.Null()]),
		interval_seconds: Type.Integer(),
	}),
	kit: PublishKitSchema,
});

export const RefreshedVersionsSchema = Type.Object({
	versions: Type.Array(Type.Object({ tag: Type.String() })),
});

export const DeploymentsSchema = Type.Object({ deployments: Type.Array(DeploymentSchema) });

const InstanceLogFields = {
	id: Type.String(),
	deployment_id: OptionalString,
	pod: Type.String(),
	container: Type.String(),
	reason: Type.String(),
	exit_code: Type.Optional(Type.Integer()),
	restart_count: Type.Integer(),
	finished_at: Type.String(),
	captured_at: Type.String(),
};

export const InstanceLogsSchema = Type.Object({ instance_logs: Type.Array(Type.Object(InstanceLogFields)) });

export const InstanceLogDetailSchema = Type.Object({ ...InstanceLogFields, lines: Type.Array(Type.String()) });

const JobRunSchema = Type.Object({
	id: Type.String(),
	environment: Type.String(),
	state: Type.String(),
	started_at: Type.String(),
	http_status: Type.Optional(Type.Integer()),
	error: OptionalString,
});

export const JobSchema = Type.Object({
	name: Type.String(),
	service: Type.String(),
	path: Type.String(),
	schedule: Type.String(),
	timezone: Type.String(),
	timeout_seconds: Type.Integer(),
	environments: Type.Array(
		Type.Object({
			name: Type.String(),
			deployed: Type.Boolean(),
			paused: Type.Boolean(),
			last_run: Type.Union([JobRunSchema, Type.Null()]),
		}),
	),
});

export const JobsSchema = Type.Object({ jobs: Type.Array(JobSchema) });
export const JobRunsSchema = Type.Object({ runs: Type.Array(JobRunSchema) });
export { JobRunSchema };

export const ResourceSchema = Type.Object({
	id: Type.String(),
	environment: Type.String(),
	slug: Type.String(),
	mode: Type.String(),
	variable: Type.String(),
	state: Type.String(),
});

export const ResourcesSchema = Type.Object({ resources: Type.Array(ResourceSchema) });

export const ResourcePreviewSchema = Type.Object({
	id: Type.String(),
	action: Type.String(),
	environment: Type.String(),
	slug: Type.String(),
	variable: Type.String(),
	mode: Type.String(),
	pending_configuration: Type.Boolean(),
	services: Type.Array(
		Type.Object({
			name: Type.String(),
			changes: Type.Array(Type.Object({ name: Type.String(), change: Type.String() })),
		}),
	),
});

export const ResourceConfirmationSchema = Type.Object({ operation_id: Type.String(), state: Type.String() });

export const ResourceOperationSchema = Type.Object({
	id: Type.String(),
	resource_id: Type.String(),
	state: Type.String(),
	error: OptionalString,
});

export const HostSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	state: Type.String(),
	is_control_plane: Type.Boolean(),
	approved: Type.Boolean(),
	registry_eligible: Type.Boolean(),
});

export const HostsSchema = Type.Object({ hosts: Type.Array(HostSchema) });

export const RegistrySchema = Type.Object({
	state: Type.String(),
	host_id: Type.String(),
	host_name: Type.String(),
	hostname: Type.String(),
	push_username: Type.String(),
	last_error: OptionalString,
	public_route: Type.String(),
	route_error: OptionalString,
});

/** Única respuesta que trae la contraseña de push: OMI guarda sólo su hash. */
export const RegistryCredentialsSchema = Type.Object({ registry: RegistrySchema, push_password: Type.String({ minLength: 1 }) });

export type ServiceView = Static<typeof ServiceSchema>;
export type EnvironmentView = Static<typeof EnvironmentSchema>;
export type Variable = Static<typeof VariableSchema>;
export type Deployment = Static<typeof DeploymentSchema>;
export type HostView = Static<typeof HostSchema>;
export type RegistryView = Static<typeof RegistrySchema>;
