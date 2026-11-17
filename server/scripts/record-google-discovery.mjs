#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const dir = new URL("../src/services/google-workspace/", import.meta.url);
const review = JSON.parse(readFileSync(new URL("method-review.json", dir), "utf8"));
const check = process.argv.includes("--check");
const drift = [];

function collect(resource, out) {
  for (const method of Object.values(resource.methods ?? {})) out.push(method);
  for (const child of Object.values(resource.resources ?? {})) collect(child, out);
  return out;
}

async function download(service, version) {
  for (const url of [
    `https://www.googleapis.com/discovery/v1/apis/${service}/${version}/rest`,
    `https://${service}.googleapis.com/$discovery/rest?version=${version}`,
  ]) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (response.ok) return response.json();
  }
  throw new Error(`Discovery document for ${service} ${version} is unavailable`);
}

for (const [service, reviewed] of Object.entries(review.services)) {
  const doc = await download(service, reviewed.version);
  const methods = collect(doc, []);
  const ids = new Set(methods.map((method) => method.id));
  for (const id of ids) if (!reviewed.methods[id]) drift.push(`unreviewed method ${id}`);
  for (const id of Object.keys(reviewed.methods)) if (!ids.has(id)) drift.push(`removed method ${id}`);
  for (const [methodId, kinds] of Object.entries(reviewed.batchRequests ?? {})) {
    const method = methods.find((candidate) => candidate.id === methodId);
    const itemRef = doc.schemas?.[method?.request?.$ref ?? ""]?.properties?.requests?.items?.$ref;
    const live = Object.keys(doc.schemas?.[itemRef ?? ""]?.properties ?? {});
    for (const kind of live) if (!kinds[kind]) drift.push(`unreviewed request kind ${methodId}#${kind}`);
    for (const kind of Object.keys(kinds)) if (!live.includes(kind)) drift.push(`removed request kind ${methodId}#${kind}`);
  }
  if (doc.revision !== reviewed.revision) drift.push(`${service} revision ${reviewed.revision} -> ${doc.revision}`);
  if (!check) {
    writeFileSync(new URL(`__fixtures__/discovery/${service}_${reviewed.version}.json.gz`, dir), gzipSync(JSON.stringify(doc), { level: 9 }));
  }
}

for (const line of drift) console.log(line);
console.log(drift.length === 0 ? "Discovery matches method-review.json" : `${drift.length} difference(s); review the classes in method-review.json`);
if (check && drift.length > 0) process.exitCode = 1;
