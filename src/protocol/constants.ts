// Nombres de protocolo de chichex/omi: el único lugar de omi-code que los define.
// test/protocol.test.ts los compara contra un checkout de chichex/omi con OMI_REPO.

/** URL pública de omi-api: el panel proxya /api/v1/* hacia la API. */
export const DEFAULT_API_URL = "https://app.ohmyinfra.com";
export const API_URL_ENV = "OMI_API_URL";
export const API_PREFIX = "/api/v1";

/** Rol que omi-api exige para administrar el registry de la organización. */
export const ROLE_OWNER = "dueño";

// Variables que OMI inyecta a cada workload. Un service no puede declararlas.
export const ENV_PORT = "PORT";
export const ENV_OMI_ENVIRONMENT = "OMI_ENVIRONMENT";
export const ENV_OMI_VERSION = "OMI_VERSION";
export const RESERVED_ENV_PREFIX = "OMI_";
export const RESOURCE_ENV_PREFIX = "POSTGRES_URL_";

/** Secreto de CI con el que el workflow del kit empuja al registry de la organización. */
export const CI_REGISTRY_SECRET = "OMI_REGISTRY_PASSWORD";

// Jobs: secreto del workload y headers de la firma HMAC-SHA256.
export const ENV_TRIGGER_SECRET = "OMI_TRIGGER_SECRET";
export const HEADER_JOB = "X-Omi-Job";
export const HEADER_SCHEDULED_AT = "X-Omi-Scheduled-At";
export const HEADER_ATTEMPT = "X-Omi-Attempt";
export const HEADER_TIMESTAMP = "X-Omi-Timestamp";
export const HEADER_SIGNATURE = "X-Omi-Signature";

// Login: un cliente sin cookies pide el token de la sesión en el cuerpo con este header.
export const HEADER_SESSION_TOKEN = "X-Omi-Session-Token";
export const SESSION_TOKEN_IN_BODY = "body";
/** Cookie con que omi-api abre la sesión del panel: su valor es el token de la sesión. */
export const SESSION_COOKIE = "__Host-omi_session";

// Labels OCI que el barrido de versiones de OMI exige en cada imagen.
export const LABEL_VERSION = "org.opencontainers.image.version";
export const LABEL_REVISION = "org.opencontainers.image.revision";
export const LABEL_CREATED = "org.opencontainers.image.created";

/** Tamaño de chunk del push con regctl que declara el kit de publicación. */
export const REGISTRY_CHUNK_BYTES = 52_428_800;

// Archivos locales.
export const OMI_HOME_DIR = ".omi";
export const CREDENTIALS_FILE = "credentials.json";
export const PROJECT_LINK_FILE = ".omi/project.json";
