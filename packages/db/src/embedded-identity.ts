export const EMBEDDED_POSTGRES_USER = "wardmote";
export const EMBEDDED_POSTGRES_PASSWORD = "wardmote";
export const EMBEDDED_POSTGRES_DATABASE = "wardmote";

export function embeddedPostgresUrl(port: number, database: string = EMBEDDED_POSTGRES_DATABASE): string {
  return `postgres://${EMBEDDED_POSTGRES_USER}:${EMBEDDED_POSTGRES_PASSWORD}@127.0.0.1:${port}/${database}`;
}

export function embeddedPostgresAdminUrl(port: number): string {
  return embeddedPostgresUrl(port, "postgres");
}
