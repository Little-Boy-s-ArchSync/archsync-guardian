import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseKubernetes, parseKubernetesFiles } from "./iac-kubernetes.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = (...parts: string[]) => join(root, "test", "fixtures", "iac", "kubernetes", ...parts);

describe("Phase 5 Kubernetes parser", () => {
  it("parses multi-document workloads, services, ingress and ConfigMap references", async () => {
    const source = await readFile(fixture("positive.yaml"), "utf8");
    const first = parseKubernetes(source, "deploy/orders.yaml");
    const second = parseKubernetes(source, "deploy/orders.yaml");

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.resources.map(({ native_type, name, exposure }) => [native_type, name, exposure])).toEqual([
      ["ConfigMap", "orders-config", "internal"],
      ["Deployment", "orders-api", "internal"],
      ["Ingress", "orders-public", "public"],
      ["Service", "orders-api", "internal"],
    ]);
    expect(first.resources.find(({ native_type }) => native_type === "Deployment")).toMatchObject({
      kind: "workload",
      approved: true,
      trust_boundary: "application",
      attributes: { replicas: 2 },
      aliases: expect.arrayContaining(["orders-api", "orders/orders-api"]),
    });
    expect(first.references.map(({ type, resolved }) => [type, resolved])).toEqual([
      ["configures", true],
      ["routes-to", true],
      ["selects", true],
    ]);
    expect(first.resources[0]?.evidence[0]).toMatchObject({
      file: "deploy/orders.yaml",
      range: { start: { line: 1, column: 1, offset: 0 } },
      detector: "kubernetes-object",
    });
    expect(first.diagnostics).toEqual([]);
  });

  it("emits explicit template, unsupported-kind and missing-reference diagnostics", async () => {
    const source = await readFile(fixture("missing-and-negative.yaml"), "utf8");
    const result = parseKubernetes(source, "deploy/negative.yaml");

    expect(result.resources).toHaveLength(4);
    expect(result.resources.find(({ native_type }) => native_type === "Secret")).toMatchObject({
      kind: "unknown",
      managed: false,
    });
    expect(result.references.map(({ type, resolved }) => [type, resolved])).toEqual([
      ["configures", false],
      ["routes-to", false],
      ["selects", false],
    ]);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "unsupported-dynamic-expression",
      "missing-reference",
      "missing-reference",
      "missing-reference",
      "unsupported-resource",
    ]);
  });

  it("marks selectors that match multiple Deployments as ambiguous", async () => {
    const source = await readFile(fixture("ambiguous.yaml"), "utf8");
    const result = parseKubernetes(source);

    expect(result.references).toHaveLength(1);
    expect(result.references[0]).toMatchObject({
      from: "kubernetes:default:service:workers",
      to: "kubernetes:default:deployment:worker-a",
      type: "selects",
      resolved: false,
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("ambiguous-reference");
  });

  it("reports malformed and unidentified YAML documents without throwing", () => {
    const source = `apiVersion: v1
kind: ConfigMap
metadata:
  name: valid
---
apiVersion: v1
metadata:
  name: missing-kind
---
kind: ConfigMap
metadata: {}
---
[]
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: [unterminated
`;
    const result = parseKubernetes(source, "broken.yaml");

    expect(result.resources.map(({ name }) => name)).toEqual(["valid"]);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "missing-identity",
      "missing-identity",
      "malformed-document",
    ]);
    expect(result.diagnostics.at(-1)?.evidence).toMatchObject({
      file: "broken.yaml",
      detector: "kubernetes-yaml-parser",
    });
  });

  it("classifies service exposure and approved transitions without public false positives", () => {
    const source = `apiVersion: v1
kind: Service
metadata:
  name: internal-lb
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-internal: "true"
    archsync.io/approved-trust-transition: "true"
spec:
  type: LoadBalancer
---
apiVersion: v1
kind: Service
metadata:
  name: public-node
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-internal: "false"
spec:
  type: NodePort
---
apiVersion: v1
kind: Service
metadata:
  name: external
spec:
  type: ExternalName
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: internal-ingress
  annotations:
    nginx.ingress.kubernetes.io/internal: "yes"
spec: {}
`;
    const result = parseKubernetes(source);
    expect(result.resources.map(({ name, exposure }) => [name, exposure])).toEqual([
      ["internal-ingress", "internal"],
      ["external", "public"],
      ["internal-lb", "internal"],
      ["public-node", "public"],
    ]);
    expect(
      result.resources.find(({ name }) => name === "internal-lb")?.attributes,
    ).toMatchObject({ approved_trust_transition: true, service_type: "LoadBalancer" });
  });

  it("combines files in lexical order and preserves portable paths", () => {
    const result = parseKubernetesFiles({
      "z.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: z\n",
      "folder\\a.yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n",
    });

    expect(result.resources.map(({ name }) => name)).toEqual(["a", "z"]);
    expect(result.resources[0]?.evidence[0]?.file).toBe("folder/a.yaml");
    expect(result.references).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });
});
