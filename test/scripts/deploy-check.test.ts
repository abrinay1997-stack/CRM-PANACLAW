import { describe, it, expect } from "vitest";
import {
  validateDeployConfig,
  parseResourceNames,
  checkResources,
  KB_DIMENSIONS,
  type ResourceInventory,
} from "../../scripts/deploy-check";

describe("validateDeployConfig", () => {
  const full = {
    ANTHROPIC_API_KEY: "sk-x",
    BOT_NAME: "Testi",
    BOT_TIER: "pro",
    DASHBOARD_PASSWORD: "pw",
    TELEGRAM_BOT_TOKEN: "tok",
  };

  it("passes with a complete Pro config", () => {
    expect(validateDeployConfig(full)).toEqual({ ok: true, errors: [] });
  });

  it("passes a Free config without DASHBOARD_PASSWORD", () => {
    const { DASHBOARD_PASSWORD, ...rest } = full;
    expect(validateDeployConfig({ ...rest, BOT_TIER: "free" }).ok).toBe(true);
  });

  it("fails when ANTHROPIC_API_KEY is missing", () => {
    const { ANTHROPIC_API_KEY, ...rest } = full;
    const r = validateDeployConfig(rest);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("ANTHROPIC_API_KEY");
  });

  it("fails when no channel is configured", () => {
    const { TELEGRAM_BOT_TOKEN, ...rest } = full;
    const r = validateDeployConfig(rest);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("canal");
  });

  it("fails Pro without DASHBOARD_PASSWORD", () => {
    const { DASHBOARD_PASSWORD, ...rest } = full;
    const r = validateDeployConfig(rest);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("DASHBOARD_PASSWORD");
  });
});

const TOML = `
name = "panaclaw-barberia-a3f9c1"

[[d1_databases]]
binding = "DB"
database_name = "panaclaw_barberia_a3f9c1_db"
database_id = "d58d8172-c9c4-42c5-9261-6cbc77d964b0"

[[vectorize]]
binding = "KB"
index_name = "panaclaw_barberia_a3f9c1_kb"

[[r2_buckets]]
binding = "CATALOG"
bucket_name = "panaclaw-catalog-barberia-a3f9c1"
`;

describe("parseResourceNames", () => {
  it("saca los tres nombres y el id del toml", () => {
    expect(parseResourceNames(TOML)).toEqual({
      databaseName: "panaclaw_barberia_a3f9c1_db",
      databaseId: "d58d8172-c9c4-42c5-9261-6cbc77d964b0",
      indexName: "panaclaw_barberia_a3f9c1_kb",
      bucketName: "panaclaw-catalog-barberia-a3f9c1",
    });
  });

  it("devuelve undefined en lo que no está", () => {
    expect(parseResourceNames("name = \"x\"")).toEqual({
      databaseName: undefined,
      databaseId: undefined,
      indexName: undefined,
      bucketName: undefined,
    });
  });
});

describe("checkResources", () => {
  const names = parseResourceNames(TOML);
  /** Cuenta donde existe justo lo que el toml pide. */
  const healthy: ResourceInventory = {
    d1: [names.databaseName!],
    vectorize: [{ name: names.indexName!, dimensions: KB_DIMENSIONS }],
    r2: [names.bucketName!],
  };

  it("no dice nada cuando todo existe", () => {
    expect(checkResources(names, healthy)).toEqual({ errors: [], warnings: [] });
  });

  // El bug del reporte: seguiste la guía y creaste `panaclaw_kb`, pero el toml
  // pide el namespaceado. Antes esto solo se sabía al fallar el deploy.
  it("detecta el índice creado con el nombre de la guía vieja", () => {
    const r = checkResources(names, { ...healthy, vectorize: [{ name: "panaclaw_kb", dimensions: KB_DIMENSIONS }] });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("panaclaw_barberia_a3f9c1_kb");
    expect(r.errors[0]).toContain("--dimensions=1024");
  });

  it("detecta la base y el bucket que faltan, con su comando", () => {
    const r = checkResources(names, { ...healthy, d1: [], r2: [] });
    expect(r.errors).toHaveLength(2);
    expect(r.errors.join(" ")).toContain("wrangler d1 create panaclaw_barberia_a3f9c1_db");
    expect(r.errors.join(" ")).toContain("wrangler r2 bucket create panaclaw-catalog-barberia-a3f9c1");
  });

  // El que nunca da la cara: deploy verde, bot que contesta, búsqueda que no
  // encuentra nada jamás porque los vectores no viven en el mismo espacio.
  it("detecta el índice con dimensiones equivocadas", () => {
    const r = checkResources(names, { ...healthy, vectorize: [{ name: names.indexName!, dimensions: 768 }] });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("768");
    expect(r.errors[0]).toContain("no encuentra nada");
  });

  it("no se queja si el índice existe y no sabemos sus dimensiones", () => {
    const r = checkResources(names, { ...healthy, vectorize: [{ name: names.indexName! }] });
    expect(r.errors).toEqual([]);
  });

  it("detecta el marcador sin resolver en database_id", () => {
    const r = checkResources({ ...names, databaseId: "{{D1_DATABASE_ID}}" }, healthy);
    expect(r.errors.join(" ")).toContain("{{D1_DATABASE_ID}}");
  });

  // La regla de oro: no se bloquea un deploy por algo que no se pudo mirar.
  it("sin inventario avisa pero NO da error", () => {
    const r = checkResources(names, { d1: null, vectorize: null, r2: null });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });

  it("si solo falla una consulta, las otras siguen comprobando", () => {
    const r = checkResources(names, { ...healthy, d1: null, r2: [] });
    expect(r.warnings).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("bucket R2");
  });
});
