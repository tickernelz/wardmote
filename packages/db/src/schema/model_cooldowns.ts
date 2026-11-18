import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const modelCooldowns = pgTable(
  "model_cooldowns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    selector: text("selector").notNull(),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    sourceRunId: uuid("source_run_id"),
    probeAfter: timestamp("probe_after", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: text("released_by"),
    probeFailingSince: timestamp("probe_failing_since", { withTimezone: true }),
    lastProbeAt: timestamp("last_probe_at", { withTimezone: true }),
    lastProbeError: text("last_probe_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySelectorUq: uniqueIndex("model_cooldowns_company_selector_uq").on(table.companyId, table.selector),
    companyUntilIdx: index("model_cooldowns_company_until_idx").on(table.companyId, table.cooldownUntil),
  }),
);
